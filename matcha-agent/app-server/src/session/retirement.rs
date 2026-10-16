use serde::Deserialize;
use serde_json::{Value, json};

use crate::rpc;

use super::{Sessions, history, record};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Retire {
    session_id: String,
    expected_agent_id: String,
}

impl Sessions {
    pub(super) async fn retire(&self, input: Retire) -> rpc::Result<Value> {
        super::validate_uuid(&input.session_id)?;
        crate::config::validate_id(&input.expected_agent_id)?;
        let owner = self.clone();
        tokio::spawn(async move { owner.retire_session(input).await })
            .await
            .map_err(|error| {
                rpc::Error::new(
                    -32006,
                    "session_retire_unknown",
                    "Session retirement could not be confirmed",
                )
                .with_data(json!({ "cleanupComplete": false }))
                .with_source(error)
            })?
    }

    async fn retire_session(&self, input: Retire) -> rpc::Result<Value> {
        self.accepting()?;
        let admission = self.agent_guard(&input.expected_agent_id).await;
        self.accepting()?;
        if let Some(deletion) = record::deletion_state(
            &self.0.database,
            &input.session_id,
            Some(&input.expected_agent_id),
        )
        .await
        .map_err(|error| retire_error(error, "intent"))?
            && deletion.cleanup_complete
        {
            self.0.sessions.write().await.remove(&input.session_id);
            return Ok(receipt(&input.session_id, deletion.had_session));
        }
        let session = self.0.sessions.read().await.get(&input.session_id).cloned();
        if let Some(session) = session {
            if session.data.lock().await.record.agent_id != input.expected_agent_id {
                return Err(retire_error(
                    rpc::Error::conflict(
                        "session_agent_mismatch",
                        "This session identity belongs to another Agent",
                    ),
                    "intent",
                ));
            }
            // The existing deletion path checks Closed/quiescent before accepting
            // intent, then stops/joins the executor and proves each owned cleanup.
            self.delete_session_guarded(session, Some(admission))
                .await
                .map_err(|error| retire_error(error, "session"))?;
            return Ok(receipt(&input.session_id, true));
        }
        let deletion = record::begin_retirement(
            &self.0.database,
            &input.session_id,
            &input.expected_agent_id,
            None,
        )
        .await
        .map_err(|error| retire_error(error, "intent"))?;
        // No record means no proof of CLI artifact custody. Fence late creation,
        // but never turn an unexpected native artifact into permission to delete it.
        let paths = self.0.config.paths();
        history::assert_absent(
            &paths.runtime(&input.expected_agent_id)?,
            &paths.workspace(&input.expected_agent_id)?,
            &input.session_id,
        )
        .await
        .map_err(|error| retire_error(error, "native_artifacts"))?;
        self.0
            .media
            .clear_session(&input.session_id)
            .map_err(|error| retire_error(error, "media"))?;
        self.0
            .interactions
            .delete_session(&input.session_id)
            .await
            .map_err(|error| retire_error(error, "interactions"))?;
        self.0
            .events
            .delete_session(&input.session_id)
            .await
            .map_err(|error| retire_error(error, "events"))?;
        record::delete(&self.0.database, &input.session_id)
            .await
            .map_err(|error| retire_error(error, "records"))?;
        drop(admission);
        Ok(receipt(&input.session_id, deletion.had_session))
    }
}

fn receipt(session_id: &str, had_session: bool) -> Value {
    json!({
        "sessionId": session_id, "retired": true, "cleanupComplete": true,
        "scope": "session", "state": if had_session { "deleted" } else { "absent" },
    })
}

fn retire_error(error: rpc::Error, stage: &str) -> rpc::Error {
    error.with_data(json!({ "retireStage": stage, "cleanupComplete": false }))
}
