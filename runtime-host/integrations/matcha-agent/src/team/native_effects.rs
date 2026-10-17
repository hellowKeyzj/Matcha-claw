use organization::ports::native_effects::RoleSessionRetirementOutcome;
use organization::{
    GraphRunId, NativeDeletionEvidence, NativeDeletionProof, RoleAbortOutcome,
    RoleSessionDeleteReceipt, RoleSessionDeletionConfirmation, RoleSessionReceipt,
    RunRuntimeReceipt, RuntimeReceiptOutcome, TeamCreationFailure,
    TeamCreationFailureReason as Reason, TeamCreationStage,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::profiles::{absent, reason};
use crate::client::Client;

fn matches_session(value: &Value, binding: &RoleSessionReceipt) -> bool {
    value.get("sessionId").and_then(Value::as_str) == Some(binding.endpoint_session_id().as_str())
        && value.get("agentId").and_then(Value::as_str) == Some(binding.agent().as_str())
}

pub(super) async fn confirm(
    client: Client,
    receipt: RunRuntimeReceipt,
    cancellation: CancellationToken,
) -> (RuntimeReceiptOutcome, Option<TeamCreationFailure>) {
    let failure = |reason, native_started| {
        (
            match reason {
                _ if native_started => RuntimeReceiptOutcome::OutcomeUnknown,
                Reason::InvalidInput | Reason::RpcRejected | Reason::AgentMissing => {
                    RuntimeReceiptOutcome::Rejected
                }
                Reason::RpcUnavailable => RuntimeReceiptOutcome::Unavailable,
                _ => RuntimeReceiptOutcome::OutcomeUnknown,
            },
            Some(TeamCreationFailure::new(
                TeamCreationStage::InitializingSessions,
                reason,
            )),
        )
    };
    let mut native_started = false;
    for binding in receipt.bindings() {
        let params = json!({"sessionId": binding.endpoint_session_id().as_str()});
        let session = match client
            .call_cancellable("sessions.get", params.clone(), &cancellation)
            .await
        {
            Ok(session) => {
                native_started = true;
                session
            }
            Err(error) if absent(&error) => {
                native_started = true;
                match client.call_cancellable("sessions.create", json!({
                    "agentId": binding.agent().as_str(), "sessionId": binding.endpoint_session_id().as_str(),
                }), &cancellation).await {
                    Ok(_) => {}
                    Err(error) => return failure(reason(&error), native_started),
                }
                match client
                    .call_cancellable("sessions.get", params.clone(), &cancellation)
                    .await
                {
                    Ok(session) => session,
                    Err(error) => return failure(reason(&error), native_started),
                }
            }
            Err(error) => return failure(reason(&error), native_started),
        };
        if !matches_session(&session, binding)
            || session.get("status").and_then(Value::as_str) != Some("open")
        {
            return failure(Reason::NativeReadbackMismatch, native_started);
        }
        let title = format!(
            "{} · {} · {}",
            binding.team_run().as_str(),
            binding.role().as_str(),
            binding.session_ref().as_str()
        );
        if session.get("title").and_then(Value::as_str) != Some(title.as_str()) {
            if let Err(error) = client
                .call_cancellable(
                    "sessions.rename",
                    json!({
                        "sessionId": binding.endpoint_session_id().as_str(), "title": title,
                    }),
                    &cancellation,
                )
                .await
            {
                return failure(reason(&error), native_started);
            }
        }
        match client
            .call_cancellable("sessions.get", params, &cancellation)
            .await
        {
            Ok(observed)
                if matches_session(&observed, binding)
                    && observed.get("status").and_then(Value::as_str) == Some("open")
                    && observed.get("title").and_then(Value::as_str) == Some(title.as_str()) => {}
            Ok(_) => return failure(Reason::NativeReadbackMismatch, native_started),
            Err(error) => return failure(reason(&error), native_started),
        }
    }
    (RuntimeReceiptOutcome::Installed, None)
}

async fn runs(
    client: &Client,
    binding: &RoleSessionReceipt,
    cancellation: &CancellationToken,
) -> Result<Vec<Value>, ()> {
    let mut cursor: Option<String> = None;
    let mut cursors = std::collections::BTreeSet::new();
    let mut runs = Vec::new();
    loop {
        let mut params = json!({"sessionId": binding.endpoint_session_id().as_str()});
        if let Some(cursor) = &cursor {
            params["beforeRunId"] = json!(cursor);
        }
        let page = client
            .call_cancellable("runs.list", params, cancellation)
            .await
            .map_err(|_| ())?;
        let entries = page.get("runs").and_then(Value::as_array).ok_or(())?;
        for run in entries {
            if run.get("sessionId").and_then(Value::as_str)
                != Some(binding.endpoint_session_id().as_str())
                || run.get("runId").and_then(Value::as_str).is_none()
                || run.get("status").and_then(Value::as_str).is_none()
            {
                return Err(());
            }
            runs.push(run.clone());
        }
        match page.get("nextBeforeRunId") {
            Some(Value::String(next)) if !next.is_empty() && cursors.insert(next.clone()) => {
                cursor = Some(next.clone())
            }
            Some(Value::Null) => return Ok(runs),
            _ => return Err(()),
        }
    }
}

fn stopped(run: &Value) -> bool {
    matches!(
        run.get("status").and_then(Value::as_str),
        Some("succeeded" | "failed" | "cancelled")
    )
}

pub(super) async fn abort(
    client: Client,
    bindings: Vec<RoleSessionReceipt>,
    cancellation: CancellationToken,
) -> RoleAbortOutcome {
    for binding in &bindings {
        let session = match client
            .call_cancellable(
                "sessions.get",
                json!({"sessionId": binding.endpoint_session_id().as_str()}),
                &cancellation,
            )
            .await
        {
            Ok(session) if matches_session(&session, binding) => session,
            _ => return RoleAbortOutcome::OutcomeUnknown,
        };
        let Ok(pending) = runs(&client, binding, &cancellation).await else {
            return RoleAbortOutcome::OutcomeUnknown;
        };
        for run in pending.iter().filter(|run| !stopped(run)) {
            if run["status"] == "outcomeUnknown" {
                return RoleAbortOutcome::OutcomeUnknown;
            }
            if client
                .call_cancellable("runs.cancel", json!({"runId": run["runId"]}), &cancellation)
                .await
                .is_err()
            {
                return RoleAbortOutcome::OutcomeUnknown;
            }
        }
        let Ok(observed) = runs(&client, binding, &cancellation).await else {
            return RoleAbortOutcome::OutcomeUnknown;
        };
        if !observed.iter().all(stopped)
            || !matches!(session["status"].as_str(), Some("open" | "closed"))
        {
            return RoleAbortOutcome::OutcomeUnknown;
        }
    }
    RoleAbortOutcome::Confirmed
}

pub(super) async fn retire_unconfirmed(
    client: Client,
    bindings: Vec<RoleSessionReceipt>,
    cancellation: CancellationToken,
) -> RoleSessionRetirementOutcome {
    if bindings.is_empty() {
        return RoleSessionRetirementOutcome::OutcomeUnknown;
    }
    for binding in bindings {
        let params = json!({"sessionId": binding.endpoint_session_id().as_str()});
        match client
            .call_cancellable("sessions.get", params.clone(), &cancellation)
            .await
        {
            Ok(session) if matches_session(&session, &binding) => {
                match client
                    .call_cancellable("sessions.close", params.clone(), &cancellation)
                    .await
                {
                    Ok(closed)
                        if matches_session(&closed, &binding) && closed["status"] == "closed" => {}
                    _ => return RoleSessionRetirementOutcome::OutcomeUnknown,
                }
            }
            Err(error)
                if absent(&error)
                    || (error.code() == Some(-32002) && error.kind() == "session_deleting") => {}
            _ => return RoleSessionRetirementOutcome::OutcomeUnknown,
        }
        match client
            .call_cancellable(
                "sessions.retire",
                json!({
                    "sessionId": binding.endpoint_session_id().as_str(),
                    "expectedAgentId": binding.agent().as_str(),
                }),
                &cancellation,
            )
            .await
        {
            Ok(retired)
                if retired["sessionId"] == binding.endpoint_session_id().as_str()
                    && retired["retired"] == true
                    && retired["cleanupComplete"] == true
                    && retired["scope"] == "session"
                    && matches!(retired["state"].as_str(), Some("absent" | "deleted")) => {}
            _ => return RoleSessionRetirementOutcome::OutcomeUnknown,
        }
        match client
            .call_cancellable("sessions.get", params, &cancellation)
            .await
        {
            Err(error) if absent(&error) => {}
            _ => return RoleSessionRetirementOutcome::OutcomeUnknown,
        }
    }
    RoleSessionRetirementOutcome::Confirmed
}

pub(super) async fn delete(
    client: Client,
    run_id: GraphRunId,
    bindings: Vec<RoleSessionReceipt>,
    abort_first: bool,
    cancellation: CancellationToken,
) -> NativeDeletionEvidence {
    let mut confirmations = Vec::with_capacity(bindings.len());
    for binding in bindings {
        let params = json!({"sessionId": binding.endpoint_session_id().as_str()});
        match client
            .call_cancellable("sessions.get", params.clone(), &cancellation)
            .await
        {
            Ok(session) if matches_session(&session, &binding) => {
                if abort_first {
                    let Ok(pending) = runs(&client, &binding, &cancellation).await else {
                        return NativeDeletionEvidence::OutcomeUnknown;
                    };
                    for run in pending.iter().filter(|run| {
                        matches!(
                            run["status"].as_str(),
                            Some("queued" | "starting" | "running" | "cancelRequested")
                        )
                    }) {
                        if client
                            .call_cancellable(
                                "runs.cancel",
                                json!({"runId": run["runId"]}),
                                &cancellation,
                            )
                            .await
                            .is_err()
                        {
                            return NativeDeletionEvidence::OutcomeUnknown;
                        }
                    }
                }
                // Historical outcomeUnknown is not deletion proof or a cleanup veto.
                match client
                    .call_cancellable("sessions.close", params.clone(), &cancellation)
                    .await
                {
                    Ok(closed)
                        if matches_session(&closed, &binding) && closed["status"] == "closed" => {}
                    _ => return NativeDeletionEvidence::OutcomeUnknown,
                }
            }
            Err(error) if absent(&error) || error.kind() == "session_deleting" => {}
            Ok(_) => return NativeDeletionEvidence::Rejected,
            Err(_) => return NativeDeletionEvidence::OutcomeUnknown,
        }
        let mut delete_params = params.clone();
        delete_params["expectedAgentId"] = json!(binding.agent().as_str());
        match client
            .call_cancellable("sessions.delete", delete_params, &cancellation)
            .await
        {
            Ok(deleted)
                if deleted["sessionId"] == binding.endpoint_session_id().as_str()
                    && deleted["deleted"] == true
                    && deleted["cleanupComplete"] == true
                    && deleted["scope"] == "session" => {}
            _ => return NativeDeletionEvidence::OutcomeUnknown,
        }
        match client
            .call_cancellable("sessions.get", params, &cancellation)
            .await
        {
            Err(error) if absent(&error) => {}
            _ => return NativeDeletionEvidence::OutcomeUnknown,
        }
        let receipt = RoleSessionDeleteReceipt::new(binding.endpoint_session_id().clone());
        let Ok(confirmation) = RoleSessionDeletionConfirmation::try_new(binding, receipt) else {
            return NativeDeletionEvidence::Rejected;
        };
        confirmations.push(confirmation);
    }
    NativeDeletionProof::try_new(run_id, confirmations).map_or(
        NativeDeletionEvidence::Rejected,
        NativeDeletionEvidence::Confirmed,
    )
}
