use futures_util::{StreamExt, stream};
use organization::ports::native_effects::RoleSessionRetirementOutcome;
use organization::{
    GraphRunId, NativeDeletionEvidence, NativeDeletionFailure, RoleAbortOutcome,
    RoleSessionDeleteReceipt, RoleSessionDeletionConfirmation, RoleSessionReceipt,
    RoleSessionSubmission, RunRuntimeReceipt, RunWorkspace, RuntimeReceiptOutcome, TeamCreationFailure,
    TeamCreationFailureReason as Reason, TeamCreationStage,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

use super::profiles::{absent, reason};
use crate::{
    client::Client,
    session::model::{RunRecord, RunStatus, SessionRecord},
};

fn matches_session(value: &Value, binding: &RoleSessionReceipt) -> bool {
    value.get("sessionId").and_then(Value::as_str) == Some(binding.endpoint_session_id().as_str())
        && value.get("agentId").and_then(Value::as_str) == Some(binding.agent().as_str())
}

fn matches_workspace(
    value: &Value,
    binding: &RoleSessionReceipt,
    workspace: Option<&RunWorkspace>,
) -> bool {
    SessionRecord::deserialize(value).is_ok_and(|record| {
        record.validate(binding.endpoint_session_id().as_str(), Some(binding.agent().as_str()))
            && workspace.is_none_or(|workspace| {
                workspace.is_prepared() && Path::new(&record.cwd) == workspace.root()
            })
    })
}

pub(super) async fn confirm(
    client: Client,
    receipt: RunRuntimeReceipt,
    workspace: Option<RunWorkspace>,
    cancellation: CancellationToken,
    submission: &mut RoleSessionSubmission,
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
    if workspace.as_ref().is_some_and(|workspace| {
        !workspace.is_prepared() || workspace.root().to_str().is_none_or(|root| root.contains('\0'))
    }) {
        return failure(Reason::InvalidInput, false);
    }
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
                let mut create = json!({
                    "agentId": binding.agent().as_str(), "sessionId": binding.endpoint_session_id().as_str(),
                });
                if let Some(workspace) = &workspace {
                    create["cwd"] = json!(workspace.root());
                }
                match client.call_cancellable("sessions.create", create, &cancellation).await {
                    Ok(_) => {}
                    Err(error) => {
                        if error.delivery() == crate::client::Delivery::Unknown {
                            *submission = RoleSessionSubmission::Unknown;
                        }
                        return failure(reason(&error), native_started);
                    }
                }
                match client
                    .call_cancellable("sessions.get", params, &cancellation)
                    .await
                {
                    Ok(session) => session,
                    Err(error) => return failure(reason(&error), native_started),
                }
            }
            Err(error) => return failure(reason(&error), native_started),
        };
        if !matches_workspace(&session, binding, workspace.as_ref()) || session["status"] != "open" {
            return failure(Reason::NativeReadbackMismatch, native_started);
        }
    }
    (RuntimeReceiptOutcome::Installed, None)
}

pub(super) async fn readback(
    client: Client,
    binding: RoleSessionReceipt,
    workspace: Option<RunWorkspace>,
    cancellation: CancellationToken,
) -> (RuntimeReceiptOutcome, Option<TeamCreationFailure>) {
    let (outcome, reason) = match client
        .call_cancellable(
            "sessions.get",
            json!({"sessionId": binding.endpoint_session_id().as_str()}),
            &cancellation,
        )
        .await
    {
        Ok(session) if matches_workspace(&session, &binding, workspace.as_ref()) && session["status"] == "open" => {
            return (RuntimeReceiptOutcome::Installed, None);
        }
        Ok(_) => (RuntimeReceiptOutcome::OutcomeUnknown, Reason::NativeReadbackMismatch),
        Err(error) if absent(&error) => (RuntimeReceiptOutcome::Unavailable, Reason::NativeReadbackMismatch),
        Err(error) => (RuntimeReceiptOutcome::Unavailable, reason(&error)),
    };
    (outcome, Some(TeamCreationFailure::new(TeamCreationStage::InitializingSessions, reason)))
}

