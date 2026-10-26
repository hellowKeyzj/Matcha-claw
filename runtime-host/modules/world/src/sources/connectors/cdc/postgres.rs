use super::super::{SourceAccess, SourceCredential, SourceError, metadata::ReadMetadata, values};
use std::{collections::BTreeSet, sync::Arc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{failure::FailureStage, ids::*, sources::*, time::Timestamp};

const MAX_CHANGES: i32 = 65_536;
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Native exclusion only: this fences old I/O; it does not claim a historical task joined.
pub(in crate::sources) struct NativeSourceFence {
    connection: super::super::PgSourceConnection,
    slot: Option<String>,
    binding: DefinitionRef,
    instance: InvocationLeaseId,
    inspected: Option<Option<SourcePosition>>,
}
impl NativeSourceFence {
    pub(super) async fn acquire(
        access: &Arc<dyn SourceAccess>, metadata: &ReadMetadata, instance: &InvocationLeaseId,
        credential: SourceCredential, cancel: CancellationToken, deadline: Instant,
    ) -> Result<Self, SourceError> {
        let SourceConnectionConfig::Postgres(config) = &metadata.connection.config else { return Err(super::missing()); };
        let connection = access.connect_postgres(config, credential, cancel.clone(), deadline).await?;
        let slot = if matches!(metadata.binding.body.sync, SyncPolicy::ChangeStream) {
            Some(config.logical.as_ref().ok_or_else(super::missing)?.slot.clone())
        } else { None };
        let digest = crate::definitions::canonical_digest(&(
            "world.source.postgres.fence.v1", &config.database,
            slot.as_deref().unwrap_or(&metadata.binding.body.resource),
        )).map_err(|_| values::invalid_response("sourceFence"))?;
        let fence = Self { connection, slot, binding: metadata.binding.reference.clone(),
            instance: instance.clone(), inspected: None };
        let key = u64::from_str_radix(&digest.as_str()[7..23], 16)
            .map_err(|_| values::invalid_response("sourceFence"))? as i64;
        let application = format!("matcha-source-{}", instance.as_str());
        let millis = deadline.saturating_duration_since(Instant::now()).as_millis().min(i32::MAX as u128).max(1).to_string();
        let work = async {
            fence.connection.client.query_one("SELECT set_config('application_name',$1,false),set_config('statement_timeout',$2,false)", &[&application, &millis]).await.map_err(|error| SourceError::database(error, FailureStage::Prepare))?;
            fence.connection.client.query_one("SELECT pg_advisory_lock($1)", &[&key]).await.map_err(|error| SourceError::database(error, FailureStage::Prepare))?;
            Ok(())
        };
        let result = tokio::select! {
            result = work => result,
            _ = cancel.cancelled() => Err(super::super::cancelled()),
            _ = tokio::time::sleep_until(deadline) => Err(SourceError::new(SourceFailure::ReadTimeout, FailureStage::Prepare)),
        };
        if let Err(error) = result {
            return match fence.close().await { Ok(()) => Err(error), Err(cleanup) => Err(SourceError::cleanup(Some(error), "source.postgres_fence_cleanup", cleanup)) };
        }
        Ok(fence)
    }
    pub(in crate::sources) async fn inspect(
        &mut self, applied: Option<&SourcePosition>,
    ) -> Result<(), SourceError> {
        let Some(slot) = &self.slot else { self.inspected = Some(applied.cloned()); return Ok(()); };
        let row = self.connection.client.query_opt("SELECT plugin,active,active_pid,confirmed_flush_lsn::text AS cursor FROM pg_replication_slots WHERE slot_name=$1 AND database=current_database()", &[&slot]).await.map_err(|error| SourceError::database(error, FailureStage::Recover))?;
        let Some(row) = row else {
            if applied.is_some() { return Err(super::missing()); }
            self.inspected = Some(None);
            return Ok(());
        };
        if row.get::<_, String>("plugin") != "wal2json" || row.get::<_, bool>("active") || row.get::<_, Option<i32>>("active_pid").is_some() {
            return Err(SourceError::new(SourceFailure::ReaderNotStopped, FailureStage::Recover));
        }
        let confirmed: String = row.get("cursor");
        let applied = applied.ok_or_else(|| SourceError::new(SourceFailure::PositionIncomparable, FailureStage::Recover))?;
        if parse_lsn(&confirmed)? > parse_lsn(&applied.cursor)? {
            return Err(SourceError::new(SourceFailure::PositionExpired, FailureStage::Recover));
        }
        self.inspected = Some(Some(applied.clone()));
        Ok(())
    }
    pub(in crate::sources) fn permits(
        &self, assignment: &crate::sources::sync::Assignment, applied: Option<&SourcePosition>,
    ) -> bool {
        !self.connection.driver.is_finished()
            && self.binding == assignment.binding && self.instance == assignment.instance
            && self.inspected.as_ref().is_some_and(|actual| actual.as_ref() == applied)
    }
    pub(in crate::sources) async fn close(mut self) -> Result<(), SourceError> {
        drop(self.connection.client);
        self.connection.driver.cancel_and_join().await
            .map_err(|error| SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Drain, error))?
            .map_err(|error| SourceError::database(error, FailureStage::Drain))
    }
}

