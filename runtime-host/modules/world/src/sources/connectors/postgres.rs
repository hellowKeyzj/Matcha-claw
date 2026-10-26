use super::{SourceAccess, SourceCredential, SourceError, metadata::ReadMetadata, values};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};
use tokio::time::Instant;
use tokio_postgres::types::ToSql;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension,
    expression::{BinaryOperator, ExpressionIr, UnaryOperator},
    failure::FailureStage,
    sources::*,
    value::{Value, ValueType},
};

const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    plan: String,
    offset: u64,
}

pub(super) async fn read(
    access: &Arc<dyn SourceAccess>,
    metadata: &ReadMetadata,
    plan: &SourceReadPlan,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
    budget: &crate::extensions::invocation::CallBudget,
) -> Result<SourcePage, SourceError> {
    check_read(&cancel, deadline)?;
    budget.check().map_err(super::budget_error)?;
    let SourceConnectionConfig::Postgres(config) = &metadata.connection.config else {
        return Err(invalid("connection", SourcePlanReason::InvalidValue));
    };
    if plan.as_of.is_some() {
        return Err(SourceError::new(
            SourceFailure::HistoryUnavailable,
            FailureStage::Read,
        ));
    }
    let resource = config
        .resources
        .iter()
        .find(|resource| resource.id == plan.resource)
        .ok_or_else(|| invalid("resource", SourcePlanReason::UnknownResource))?;
    validate_resource(resource)?;
    let mut selected = plan
        .fields
        .iter()
        .map(|name| field(resource, name))
        .collect::<Result<Vec<_>, _>>()?;
    for id in &resource.key {
        let field = resource
            .fields
            .iter()
            .find(|field| &field.id == id)
            .ok_or_else(|| invalid("key", SourcePlanReason::InvalidKey))?;
        if !selected.iter().any(|selected| selected.id == field.id) {
            selected.push(field);
        }
    }
    if selected.iter().any(|field| !field.readable) {
        return Err(invalid("fields", SourcePlanReason::FieldNotReadable));
    }
    let mut parameters = Vec::<Option<String>>::new();
    let mut nodes = 0;
    let filter = plan
        .predicate
        .as_ref()
        .map(|predicate| {
            predicate_sql(
                predicate,
                resource,
                metadata,
                &mut parameters,
                0,
                &mut nodes,
            )
        })
        .transpose()?;
    if filter.is_some() && !metadata.binding.body.capabilities.predicate_pushdown {
        return Err(invalid(
            "predicate",
            SourcePlanReason::CapabilityNotDeclared,
        ));
    }
    if !plan.order.is_empty() && !metadata.binding.body.capabilities.ordering_pushdown {
        return Err(invalid("order", SourcePlanReason::CapabilityNotDeclared));
    }
    let mut order = plan
        .order
        .iter()
        .map(|order| Ok((field(resource, &order.field)?, order.descending)))
        .collect::<Result<Vec<_>, SourceError>>()?;
    for key in &resource.key {
        if !order.iter().any(|(field, _)| &field.id == key) {
            order.push((
                resource
                    .fields
                    .iter()
                    .find(|field| &field.id == key)
                    .ok_or_else(|| invalid("key", SourcePlanReason::InvalidKey))?,
                false,
            ));
        }
    }
    let mut digest_plan = plan.clone();
    digest_plan.continuation = None;
    let digest =
        world_protocol::schema::hash(&serde_json::to_vec(&digest_plan).map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Validate, cause)
        })?)
        .map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Validate, cause)
        })?;
    let offset = match &plan.continuation {
        None => 0,
        Some(cursor) => {
            if cursor.len() > 4096 {
                return Err(invalid("continuation", SourcePlanReason::InvalidValue));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(cursor)
                .map_err(|_| invalid("continuation", SourcePlanReason::InvalidValue))?;
            let cursor: Cursor = world_protocol::wire::decode(&bytes, 4096)
                .map_err(|_| invalid("continuation", SourcePlanReason::InvalidValue))?;
            if cursor.plan != digest.as_str() || cursor.offset > i64::MAX as u64 {
                return Err(invalid("continuation", SourcePlanReason::InvalidValue));
            }
            cursor.offset
        }
    };
    let columns = selected
        .iter()
        .map(|field| column_expression(field))
        .collect::<Vec<_>>()
        .join(",");
    let ordering = order
        .iter()
        .map(|(field, descending)| {
            format!(
                "{} {} NULLS LAST",
                identifier(&field.column),
                if *descending { "DESC" } else { "ASC" }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT {columns} FROM {}.{}{} ORDER BY {ordering} LIMIT {} OFFSET {offset}",
        identifier(&config.schema),
        identifier(&resource.table),
        filter.map_or(String::new(), |filter| format!(" WHERE {filter}")),
        u64::from(plan.limit) + 1
    );
    let connection = access
        .connect_postgres(config, credential, cancel.clone(), deadline)
        .await?;
    let mut client = connection.client;
    let mut driver = connection.driver;
    let result = {
        let work = async {
            let transaction = client
                .build_transaction()
                .read_only(true)
                .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
                .start()
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            let millis = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(i32::MAX as u128)
                .max(1)
                .to_string();
            transaction.query_one("SELECT set_config('statement_timeout',$1,true),set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true)", &[&millis]).await
            .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            let basis = transaction.query_one("SELECT pg_current_snapshot()::text AS snapshot,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS observed", &[]).await
            .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            let refs: Vec<&(dyn ToSql + Sync)> = parameters
                .iter()
                .map(|parameter| parameter as &(dyn ToSql + Sync))
                .collect();
            let stream = transaction
                .query_raw(&sql, refs)
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            let mut stream = Box::pin(stream);
            let mut rows = Vec::new();
            let mut size = 0usize;
            let mut more = false;
            let mut keys = BTreeSet::new();
            while let Some(row) = stream.next().await {
                let row = row.map_err(|error| SourceError::database(error, FailureStage::Read))?;
                check_read(&cancel, deadline)?;
                budget
                    .charge(BudgetDimension::Rows, 1)
                    .map_err(super::budget_error)?;
                let mut raw_values = Vec::with_capacity(selected.len());
                for index in 0..selected.len() {
                    let raw = row.try_get::<_, Option<&str>>(index).map_err(|cause| {
                        SourceError::caused_by(
                            SourceFailure::UnsupportedField {
                                field: selected[index].id.to_string(),
                            },
                            FailureStage::Decode,
                            cause,
                        )
                    })?;
                    let bytes = raw.map_or(0, str::len);
                    budget
                        .charge(BudgetDimension::Bytes, bytes as u64)
                        .map_err(super::budget_error)?;
                    size = size.saturating_add(bytes);
                    if size > MAX_PAGE_BYTES {
                        return Err(SourceError::new(
                            SourceFailure::ResponseLimit,
                            FailureStage::Read,
                        ));
                    }
                    raw_values.push(raw);
                }
                if rows.len() == plan.limit as usize {
                    more = true;
                    break;
                }
                let mut fields = Vec::with_capacity(plan.fields.len());
                let mut key = Vec::with_capacity(resource.key.len());
                for id in &resource.key {
                    let index = selected
                        .iter()
                        .position(|field| &field.id == id)
                        .ok_or_else(|| invalid("key", SourcePlanReason::InvalidKey))?;
                    let declared = selected[index];
                    key.push(values::from_text(
                        raw_values[index].as_deref(),
                        &declared.value_type,
                        declared.nullable,
                    ));
                }
                let native_key = values::native_key(&key)?;
                if !keys.insert(native_key.clone()) {
                    return Err(values::invalid_response("duplicateKey"));
                }
                for name in &plan.fields {
                    let declared = field(resource, name)?;
                    let index = selected
                        .iter()
                        .position(|field| field.id == declared.id)
                        .ok_or_else(|| values::invalid_response("fields"))?;
                    let raw = raw_values[index].map(str::to_owned);
                    fields.push(SourceField {
                        id: declared.id.clone(),
                        name: metadata
                            .schema
                            .fields
                            .iter()
                            .find(|field| field.id == declared.id)
                            .ok_or_else(|| values::invalid_response("schemaField"))?
                            .name
                            .clone(),
                        value: values::from_text(
                            raw.as_deref(),
                            &declared.value_type,
                            declared.nullable,
                        ),
                        raw_lexeme: raw,
                        formula: None,
                        locator: None,
                    });
                }
                rows.push(SourceRow {
                    native_key,
                    incarnation: metadata.binding.body.incarnation.clone(),
                    fields,
                });
            }
            drop(stream);
            transaction
                .rollback()
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            let continuation = if more {
                let cursor = Cursor {
                    plan: digest.to_string(),
                    offset: offset + rows.len() as u64,
                };
                Some(
                    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).map_err(|cause| {
                        SourceError::caused_by(
                            SourceFailure::InternalFault,
                            FailureStage::Read,
                            cause,
                        )
                    })?),
                )
            } else {
                None
            };
            let binding = &metadata.binding.body;
            Ok(SourcePage {
                rows,
                basis: SourceBasis {
                    source_id: binding.source_id.clone(),
                    incarnation: binding.incarnation.clone(),
                    binding: metadata.binding.reference.clone(),
                    mapping_revision: binding.mapping.revision,
                    authority_revision: binding.authority.revision,
                    schema: binding.schema.clone(),
                    identity_rule: binding.identity_rule.clone(),
                    field_definitions: binding
                        .field_mapping
                        .iter()
                        .map(|field| field.property.clone())
                        .collect(),
                    position: None,
                    snapshot: Some(basis.get("snapshot")),
                    observed_at: world_protocol::time::Timestamp::try_new(
                        basis.get::<_, String>("observed"),
                    )
                    .map_err(|_| values::invalid_response("observedAt"))?,
                    captured_at: None,
                    last_reconciled_at: None,
                    guarantee: SourceGuarantee::Authoritative,
                    gap: (more || offset != 0).then_some(SourceGap {
                        reason: GapReason::IncompleteEnumeration,
                        after: None,
                        before: None,
                    }),
                },
                continuation,
                complete: !more && offset == 0,
            })
        };
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => result,
            _ = cancel.cancelled() => Err(SourceError::new(SourceFailure::Cancelled, FailureStage::Read)),
            _ = tokio::time::sleep_until(deadline) => Err(SourceError::new(SourceFailure::ReadTimeout, FailureStage::Read)),
        }
    };
    drop(client);
    let cleanup = driver
        .cancel_and_join()
        .await
        .map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Drain, cause)
        })
        .and_then(|result| {
            result.map_err(|cause| SourceError::database(cause, FailureStage::Drain))
        });
    if let Err(cleanup) = cleanup {
        return Err(SourceError::cleanup(
            result.err(),
            "source.postgres_driver_cleanup",
            cleanup,
        ));
    }
    result
}