pub(super) async fn validate_run_files(
    client: Client,
    binding: RoleSessionReceipt,
    workspace: RunWorkspace,
    paths: Vec<String>,
    cancellation: CancellationToken,
) -> Result<(), organization::RunFileValidationError> {
    use organization::RunFileValidationError as Error;

    if paths.is_empty() {
        return Ok(());
    }
    let paths = organization::run::artifact::normalize_delivery_files(paths)
        .map_err(|_| Error::InvalidPath)?;
    if !workspace.is_prepared() {
        return Err(Error::Unavailable);
    }
    let session = client.call_cancellable(
        "sessions.get",
        json!({"sessionId": binding.endpoint_session_id().as_str()}),
        &cancellation,
    ).await.map_err(|_| Error::Unavailable)?;
    if !matches_workspace(&session, &binding, Some(&workspace)) || session["status"] == "deleting" {
        return Err(Error::Unavailable);
    }
    for path in paths {
        let stat = client.call_cancellable(
            "workspace.stat",
            json!({
                "agentId": binding.agent().as_str(),
                "sessionId": binding.endpoint_session_id().as_str(),
                "path": path,
            }),
            &cancellation,
        ).await.map_err(|error| match error.kind() {
            "workspace_not_found" => Error::MissingFile,
            "invalid_params" | "workspace_link_forbidden" | "workspace_hardlink_forbidden"
            | "workspace_not_directory" | "workspace_special_file" => Error::InvalidPath,
            _ => Error::Unavailable,
        })?;
        if stat["agentId"] != binding.agent().as_str() || stat["path"] != path
            || stat["sessionId"].as_str() != Some(binding.endpoint_session_id().as_str())
            || stat["root"].as_str().is_none_or(|root| Path::new(root) != workspace.root())
        {
            return Err(Error::Unavailable);
        }
        match stat["kind"].as_str() {
            Some("file") => {}
            Some("directory" | "symlink" | "other") => return Err(Error::InvalidPath),
            _ => return Err(Error::Unavailable),
        }
    }
    Ok(())
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

async fn pending_runs(
    client: &Client,
    binding: &RoleSessionReceipt,
    cancellation: &CancellationToken,
) -> Result<Vec<RunRecord>, ()> {
    let mut pending = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for value in runs(client, binding, cancellation).await? {
        let run = RunRecord::deserialize(value).map_err(|_| ())?;
        if !run.validate(binding.endpoint_session_id().as_str())
            || !ids.insert(run.run_id.clone())
            || run.status == RunStatus::OutcomeUnknown
        {
            return Err(());
        }
        if !run.status.terminal() {
            pending.push(run);
        }
    }
    Ok(pending)
}

async fn read_cancellation_run(
    client: &Client,
    binding: &RoleSessionReceipt,
    expected: &RunRecord,
    cancellation: &CancellationToken,
) -> Result<RunRecord, ()> {
    let value = client.call_cancellable(
        "runs.get", json!({"runId": expected.run_id}), cancellation,
    ).await.map_err(|_| ())?;
    let run = RunRecord::deserialize(value).map_err(|_| ())?;
    if !run.validate(binding.endpoint_session_id().as_str())
        || run.run_id != expected.run_id || run.message_id != expected.message_id
    {
        return Err(());
    }
    Ok(run)
}

pub(super) async fn confirm_cancellation(
    client: Client,
    bindings: Vec<RoleSessionReceipt>,
    abort_first: bool,
    cancellation: CancellationToken,
) -> RoleAbortOutcome {
    let confirmation = async {
        let client = &client;
        let cancellation = &cancellation;
        // Complete cancellation delivery for every binding before waiting for terminal outcomes.
        let pending = stream::iter(bindings.into_iter().map(|binding| async move {
            let pending = prepare_cancellation(client, &binding, abort_first, cancellation).await;
            (binding, pending)
        })).buffer_unordered(4).collect::<Vec<_>>().await;
        let outcomes = stream::iter(pending.into_iter().map(|(binding, pending)| async move {
            match pending {
                Ok(pending) => confirm_binding_cancellation(client, &binding, pending, cancellation).await,
                Err(()) => RoleAbortOutcome::OutcomeUnknown,
            }
        })).buffer_unordered(4).collect::<Vec<_>>().await;
        if outcomes.into_iter().all(|outcome| outcome == RoleAbortOutcome::Confirmed) {
            RoleAbortOutcome::Confirmed
        } else {
            RoleAbortOutcome::OutcomeUnknown
        }
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => RoleAbortOutcome::OutcomeUnknown,
        outcome = tokio::time::timeout(Duration::from_secs(20), confirmation) => match outcome {
            Ok(outcome) if !cancellation.is_cancelled() => outcome,
            _ => RoleAbortOutcome::OutcomeUnknown,
        },
    }
}

async fn prepare_cancellation(
    client: &Client,
    binding: &RoleSessionReceipt,
    abort_first: bool,
    cancellation: &CancellationToken,
) -> Result<Vec<RunRecord>, ()> {
    let params = json!({"sessionId": binding.endpoint_session_id().as_str()});
    match client.call_cancellable("sessions.get", params, cancellation).await {
        Ok(session) if matches_session(&session, binding)
            && matches!(session["status"].as_str(), Some("open" | "closed")) => {}
        _ => return Err(()),
    }
    let pending = pending_runs(client, binding, cancellation).await?;
    if abort_first {
        for expected in &pending {
            let run = read_cancellation_run(client, binding, expected, cancellation).await?;
            if run.status == RunStatus::OutcomeUnknown {
                return Err(());
            }
            if !run.status.terminal() && run.status != RunStatus::CancelRequested {
                client.call_cancellable(
                    "runs.cancel", json!({"runId": run.run_id}), cancellation,
                ).await.map_err(|_| ())?;
            }
        }
    }
    Ok(pending)
}

async fn confirm_binding_cancellation(
    client: &Client,
    binding: &RoleSessionReceipt,
    pending: Vec<RunRecord>,
    cancellation: &CancellationToken,
) -> RoleAbortOutcome {
    // runs.cancel acknowledges interrupt delivery, not the persisted terminal outcome.
    for expected in &pending {
        loop {
            let Ok(run) = read_cancellation_run(client, binding, expected, cancellation).await else {
                return RoleAbortOutcome::OutcomeUnknown;
            };
            match run.status {
                RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled => break,
                RunStatus::OutcomeUnknown => return RoleAbortOutcome::OutcomeUnknown,
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
    // Check once for runs admitted after the initial listing, never cancel them again.
    match pending_runs(client, binding, cancellation).await {
        Ok(pending) if pending.is_empty() => {}
        _ => return RoleAbortOutcome::OutcomeUnknown,
    }
    match client.call_cancellable(
        "sessions.get", json!({"sessionId": binding.endpoint_session_id().as_str()}), cancellation,
    ).await {
        Ok(session) if matches_session(&session, binding)
            && matches!(session["status"].as_str(), Some("open" | "closed")) => RoleAbortOutcome::Confirmed,
        _ => RoleAbortOutcome::OutcomeUnknown,
    }
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
    let outcomes = stream::iter(bindings.into_iter().map(|binding| {
        delete_binding(client.clone(), binding, abort_first, cancellation.clone())
    })).buffer_unordered(4).collect::<Vec<_>>().await;
    let mut confirmations = Vec::with_capacity(outcomes.len());
    let mut failure = None;
    for outcome in outcomes {
        match outcome {
            Ok(confirmation) => confirmations.push(confirmation),
            Err(error) => failure = failure.max(Some(error)),
        }
    }
    NativeDeletionEvidence::from_confirmations(run_id, confirmations, failure)
}

async fn delete_binding(
    client: Client,
    binding: RoleSessionReceipt,
    abort_first: bool,
    cancellation: CancellationToken,
) -> Result<RoleSessionDeletionConfirmation, NativeDeletionFailure> {
    let params = json!({"sessionId": binding.endpoint_session_id().as_str()});
    match client
        .call_cancellable("sessions.get", params.clone(), &cancellation)
        .await
    {
        Ok(session) if matches_session(&session, &binding) => {
            if abort_first {
                let Ok(pending) = runs(&client, &binding, &cancellation).await else {
                    return Err(NativeDeletionFailure::OutcomeUnknown);
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
                        return Err(NativeDeletionFailure::OutcomeUnknown);
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
                _ => return Err(NativeDeletionFailure::OutcomeUnknown),
            }
        }
        Err(error) if absent(&error) || error.kind() == "session_deleting" => {}
        Ok(_) => return Err(NativeDeletionFailure::Rejected),
        Err(_) => return Err(NativeDeletionFailure::OutcomeUnknown),
    }
    let mut delete_params = params.clone();
    delete_params["expectedAgentId"] = json!(binding.agent().as_str());
    match client
        .call_cancellable("sessions.retire", delete_params, &cancellation)
        .await
    {
        Ok(deleted)
            if deleted["sessionId"] == binding.endpoint_session_id().as_str()
                && deleted["retired"] == true
                && deleted["cleanupComplete"] == true
                && deleted["scope"] == "session"
                && matches!(deleted["state"].as_str(), Some("absent" | "deleted")) => {}
        _ => return Err(NativeDeletionFailure::OutcomeUnknown),
    }
    match client
        .call_cancellable("sessions.get", params, &cancellation)
        .await
    {
        Err(error) if absent(&error) => {}
        _ => return Err(NativeDeletionFailure::OutcomeUnknown),
    }
    let receipt = RoleSessionDeleteReceipt::new(binding.endpoint_session_id().clone());
    let Ok(confirmation) = RoleSessionDeletionConfirmation::try_new(binding, receipt) else {
        return Err(NativeDeletionFailure::Rejected);
    };
    Ok(confirmation)
}
