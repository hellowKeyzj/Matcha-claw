use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::rpc;

use super::{AgentScope, Session, Sessions, history, record};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Rename {
    session_id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Delete {
    session_id: String,
    expected_agent_id: Option<String>,
}

impl Sessions {
    pub(super) async fn rename(&self, input: Rename) -> rpc::Result<Value> {
        super::dispatch::selection(&input.title, "title")?;
        let session = self.session(&input.session_id).await?;
        let owner = self.clone();
        tokio::spawn(async move {
            owner.accepting()?;
            let mut execution = session.data.lock().await;
            session.mutable()?;
            let record = session.record();
            let changed = record.title.as_ref() != Some(&input.title);
            let mut renamed = (*record).clone();
            renamed.title = Some(input.title);
            renamed.updated_at_ms = rpc::now_ms();
            session.commit(&owner.0.database, &mut execution, renamed).await?;
            if changed {
                owner.0.catalog_changes.send_replace(());
            }
            Ok(session.record().view())
        })
        .await
        .map_err(|error| {
            rpc::Error::new(
                -32006,
                "session_rename_unknown",
                "Session rename could not be confirmed",
            )
            .with_source(error)
        })?
    }

    pub(super) async fn delete(&self, input: Delete) -> rpc::Result<Value> {
        super::validate_uuid(&input.session_id)?;
        if let Some(agent_id) = &input.expected_agent_id {
            crate::config::validate_id(agent_id)?;
        }
        if record::deletion_complete(
            &self.0.database,
            &input.session_id,
            input.expected_agent_id.as_deref(),
        )
        .await?
        {
            self.0.sessions.write().await.remove(&input.session_id);
            return Ok(receipt(&input.session_id));
        }
        let session = self.stored_session(&input.session_id).await?;
        let owner = self.clone();
        tokio::spawn(async move {
            owner
                .delete_session(session, input.expected_agent_id.as_deref())
                .await
        })
        .await
        .map_err(|error| {
            rpc::Error::new(
                -32006,
                "session_delete_unknown",
                "Session deletion could not be confirmed",
            )
            .with_data(json!({ "cleanupComplete": false }))
            .with_source(error)
        })?
    }

    async fn delete_session(
        &self,
        session: Arc<Session>,
        expected_agent_id: Option<&str>,
    ) -> rpc::Result<Value> {
        let agent_id = session.record().agent_id.clone();
        if expected_agent_id.is_some_and(|expected| expected != agent_id.as_str()) {
            return Err(rpc::Error::conflict(
                "session_agent_mismatch",
                "This session identity belongs to another Agent",
            ));
        }
        let admission = self.agent_gate(&agent_id).await.write_owned().await;
        self.delete_session_guarded(session, Some(admission)).await
    }

    pub(super) async fn delete_session_guarded(
        &self,
        session: Arc<Session>,
        admission: Option<tokio::sync::OwnedRwLockWriteGuard<()>>,
    ) -> rpc::Result<Value> {
        self.accepting()?;
        let (admission, _closing) = match admission {
            Some(admission) => match session.close_guard.try_lock() {
                Ok(closing) => (Some(admission), closing),
                Err(_) => {
                    drop(admission);
                    let agent_id = session.record().agent_id.clone();
                    let gate = self.agent_gate(&agent_id).await;
                    loop {
                        let admission = gate.clone().write_owned().await;
                        if let Ok(closing) = session.close_guard.try_lock() {
                            break (Some(admission), closing);
                        }
                        drop(admission);
                        let closing = session.close_guard.lock().await;
                        if let Ok(admission) = gate.clone().try_write_owned() {
                            break (Some(admission), closing);
                        }
                        drop(closing);
                    }
                }
            },
            None => (None, session.close_guard.try_lock().map_err(|_| {
                rpc::Error::conflict("session_delete_busy", "Session execution has not stopped")
            })?),
        };
        let execution = session.data.lock().await;
        let record = session.record();
        if record::deletion_complete(
            &self.0.database,
            &record.session_id,
            Some(&record.agent_id),
        )
        .await?
        {
            let session_id = record.session_id.clone();
            drop(execution);
            self.0.sessions.write().await.remove(&session_id);
            return Ok(receipt(&session_id));
        }
        if record.status == record::Status::Open {
            return Err(rpc::Error::conflict(
                "session_delete_requires_closed",
                "Close the session successfully before deleting it",
            ));
        }
        if execution.cli.is_some()
            || execution.launching
            || execution.sending
            || execution.consuming
            || execution.active.is_some()
            || !execution.queue.is_empty()
            || execution.cancel_in_flight
        {
            return Err(rpc::Error::conflict(
                "session_delete_busy",
                "Session execution has not stopped",
            ));
        }
        if execution.cleanup_failed || record.native_cleanup_failed {
            return Err(rpc::Error::conflict(
                "native_cleanup_unconfirmed",
                "The previous CLI instance cleanup was not confirmed",
            )
            .with_data(json!({ "cleanupComplete": false })));
        }
        let session_id = record.session_id.clone();
        let snapshot = self.0.config.snapshot().await;
        if snapshot
            .channels
            .values()
            .chain(snapshot.schedules.values())
            .any(|value| value.get("sessionId").and_then(Value::as_str) == Some(&session_id))
        {
            return Err(rpc::Error::conflict(
                "session_referenced",
                "Remove the channel or schedule session binding before deleting this session",
            ));
        }
        drop(execution);
        let others: Vec<_> = self.0.sessions.read().await.values().cloned().collect();
        for other in others {
            if Arc::ptr_eq(&session, &other) {
                continue;
            }
            let other = other.record();
            if other.forked_from.as_deref() == Some(&session_id) && !other.native_started {
                return Err(rpc::Error::conflict(
                    "session_fork_referenced",
                    "An unmaterialized fork still needs this session transcript",
                ));
            }
        }
        let mut execution = session.data.lock().await;
        record::ensure_investigations_settled(&self.0.database, &session_id).await?;
        let mut deleting = (*session.record()).clone();
        deleting.status = record::Status::Deleting;
        deleting.updated_at_ms = rpc::now_ms();
        // Fence admission even on an unknown commit; catalog readers see committed records only.
        session.deleting.store(true, std::sync::atomic::Ordering::Release);
        session.commit(&self.0.database, &mut execution, deleting.clone())
            .await
            .map_err(|error| delete_error(error, "intent"))?;
        drop(execution);
        self.0
            .media
            .clear_session(&session_id)
            .map_err(|error| delete_error(error, "media"))?;
        session.stopped.cancel();
        drop(admission);
        // The executor no longer accepts work; join it without aborting a task
        // that might still own a database operation.
        session.wake.notify_one();
        if let Some(task) = session.executor.lock().await.take() {
            task.await.map_err(|error| {
                delete_error(
                    rpc::Error::internal("session_executor_task").with_source(error),
                    "executor",
                )
            })?;
        }
        history::delete(&deleting.runtime, &deleting.workspace, &session_id)
            .await
            .map_err(|error| delete_error(error, "native_artifacts"))?;
        self.0
            .interactions
            .delete_session(&session_id)
            .await
            .map_err(|error| delete_error(error, "interactions"))?;
        self.0
            .events
            .delete_session(&session_id)
            .await
            .map_err(|error| delete_error(error, "events"))?;
        record::delete(&self.0.database, &session_id)
            .await
            .map_err(|error| delete_error(error, "records"))?;
        self.0.sessions.write().await.remove(&session_id);
        Ok(receipt(&session_id))
    }
}

impl AgentScope {
    pub(crate) async fn delete_sessions(&self) -> rpc::Result<u64> {
        crate::config::validate_id(&self.agent_id)?;
        let sessions: Vec<_> = self.sessions.0.sessions.read().await.values().cloned().collect();
        let mut pending = Vec::new();
        for session in sessions {
            let record = session.record();
            if record.agent_id == self.agent_id {
                pending.push((record, session));
            }
        }
        let mut deleted = 0;
        while !pending.is_empty() {
            // ponytail: quadratic within one Agent; use a dependency index if large fleets require it.
            let index = pending
                .iter()
                .position(|(record, _)| {
                    !pending.iter().any(|(other, _)| {
                        !other.native_started
                            && other.forked_from.as_deref() == Some(record.session_id.as_str())
                    })
                })
                .ok_or_else(|| {
                    rpc::Error::conflict(
                        "session_fork_cycle",
                        "Session fork dependencies contain a cycle",
                    )
                    .with_data(json!({ "deletedSessions": deleted }))
                })?;
            let (_, session) = pending.remove(index);
            self.sessions.delete_session_guarded(session, None)
                .await
                .map_err(|error| error.with_data(json!({ "deletedSessions": deleted })))?;
            deleted += 1;
        }
        Ok(deleted)
    }
}

fn receipt(session_id: &str) -> Value {
    json!({ "sessionId": session_id, "deleted": true, "cleanupComplete": true, "scope": "session" })
}

fn delete_error(error: rpc::Error, stage: &str) -> rpc::Error {
    error.with_data(json!({ "deleteStage": stage, "cleanupComplete": false }))
}
