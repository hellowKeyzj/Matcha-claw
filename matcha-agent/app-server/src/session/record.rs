use std::path::PathBuf;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{persistence::Database, rpc};

use super::run;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Status {
    Open,
    Closed,
    Deleting,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Record {
    pub session_id: String,
    pub agent_id: String,
    pub status: Status,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub model: Option<String>,
    pub mode: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model_selection_id: Option<String>,
    #[serde(default)]
    pub provider_fingerprint: Option<String>,
    #[serde(default)]
    pub native_cleanup_failed: bool,
    pub forked_from: Option<String>,
    pub native_started: bool,
    pub workspace: PathBuf,
    pub runtime: PathBuf,
    pub transcript: Option<PathBuf>,
}

impl Record {
    pub fn mutable(&self) -> rpc::Result<()> {
        if self.status == Status::Deleting {
            return Err(rpc::Error::conflict(
                "session_deleting",
                "Session deletion is pending; retry deletion instead of resuming activity",
            ));
        }
        Ok(())
    }

    pub fn view(&self) -> Value {
        serde_json::json!({
            "sessionId": self.session_id, "agentId": self.agent_id, "status": self.status,
            "createdAtMs": self.created_at_ms, "updatedAtMs": self.updated_at_ms,
            "model": self.model, "mode": self.mode, "forkedFrom": self.forked_from,
            "title": self.title, "providerId": self.provider_id,
            "modelSelectionId": self.model_selection_id, "providerFingerprint": self.provider_fingerprint,
        })
    }
}

fn storage(kind: &str) -> rpc::Error {
    rpc::Error::new(-32005, kind, "Session management storage failed")
}

fn sqlite_error(kind: &str, error: rusqlite::Error) -> rpc::Error {
    storage(kind)
        .with_data(serde_json::json!({
            "sqliteCode": error.sqlite_error().map(|error| error.extended_code),
        }))
        .with_source(error)
}

fn encode<T: Serialize>(record: &T) -> rpc::Result<String> {
    serde_json::to_string(record)
        .map_err(|error| storage("session_record_encode").with_source(error))
}

pub(super) async fn prepare_database(database: &Database) -> rpc::Result<()> {
    database.call(|connection| {
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS managed_sessions (
                session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL, record TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS managed_runs (
                run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS managed_runs_session ON managed_runs(session_id,created_at_ms,run_id);
             CREATE TABLE IF NOT EXISTS managed_session_deletions (
                session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
                had_session INTEGER NOT NULL CHECK(had_session IN (0,1)),
                cleanup_complete INTEGER NOT NULL CHECK(cleanup_complete IN (0,1)),
                requested_at_ms INTEGER NOT NULL
             );",
        ).map_err(|error| sqlite_error("session_schema", error))
    }).await
}

pub(crate) fn assert_live_session(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> rpc::Result<()> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM managed_sessions WHERE session_id=?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("session_read", error))?;
    if !exists {
        return Err(rpc::Error::not_found("Session"));
    }
    if deleted(connection, session_id)? {
        return Err(rpc::Error::conflict(
            "session_deleting",
            "Session deletion is pending",
        ));
    }
    Ok(())
}

fn deleted(connection: &rusqlite::Connection, session_id: &str) -> rpc::Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM managed_session_deletions WHERE session_id=?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("session_deletion_read", error))
}

pub(super) async fn assert_not_deleted(database: &Database, session_id: &str) -> rpc::Result<()> {
    let session_id = session_id.to_owned();
    database
        .call(move |connection| {
            if deleted(connection, &session_id)? {
                return Err(rpc::Error::conflict(
                    "session_deleted",
                    "A deleted session identity cannot be reused",
                ));
            }
            Ok(())
        })
        .await
}

pub(super) struct Deletion {
    pub agent_id: String,
    pub had_session: bool,
    pub cleanup_complete: bool,
}

fn deletion(connection: &rusqlite::Connection, session_id: &str) -> rpc::Result<Option<Deletion>> {
    connection.query_row(
        "SELECT agent_id,had_session,cleanup_complete FROM managed_session_deletions WHERE session_id=?1",
        [session_id], |row| Ok(Deletion {
            agent_id: row.get(0)?, had_session: row.get(1)?, cleanup_complete: row.get(2)?,
        }),
    ).optional().map_err(|error| sqlite_error("session_deletion_read", error))
}

