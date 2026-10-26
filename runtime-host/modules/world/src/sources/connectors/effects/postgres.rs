use std::sync::Arc;

use tokio::time::Instant;
use tokio_postgres::{Transaction, types::ToSql};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    actions::EffectDisposition,
    failure::FailureStage,
    sources::{SourceConnectionConfig, SourceFailure, SourcePlanReason},
    value::Value,
};

use super::super::{
    SourceAccess, SourceCredential,
    postgres::{identifier, literal, sql_type},
};
use super::{EffectMetadata, Observation, PreparedEffect, SourceBroker, SourceError};
use crate::{
    authorization::{Admission, AuthorizedEffect},
    extensions::invocation::CallBudget,
};

pub(super) async fn execute(
    access: &Arc<dyn SourceAccess>,
    broker: &SourceBroker,
    admission: &Admission,
    prepared: &PreparedEffect,
    metadata: &EffectMetadata,
    budget: &CallBudget,
    authorized: AuthorizedEffect,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
) -> Observation {
    let mut result = Observation::new(prepared, metadata, EffectDisposition::NotSent);
    let SourceConnectionConfig::Postgres(config) = &metadata.connection.config else {
        return result.failed(protocol());
    };
    let Some(resource) = config
        .resources
        .iter()
        .find(|resource| resource.id == prepared.operation.resource)
    else {
        return result.failed(protocol());
    };
    let connection = match access
        .connect_postgres(config, credential, cancel.clone(), deadline)
        .await
    {
        Ok(connection) => connection,
        Err(error) => return result.failed(error),
    };
    let mut client = connection.client;
    let mut driver = connection.driver;
    let mut sent = false;
    let mut committing = false;
    let outcome = {
        let work = async {
            let transaction = client
                .transaction()
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Execute))?;
            let timeout = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .clamp(1, i32::MAX as u128)
                .to_string();
            transaction
                .execute(
                    "SELECT set_config('statement_timeout',$1,true),set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true)",
                    &[&timeout],
                )
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Execute))?;
            require_unique_key(&transaction, &config.schema, resource).await?;
            let (sql, parameters) =
                mutation_sql(prepared, metadata, &config.schema, &resource.table)?;
            if cancel.is_cancelled() || Instant::now() >= deadline {
                return Err(SourceError::new(
                    SourceFailure::Cancelled,
                    FailureStage::Execute,
                ));
            }
            broker.recheck_effect(prepared, admission, false).await?;
            let now = world_protocol::time::Timestamp::try_new(chrono::Utc::now().to_rfc3339())
                .expect("UTC timestamp");
            authorized.ensure_live(&now)?;
            budget.check().map_err(super::super::budget_error)?;
            sent = true;
            let parameters: Vec<&(dyn ToSql + Sync)> = parameters
                .iter()
                .map(|value| value as &(dyn ToSql + Sync))
                .collect();
            let rows = transaction
                .query(&sql, &parameters)
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Execute))?;
            budget
                .charge(world_protocol::budget::BudgetDimension::Rows, rows.len() as u64)
                .map_err(super::super::budget_error)?;
            if rows.len() != 1 {
                transaction
                    .rollback()
                    .await
                    .map_err(|error| SourceError::database(error, FailureStage::Execute))?;
                return Ok(EffectDisposition::NotApplied);
            }
            broker.recheck_effect(prepared, admission, false).await?;
            let now = world_protocol::time::Timestamp::try_new(chrono::Utc::now().to_rfc3339())
                .expect("UTC timestamp");
            authorized.ensure_live(&now)?;
            budget.check().map_err(super::super::budget_error)?;
            committing = true;
            transaction
                .commit()
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Execute))?;
            Ok(EffectDisposition::Applied)
        };
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => result,
            _ = cancel.cancelled() => Err(SourceError::new(SourceFailure::Cancelled, FailureStage::Execute)),
            _ = tokio::time::sleep_until(deadline) => Err(SourceError::new(SourceFailure::ReadTimeout, FailureStage::Execute)),
        }
    };
    // Dropping a live transaction sends ROLLBACK; never infer a COMMIT outcome from cancellation.
    drop(client);
    result = match outcome {
        Ok(disposition) => {
            result.receipt.disposition = disposition;
            result
        }
        Err(error) if committing => {
            result.receipt.disposition = EffectDisposition::Indeterminate;
            result.failed(SourceError::caused_by(
                SourceFailure::EffectIndeterminate {
                    intent_id: prepared.intent_id.clone(),
                },
                FailureStage::Execute,
                error,
            ))
        }
        Err(error) => {
            result.receipt.disposition = if sent {
                EffectDisposition::NotApplied
            } else {
                EffectDisposition::NotSent
            };
            result.failed(error)
        }
    };
    let cleanup = driver
        .cancel_and_join()
        .await
        .map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Drain, cause)
        })
        .and_then(|result| {
            result.map_err(|cause| SourceError::database(cause, FailureStage::Drain))
        });
    if let Err(error) = cleanup {
        result = result.cleanup(error);
    }
    result
}

