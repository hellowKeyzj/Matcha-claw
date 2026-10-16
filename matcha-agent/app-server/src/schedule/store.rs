use std::collections::BTreeSet;

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    persistence::Database,
    rpc::{self, Error},
};

use super::definition::Definition;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TriggerState {
    pub next_fire_ms: Option<u64>,
    pub owned_session_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    pub receipt_id: String,
    pub schedule_id: String,
    pub trigger: String,
    pub due_at_ms: u64,
    pub observed_at_ms: u64,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub status: String,
    pub reason: Option<String>,
    pub completed_at_ms: Option<u64>,
}

#[derive(Clone)]
pub(super) struct Store(pub Database);

pub(super) enum Trigger {
    Manual,
    Cron,
    Missed,
}

pub(super) fn storage(source: rusqlite::Error) -> Error {
    Error::new(
        -32005,
        "schedule_storage",
        "Schedule state could not be read or committed",
    )
    .with_source(source)
}

fn receipt(row: &rusqlite::Row<'_>) -> rusqlite::Result<Receipt> {
    Ok(Receipt {
        receipt_id: row.get(0)?,
        schedule_id: row.get(1)?,
        trigger: row.get(2)?,
        due_at_ms: row.get(3)?,
        observed_at_ms: row.get(4)?,
        session_id: row.get(5)?,
        run_id: row.get(6)?,
        status: row.get(7)?,
        reason: row.get(8)?,
        completed_at_ms: row.get(9)?,
    })
}

const RECEIPT_COLUMNS: &str = "receipt_id,schedule_id,trigger,due_at_ms,observed_at_ms,session_id,run_id,status,reason,completed_at_ms";

