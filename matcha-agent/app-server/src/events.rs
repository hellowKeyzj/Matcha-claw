use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, Row, ToSql, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, watch};

use crate::{persistence::Database, rpc};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub session_id: String,
    pub seq: u64,
    pub run_id: Option<String>,
    pub kind: String,
    pub at_ms: u64,
    pub payload: Value,
}

pub struct NativeResult {
    pub event: Event,
    pub instance_id: Option<String>,
    pub started_seq: Option<u64>,
}

#[derive(Clone)]
pub struct NativeResultCursor {
    pub at_ms: u64,
    pub session_id: String,
    pub seq: u64,
}

#[derive(Clone)]
pub struct Events {
    database: Database,
    watchers: Arc<Watchers>,
}

struct Watchers {
    senders: Mutex<HashMap<String, watch::Sender<u64>>>,
    // Cleanup tasks do not retain this sender or the registry; Events drop closes live watches too.
    closed: watch::Sender<()>,
}

impl Events {
    pub async fn open(database: Database) -> rpc::Result<Self> {
        database
            .call(|connection| {
                connection
                    .execute_batch(
                        "CREATE TABLE IF NOT EXISTS session_event_heads (
                            session_id TEXT PRIMARY KEY NOT NULL,
                            seq INTEGER NOT NULL CHECK (seq >= 0)
                        ) WITHOUT ROWID;
                        CREATE TABLE IF NOT EXISTS session_events (
                            session_id TEXT NOT NULL,
                            seq INTEGER NOT NULL CHECK (seq > 0),
                            run_id TEXT,
                            kind TEXT NOT NULL CHECK (length(kind) > 0),
                            at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
                            payload TEXT NOT NULL,
                            PRIMARY KEY (session_id, seq)
                        ) WITHOUT ROWID;
                        CREATE INDEX IF NOT EXISTS session_events_by_kind
                            ON session_events (session_id, kind, seq);
                        CREATE INDEX IF NOT EXISTS session_events_by_kind_time
                            ON session_events (kind, at_ms DESC, session_id DESC, seq DESC);
                        CREATE INDEX IF NOT EXISTS session_events_by_session_kind_time
                            ON session_events (session_id, kind, at_ms DESC, seq DESC);
                        CREATE INDEX IF NOT EXISTS session_native_results_by_uuid
                            ON session_events (session_id, json_extract(payload,'$.uuid'), seq)
                            WHERE kind='native.result';",
                    )
                    .map_err(|source| storage_error("events_schema_failed", source))
            })
            .await?;
        Ok(Self {
            database,
            watchers: Arc::new(Watchers {
                senders: Mutex::new(HashMap::new()),
                closed: watch::channel(()).0,
            }),
        })
    }

    pub async fn append(
        &self,
        session_id: &str,
        run_id: Option<&str>,
        kind: &str,
        payload: Value,
    ) -> rpc::Result<Event> {
        let mut events = self
            .append_batch(session_id, run_id, vec![(kind.to_owned(), payload)])
            .await?;
        Ok(events.remove(0))
    }

    /// A batch is one transaction. The caller chooses batching; no token queue is retained here.
    pub async fn append_batch(
        &self,
        session_id: &str,
        run_id: Option<&str>,
        items: Vec<(String, Value)>,
    ) -> rpc::Result<Vec<Event>> {
        validate_session(session_id)?;
        if run_id.is_some_and(str::is_empty) || items.iter().any(|(kind, _)| kind.is_empty()) {
            return Err(rpc::Error::invalid(
                "Event runId and kind must not be empty",
            ));
        }
        if items.is_empty() {
            self.latest(session_id).await?;
            return Ok(Vec::new());
        }
        let count = i64::try_from(items.len()).map_err(|source| {
            rpc::Error::invalid("Event batch exceeds SQLite sequence range").with_source(source)
        })?;
        let session_id = session_id.to_owned();
        let run_id = run_id.map(str::to_owned);
        let watchers = self.watchers.clone();
        self.database
            .call(move |connection| {
                // Serialize each moved payload once, off the async I/O threads and before locking SQLite.
                let at_ms = timestamp()?;
                let mut encoded = Vec::with_capacity(items.len());
                for (kind, payload) in items {
                    let text = serde_json::to_string(&payload).map_err(|source| {
                        rpc::Error::internal("events_payload_encode").with_source(source)
                    })?;
                    encoded.push((
                        Event {
                            session_id: session_id.clone(),
                            seq: 0,
                            run_id: run_id.clone(),
                            kind,
                            at_ms,
                            payload,
                        },
                        text,
                    ));
                }
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|source| storage_error("events_begin_failed", source))?;
                let result = (|| {
                    let previous = durable_latest(&transaction, &session_id)?;
                    let latest = previous
                        .checked_add(count as u64)
                        .filter(|seq| *seq <= i64::MAX as u64)
                        .ok_or_else(|| {
                            rpc::Error::new(
                                -32005,
                                "events_seq_exhausted",
                                "Session event sequence is exhausted",
                            )
                        })?;
                    transaction
                        .execute(
                            "INSERT INTO session_event_heads (session_id, seq) VALUES (?1, ?2)
                         ON CONFLICT (session_id) DO UPDATE SET seq = excluded.seq",
                            params![session_id, latest],
                        )
                        .map_err(|source| storage_error("events_seq_allocate_failed", source))?;
                    let mut statement = transaction.prepare_cached(
                        "INSERT INTO session_events (session_id, seq, run_id, kind, at_ms, payload)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    ).map_err(|source| storage_error("events_insert_prepare_failed", source))?;
                    let mut events = Vec::with_capacity(encoded.len());
                    for (offset, (mut event, text)) in encoded.into_iter().enumerate() {
                        event.seq = previous + offset as u64 + 1;
                        statement
                            .execute(params![
                                event.session_id,
                                event.seq,
                                event.run_id,
                                event.kind,
                                event.at_ms,
                                text,
                            ])
                            .map_err(|source| storage_error("events_insert_failed", source))?;
                        events.push(event);
                    }
                    Ok((events, latest))
                })();
                let (events, latest) = match result {
                    Ok(events) => events,
                    Err(error) => return Err(rollback(&transaction, error)),
                };
                // Keep the transaction available for an explicit, fallible rollback on commit failure.
                if let Err(source) = transaction.execute_batch("COMMIT") {
                    let error = if transaction.is_autocommit() {
                        rpc::Error::new(
                            -32006,
                            "events_commit_unknown",
                            "Event commit could not be confirmed; replay before retrying",
                        )
                        .with_source(source)
                    } else {
                        storage_error("events_commit_failed", source)
                    };
                    return Err(rollback(&transaction, error));
                }
                // No await separates commit and notification: cancelling append cannot swallow this wakeup.
                let sender = watchers.senders.blocking_lock().get(&session_id).cloned();
                if let Some(sender) = sender {
                    sender.send_if_modified(|seq| {
                        if latest <= *seq {
                            return false;
                        }
                        *seq = latest;
                        true
                    });
                }
                Ok(events)
            })
            .await
    }

    /// Exclusive cursor, ascending sequence, at most exactly the requested limit; zero reads no payloads.
    /// No retention is performed. A cursor ahead of storage or a missing sequence is an error.
    pub async fn replay(
        &self,
        session_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> rpc::Result<Vec<Event>> {
        validate_session(session_id)?;
        let sql_limit = replay_limit(limit)?;
        let session_id = session_id.to_owned();
        self.database
            .call(move |connection| {
                let latest = durable_latest(connection, &session_id)?;
                validate_cursor(after_seq, latest)?;
                if limit == 0 || after_seq == latest {
                    return Ok(Vec::new());
                }
                // Append-only storage lets this query read the immutable prefix observed above.
                let mut statement = connection
                    .prepare_cached(
                        "SELECT seq, run_id, kind, at_ms, payload FROM session_events
                 WHERE session_id = ?1 AND seq > ?2 AND seq <= ?3 ORDER BY seq LIMIT ?4",
                    )
                    .map_err(|source| storage_error("events_replay_prepare_failed", source))?;
                let events = read_page(
                    &mut statement,
                    &[&session_id, &after_seq, &latest, &sql_limit],
                    &session_id,
                )?;
                let mut cursor = after_seq;
                for event in &events {
                    if event.seq != cursor + 1 {
                        return Err(sequence_gap(cursor + 1, Some(event.seq), latest));
                    }
                    cursor = event.seq;
                }
                if events.len() < limit && cursor < latest {
                    return Err(sequence_gap(cursor + 1, None, latest));
                }
                Ok(events)
            })
            .await
    }

    /// Filter in SQLite before decoding payloads, within the fixed (after_seq, through_seq] window.
    /// Unlike replay, gaps between matching kinds are expected; limit zero and empty kinds read no payloads.
    pub async fn query_kinds(
        &self,
        session_id: &str,
        after_seq: u64,
        through_seq: u64,
        kinds: &[&str],
        limit: usize,
    ) -> rpc::Result<Vec<Event>> {
        validate_session(session_id)?;
        if after_seq > through_seq || kinds.iter().any(|kind| kind.is_empty()) {
            return Err(rpc::Error::invalid(
                "Event range is reversed or kind is empty",
            ));
        }
        let sql_limit = replay_limit(limit)?;
        let session_id = session_id.to_owned();
        let kinds: Vec<String> = kinds.iter().map(|kind| (*kind).to_owned()).collect();
        self.database
            .call(move |connection| {
                let latest = durable_latest(connection, &session_id)?;
                validate_cursor(through_seq, latest)?;
                if limit == 0 || after_seq == through_seq || kinds.is_empty() {
                    return Ok(Vec::new());
                }
                let placeholders = (0..kinds.len())
                    .map(|index| format!("?{}", index + 5))
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT seq, run_id, kind, at_ms, payload FROM session_events
                 INDEXED BY session_events_by_kind
                 WHERE session_id = ?1 AND seq > ?2 AND seq <= ?3 AND kind IN ({placeholders})
                 ORDER BY seq LIMIT ?4",
                );
                let mut statement = connection
                    .prepare(&sql)
                    .map_err(|source| storage_error("events_kind_query_prepare_failed", source))?;
                let mut parameters: Vec<&dyn ToSql> =
                    vec![&session_id, &after_seq, &through_seq, &sql_limit];
                parameters.extend(kinds.iter().map(|kind| kind as &dyn ToSql));
                read_page(&mut statement, &parameters, &session_id)
            })
            .await
    }

    pub async fn query_native_results(
        &self,
        session_id: Option<&str>,
        before: Option<&NativeResultCursor>,
        limit: usize,
    ) -> rpc::Result<Vec<NativeResult>> {
        if let Some(session_id) = session_id {
            validate_session(session_id)?;
        }
        validate_native_cursor(before)?;
        let limit = replay_limit(limit)?;
        let session_id = session_id.map(str::to_owned);
        let before = before.cloned();
        self.database.call(move |connection| {
            if let Some(session_id) = &session_id {
                crate::session::assert_live_session(connection, session_id)?;
            }
            let (index, session_filter) = native_query_scope(session_id.is_some());
            let sql = format!(
                "SELECT e.seq,e.run_id,e.kind,e.at_ms,
                    json_object(
                        'session_id',json_extract(e.payload,'$.session_id'),
                        'uuid',json_extract(e.payload,'$.uuid'),
                        'subtype',json_extract(e.payload,'$.subtype'),
                        'is_error',json(e.payload -> '$.is_error'),
                        'usage',json_extract(e.payload,'$.usage'),
                        'total_cost_usd',json_extract(e.payload,'$.total_cost_usd'),
                        'modelUsage',json_extract(e.payload,'$.modelUsage'),
                        'duration_ms',json_extract(e.payload,'$.duration_ms'),
                        'duration_api_ms',json_extract(e.payload,'$.duration_api_ms'),
                        'num_turns',json_extract(e.payload,'$.num_turns')),
                    e.session_id,
                    CASE WHEN json_type(s.payload,'$.instanceId')='text'
                        THEN NULLIF(json_extract(s.payload,'$.instanceId'),'') END,
                    s.seq
                 FROM session_events e INDEXED BY {index}
                 JOIN managed_sessions m ON m.session_id=e.session_id
                 LEFT JOIN session_events s ON s.session_id=e.session_id AND s.seq=(
                    SELECT MAX(seq) FROM session_events INDEXED BY session_events_by_kind
                    WHERE session_id=e.session_id AND kind='cli.started' AND seq<=e.seq)
                 WHERE e.kind='native.result'
                    AND {session_filter}
                    AND (?2 IS NULL OR (e.at_ms,e.session_id,e.seq)<(?2,?3,?4))
                    AND NOT EXISTS(SELECT 1 FROM managed_session_deletions d WHERE d.session_id=e.session_id)
                    AND (json_type(s.payload,'$.instanceId') IS NOT 'text'
                        OR json_extract(s.payload,'$.instanceId')=''
                        OR json_type(e.payload,'$.uuid') IS NOT 'text'
                        OR json_extract(e.payload,'$.uuid')=''
                        OR NOT EXISTS(
                            SELECT 1 FROM session_events p INDEXED BY session_native_results_by_uuid
                            WHERE p.session_id=e.session_id AND p.kind='native.result' AND p.seq<e.seq
                                AND json_extract(p.payload,'$.uuid')=json_extract(e.payload,'$.uuid')
                                AND json_extract((
                                    SELECT payload FROM session_events INDEXED BY session_events_by_kind
                                    WHERE session_id=p.session_id AND kind='cli.started' AND seq<=p.seq
                                    ORDER BY seq DESC LIMIT 1),'$.instanceId')=json_extract(s.payload,'$.instanceId')))
                 ORDER BY e.at_ms DESC,e.session_id DESC,e.seq DESC LIMIT ?5"
            );
            let mut statement = connection.prepare(&sql)
                .map_err(|source| storage_error("events_native_results_prepare_failed", source))?;
            let mut rows = statement.query(params![
                session_id,
                before.as_ref().map(|cursor| cursor.at_ms),
                before.as_ref().map(|cursor| cursor.session_id.as_str()),
                before.as_ref().map(|cursor| cursor.seq),
                limit,
            ]).map_err(|source| storage_error("events_native_results_query_failed", source))?;
            let mut results = Vec::new();
            while let Some(row) = rows.next().map_err(|source| storage_error("events_native_results_read_failed", source))? {
                let session_id: String = row.get(5).map_err(|source| storage_error("events_native_results_read_failed", source))?;
                results.push(NativeResult {
                    event: decode_event(row, &session_id)?,
                    instance_id: row.get(6).map_err(|source| storage_error("events_native_results_read_failed", source))?,
                    started_seq: row.get(7).map_err(|source| storage_error("events_native_results_read_failed", source))?,
                });
            }
            Ok(results)
        }).await
    }

    pub async fn has_native_usage_gap(
        &self,
        session_id: Option<&str>,
        after: Option<&NativeResultCursor>,
        before: Option<&NativeResultCursor>,
    ) -> rpc::Result<bool> {
        if let Some(session_id) = session_id {
            validate_session(session_id)?;
        }
        validate_native_cursor(after)?;
        validate_native_cursor(before)?;
        let session_id = session_id.map(str::to_owned);
        let after = after.cloned();
        let before = before.cloned();
        self.database.call(move |connection| {
            if let Some(session_id) = &session_id {
                crate::session::assert_live_session(connection, session_id)?;
            }
            let (index, session_filter) = native_query_scope(session_id.is_some());
            let sql = format!(
                "SELECT EXISTS(
                    SELECT 1 FROM session_events e INDEXED BY {index}
                    JOIN managed_sessions m ON m.session_id=e.session_id
                    WHERE e.kind='run.terminal' AND json_extract(e.payload,'$.status')='outcomeUnknown'
                        AND {session_filter}
                        AND (?2 IS NULL OR (e.at_ms,e.session_id,e.seq)>(?2,?3,?4))
                        AND (?5 IS NULL OR (e.at_ms,e.session_id,e.seq)<(?5,?6,?7))
                        AND NOT EXISTS(SELECT 1 FROM managed_session_deletions d WHERE d.session_id=e.session_id))"
            );
            connection.query_row(&sql,
                params![
                    session_id,
                    after.as_ref().map(|cursor| cursor.at_ms),
                    after.as_ref().map(|cursor| cursor.session_id.as_str()),
                    after.as_ref().map(|cursor| cursor.seq),
                    before.as_ref().map(|cursor| cursor.at_ms),
                    before.as_ref().map(|cursor| cursor.session_id.as_str()),
                    before.as_ref().map(|cursor| cursor.seq),
                ],
                |row| row.get(0),
            ).map_err(|source| storage_error("events_native_usage_gap_failed", source))
        }).await
    }

    pub async fn delete_session(&self, session_id: &str) -> rpc::Result<()> {
        validate_session(session_id)?;
        let session_id = session_id.to_owned();
        let watchers = self.watchers.clone();
        self.database
            .call(move |connection| {
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|source| storage_error("events_delete_begin_failed", source))?;
                let result = (|| {
                    transaction
                        .execute(
                            "DELETE FROM session_events WHERE session_id=?1",
                            [&session_id],
                        )
                        .map_err(|source| storage_error("events_delete_failed", source))?;
                    transaction
                        .execute(
                            "DELETE FROM session_event_heads WHERE session_id=?1",
                            [&session_id],
                        )
                        .map_err(|source| storage_error("events_head_delete_failed", source))?;
                    Ok(())
                })();
                if let Err(error) = result {
                    return Err(rollback(&transaction, error));
                }
                if let Err(source) = transaction.execute_batch("COMMIT") {
                    let error = if transaction.is_autocommit() {
                        rpc::Error::new(
                            -32006,
                            "events_delete_commit_unknown",
                            "Session event deletion could not be confirmed",
                        )
                        .with_source(source)
                    } else {
                        storage_error("events_delete_commit_failed", source)
                    };
                    return Err(rollback(&transaction, error));
                }
                // Wake an existing observer even when its cursor was already at the tail.
                // Its next durable read reports the Session owner's deletion fact.
                if let Some(sender) = watchers.senders.blocking_lock().remove(&session_id) {
                    sender.send_modify(|_| {});
                }
                Ok(())
            })
            .await
    }

    pub async fn latest(&self, session_id: &str) -> rpc::Result<u64> {
        validate_session(session_id)?;
        let session_id = session_id.to_owned();
        self.database
            .call(move |connection| durable_latest(connection, &session_id))
            .await
    }

    /// Only a coalescing wakeup, initially zero, not a substitute for latest/replay.
    /// Subscribe first, then borrow_and_update -> drain replay from durable cursor -> changed().await.
    pub async fn watch(&self, session_id: &str) -> watch::Receiver<u64> {
        let mut senders = self.watchers.senders.lock().await;
        if let Some(sender) = senders.get(session_id) {
            return sender.subscribe();
        }
        let (sender, receiver) = watch::channel(0);
        senders.insert(session_id.to_owned(), sender.clone());
        let registry = Arc::downgrade(&self.watchers);
        let session_id = session_id.to_owned();
        let mut closed = self.watchers.closed.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = closed.changed() => return,
                    _ = sender.closed() => {
                        let Some(registry) = registry.upgrade() else { return };
                        let mut senders = registry.senders.lock().await;
                        let Some(current) = senders.get(&session_id) else { return };
                        if !current.same_channel(&sender) {
                            return;
                        }
                        if sender.is_closed() {
                            senders.remove(&session_id);
                            return;
                        }
                    }
                }
            }
        });
        receiver
    }
}

