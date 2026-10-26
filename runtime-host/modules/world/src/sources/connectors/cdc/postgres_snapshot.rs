use super::super::{
    ReadSourcePage, SourceBroker, SourceCredential, SourceError, metadata::ReadMetadata, postgres,
    values,
};
use crate::{authorization::Admission, extensions::invocation::CallBudget};
use std::collections::BTreeSet;
use tokio::{sync::mpsc, time::Instant};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension, failure::FailureStage, ids::CheckpointFormatId, sources::*,
    time::Timestamp,
};

/// DECLARE/FETCH stays in one repeatable-read transaction on one owned connection.
pub(super) async fn run(
    broker: &SourceBroker,
    metadata: &ReadMetadata,
    plan: &SourceReadPlan,
    assignment: Option<&crate::sources::sync::Assignment>,
    admission: &Admission,
    credential: SourceCredential,
    budget: &CallBudget,
    output: &mpsc::Sender<Result<ReadSourcePage, SourceError>>,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<(), SourceError> {
    let SourceConnectionConfig::Postgres(config) = &metadata.connection.config else {
        return Err(values::invalid_response("connection"));
    };
    let resource = config
        .resources
        .iter()
        .find(|resource| resource.id == plan.resource)
        .ok_or_else(|| values::invalid_response("resource"))?;
    postgres::validate_resource(resource)?;
    let mut selected = plan
        .fields
        .iter()
        .map(|name| postgres::field(resource, name))
        .collect::<Result<Vec<_>, _>>()?;
    for id in &resource.key {
        let field = resource
            .fields
            .iter()
            .find(|field| &field.id == id)
            .ok_or_else(|| values::invalid_response("key"))?;
        if !selected.iter().any(|selected| selected.id == field.id) {
            selected.push(field);
        }
    }
    if selected.iter().any(|field| !field.readable) {
        return Err(SourceError::invalid(
            "fields",
            SourcePlanReason::FieldNotReadable,
        ));
    }
    let mut parameters = Vec::<Option<String>>::new();
    let mut nodes = 0;
    let filter = plan
        .predicate
        .as_ref()
        .map(|predicate| {
            postgres::predicate_sql(
                predicate,
                resource,
                metadata,
                &mut parameters,
                0,
                &mut nodes,
            )
        })
        .transpose()?;
    let mut order = plan
        .order
        .iter()
        .map(|order| Ok((postgres::field(resource, &order.field)?, order.descending)))
        .collect::<Result<Vec<_>, SourceError>>()?;
    for id in &resource.key {
        if !order.iter().any(|(field, _)| &field.id == id) {
            order.push((
                resource
                    .fields
                    .iter()
                    .find(|field| &field.id == id)
                    .ok_or_else(|| values::invalid_response("key"))?,
                false,
            ));
        }
    }
    let columns = selected
        .iter()
        .map(|field| postgres::column_expression(field))
        .collect::<Vec<_>>()
        .join(",");
    let ordering = order
        .iter()
        .map(|(field, desc)| {
            format!(
                "{} {} NULLS LAST",
                postgres::identifier(&field.column),
                if *desc { "DESC" } else { "ASC" }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "DECLARE matcha_source_snapshot NO SCROLL CURSOR FOR SELECT {columns} FROM {}.{}{} ORDER BY {ordering}",
        postgres::identifier(&config.schema),
        postgres::identifier(&resource.table),
        filter.map_or(String::new(), |filter| format!(" WHERE {filter}"))
    );
    let logical = if matches!(metadata.binding.body.sync, SyncPolicy::ChangeStream) {
        let logical = config
            .logical
            .as_ref()
            .ok_or_else(|| SourceError::invalid("logical", SourcePlanReason::InvalidValue))?;
        if logical.snapshot_slot == PostgresSnapshotSlot::Existing {
            return Err(SourceError::new(
                SourceFailure::HistoryUnavailable,
                FailureStage::Prepare,
            ));
        }
        Some(logical)
    } else {
        None
    };
    let connection = broker
        .native_access()?
        .connect_postgres(config, credential, cancel.clone(), deadline)
        .await?;
    let mut client = connection.client;
    let mut driver = connection.driver;
    let mut exporter = None;
    let mut native_fence = None;
    let result = {
        let work = async {
            if let Some(assignment) = assignment {
                let access = broker.native_access()?;
                let credential = access.credentials(&metadata.connection.world, &metadata.connection.id,
                    metadata.connection.revision, cancel.clone(), deadline).await?;
                native_fence = Some(super::postgres::NativeSourceFence::acquire(access, metadata,
                    &assignment.instance, credential, cancel.clone(), deadline).await?);
                broker.recheck_sync_assignment(admission, assignment).await?;
            }
            let exported = if let Some(logical) = logical {
                budget
                    .charge(BudgetDimension::SourceReads, 1)
                    .map_err(super::super::budget_error)?;
                let access = broker.native_access()?;
                let credential = access
                    .credentials(
                        &metadata.connection.world,
                        &metadata.connection.id,
                        metadata.connection.revision,
                        cancel.clone(),
                        deadline,
                    )
                    .await?;
                let replication = access
                    .connect_postgres_replication(
                        config,
                        credential,
                        format!(
                            "CREATE_REPLICATION_SLOT {} LOGICAL wal2json EXPORT_SNAPSHOT",
                            postgres::identifier(&logical.slot),
                        ),
                        cancel.clone(),
                        deadline,
                    )
                    .await?;
                exporter = Some(replication.driver);
                Some(exported_snapshot(replication.rows, logical)?)
            } else {
                None
            };
            let tx = client
                .build_transaction()
                .read_only(true)
                .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
                .start()
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            if let Some((snapshot, _)) = &exported {
                // Import before any query can acquire a different transaction snapshot.
                let snapshot = snapshot.replace('\\', "\\\\").replace('\'', "''");
                tx.batch_execute(&format!("SET TRANSACTION SNAPSHOT E'{snapshot}'"))
                    .await
                    .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            }
            let millis = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(i32::MAX as u128)
                .max(1)
                .to_string();
            tx.query_one("SELECT set_config('statement_timeout',$1,true),set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true)",&[&millis]).await.map_err(|error|SourceError::database(error,FailureStage::Read))?;
            let basis=tx.query_one("SELECT pg_current_snapshot()::text AS snapshot,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS observed",&[]).await.map_err(|error|SourceError::database(error,FailureStage::Read))?;
            let observed = Timestamp::try_new(basis.get::<_, String>("observed"))
                .map_err(|_| values::invalid_response("observedAt"))?;
            // pg_current_snapshot alone is not a globally unique material token.
            let token = format!(
                "{}:{}",
                uuid::Uuid::new_v4(),
                basis.get::<_, String>("snapshot")
            );
            let parameters: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = parameters
                .iter()
                .map(|value| value as &(dyn tokio_postgres::types::ToSql + Sync))
                .collect();
            tx.execute(&sql, &parameters)
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Read))?;
            let b = &metadata.binding.body;
            let basis = SourceBasis {
                source_id: b.source_id.clone(),
                incarnation: b.incarnation.clone(),
                binding: metadata.binding.reference.clone(),
                mapping_revision: b.mapping.revision,
                authority_revision: b.authority.revision,
                schema: b.schema.clone(),
                identity_rule: b.identity_rule.clone(),
                field_definitions: b.field_mapping.iter().map(|f| f.property.clone()).collect(),
                position: exported
                    .as_ref()
                    .map(|(_, cursor)| {
                        Ok::<_, SourceError>(SourcePosition {
                            source_id: b.source_id.clone(),
                            incarnation: b.incarnation.clone(),
                            partition: b.resource.clone(),
                            format: CheckpointFormatId::try_new("postgres.wal2json.v2")
                                .map_err(|_| values::invalid_response("checkpointFormat"))?,
                            cursor: cursor.clone(),
                            transaction: None,
                            event_index: None,
                        })
                    })
                    .transpose()?,
                snapshot: Some(token.clone()),
                observed_at: observed,
                captured_at: None,
                last_reconciled_at: None,
                guarantee: SourceGuarantee::Authoritative,
                gap: None,
            };
            let mut keys = BTreeSet::new();
            let mut chunk = 0u64;
            loop {
                budget
                    .charge(BudgetDimension::SourceReads, 1)
                    .map_err(super::super::budget_error)?;
                let native = tx
                    .query(
                        &format!("FETCH FORWARD {} FROM matcha_source_snapshot", plan.limit),
                        &[],
                    )
                    .await
                    .map_err(|error| SourceError::database(error, FailureStage::Read))?;
                let complete = native.len() < plan.limit as usize;
                let mut rows = Vec::with_capacity(native.len());
                let mut size = 0usize;
                for row in native {
                    let key = resource
                        .key
                        .iter()
                        .map(|id| {
                            let index = selected
                                .iter()
                                .position(|field| &field.id == id)
                                .ok_or_else(|| values::invalid_response("key"))?;
                            let field = selected[index];
                            let raw = row.try_get::<_, Option<String>>(index).map_err(|error| {
                                SourceError::database(error, FailureStage::Decode)
                            })?;
                            Ok::<_, SourceError>(values::from_text(
                                raw.as_deref(),
                                &field.value_type,
                                field.nullable,
                            ))
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let native_key = values::native_key(&key)?;
                    if !keys.insert(native_key.clone()) {
                        return Err(values::invalid_response("duplicateKey"));
                    }
                    let mut fields = Vec::with_capacity(selected.len());
                    for (index, field) in selected.iter().enumerate() {
                        let raw = row
                            .try_get::<_, Option<String>>(index)
                            .map_err(|error| SourceError::database(error, FailureStage::Decode))?;
                        size = size.saturating_add(raw.as_ref().map_or(0, String::len));
                        if size > 8 * 1024 * 1024 {
                            return Err(SourceError::new(
                                SourceFailure::ResponseLimit,
                                FailureStage::Read,
                            ));
                        }
                        let name = metadata
                            .schema
                            .fields
                            .iter()
                            .find(|entry| entry.id == field.id)
                            .ok_or_else(|| values::invalid_response("schemaField"))?
                            .name
                            .clone();
                        fields.push(SourceField {
                            id: field.id.clone(),
                            name,
                            value: values::from_text(
                                raw.as_deref(),
                                &field.value_type,
                                field.nullable,
                            ),
                            raw_lexeme: raw,
                            formula: None,
                            locator: None,
                        });
                    }
                    rows.push(SourceRow {
                        native_key,
                        incarnation: b.incarnation.clone(),
                        fields,
                    });
                }
                let page = SourcePage {
                    rows,
                    basis: basis.clone(),
                    continuation: (!complete).then(|| format!("{token}:{chunk}")),
                    complete,
                };
                super::snapshot::deliver(
                    broker, metadata, admission, budget, output, page, &cancel,
                )
                .await?;
                if complete {
                    break;
                }
                chunk = chunk
                    .checked_add(1)
                    .ok_or_else(|| values::invalid_response("page"))?;
            }
            tx.batch_execute("CLOSE matcha_source_snapshot")
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Drain))?;
            tx.rollback()
                .await
                .map_err(|error| SourceError::database(error, FailureStage::Drain))?;
            Ok(())
        };
        tokio::pin!(work);
        tokio::select! {result=&mut work=>result,_=cancel.cancelled()=>Err(super::super::cancelled()),_=tokio::time::sleep_until(deadline)=>Err(SourceError::new(SourceFailure::ReadTimeout,FailureStage::Read))}
    };
    drop(client);
    let cleanup = driver
        .cancel_and_join()
        .await
        .map_err(|error| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Drain, error)
        })
        .and_then(|result| {
            result.map_err(|error| SourceError::database(error, FailureStage::Drain))
        });
    let mut result = match cleanup {
        Ok(()) => result,
        Err(cleanup) => Err(SourceError::cleanup(
            result.err(),
            "source.postgres_snapshot_driver_cleanup",
            cleanup,
        )),
    };
    // The exporter must outlive the imported scan and the SQL connection's checked join.
    if let Some(mut exporter) = exporter {
        let cleanup = exporter
            .cancel_and_join()
            .await
            .map_err(|error| {
                SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Drain, error)
            })
            .and_then(|result| result);
        if let Err(cleanup) = cleanup {
            result = Err(SourceError::cleanup(
                result.err(),
                "source.postgres_snapshot_exporter_cleanup",
                cleanup,
            ));
        }
    }
    if let Some(fence) = native_fence {
        if let Err(cleanup) = fence.close().await {
            result = Err(SourceError::cleanup(result.err(), "source.postgres_snapshot_fence_cleanup", cleanup));
        }
    }
    result
}

fn exported_snapshot(
    rows: Vec<Vec<Option<String>>>,
    logical: &PostgresLogicalConfig,
) -> Result<(String, String), SourceError> {
    let [row] = rows.as_slice() else {
        return Err(values::invalid_response("exportedSnapshot"));
    };
    let [Some(slot), Some(cursor), Some(snapshot), Some(plugin)] = row.as_slice() else {
        return Err(values::invalid_response("exportedSnapshot"));
    };
    if slot != &logical.slot
        || plugin != "wal2json"
        || snapshot.is_empty()
        || snapshot.len() > 1024
        || snapshot.contains('\0')
    {
        return Err(values::invalid_response("exportedSnapshot"));
    }
    super::postgres::parse_lsn(cursor)?;
    Ok((snapshot.clone(), cursor.clone()))
}
