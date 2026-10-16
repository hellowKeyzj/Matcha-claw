use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    persistence::Database,
    rpc::{self, Error},
};

use super::{Delivery, Failure, Pending, Target, native::Request};

#[derive(Clone)]
pub(super) struct Store {
    database: Database,
}

pub(super) struct Reservation {
    pub pending: Pending,
    pub should_send: bool,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Fact {
    pub id: i64,
    pub session_id: String,
    pub run_id: Option<String>,
    pub kind: String,
    pub payload: Value,
}

impl Store {
    pub(super) async fn open(database: Database) -> rpc::Result<Self> {
        database.call(|connection| {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS interaction_instances (
                    session_id TEXT NOT NULL, instance_id TEXT NOT NULL, closed INTEGER NOT NULL,
                    PRIMARY KEY(session_id, instance_id)
                );
                CREATE TABLE IF NOT EXISTS interactions (
                    session_id TEXT NOT NULL, instance_id TEXT NOT NULL, native_request_id TEXT NOT NULL,
                    run_id TEXT, family TEXT NOT NULL, availability TEXT NOT NULL, requested_at_ms INTEGER NOT NULL,
                    record_json TEXT NOT NULL,
                    PRIMARY KEY(session_id, instance_id, native_request_id)
                );
                CREATE INDEX IF NOT EXISTS interactions_session ON interactions(session_id, family, availability);
                CREATE TABLE IF NOT EXISTS interaction_facts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT,
                    kind TEXT NOT NULL, payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS interaction_facts_session ON interaction_facts(session_id, id);
                CREATE TABLE IF NOT EXISTS interaction_cancellations (
                    session_id TEXT NOT NULL, instance_id TEXT NOT NULL, native_request_id TEXT NOT NULL,
                    PRIMARY KEY(session_id,instance_id,native_request_id)
                );"
            ).map_err(|source| storage("interaction_schema", source))?;
            let transaction = connection.transaction().map_err(|source| storage("interaction_recovery_begin", source))?;
            let pending = records(&transaction,
                "SELECT record_json FROM interactions WHERE availability='pending' OR json_extract(record_json,'$.delivery')='sending'", [])?;
            for mut record in pending {
                if !live_session(&transaction, &record.session_id)? {
                    continue;
                }
                if record.availability == super::Availability::Pending {
                    record.availability = super::Availability::ServerRestarted;
                }
                if record.delivery == Delivery::Sending {
                    record.delivery = Delivery::Unknown;
                }
                record.updated_at_ms = rpc::now_ms();
                save(&transaction, &record, "interaction.recovered")?;
            }
            transaction.execute("UPDATE interaction_instances SET closed=1 WHERE closed=0", [])
                .map_err(|source| storage("interaction_recovery_instances", source))?;
            commit(transaction, "interaction_recovery_commit")
        }).await?;
        Ok(Self { database })
    }