pub(super) async fn inspect(
    access: &Arc<dyn SourceAccess>,
    broker: &SourceBroker,
    admission: &Admission,
    prepared: &PreparedEffect,
    metadata: &EffectMetadata,
    budget: &CallBudget,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
) -> Observation {
    let mut result = Observation::new(prepared, metadata, EffectDisposition::Indeterminate);
    let SourceConnectionConfig::Postgres(config) = &metadata.connection.config else {
        return result.failed(protocol());
    };
    let Some(resource) = config
        .resources
        .iter()
        .find(|resource| resource.id == prepared.operation.resource)
    else {
        return result.failed(protocol());
    };
    let connection = match access
        .connect_postgres(config, credential, cancel.clone(), deadline)
        .await
    {
        Ok(connection) => connection,
        Err(error) => return result.failed(error),
    };
    let mut client = connection.client;
    let mut driver = connection.driver;
    let outcome = {
        let work = async {
            let transaction = client
                .build_transaction()
                .read_only(true)
                .start()
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            let timeout = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .clamp(1, i32::MAX as u128)
                .to_string();
            transaction
                .execute(
                    "SELECT set_config('statement_timeout',$1,true),set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true)",
                    &[&timeout],
                )
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            require_unique_key(&transaction, &config.schema, resource).await?;
            let mut parameters = Vec::new();
            let keys = if prepared.values.insert {
                prepared
                    .values
                    .values
                    .iter()
                    .filter(|(field, _)| metadata.keys.contains(field))
                    .cloned()
                    .collect::<Vec<_>>()
            } else {
                prepared.values.keys.clone()
            };
            let predicate = conditions(&keys, metadata, &mut parameters)?;
            let selected = metadata
                .fields
                .iter()
                .filter(|field| {
                    keys.iter()
                        .chain(&prepared.values.values)
                        .chain(&prepared.values.expected)
                        .any(|(id, _)| &field.id == id)
                })
                .collect::<Vec<_>>();
            let columns = selected
                .iter()
                .map(|field| super::super::postgres::column_expression(field))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT {columns} FROM {}.{} WHERE {predicate} LIMIT 2",
                identifier(&config.schema),
                identifier(&resource.table)
            );
            let parameters: Vec<&(dyn ToSql + Sync)> = parameters
                .iter()
                .map(|value| value as &(dyn ToSql + Sync))
                .collect();
            broker.recheck_effect(prepared, admission, true).await?;
            budget.check().map_err(super::super::budget_error)?;
            let rows = transaction
                .query(&sql, &parameters)
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            transaction
                .rollback()
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            // A current row/absence is an independent observation, never proof that this intent caused it.
            // Without a source-owned operation receipt, retain Indeterminate and do not authorize resend.
            budget
                .charge(world_protocol::budget::BudgetDimension::Rows, rows.len() as u64)
                .map_err(super::super::budget_error)?;
            if rows.len() > 1 {
                return Err(SourceError::invalid("keys", SourcePlanReason::InvalidKey));
            }
            let mut bytes = 0usize;
            let mut fields = std::collections::BTreeMap::new();
            fields.insert(
                "exists".into(),
                Value::Boolean {
                    value: !rows.is_empty(),
                },
            );
            if let Some(row) = rows.first() {
                for (index, field) in selected.iter().enumerate() {
                    let raw = row
                        .try_get::<_, Option<&str>>(index)
                        .map_err(|error| SourceError::database(error, FailureStage::Decode))?;
                    let length = raw.map_or(0, str::len);
                    budget
                        .charge(world_protocol::budget::BudgetDimension::Bytes, length as u64)
                        .map_err(super::super::budget_error)?;
                    bytes = bytes.saturating_add(length);
                    if bytes > 8 * 1024 * 1024 {
                        return Err(SourceError::new(
                            SourceFailure::ResponseLimit,
                            FailureStage::Read,
                        ));
                    }
                    let world_protocol::sources::RecordCell::Known { value } =
                        super::super::values::from_text(
                            raw.as_deref(),
                            &field.value_type,
                            field.nullable,
                        )
                    else {
                        return Err(super::super::values::invalid_response(field.id.to_string()));
                    };
                    fields.insert(field.id.to_string(), value);
                }
            }
            Ok(Value::Record { fields })
        };
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => result,
            _ = cancel.cancelled() => Err(SourceError::new(SourceFailure::Cancelled, FailureStage::Read)),
            _ = tokio::time::sleep_until(deadline) => Err(SourceError::new(SourceFailure::ReadTimeout, FailureStage::Read)),
        }
    };
    drop(client);
    match outcome {
        Ok(value) => result.receipt.result = Some(value),
        Err(error) => result = result.failed(error),
    }
    let cleanup = driver
        .cancel_and_join()
        .await
        .map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Drain, cause)
        })
        .and_then(|result| {
            result.map_err(|cause| SourceError::database(cause, FailureStage::Drain))
        });
    if let Err(error) = cleanup {
        result = result.cleanup(error);
    }
    result
}