pub(super) fn validate_resource(resource: &PostgresResource) -> Result<(), SourceError> {
    if resource.key.is_empty()
        || resource
            .fields
            .iter()
            .map(|field| &field.id)
            .collect::<BTreeSet<_>>()
            .len()
            != resource.fields.len()
        || resource.key.iter().collect::<BTreeSet<_>>().len() != resource.key.len()
    {
        return Err(invalid("resource", SourcePlanReason::InvalidKey));
    }
    for name in
        std::iter::once(&resource.table).chain(resource.fields.iter().map(|field| &field.column))
    {
        if name.is_empty() || name.contains('\0') || name.len() > 63 {
            return Err(invalid("resource", SourcePlanReason::InvalidIdentifier));
        }
    }
    Ok(())
}
pub(super) fn column_expression(field: &SourceResourceField) -> String {
    let column = identifier(&field.column);
    match field.value_type {
        ValueType::Timestamp { .. } => format!(
            "CASE WHEN pg_typeof({column}) = 'timestamp without time zone'::regtype THEN to_char({column}::timestamp,'YYYY-MM-DD\"T\"HH24:MI:SS.US') WHEN pg_typeof({column}) = 'timestamp with time zone'::regtype THEN to_char({column}::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') ELSE {column}::text END"
        ),
        ValueType::List { .. } | ValueType::Record { .. } => format!("to_jsonb({column})::text"),
        _ => format!("{column}::text"),
    }
}
pub(super) fn identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
pub(super) fn field<'a>(
    resource: &'a PostgresResource,
    name: &str,
) -> Result<&'a SourceResourceField, SourceError> {
    resource
        .fields
        .iter()
        .find(|field| field.id.as_str() == name)
        .ok_or_else(|| invalid("fields", SourcePlanReason::UnknownField))
}
pub(super) fn predicate_sql(
    expression: &ExpressionIr,
    resource: &PostgresResource,
    metadata: &ReadMetadata,
    parameters: &mut Vec<Option<String>>,
    depth: usize,
    nodes: &mut usize,
) -> Result<String, SourceError> {
    *nodes += 1;
    if depth > 64 || *nodes > 4096 {
        return Err(invalid("predicate", SourcePlanReason::UnsupportedPredicate));
    }
    let recurse =
        |expression: &ExpressionIr, parameters: &mut Vec<Option<String>>, nodes: &mut usize| {
            predicate_sql(expression, resource, metadata, parameters, depth + 1, nodes)
        };
    match expression {
        ExpressionIr::Field { property, .. } => {
            let mapping = metadata
                .binding
                .body
                .field_mapping
                .iter()
                .find(|field| &field.property == property)
                .ok_or_else(|| invalid("predicate", SourcePlanReason::UnknownField))?;
            let field = field(resource, &mapping.source_field)?;
            if !field.readable {
                return Err(invalid("predicate", SourcePlanReason::FieldNotReadable));
            }
            // A transformed source expression must not be mistaken for a property expression.
            if mapping
                .transform
                .as_ref()
                .is_some_and(|transform| !matches!(transform, SourceTransform::Identity))
            {
                return Err(invalid("predicate", SourcePlanReason::UnsupportedPredicate));
            }
            Ok(format!(
                "({})::{}",
                identifier(&field.column),
                sql_type(&field.value_type)?
            ))
        }
        ExpressionIr::Literal { value } => {
            let (value, kind) = literal(value)?;
            parameters.push(value);
            Ok(format!("${}::text::{kind}", parameters.len()))
        }
        ExpressionIr::Binary {
            operator,
            left,
            right,
        } => {
            let operator = match operator {
                BinaryOperator::Equal => "=",
                BinaryOperator::NotEqual => "<>",
                BinaryOperator::Less => "<",
                BinaryOperator::LessOrEqual => "<=",
                BinaryOperator::Greater => ">",
                BinaryOperator::GreaterOrEqual => ">=",
                BinaryOperator::Add => "+",
                BinaryOperator::Subtract => "-",
                BinaryOperator::Multiply => "*",
                _ => return Err(invalid("predicate", SourcePlanReason::UnsupportedPredicate)),
            };
            Ok(format!(
                "({} {operator} {})",
                recurse(left, parameters, nodes)?,
                recurse(right, parameters, nodes)?
            ))
        }
        ExpressionIr::Unary {
            operator: UnaryOperator::Not,
            operand,
        } => Ok(format!("(NOT {})", recurse(operand, parameters, nodes)?)),
        ExpressionIr::IsNull { operand } => Ok(format!(
            "({} IS NULL)",
            recurse(operand, parameters, nodes)?
        )),
        ExpressionIr::All { terms } | ExpressionIr::Any { terms } => {
            let all = matches!(expression, ExpressionIr::All { .. });
            if terms.is_empty() {
                return Ok(if all { "TRUE" } else { "FALSE" }.into());
            }
            let terms = terms
                .iter()
                .map(|term| recurse(term, parameters, nodes))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!(
                "({})",
                terms.join(if all { " AND " } else { " OR " })
            ))
        }
        _ => Err(invalid("predicate", SourcePlanReason::UnsupportedPredicate)),
    }
}
pub(super) fn sql_type(value_type: &ValueType) -> Result<&'static str, SourceError> {
    Ok(match value_type {
        ValueType::Boolean => "boolean",
        ValueType::Integer => "bigint",
        ValueType::Decimal { .. } | ValueType::Money { .. } | ValueType::Quantity { .. } => {
            "numeric"
        }
        ValueType::Text { .. } | ValueType::Object { .. } | ValueType::Relation { .. } => "text",
        ValueType::Timestamp { .. } => "timestamptz",
        ValueType::Date { .. } => "date",
        ValueType::Duration => "numeric",
        _ => return Err(invalid("predicate", SourcePlanReason::UnsupportedPredicate)),
    })
}
pub(super) fn literal(value: &Value) -> Result<(Option<String>, &'static str), SourceError> {
    Ok(match value {
        Value::Boolean { value } => (Some(value.to_string()), "boolean"),
        Value::Integer { value } => (Some(value.to_string()), "bigint"),
        Value::Decimal { value } => (Some(value.to_string()), "numeric"),
        Value::Money { amount, .. } | Value::Quantity { amount, .. } => {
            (Some(amount.to_string()), "numeric")
        }
        Value::Text { value } => (Some(value.clone()), "text"),
        Value::Timestamp { value } => (Some(value.to_string()), "timestamptz"),
        Value::Date { value, .. } => (Some(value.clone()), "date"),
        Value::Null => (None, "text"),
        _ => return Err(invalid("predicate", SourcePlanReason::UnsupportedPredicate)),
    })
}
fn check_read(cancel: &CancellationToken, deadline: Instant) -> Result<(), SourceError> {
    if cancel.is_cancelled() {
        return Err(SourceError::new(
            SourceFailure::Cancelled,
            FailureStage::Read,
        ));
    }
    if Instant::now() >= deadline {
        return Err(SourceError::new(
            SourceFailure::ReadTimeout,
            FailureStage::Read,
        ));
    }
    Ok(())
}
fn invalid(field: &str, reason: SourcePlanReason) -> SourceError {
    SourceError::invalid(field, reason)
}