pub(super) async fn read(
    broker: &super::super::SourceBroker,
    admission: &crate::authorization::Admission,
    access: &Arc<dyn SourceAccess>,
    metadata: &ReadMetadata,
    plan: &SourceReadPlan,
    a: &crate::sources::sync::Assignment,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<(OrderedSourceBatch, Vec<u8>, Timestamp), SourceError> {
    let SourceConnectionConfig::Postgres(config) = &metadata.connection.config else {
        return Err(super::missing());
    };
    let logical = config.logical.as_ref().ok_or_else(super::missing)?;
    let resource = config
        .resources
        .iter()
        .find(|r| r.id == plan.resource)
        .ok_or_else(|| values::invalid_response("resource"))?;
    let fence = NativeSourceFence::acquire(access, metadata, &a.instance, credential, cancel.clone(), deadline).await?;
    let client = &fence.connection.client;
    let result = {
        let work = async {
            broker.recheck_sync_assignment(admission, a).await?;
            let slot = client.query_opt("SELECT plugin,confirmed_flush_lsn::text AS cursor,active FROM pg_replication_slots WHERE slot_name=$1 AND database=current_database()", &[&logical.slot]).await.map_err(|e| SourceError::database(e, FailureStage::Read))?.ok_or_else(super::missing)?;
            if slot.get::<_, String>("plugin") != "wal2json" || slot.get::<_, bool>("active") {
                return Err(super::missing());
            }
            let confirmed: String = slot.get("cursor");
            // numeric-data-types-as-string is required: JSON floats may never silently round a decimal.
            let result = client.query("SELECT lsn::text AS lsn,xid::text AS xid,data FROM pg_logical_slot_peek_changes($1,NULL,$2,'format-version','2','include-lsn','true','include-xids','true','include-timestamp','true','include-transaction','true','numeric-data-types-as-string','true')", &[&logical.slot, &MAX_CHANGES]).await.map_err(|e| SourceError::database(e, FailureStage::Read))?;
            let mut raw = Vec::new();
            let mut events = Vec::<SourceEvent>::new();
            let mut transaction = None;
            let mut completed = true;
            let mut cursor = confirmed;
            let mut observed = Timestamp::try_new(chrono::Utc::now().to_rfc3339())
                .map_err(|_| values::invalid_response("observedAt"))?;
            let after = plan.continuation.as_deref().map(parse_lsn).transpose()?;
            if after
                .is_some_and(|after| parse_lsn(&cursor).is_ok_and(|confirmed| confirmed > after))
            {
                return Err(SourceError::new(
                    SourceFailure::PositionExpired,
                    FailureStage::Read,
                ));
            }
            let mut transaction_index = 0u64;
            let mut transaction_start = 0usize;
            let mut transaction_raw_start = 0usize;
            let mut last_complete = 0usize;
            let mut last_raw = 0usize;
            for row in result {
                let data: String = row.get("data");
                if raw.len().saturating_add(data.len()).saturating_add(1) > MAX_BYTES {
                    return Err(SourceError::new(
                        SourceFailure::ResponseLimit,
                        FailureStage::Read,
                    ));
                }
                raw.extend_from_slice(data.as_bytes());
                raw.push(b'\n');
                let value: serde_json::Value =
                    world_protocol::wire::decode(data.as_bytes(), MAX_BYTES)
                        .map_err(|_| values::invalid_response("wal2json"))?;
                let action = value
                    .get("action")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| values::invalid_response("wal2json.action"))?;
                let xid: String = row.get("xid");
                let lsn: String = row.get("lsn");
                let event_index = transaction_index;
                transaction_index = transaction_index
                    .checked_add(1)
                    .ok_or_else(|| values::invalid_response("eventIndex"))?;
                let mut position = SourcePosition {
                    source_id: a.source_id.clone(),
                    incarnation: a.incarnation.clone(),
                    partition: a.partition.clone(),
                    format: a.format.clone(),
                    cursor: lsn,
                    transaction: Some(xid.clone()),
                    event_index: Some(event_index),
                };
                let change = match action {
                    "B" => {
                        if transaction.is_some() {
                            return Err(values::invalid_response("wal2json.transaction"));
                        }
                        transaction = Some(xid);
                        transaction_index = 0;
                        transaction_start = events.len();
                        transaction_raw_start = raw.len().saturating_sub(data.len() + 1);
                        completed = false;
                        continue;
                    }
                    "C" => {
                        if transaction.as_ref() != Some(&xid) {
                            return Err(values::invalid_response("wal2json.transaction"));
                        }
                        position.cursor = value
                            .get("nextlsn")
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| values::invalid_response("wal2json.nextlsn"))?
                            .into();
                        parse_lsn(&position.cursor)?;
                        cursor = position.cursor.clone();
                        transaction = None;
                        completed = true;
                        if let Some(text) = value.get("timestamp").and_then(|v| v.as_str()) {
                            observed = Timestamp::try_new(text)
                                .map_err(|_| values::invalid_response("wal2json.timestamp"))?;
                        }
                        if after.is_some_and(|after| {
                            parse_lsn(&cursor).is_ok_and(|cursor| cursor <= after)
                        }) {
                            events.truncate(transaction_start);
                            raw.truncate(transaction_raw_start);
                            last_complete = events.len();
                            last_raw = raw.len();
                            continue;
                        }
                        for event in &mut events[transaction_start..] {
                            event.occurred_at = Some(observed.clone());
                        }
                        SourceChange::TransactionEnd { transaction: xid }
                    }
                    "I" | "U" | "D" => {
                        if transaction.as_ref() != Some(&xid) {
                            return Err(values::invalid_response("wal2json.transaction"));
                        }
                        let schema = value
                            .get("schema")
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| values::invalid_response("wal2json.schema"))?;
                        let table = value
                            .get("table")
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| values::invalid_response("wal2json.table"))?;
                        if schema != config.schema || table != resource.table {
                            continue;
                        }
                        let columns = value
                            .get(if action == "D" { "identity" } else { "columns" })
                            .and_then(|v| v.as_array())
                            .ok_or_else(|| values::invalid_response("wal2json.columns"))?;
                        let mut names = BTreeSet::new();
                        for c in columns {
                            if !names.insert(
                                c.get("name")
                                    .and_then(|v| v.as_str())
                                    .ok_or_else(|| values::invalid_response("wal2json.column"))?,
                            ) {
                                return Err(values::invalid_response("wal2json.duplicateColumn"));
                            }
                        }
                        let key = key(resource, columns)?;
                        if action == "D" {
                            SourceChange::Delete {
                                native_key: key,
                                incarnation: a.incarnation.clone(),
                            }
                        } else {
                            let fields = plan
                                .fields
                                .iter()
                                .map(|id| {
                                    let f = resource
                                        .fields
                                        .iter()
                                        .find(|f| f.id.as_str() == id)
                                        .ok_or_else(|| values::invalid_response("field"))?;
                                    let column = columns.iter().find(|c| {
                                        c.get("name").and_then(|v| v.as_str())
                                            == Some(f.column.as_str())
                                    });
                                    let value = column.and_then(|c| c.get("value"));
                                    let name = metadata
                                        .schema
                                        .fields
                                        .iter()
                                        .find(|s| s.id == f.id)
                                        .ok_or_else(|| values::invalid_response("schemaField"))?
                                        .name
                                        .clone();
                                    Ok(SourceField {
                                        id: f.id.clone(),
                                        name,
                                        value: values::from_json(value, &f.value_type, f.nullable),
                                        raw_lexeme: value.map(|v| {
                                            v.as_str()
                                                .map(str::to_owned)
                                                .unwrap_or_else(|| v.to_string())
                                        }),
                                        formula: None,
                                        locator: None,
                                    })
                                })
                                .collect::<Result<Vec<_>, SourceError>>()?;
                            SourceChange::Upsert {
                                row: SourceRow {
                                    native_key: key,
                                    incarnation: a.incarnation.clone(),
                                    fields,
                                },
                            }
                        }
                    }
                    "T" => {
                        return Err(SourceError::new(
                            SourceFailure::Gap {
                                reason: GapReason::SchemaDrift,
                            },
                            FailureStage::Read,
                        ));
                    }
                    _ => return Err(values::invalid_response("wal2json.action")),
                };
                let digest = crate::definitions::canonical_digest(&(
                    "world.postgres.change.v1",
                    &a.source_id,
                    &a.incarnation,
                    &a.partition,
                    &position,
                ))
                .map_err(|_| values::invalid_response("eventId"))?;
                events.push(SourceEvent {
                    event_id: EventId::try_new(digest.as_str().replace(':', "-"))
                        .map_err(|_| values::invalid_response("eventId"))?,
                    position,
                    occurred_at: completed.then(|| observed.clone()),
                    change,
                });
                if completed {
                    last_complete = events.len();
                    last_raw = raw.len();
                }
            }
            if !completed {
                events.truncate(last_complete);
                raw.truncate(last_raw);
                if events.is_empty() {
                    return Err(SourceError::new(
                        SourceFailure::IncompleteTransaction,
                        FailureStage::Read,
                    ));
                }
            }
            let captured = events
                .last()
                .map(|e| e.position.clone())
                .unwrap_or(SourcePosition {
                    source_id: a.source_id.clone(),
                    incarnation: a.incarnation.clone(),
                    partition: a.partition.clone(),
                    format: a.format.clone(),
                    cursor,
                    transaction: None,
                    event_index: None,
                });
            Ok((
                OrderedSourceBatch {
                    binding: a.binding.clone(),
                    epoch: a.epoch,
                    events,
                    transaction_complete: true,
                    captured,
                },
                raw,
                observed,
            ))
        };
        tokio::pin!(work);
        tokio::select! {r=&mut work=>r,_=cancel.cancelled()=>Err(super::super::cancelled()),_=tokio::time::sleep_until(deadline)=>Err(SourceError::new(SourceFailure::ReadTimeout,FailureStage::Read))}
    };
    let cleanup = fence.close().await;
    if let Err(cleanup) = cleanup {
        return Err(SourceError::cleanup(
            result.err(),
            "source.cdc_postgres_reader_cleanup",
            cleanup,
        ));
    }
    result
}