impl Store {
    pub async fn open(path: &std::path::Path) -> rpc::Result<Self> {
        let database = Database::open(path).await?;
        database.call(|connection| {
            connection.execute_batch("
                CREATE TABLE IF NOT EXISTS schedule_triggers (
                    id TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    next_fire_ms INTEGER,
                    owned_session_id TEXT
                );
                CREATE INDEX IF NOT EXISTS schedule_next_fire ON schedule_triggers(next_fire_ms) WHERE next_fire_ms IS NOT NULL;
                CREATE TABLE IF NOT EXISTS schedule_receipts (
                    receipt_id TEXT PRIMARY KEY,
                    schedule_id TEXT NOT NULL,
                    trigger TEXT NOT NULL,
                    due_at_ms INTEGER NOT NULL,
                    observed_at_ms INTEGER NOT NULL,
                    session_id TEXT,
                    run_id TEXT,
                    status TEXT NOT NULL,
                    reason TEXT,
                    completed_at_ms INTEGER
                );
                CREATE UNIQUE INDEX IF NOT EXISTS schedule_due_receipt ON schedule_receipts(schedule_id,due_at_ms) WHERE trigger='cron';
                CREATE INDEX IF NOT EXISTS schedule_receipt_history ON schedule_receipts(schedule_id,observed_at_ms DESC);
                CREATE INDEX IF NOT EXISTS schedule_receipt_pending ON schedule_receipts(status) WHERE status IN ('dispatching','submitted');
                CREATE TABLE IF NOT EXISTS schedule_receipt_changes (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    receipt_id TEXT NOT NULL,
                    schedule_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    run_id TEXT
                );
            ").map_err(storage)?;
            let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(storage)?;
            let columns = {
                let mut query = transaction.prepare("PRAGMA table_info(schedule_triggers)").map_err(storage)?;
                query.query_map([], |row| row.get::<_, String>(1)).map_err(storage)?
                    .collect::<rusqlite::Result<BTreeSet<_>>>().map_err(storage)?
            };
            for column in ["timing_fingerprint", "execution_fingerprint"] {
                if !columns.contains(column) {
                    transaction.execute_batch(&format!("ALTER TABLE schedule_triggers ADD COLUMN {column} TEXT")).map_err(storage)?;
                }
            }
            transaction.commit().map_err(storage)?;
            Ok(())
        }).await?;
        Ok(Self(database))
    }

    pub async fn sync(
        &self,
        id: &str,
        definition: &Definition,
        state: TriggerState,
        reset: bool,
    ) -> rpc::Result<()> {
        let id = id.to_owned();
        let agent_id = definition.agent_id.clone();
        let fingerprint = definition.fingerprint()?;
        let timing_fingerprint = definition.timing_fingerprint()?;
        let execution_fingerprint = definition.execution_fingerprint()?;
        let TriggerState {
            next_fire_ms,
            owned_session_id,
        } = state;
        self.0.call(move |connection| {
            connection.execute(
                "INSERT INTO schedule_triggers(id,agent_id,fingerprint,next_fire_ms,owned_session_id,timing_fingerprint,execution_fingerprint) VALUES(?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,fingerprint=excluded.fingerprint,
                   next_fire_ms=CASE WHEN (schedule_triggers.timing_fingerprint IS NULL AND schedule_triggers.fingerprint=excluded.fingerprint) OR schedule_triggers.timing_fingerprint=excluded.timing_fingerprint THEN schedule_triggers.next_fire_ms ELSE excluded.next_fire_ms END,
                   owned_session_id=CASE WHEN schedule_triggers.agent_id=excluded.agent_id AND ((schedule_triggers.execution_fingerprint IS NULL AND schedule_triggers.fingerprint=excluded.fingerprint) OR schedule_triggers.execution_fingerprint=excluded.execution_fingerprint) THEN COALESCE(schedule_triggers.owned_session_id,excluded.owned_session_id) ELSE excluded.owned_session_id END,
                   timing_fingerprint=excluded.timing_fingerprint,execution_fingerprint=excluded.execution_fingerprint
                 WHERE ?8 OR schedule_triggers.fingerprint != excluded.fingerprint OR schedule_triggers.timing_fingerprint IS NULL",
                params![id, agent_id, fingerprint, next_fire_ms, owned_session_id, timing_fingerprint, execution_fingerprint, reset],
            ).map_err(storage)?;
            Ok(())
        }).await
    }

    pub async fn remove(&self, id: &str) -> rpc::Result<()> {
        let id = id.to_owned();
        self.0
            .call(move |connection| {
                connection
                    .execute("DELETE FROM schedule_triggers WHERE id=?1", [id])
                    .map_err(storage)?;
                Ok(())
            })
            .await
    }

    pub async fn retain(&self, ids: Vec<String>) -> rpc::Result<()> {
        let ids: BTreeSet<_> = ids.into_iter().collect();
        self.0
            .call(move |connection| {
                let mut query = connection
                    .prepare("SELECT id FROM schedule_triggers")
                    .map_err(storage)?;
                let stored = query
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(storage)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(storage)?;
                drop(query);
                let transaction = connection.transaction().map_err(storage)?;
                for id in stored {
                    if !ids.contains(&id) {
                        transaction
                            .execute("DELETE FROM schedule_triggers WHERE id=?1", [id])
                            .map_err(storage)?;
                    }
                }
                transaction.commit().map_err(storage)?;
                Ok(())
            })
            .await
    }

    pub async fn state(&self, id: &str) -> rpc::Result<Option<TriggerState>> {
        let id = id.to_owned();
        self.0
            .call(move |connection| {
                connection
                    .query_row(
                        "SELECT next_fire_ms,owned_session_id FROM schedule_triggers WHERE id=?1",
                        [id],
                        |row| {
                            Ok(TriggerState {
                                next_fire_ms: row.get(0)?,
                                owned_session_id: row.get(1)?,
                            })
                        },
                    )
                    .optional()
                    .map_err(storage)
            })
            .await
    }

    pub async fn earliest(&self) -> rpc::Result<Option<(String, u64)>> {
        self.0.call(|connection| {
            connection.query_row("SELECT id,next_fire_ms FROM schedule_triggers WHERE next_fire_ms IS NOT NULL ORDER BY next_fire_ms,id LIMIT 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            }).optional().map_err(storage)
        }).await
    }

    pub async fn claim(
        &self,
        id: &str,
        fingerprint: String,
        due_at_ms: u64,
        next_fire_ms: Option<u64>,
        trigger: Trigger,
        session_id: String,
    ) -> rpc::Result<Option<Receipt>> {
        let manual = matches!(trigger, Trigger::Manual);
        let missed = matches!(trigger, Trigger::Missed);
        let id = id.to_owned();
        let observed_at_ms = rpc::now_ms();
        let claimed = Receipt {
            receipt_id: Uuid::new_v4().to_string(),
            schedule_id: id.clone(),
            trigger: if manual { "manual" } else { "cron" }.into(),
            due_at_ms,
            observed_at_ms,
            session_id: Some(session_id),
            run_id: None,
            status: if missed { "missed" } else { "dispatching" }.into(),
            reason: missed.then(|| "server_was_offline".into()),
            completed_at_ms: missed.then_some(observed_at_ms),
        };
        self.0.call(move |connection| {
            let transaction = connection.transaction().map_err(storage)?;
            let expected: Option<(String, Option<u64>)> = transaction.query_row(
                "SELECT fingerprint,next_fire_ms FROM schedule_triggers WHERE id=?1", [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(storage)?;
            let Some((stored_fingerprint, stored_due)) = expected else { return Ok(None); };
            if stored_fingerprint != fingerprint || (!manual && stored_due != Some(due_at_ms)) {
                return Ok(None);
            }
            let inserted = transaction.execute(
                "INSERT OR IGNORE INTO schedule_receipts(receipt_id,schedule_id,trigger,due_at_ms,observed_at_ms,session_id,status,reason,completed_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![claimed.receipt_id, id, claimed.trigger, due_at_ms, observed_at_ms, claimed.session_id, claimed.status, claimed.reason, claimed.completed_at_ms],
            ).map_err(storage)?;
            if !manual {
                transaction.execute("UPDATE schedule_triggers SET next_fire_ms=?2 WHERE id=?1", params![id, next_fire_ms]).map_err(storage)?;
            }
            if inserted != 0 {
                super::changes::append(&transaction, &claimed.receipt_id)?;
            }
            transaction.commit().map_err(storage)?;
            if inserted != 0 {
                super::changes::committed();
            }
            Ok((inserted != 0).then_some(claimed))
        }).await
    }

    pub async fn settle(
        &self,
        receipt_id: &str,
        status: &str,
        run_id: Option<String>,
        reason: Option<String>,
    ) -> rpc::Result<()> {
        let receipt_id = receipt_id.to_owned();
        let status = status.to_owned();
        let completed_at_ms = (status != "submitted").then(rpc::now_ms);
        self.0.call(move |connection| {
            let transaction = connection.transaction().map_err(storage)?;
            let updated = transaction.execute(
                "UPDATE schedule_receipts SET status=?2,run_id=COALESCE(?3,run_id),reason=?4,completed_at_ms=?5 WHERE receipt_id=?1 AND status IN ('dispatching','submitted')",
                params![receipt_id, status, run_id, reason, completed_at_ms],
            ).map_err(storage)?;
            if updated != 0 {
                super::changes::append(&transaction, &receipt_id)?;
            }
            transaction.commit().map_err(storage)?;
            if updated != 0 {
                super::changes::committed();
            }
            Ok(())
        }).await
    }

    pub async fn recover_dispatching(&self) -> rpc::Result<()> {
        self.0.call(|connection| {
            let transaction = connection.transaction().map_err(storage)?;
            let receipts = {
                let mut query = transaction.prepare("SELECT receipt_id FROM schedule_receipts WHERE status='dispatching'").map_err(storage)?;
                query.query_map([], |row| row.get::<_, String>(0)).map_err(storage)?
                    .collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?
            };
            transaction.execute(
                "UPDATE schedule_receipts SET status='outcomeUnknown',reason='restart_during_submission',completed_at_ms=?1 WHERE status='dispatching'",
                [rpc::now_ms()],
            ).map_err(storage)?;
            for receipt_id in &receipts {
                super::changes::append(&transaction, receipt_id)?;
            }
            transaction.commit().map_err(storage)?;
            if !receipts.is_empty() {
                super::changes::committed();
            }
            Ok(())
        }).await
    }

    pub async fn finished(&self, id: &str) -> rpc::Result<Option<Receipt>> {
        let id = id.to_owned();
        self.0.call(move |connection| {
            connection.query_row(&format!("SELECT {RECEIPT_COLUMNS} FROM schedule_receipts WHERE schedule_id=?1 AND status NOT IN ('dispatching','submitted') ORDER BY observed_at_ms DESC,receipt_id DESC LIMIT 1"), [id], receipt).optional().map_err(storage)
        }).await
    }

    pub async fn running(&self, id: &str) -> rpc::Result<Option<Receipt>> {
        let id = id.to_owned();
        self.0.call(move |connection| {
            connection.query_row(&format!("SELECT {RECEIPT_COLUMNS} FROM schedule_receipts WHERE schedule_id=?1 AND status IN ('dispatching','submitted') ORDER BY observed_at_ms DESC,receipt_id DESC LIMIT 1"), [id], receipt).optional().map_err(storage)
        }).await
    }

    pub async fn pending(&self) -> rpc::Result<Vec<Receipt>> {
        self.0.call(|connection| {
            let mut query = connection.prepare(&format!("SELECT {RECEIPT_COLUMNS} FROM schedule_receipts WHERE status='submitted' ORDER BY observed_at_ms")).map_err(storage)?;
            query.query_map([], receipt).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)
        }).await
    }

    pub async fn receipts(&self, id: &str, limit: usize) -> rpc::Result<Vec<Receipt>> {
        let limit = i64::try_from(limit)
            .map_err(|_| Error::invalid("limit exceeds the database integer range"))?;
        let id = id.to_owned();
        self.0.call(move |connection| {
            let mut query = connection.prepare(&format!("SELECT {RECEIPT_COLUMNS} FROM schedule_receipts WHERE schedule_id=?1 ORDER BY observed_at_ms DESC,receipt_id DESC LIMIT ?2")).map_err(storage)?;
            query.query_map(params![id, limit], receipt).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)
        }).await
    }
}