fn native_query_scope(session: bool) -> (&'static str, &'static str) {
    if session {
        ("session_events_by_session_kind_time", "e.session_id=?1")
    } else {
        ("session_events_by_kind_time", "?1 IS NULL")
    }
}

fn validate_native_cursor(cursor: Option<&NativeResultCursor>) -> rpc::Result<()> {
    if cursor.is_some_and(|cursor| {
        cursor.session_id.is_empty()
            || cursor.seq == 0
            || cursor.at_ms > i64::MAX as u64
            || cursor.seq > i64::MAX as u64
    }) {
        return Err(rpc::Error::invalid("Native result cursor is invalid"));
    }
    Ok(())
}

fn validate_session(session_id: &str) -> rpc::Result<()> {
    if session_id.is_empty() {
        return Err(rpc::Error::invalid("Event sessionId must not be empty"));
    }
    Ok(())
}

fn replay_limit(limit: usize) -> rpc::Result<i64> {
    i64::try_from(limit).map_err(|source| {
        rpc::Error::invalid("Event replay limit exceeds SQLite integer range").with_source(source)
    })
}

fn validate_cursor(cursor: u64, latest: u64) -> rpc::Result<()> {
    if cursor > latest {
        return Err(rpc::Error::conflict(
            "events_cursor_ahead",
            "Event cursor is ahead of durable storage",
        )
        .with_data(json!({ "cursor": cursor, "latestSeq": latest })));
    }
    Ok(())
}