    pub(super) async fn observe(
        &self,
        target: Target,
        run_id: Option<String>,
        request: Request,
    ) -> rpc::Result<()> {
        self.database.call(move |connection| {
            let transaction = connection.transaction().map_err(|source| storage("interaction_observe_begin", source))?;
            crate::session::assert_live_session(&transaction, &target.session_id)?;
            if let Some(existing) = get(&transaction, &target)? {
                if existing.run_id != run_id || existing.request != request {
                    return Err(Error::conflict("interaction_request_reused", "Native request ID was reused with different content or run ownership"));
                }
                return Ok(());
            }
            let closed: Option<bool> = transaction.query_row(
                "SELECT closed FROM interaction_instances WHERE session_id=?1 AND instance_id=?2",
                params![target.session_id, target.instance_id], |row| row.get(0),
            ).optional().map_err(|source| storage("interaction_instance_read", source))?;
            if closed == Some(true) {
                return Err(Error::unavailable("interaction_instance_closed", "This CLI instance has already closed"));
            }
            transaction.execute(
                "INSERT OR IGNORE INTO interaction_instances(session_id,instance_id,closed) VALUES(?1,?2,0)",
                params![target.session_id, target.instance_id],
            ).map_err(|source| storage("interaction_instance_insert", source))?;
            // A cancellation observed before its request must not resurrect a pending prompt.
            let cancelled: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM interaction_cancellations WHERE session_id=?1 AND instance_id=?2 AND native_request_id=?3)",
                params![target.session_id, target.instance_id, target.native_request_id], |row| row.get(0),
            ).map_err(|source| storage("interaction_cancel_read", source))?;
            let now = rpc::now_ms();
            let pending = Pending {
                session_id: target.session_id, instance_id: target.instance_id, native_request_id: target.native_request_id,
                run_id, category: request.category(), request,
                availability: if cancelled { super::Availability::NativeCancelled } else { super::Availability::Pending },
                delivery: Delivery::NotSent, requested_at_ms: now, updated_at_ms: now, response: None, failure: None,
            };
            save(&transaction, &pending, "interaction.requested")?;
            commit(transaction, "interaction_observe_commit")
        }).await
    }

    pub(super) async fn list(
        &self,
        session_id: String,
        family: String,
        run_id: Option<String>,
        instance_id: Option<String>,
        include_resolved: bool,
    ) -> rpc::Result<Vec<Pending>> {
        self.database.call(move |connection| {
            crate::session::assert_live_session(connection, &session_id)?;
            records(connection,
                "SELECT record_json FROM interactions WHERE session_id=?1 AND family=?2
                    AND (?3 IS NULL OR run_id=?3) AND (?4 IS NULL OR instance_id=?4)
                    AND (?5 OR (availability='pending' AND json_extract(record_json,'$.delivery')='notSent'
                        AND json_extract(record_json,'$.response') IS NULL))
                    ORDER BY requested_at_ms, instance_id, native_request_id",
                params![session_id, family, run_id, instance_id, include_resolved],
            )
        }).await
    }

    pub(super) async fn reserve(
        &self,
        target: Target,
        family: String,
        response: Value,
    ) -> rpc::Result<Reservation> {
        self.database
            .call(move |connection| {
                let transaction = connection
                    .transaction()
                    .map_err(|source| storage("interaction_reserve_begin", source))?;
                crate::session::assert_live_session(&transaction, &target.session_id)?;
                let mut pending =
                    get(&transaction, &target)?.ok_or_else(|| Error::not_found("Interaction"))?;
                if pending.category.family() != family {
                    return Err(Error::conflict(
                        "interaction_family_mismatch",
                        "Interaction belongs to a different method family",
                    ));
                }
                let response = pending.request.response(response)?;
                if let Some(existing) = &pending.response {
                    if existing != &response {
                        return Err(Error::conflict(
                            "interaction_decision_conflict",
                            "A different response has already been reserved",
                        )
                        .with_data(pending.receipt()));
                    }
                    return Ok(Reservation {
                        pending,
                        should_send: false,
                    });
                }
                if pending.availability != super::Availability::Pending {
                    return Err(Error::conflict(
                        "interaction_no_longer_pending",
                        "This native interaction is no longer answerable",
                    )
                    .with_data(pending.receipt()));
                }
                pending.response = Some(response);
                pending.delivery = Delivery::Sending;
                pending.updated_at_ms = rpc::now_ms();
                save(&transaction, &pending, "interaction.response_reserved")?;
                commit(transaction, "interaction_reserve_commit")?;
                Ok(Reservation {
                    pending,
                    should_send: true,
                })
            })
            .await
    }

    pub(super) async fn answerable(&self, target: Target) -> rpc::Result<bool> {
        self.database
            .call(move |connection| {
                crate::session::assert_live_session(connection, &target.session_id)?;
                Ok(get(connection, &target)?
                    .is_some_and(|pending| pending.availability == super::Availability::Pending))
            })
            .await
    }

    pub(super) async fn finish(
        &self,
        target: Target,
        delivery: Delivery,
        failure: Option<Failure>,
    ) -> rpc::Result<Pending> {
        self.database
            .call(move |connection| {
                let transaction = connection
                    .transaction()
                    .map_err(|source| storage("interaction_finish_begin", source))?;
                crate::session::assert_live_session(&transaction, &target.session_id)?;
                let mut pending =
                    get(&transaction, &target)?.ok_or_else(|| Error::not_found("Interaction"))?;
                pending.delivery = delivery;
                pending.failure = failure;
                pending.updated_at_ms = rpc::now_ms();
                save(&transaction, &pending, "interaction.response_delivery")?;
                commit(transaction, "interaction_finish_commit")?;
                Ok(pending)
            })
            .await
    }

    pub(super) async fn cancel(&self, target: Target) -> rpc::Result<()> {
        self.database.call(move |connection| {
            let transaction = connection.transaction().map_err(|source| storage("interaction_cancel_begin", source))?;
            crate::session::assert_live_session(&transaction, &target.session_id)?;
            let inserted = transaction.execute(
                "INSERT OR IGNORE INTO interaction_cancellations(session_id,instance_id,native_request_id) VALUES(?1,?2,?3)",
                params![target.session_id, target.instance_id, target.native_request_id],
            ).map_err(|source| storage("interaction_cancel_insert", source))?;
            if let Some(mut pending) = get(&transaction, &target)? {
                if pending.availability == super::Availability::Pending {
                    pending.availability = super::Availability::NativeCancelled;
                    pending.updated_at_ms = rpc::now_ms();
                    save(&transaction, &pending, "interaction.native_cancelled")?;
                }
            } else if inserted != 0 {
                fact(&transaction, &target.session_id, None, "interaction.orphan_cancel", json!({
                    "instanceId": target.instance_id, "nativeRequestId": target.native_request_id,
                }))?;
            }
            commit(transaction, "interaction_cancel_commit")
        }).await
    }

    pub(super) async fn close_instance(
        &self,
        session_id: String,
        instance_id: String,
    ) -> rpc::Result<()> {
        self.database.call(move |connection| {
            let transaction = connection.transaction().map_err(|source| storage("interaction_close_begin", source))?;
            crate::session::assert_live_session(&transaction, &session_id)?;
            transaction.execute(
                "INSERT INTO interaction_instances(session_id,instance_id,closed) VALUES(?1,?2,1)
                    ON CONFLICT(session_id,instance_id) DO UPDATE SET closed=1",
                params![session_id, instance_id],
            ).map_err(|source| storage("interaction_instance_close", source))?;
            let pending = records(&transaction,
                "SELECT record_json FROM interactions WHERE session_id=?1 AND instance_id=?2 AND availability='pending'",
                params![session_id, instance_id],
            )?;
            for mut record in pending {
                record.availability = super::Availability::InstanceClosed;
                record.updated_at_ms = rpc::now_ms();
                save(&transaction, &record, "interaction.instance_closed")?;
            }
            transaction.execute("DELETE FROM interaction_cancellations WHERE session_id=?1 AND instance_id=?2", params![session_id, instance_id])
                .map_err(|source| storage("interaction_cancel_cleanup", source))?;
            commit(transaction, "interaction_close_commit")
        }).await
    }

    pub(super) async fn delete_session(&self, session_id: String) -> rpc::Result<()> {
        self.database
            .call(move |connection| {
                let transaction = connection
                    .transaction()
                    .map_err(|source| storage("interaction_delete_begin", source))?;
                for table in [
                    "interactions",
                    "interaction_facts",
                    "interaction_instances",
                    "interaction_cancellations",
                ] {
                    transaction
                        .execute(
                            &format!("DELETE FROM {table} WHERE session_id=?1"),
                            [&session_id],
                        )
                        .map_err(|source| storage("interaction_delete", source))?;
                }
                commit(transaction, "interaction_delete_commit")
            })
            .await
    }

    pub(super) async fn fact_sessions(&self) -> rpc::Result<Vec<String>> {
        self.database
            .call(|connection| {
                let mut statement = connection
                    .prepare(
                        "SELECT DISTINCT session_id FROM interaction_facts ORDER BY session_id",
                    )
                    .map_err(|source| storage("interaction_fact_sessions", source))?;
                let rows = statement
                    .query_map([], |row| row.get(0))
                    .map_err(|source| storage("interaction_fact_sessions", source))?;
                let sessions = rows
                    .collect::<Result<Vec<String>, _>>()
                    .map_err(|source| storage("interaction_fact_sessions", source))?;
                sessions
                    .into_iter()
                    .filter_map(|session_id| match live_session(connection, &session_id) {
                        Ok(true) => Some(Ok(session_id)),
                        Ok(false) => None,
                        Err(error) => Some(Err(error)),
                    })
                    .collect()
            })
            .await
    }

    pub(super) async fn next_fact(&self, session_id: String) -> rpc::Result<Option<Fact>> {
        self.database.call(move |connection| {
            crate::session::assert_live_session(connection, &session_id)?;
            let row: Option<(i64, String, Option<String>, String, String)> = connection.query_row(
                "SELECT id,session_id,run_id,kind,payload_json FROM interaction_facts WHERE session_id=?1 ORDER BY id LIMIT 1",
                [session_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            ).optional().map_err(|source| storage("interaction_fact_read", source))?;
            row.map(|(id, session_id, run_id, kind, payload)| {
                let payload = serde_json::from_str(&payload).map_err(|source| storage("interaction_fact_decode", source))?;
                Ok(Fact { id, session_id, run_id, kind, payload })
            }).transpose()
        }).await
    }

    pub(super) async fn acknowledge_fact(&self, id: i64) -> rpc::Result<()> {
        self.database
            .call(move |connection| {
                connection
                    .execute("DELETE FROM interaction_facts WHERE id=?1", [id])
                    .map_err(|source| storage("interaction_fact_acknowledge", source))?;
                Ok(())
            })
            .await
    }
}