fn session_agent(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> rpc::Result<Option<String>> {
    connection
        .query_row(
            "SELECT agent_id FROM managed_sessions WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| sqlite_error("session_read", error))
}

pub(super) async fn deletion_state(
    database: &Database,
    session_id: &str,
    expected_agent_id: Option<&str>,
) -> rpc::Result<Option<Deletion>> {
    let session_id = session_id.to_owned();
    let expected_agent_id = expected_agent_id.map(str::to_owned);
    database
        .call(move |connection| {
            let deletion = deletion(connection, &session_id)?;
            let live_agent = session_agent(connection, &session_id)?;
            if expected_agent_id.as_ref().is_some_and(|expected| {
                live_agent.as_ref().is_some_and(|agent| agent != expected)
                    || deletion
                        .as_ref()
                        .is_some_and(|deletion| &deletion.agent_id != expected)
            }) {
                return Err(rpc::Error::conflict(
                    "session_agent_mismatch",
                    "This session identity belongs to another Agent",
                ));
            }
            if deletion.as_ref().is_some_and(|deletion| match &live_agent {
                Some(agent) => {
                    agent != &deletion.agent_id
                        || !deletion.had_session
                        || deletion.cleanup_complete
                }
                None => deletion.had_session && !deletion.cleanup_complete,
            }) {
                return Err(storage("session_deletion_inconsistent"));
            }
            Ok(deletion)
        })
        .await
}

pub(super) async fn deletion_complete(
    database: &Database,
    session_id: &str,
    expected_agent_id: Option<&str>,
) -> rpc::Result<bool> {
    Ok(deletion_state(database, session_id, expected_agent_id)
        .await?
        .is_some_and(|deletion| deletion.had_session && deletion.cleanup_complete))
}

pub(super) async fn open(database: &Database) -> rpc::Result<Vec<Record>> {
    prepare_database(database).await?;
    database
        .call(|connection| {
            let mut statement = connection
                .prepare("SELECT record FROM managed_sessions ORDER BY created_at_ms,session_id")
                .map_err(|error| sqlite_error("session_read", error))?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| sqlite_error("session_read", error))?
                .map(|row| {
                    serde_json::from_str(&row.map_err(|error| sqlite_error("session_read", error))?)
                        .map_err(|error| storage("session_record_decode").with_source(error))
                })
                .collect()
        })
        .await
}

pub(super) async fn save_session(database: &Database, record: &Record) -> rpc::Result<()> {
    let record = record.clone();
    let encoded = encode(&record)?;
    database.call(move |connection| {
        if deleted(connection, &record.session_id)? {
            return Err(rpc::Error::conflict("session_deleting", "Session deletion is pending"));
        }
        let changed = connection.execute(
            "INSERT INTO managed_sessions(session_id,agent_id,created_at_ms,record) VALUES(?1,?2,?3,?4)
             ON CONFLICT(session_id) DO UPDATE SET record=excluded.record
             WHERE managed_sessions.agent_id=excluded.agent_id",
            params![record.session_id, record.agent_id, record.created_at_ms, encoded],
        ).map_err(|error| sqlite_error("session_write", error))?;
        if changed == 0 {
            return Err(rpc::Error::conflict(
                "session_agent_mismatch",
                "This session identity belongs to another Agent",
            ));
        }
        Ok(())
    }).await
}

pub(super) async fn begin_delete(database: &Database, record: &Record) -> rpc::Result<()> {
    begin_retirement(database, &record.session_id, &record.agent_id, Some(record)).await?;
    Ok(())
}

pub(super) async fn begin_retirement(
    database: &Database,
    session_id: &str,
    expected_agent_id: &str,
    record: Option<&Record>,
) -> rpc::Result<Deletion> {
    let session_id = session_id.to_owned();
    let expected_agent_id = expected_agent_id.to_owned();
    let encoded = record.map(encode).transpose()?;
    database.call(move |connection| {
        let transaction = connection.transaction().map_err(|error| sqlite_error("session_delete_begin", error))?;
        let live_agent = session_agent(&transaction, &session_id)?;
        if live_agent.as_ref().is_some_and(|agent| agent != &expected_agent_id) {
            return Err(rpc::Error::conflict("session_agent_mismatch", "This session identity belongs to another Agent"));
        }
        if live_agent.is_none() && encoded.is_some() {
            return Err(rpc::Error::not_found("Session"));
        }
        if live_agent.is_some() && encoded.is_none() {
            return Err(rpc::Error::conflict("session_retirement_state_changed", "The managed session state does not match the retirement request"));
        }
        transaction.execute(
            "INSERT OR IGNORE INTO managed_session_deletions(session_id,agent_id,had_session,cleanup_complete,requested_at_ms)
             VALUES(?1,?2,?3,0,?4)",
            params![session_id, expected_agent_id, live_agent.is_some(), rpc::now_ms()],
        ).map_err(|error| sqlite_error("session_delete_intent", error))?;
        let deletion = deletion(&transaction, &session_id)?
            .ok_or_else(|| storage("session_delete_intent_missing"))?;
        if deletion.agent_id != expected_agent_id {
            return Err(rpc::Error::conflict("session_agent_mismatch", "This session deletion belongs to another Agent"));
        }
        if live_agent.is_some() && (!deletion.had_session || deletion.cleanup_complete) {
            return Err(storage("session_deletion_inconsistent"));
        }
        if let Some(encoded) = encoded {
            transaction.execute(
                "UPDATE managed_sessions SET record=?2 WHERE session_id=?1 AND agent_id=?3",
                params![session_id, encoded, expected_agent_id],
            ).map_err(|error| sqlite_error("session_delete_intent", error))?;
        }
        commit(transaction, "session_delete_intent_commit")?;
        Ok(deletion)
    }).await
}

pub(super) async fn delete(database: &Database, session_id: &str) -> rpc::Result<()> {
    let session_id = session_id.to_owned();
    database
        .call(move |connection| {
            let transaction = connection
                .transaction()
                .map_err(|error| sqlite_error("session_delete_begin", error))?;
            if !deleted(&transaction, &session_id)? {
                return Err(rpc::Error::conflict(
                    "session_delete_intent_missing",
                    "Session deletion has not been accepted",
                ));
            }
            transaction
                .execute(
                    "DELETE FROM managed_runs WHERE session_id=?1",
                    [&session_id],
                )
                .map_err(|error| sqlite_error("session_runs_delete", error))?;
            transaction
                .execute(
                    "DELETE FROM managed_sessions WHERE session_id=?1",
                    [&session_id],
                )
                .map_err(|error| sqlite_error("session_delete", error))?;
            transaction
                .execute(
                    "UPDATE managed_session_deletions SET cleanup_complete=1 WHERE session_id=?1",
                    [&session_id],
                )
                .map_err(|error| sqlite_error("session_delete_complete", error))?;
            commit(transaction, "session_delete_commit")
        })
        .await
}

fn commit(transaction: rusqlite::Transaction<'_>, kind: &str) -> rpc::Result<()> {
    transaction.commit().map_err(|error| {
        rpc::Error::new(
            -32006,
            kind,
            "Session storage commit could not be confirmed",
        )
        .with_data(serde_json::json!({ "storageOutcome": "unknown" }))
        .with_source(error)
    })
}

pub(super) async fn save_run(database: &Database, record: &run::Record) -> rpc::Result<()> {
    let record = record.clone();
    let encoded = encode(&record)?;
    let status = serde_json::to_string(&record.run.status)
        .map_err(|error| storage("run_record_encode").with_source(error))?;
    database.call(move |connection| {
        assert_live_session(connection, &record.run.session_id)?;
        connection.execute(
            "INSERT INTO managed_runs(run_id,session_id,created_at_ms,status,record) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,record=excluded.record",
            params![record.run.run_id, record.run.session_id, record.run.created_at_ms, status, encoded],
        ).map_err(|error| sqlite_error("run_write", error))?;
        Ok(())
    }).await
}

pub(super) async fn get_run(database: &Database, run_id: &str) -> rpc::Result<run::Record> {
    let run_id = run_id.to_owned();
    database
        .call(move |connection| {
            let encoded: Option<String> = connection
                .query_row(
                    "SELECT record FROM managed_runs WHERE run_id=?1",
                    [run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| sqlite_error("run_read", error))?;
            let record: run::Record =
                serde_json::from_str(&encoded.ok_or_else(|| rpc::Error::not_found("Run"))?)
                    .map_err(|error| storage("run_record_decode").with_source(error))?;
            assert_live_session(connection, &record.run.session_id)?;
            Ok(record)
        })
        .await
}

pub(super) async fn pending_runs(
    database: &Database,
    session_id: &str,
) -> rpc::Result<Vec<run::Record>> {
    let session_id = session_id.to_owned();
    database.call(move |connection| {
        let mut statement = connection.prepare(
            "SELECT record FROM managed_runs WHERE session_id=?1 AND status IN ('\"queued\"','\"starting\"','\"running\"','\"cancelRequested\"') ORDER BY created_at_ms,run_id",
        ).map_err(|error| sqlite_error("run_recovery_read", error))?;
        statement.query_map([session_id], |row| row.get::<_, String>(0))
            .map_err(|error| sqlite_error("run_recovery_read", error))?
            .map(|row| serde_json::from_str(&row.map_err(|error| sqlite_error("run_recovery_read", error))?)
                .map_err(|error| storage("run_record_decode").with_source(error)))
            .collect()
    }).await
}

pub(super) async fn list_runs(
    database: &Database,
    session_id: &str,
) -> rpc::Result<Vec<run::Record>> {
    let session_id = session_id.to_owned();
    database.call(move |connection| {
        assert_live_session(connection, &session_id)?;
        let mut statement = connection.prepare(
            "SELECT record FROM managed_runs WHERE session_id=?1 ORDER BY created_at_ms DESC,run_id DESC",
        ).map_err(|error| sqlite_error("run_read", error))?;
        statement.query_map([session_id], |row| row.get::<_, String>(0))
            .map_err(|error| sqlite_error("run_read", error))?
            .map(|row| serde_json::from_str(&row.map_err(|error| sqlite_error("run_read", error))?)
                .map_err(|error| storage("run_record_decode").with_source(error)))
            .collect()
    }).await
}