async fn require_unique_key(
    transaction: &Transaction<'_>,
    schema: &str,
    resource: &world_protocol::sources::PostgresResource,
) -> Result<(), SourceError> {
    let table = format!("{}.{}", identifier(schema), identifier(&resource.table));
    let mut columns = resource
        .key
        .iter()
        .map(|id| {
            resource
                .fields
                .iter()
                .find(|field| &field.id == id)
                .map(|field| field.column.clone())
                .ok_or_else(protocol)
        })
        .collect::<Result<Vec<_>, _>>()?;
    columns.sort();
    let row = transaction.query_one("SELECT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=to_regclass($1) AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=cardinality($2::text[]) AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.ordinal<=i.indnkeyatts)=$2::text[]) AS valid", &[&table, &columns]).await.map_err(|error| SourceError::database(error, FailureStage::Validate))?;
    if !row.get::<_, bool>("valid") {
        return Err(SourceError::invalid("keys", SourcePlanReason::InvalidKey));
    }
    Ok(())
}

fn mutation_sql(
    prepared: &PreparedEffect,
    metadata: &EffectMetadata,
    schema: &str,
    table: &str,
) -> Result<(String, Vec<Option<String>>), SourceError> {
    let mut parameters = Vec::new();
    let table = format!("{}.{}", identifier(schema), identifier(table));
    let values = &prepared.values;
    let sql = if values.insert {
        let columns = values
            .values
            .iter()
            .map(|(id, _)| column(metadata, id))
            .collect::<Result<Vec<_>, _>>()?
            .join(",");
        let values = values
            .values
            .iter()
            .map(|(id, value)| parameter(metadata, id, value, &mut parameters))
            .collect::<Result<Vec<_>, _>>()?
            .join(",");
        format!("INSERT INTO {table} ({columns}) VALUES ({values}) RETURNING 1")
    } else {
        let assignments = values
            .values
            .iter()
            .map(|(id, value)| {
                Ok(format!(
                    "{}={}",
                    column(metadata, id)?,
                    parameter(metadata, id, value, &mut parameters)?
                ))
            })
            .collect::<Result<Vec<_>, SourceError>>()?;
        let mut conditions_values = values.keys.clone();
        conditions_values.extend(values.expected.clone());
        let conditions = conditions(&conditions_values, metadata, &mut parameters)?;
        if values.delete {
            format!("DELETE FROM {table} WHERE {conditions} RETURNING 1")
        } else {
            format!(
                "UPDATE {table} SET {} WHERE {conditions} RETURNING 1",
                assignments.join(",")
            )
        }
    };
    Ok((sql, parameters))
}

fn conditions(
    values: &[(world_protocol::ids::SourceFieldId, Value)],
    metadata: &EffectMetadata,
    parameters: &mut Vec<Option<String>>,
) -> Result<String, SourceError> {
    if values.is_empty() {
        return Err(SourceError::invalid("keys", SourcePlanReason::InvalidKey));
    }
    values
        .iter()
        .map(|(id, value)| {
            Ok(format!(
                "{} IS NOT DISTINCT FROM {}",
                column(metadata, id)?,
                parameter(metadata, id, value, parameters)?
            ))
        })
        .collect::<Result<Vec<_>, SourceError>>()
        .map(|terms| terms.join(" AND "))
}
fn column(
    metadata: &EffectMetadata,
    id: &world_protocol::ids::SourceFieldId,
) -> Result<String, SourceError> {
    metadata
        .fields
        .iter()
        .find(|field| &field.id == id)
        .map(|field| identifier(&field.column))
        .ok_or_else(protocol)
}
fn parameter(
    metadata: &EffectMetadata,
    id: &world_protocol::ids::SourceFieldId,
    value: &Value,
    parameters: &mut Vec<Option<String>>,
) -> Result<String, SourceError> {
    let field = metadata
        .fields
        .iter()
        .find(|field| &field.id == id)
        .ok_or_else(protocol)?;
    let raw = match value {
        Value::Object { id } => Some(id.to_string()),
        Value::Relation { id } => Some(id.to_string()),
        Value::Duration { milliseconds } => Some(milliseconds.to_string()),
        _ => literal(value)?.0,
    };
    parameters.push(raw);
    Ok(format!(
        "${}::text::{}",
        parameters.len(),
        sql_type(&field.value_type)?
    ))
}
fn protocol() -> SourceError {
    SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Validate)
}