fn live_session(connection: &Connection, session_id: &str) -> rpc::Result<bool> {
    match crate::session::assert_live_session(connection, session_id) {
        Ok(()) => Ok(true),
        Err(error)
            if error.code == -32001
                || error.data.as_ref().and_then(|data| data["kind"].as_str())
                    == Some("session_deleting") =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

fn get(connection: &Connection, target: &Target) -> rpc::Result<Option<Pending>> {
    let encoded: Option<String> = connection.query_row(
        "SELECT record_json FROM interactions WHERE session_id=?1 AND instance_id=?2 AND native_request_id=?3",
        params![target.session_id, target.instance_id, target.native_request_id], |row| row.get(0),
    ).optional().map_err(|source| storage("interaction_record_read", source))?;
    encoded
        .map(|encoded| {
            serde_json::from_str(&encoded)
                .map_err(|source| storage("interaction_record_decode", source))
        })
        .transpose()
}

fn records<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> rpc::Result<Vec<Pending>> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|source| storage("interaction_records_prepare", source))?;
    let rows = statement
        .query_map(params, |row| row.get::<_, String>(0))
        .map_err(|source| storage("interaction_records_query", source))?;
    rows.map(|row| {
        let encoded = row.map_err(|source| storage("interaction_record_read", source))?;
        serde_json::from_str(&encoded)
            .map_err(|source| storage("interaction_record_decode", source))
    })
    .collect()
}