pub(super) async fn ack(
    broker: &super::super::SourceBroker,
    admission: &crate::authorization::Admission,
    access: &Arc<dyn SourceAccess>,
    metadata: &ReadMetadata,
    a: &crate::sources::sync::Assignment,
    position: &SourcePosition,
    credential: SourceCredential,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<(), SourceError> {
    let SourceConnectionConfig::Postgres(config) = &metadata.connection.config else {
        return Err(super::missing());
    };
    let logical = config.logical.as_ref().ok_or_else(super::missing)?;
    parse_lsn(&position.cursor)?;
    let fence = NativeSourceFence::acquire(access, metadata, &a.instance, credential, cancel.clone(), deadline).await?;
    let client = &fence.connection.client;
    let result = {
        let work = async {
            broker.recheck_sync_assignment(admission, a).await?;
            let slot=client.query_opt("SELECT plugin,confirmed_flush_lsn::text AS cursor,active FROM pg_replication_slots WHERE slot_name=$1 AND database=current_database()",&[&logical.slot]).await.map_err(|e|SourceError::database(e,FailureStage::Read))?.ok_or_else(super::missing)?;
            if slot.get::<_, String>("plugin") != "wal2json" || slot.get::<_, bool>("active") {
                return Err(super::missing());
            }
            if parse_lsn(&slot.get::<_, String>("cursor"))? > parse_lsn(&position.cursor)? {
                return Err(SourceError::new(
                    SourceFailure::PositionExpired,
                    FailureStage::Execute,
                ));
            }
            let row=client.query_one("SELECT end_lsn::text AS cursor FROM pg_replication_slot_advance($1,$2::text::pg_lsn)",&[&logical.slot,&position.cursor]).await.map_err(|e|SourceError::database(e,FailureStage::Execute))?;
            if parse_lsn(&row.get::<_, String>("cursor"))? != parse_lsn(&position.cursor)? {
                return Err(SourceError::new(
                    SourceFailure::PositionIncomparable,
                    FailureStage::Execute,
                ));
            }
            Ok(())
        };
        tokio::select! {r=work=>r,_=cancel.cancelled()=>Err(super::super::cancelled()),_=tokio::time::sleep_until(deadline)=>Err(SourceError::new(SourceFailure::ReadTimeout,FailureStage::Execute))}
    };
    let cleanup = fence.close().await;
    if let Err(cleanup) = cleanup {
        return Err(SourceError::cleanup(
            result.err(),
            "source.cdc_postgres_ack_cleanup",
            cleanup,
        ));
    }
    result
}
pub(super) fn parse_lsn(value: &str) -> Result<u64, SourceError> {
    let (a, b) = value
        .split_once('/')
        .ok_or_else(|| values::invalid_response("lsn"))?;
    let hi = u32::from_str_radix(a, 16).map_err(|_| values::invalid_response("lsn"))?;
    let lo = u32::from_str_radix(b, 16).map_err(|_| values::invalid_response("lsn"))?;
    Ok((u64::from(hi) << 32) | u64::from(lo))
}
fn key(resource: &PostgresResource, columns: &[serde_json::Value]) -> Result<String, SourceError> {
    let mut key = Vec::new();
    for id in &resource.key {
        let field = resource
            .fields
            .iter()
            .find(|f| &f.id == id)
            .ok_or_else(|| values::invalid_response("key"))?;
        let value = columns
            .iter()
            .find(|c| c.get("name").and_then(|v| v.as_str()) == Some(field.column.as_str()))
            .and_then(|c| c.get("value"))
            .filter(|v| !v.is_null())
            .ok_or_else(|| values::invalid_response("replicaIdentity"))?;
        key.push(values::from_json(
            Some(value),
            &field.value_type,
            field.nullable,
        ));
    }
    values::native_key(&key)
}
