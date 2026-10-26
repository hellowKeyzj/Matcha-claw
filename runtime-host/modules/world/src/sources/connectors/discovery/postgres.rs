use std::{collections::BTreeMap, sync::Arc};

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension, failure::FailureStage, ids::SourceFieldId, sources::*,
    value::ValueType,
};

use super::super::{SourceAccess, SourceCredential, SourceError, values};
use crate::extensions::invocation::CallBudget;

pub(super) async fn discover(
    access: &Arc<dyn SourceAccess>,
    config: &PostgresConnectionConfig,
    resource: &str,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
    budget: &CallBudget,
) -> Result<SchemaObservation, SourceError> {
    let configured = config
        .resources
        .iter()
        .find(|item| item.id == resource)
        .ok_or_else(|| SourceError::invalid("resource", SourcePlanReason::UnknownResource))?;
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
                .map_err(database)?;
            let timeout = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .clamp(1, i32::MAX as u128)
                .to_string();
            transaction
                .query_one(
                    "SELECT set_config('statement_timeout',$1,true)",
                    &[&timeout],
                )
                .await
                .map_err(database)?;
            let relation = transaction.query_opt(
                "SELECT c.oid::bigint AS relation_id,n.nspname,c.relname,json_build_array((SELECT system_identifier::text FROM pg_control_system()),d.oid::text,c.oid::text,c.relfilenode::text,c.reltype::text)::text AS incarnation,has_schema_privilege(n.oid,'USAGE') AS usable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_database d ON d.datname=current_database() WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p','v','m','f')",
                &[&config.schema, &configured.table],
            ).await.map_err(database)?.ok_or_else(|| SourceError::invalid("resource", SourcePlanReason::UnknownResource))?;
            if !relation.get::<_, bool>("usable") {
                return Err(SourceError::new(
                    SourceFailure::PermissionDenied,
                    FailureStage::Read,
                ));
            }
            let relation_id: i64 = relation.get("relation_id");
            let rows = transaction.query(
                "SELECT a.attnum,a.attname,COALESCE(bt.typname,t.typname) AS type_name,tn.nspname AS type_namespace,CASE WHEN a.atttypmod>=0 THEN a.atttypmod ELSE t.typtypmod END AS type_modifier,(a.attnotnull OR t.typnotnull) AS not_null,has_column_privilege(a.attrelid,a.attnum,'SELECT') AS readable,(a.attgenerated='' AND ((has_column_privilege(a.attrelid,a.attnum,'UPDATE') AND pg_column_is_updatable(a.attrelid,a.attnum,false)) OR (a.attidentity<>'a' AND has_column_privilege(a.attrelid,a.attnum,'INSERT') AND pg_column_is_updatable(a.attrelid,a.attnum,false)))) AS writable FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_type bt ON t.typtype='d' AND bt.oid=t.typbasetype JOIN pg_namespace tn ON tn.oid=COALESCE(bt.typnamespace,t.typnamespace) WHERE a.attrelid=$1::bigint::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 4097",
                &[&relation_id],
            ).await.map_err(database)?;
            if rows.len() > 4096 {
                return Err(SourceError::new(
                    SourceFailure::ResponseLimit,
                    FailureStage::Read,
                ));
            }
            let mut fields = Vec::with_capacity(rows.len());
            let mut ids = BTreeMap::new();
            for row in rows {
                budget.check().map_err(super::super::budget_error)?;
                let number: i16 = row.get("attnum");
                let name: String = row.get("attname");
                let kind: String = row.get("type_name");
                budget
                    .charge(
                        BudgetDimension::Bytes,
                        (name.len() + kind.len() + 32) as u64,
                    )
                    .map_err(super::super::budget_error)?;
                // Configuration supplies local field identity only, never observed shape or permissions.
                let id = match configured.fields.iter().find(|field| field.column == name) {
                    Some(field) => field.id.clone(),
                    None => SourceFieldId::try_new(format!("column-{number}"))
                        .map_err(|_| values::invalid_response("fields.id"))?,
                };
                if ids.values().any(|existing| existing == &id) {
                    return Err(values::invalid_response("fields.id"));
                }
                if row.get::<_, String>("type_namespace") != "pg_catalog" {
                    return Err(unsupported(&name));
                }
                let value_type = value_type(&kind, row.get("type_modifier"), &name)?;
                ids.insert(number, id.clone());
                fields.push(DiscoveredField {
                    id,
                    name,
                    value_type,
                    nullable: !row.get::<_, bool>("not_null"),
                    optional: false,
                    readable: row.get("readable"),
                    writable: row.get("writable"),
                });
            }
            let indexes = transaction.query(
                "SELECT i.indisprimary,i.indkey::smallint[] AS columns,i.indnkeyatts::integer AS key_count FROM pg_index i WHERE i.indrelid=$1::bigint::oid AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL ORDER BY i.indisprimary DESC,i.indexrelid LIMIT 4097",
                &[&relation_id],
            ).await.map_err(database)?;
            if indexes.len() > 4096 {
                return Err(SourceError::new(
                    SourceFailure::ResponseLimit,
                    FailureStage::Read,
                ));
            }
            let mut keys = Vec::with_capacity(indexes.len());
            for row in indexes {
                let columns: Vec<i16> = row.get("columns");
                let count: i32 = row.get("key_count");
                budget
                    .charge(BudgetDimension::Bytes, (columns.len() * 2 + 16) as u64)
                    .map_err(super::super::budget_error)?;
                if count <= 0 || count as usize > columns.len() {
                    return Err(values::invalid_response("keys"));
                }
                let fields = columns[..count as usize]
                    .iter()
                    .map(|number| {
                        ids.get(number)
                            .cloned()
                            .ok_or_else(|| values::invalid_response("keys.fields"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let key = KeyDeclaration {
                    fields,
                    basis: if row.get("indisprimary") {
                        KeyBasis::DeclaredPrimary
                    } else {
                        KeyBasis::DeclaredUnique
                    },
                };
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
            let incarnation =
                world_protocol::schema::hash(relation.get::<_, String>("incarnation").as_bytes())
                    .map_err(|cause| {
                        SourceError::caused_by(
                            SourceFailure::InternalFault,
                            FailureStage::Read,
                            cause,
                        )
                    })?
                    .to_string();
            let namespace = format!(
                "{}.{}",
                relation.get::<_, String>("nspname"),
                relation.get::<_, String>("relname")
            );
            transaction.rollback().await.map_err(database)?;
            Ok(SchemaObservation {
                incarnation,
                namespace,
                fields,
                keys,
                complete: true,
            })
        };
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => result,
            _ = cancel.cancelled() => Err(super::super::cancelled()),
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
            "source.discovery_postgres_cleanup",
            cleanup,
        ));
    }
    result
}

fn value_type(kind: &str, modifier: i32, field: &str) -> Result<ValueType, SourceError> {
    Ok(match kind {
        "bool" => ValueType::Boolean,
        "int2" | "int4" | "int8" => ValueType::Integer,
        "text" | "name" => ValueType::Text {
            max_length: if kind == "name" { 63 } else { u32::MAX },
        },
        "uuid" => ValueType::Text { max_length: 36 },
        "varchar" | "bpchar" => ValueType::Text {
            max_length: if modifier >= 4 {
                (modifier - 4) as u32
            } else {
                u32::MAX
            },
        },
        "numeric" if modifier >= 4 => {
            let value = modifier - 4;
            let precision = ((value >> 16) & 0xffff) as u16;
            let scale = (((value & 0x7ff) ^ 1024) - 1024) as i16;
            if precision == 0 || precision > 128 || scale < 0 || scale as u16 > precision {
                return Err(unsupported(field));
            }
            ValueType::Decimal {
                precision,
                scale: scale as u16,
            }
        }
        "timestamptz" => ValueType::Timestamp {
            time_zone: "UTC".into(),
        },
        "date" => ValueType::Date {
            calendar: "gregorian".into(),
        },
        _ => return Err(unsupported(field)),
    })
}
fn unsupported(field: &str) -> SourceError {
    SourceError::new(
        SourceFailure::UnsupportedField {
            field: field.into(),
        },
        FailureStage::Decode,
    )
}
fn database(cause: tokio_postgres::Error) -> SourceError {
    SourceError::database(cause, FailureStage::Read)
}