fn save(transaction: &Transaction<'_>, pending: &Pending, kind: &str) -> rpc::Result<()> {
    let encoded = serde_json::to_string(pending)
        .map_err(|source| storage("interaction_record_encode", source))?;
    let availability = serde_json::to_value(pending.availability)
        .map_err(|source| storage("interaction_availability_encode", source))?;
    transaction.execute(
        "INSERT INTO interactions(session_id,instance_id,native_request_id,run_id,family,availability,requested_at_ms,record_json)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(session_id,instance_id,native_request_id)
            DO UPDATE SET availability=excluded.availability,record_json=excluded.record_json",
        params![pending.session_id, pending.instance_id, pending.native_request_id, pending.run_id,
            pending.category.family(), availability.as_str(), pending.requested_at_ms, encoded],
    ).map_err(|source| storage("interaction_record_write", source))?;
    fact(
        transaction,
        &pending.session_id,
        pending.run_id.as_deref(),
        kind,
        pending.receipt(),
    )
}

fn fact(
    transaction: &Transaction<'_>,
    session_id: &str,
    run_id: Option<&str>,
    kind: &str,
    mut payload: Value,
) -> rpc::Result<()> {
    // append and acknowledgement span two owners; transitionId makes a replayed
    // fact identifiable if the process exits after append but before acknowledgement.
    payload["transitionId"] = json!(Uuid::new_v4().to_string());
    let encoded = serde_json::to_string(&payload)
        .map_err(|source| storage("interaction_fact_encode", source))?;
    transaction.execute("INSERT INTO interaction_facts(session_id,run_id,kind,payload_json) VALUES(?1,?2,?3,?4)",
        params![session_id, run_id, kind, encoded]).map_err(|source| storage("interaction_fact_insert", source))?;
    Ok(())
}

fn commit(transaction: Transaction<'_>, kind: &str) -> rpc::Result<()> {
    transaction.commit().map_err(|source| {
        Error::new(
            -32006,
            kind,
            "The interaction storage commit could not be confirmed",
        )
        .with_source(source)
        .with_data(json!({"storageOutcome": "unknown"}))
    })
}

fn storage(kind: &str, source: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::new(
        -32005,
        kind,
        "Interaction storage failed; inspect the storage state before retrying",
    )
    .with_source(source)
}