fn durable_latest(connection: &Connection, session_id: &str) -> rpc::Result<u64> {
    crate::session::assert_live_session(connection, session_id)?;
    let (latest, tail): (u64, u64) = connection.query_row(
        "SELECT COALESCE((SELECT seq FROM session_event_heads WHERE session_id = ?1), 0),
                COALESCE((SELECT seq FROM session_events WHERE session_id = ?1 ORDER BY seq DESC LIMIT 1), 0)",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|source| storage_error("events_latest_query_failed", source))?;
    if latest != tail {
        return Err(sequence_gap(latest, Some(tail), latest));
    }
    Ok(latest)
}

fn read_page(
    statement: &mut rusqlite::Statement<'_>,
    parameters: &[&dyn ToSql],
    session_id: &str,
) -> rpc::Result<Vec<Event>> {
    let mut rows = statement
        .query(parameters)
        .map_err(|source| storage_error("events_query_failed", source))?;
    let mut events = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|source| storage_error("events_query_read_failed", source))?
    {
        events.push(decode_event(row, session_id)?);
    }
    Ok(events)
}

fn decode_event(row: &Row<'_>, session_id: &str) -> rpc::Result<Event> {
    let (seq, run_id, kind, at_ms, text): (u64, Option<String>, String, u64, String) = (|| {
        Ok::<_, rusqlite::Error>((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ))
    })()
    .map_err(|source| storage_error("events_row_decode_failed", source))?;
    let payload = serde_json::from_str(&text).map_err(|source| {
        rpc::Error::new(
            -32005,
            "events_payload_decode_failed",
            "Stored event payload could not be decoded",
        )
        .with_data(json!({ "seq": seq }))
        .with_source(source)
    })?;
    Ok(Event {
        session_id: session_id.to_owned(),
        seq,
        run_id,
        kind,
        at_ms,
        payload,
    })
}

fn sequence_gap(expected: u64, actual: Option<u64>, latest: u64) -> rpc::Error {
    rpc::Error::new(
        -32005,
        "events_seq_gap",
        "Durable session event sequence has a gap",
    )
    .with_data(json!({ "expectedSeq": expected, "actualSeq": actual, "latestSeq": latest }))
}

fn storage_error(kind: &str, source: rusqlite::Error) -> rpc::Error {
    let mut error = rpc::Error::new(-32005, kind, "Event storage operation failed");
    if let rusqlite::Error::SqliteFailure(code, _) = &source {
        error = error.with_data(json!({ "sqliteCode": code.extended_code }));
    }
    error.with_source(source)
}

#[derive(thiserror::Error)]
#[error("Event rollback also failed")]
struct RollbackFailure {
    #[source]
    operation: rpc::Error,
    rollback: rusqlite::Error,
}

impl std::fmt::Debug for RollbackFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RollbackFailure")
            .field("operation", &self.operation)
            .field("rollback_code", &self.rollback.sqlite_error_code())
            .finish()
    }
}

fn rollback(transaction: &Transaction<'_>, error: rpc::Error) -> rpc::Error {
    if !transaction.is_autocommit()
        && let Err(source) = transaction.execute_batch("ROLLBACK")
    {
        let sqlite_code = match &source {
            rusqlite::Error::SqliteFailure(code, _) => Some(code.extended_code),
            _ => None,
        };
        return error
            .clone()
            .with_data(json!({
                "rollbackKind": "events_rollback_failed", "rollbackSqliteCode": sqlite_code,
            }))
            .with_source(RollbackFailure {
                operation: error,
                rollback: source,
            });
    }
    error
}

fn timestamp() -> rpc::Result<u64> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|source| {
            rpc::Error::unavailable(
                "events_clock_before_epoch",
                "System clock predates the Unix epoch",
            )
            .with_source(source)
        })?;
    let milliseconds = i64::try_from(elapsed.as_millis()).map_err(|source| {
        rpc::Error::unavailable(
            "events_timestamp_overflow",
            "Event timestamp exceeds SQLite integer range",
        )
        .with_source(source)
    })?;
    Ok(milliseconds as u64)
}
