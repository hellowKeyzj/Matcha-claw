use crate::{
    client::Client,
    provider::{ProjectionFailureKind, ProjectionRemoteKind, project_session_runtime},
    session::{
        model::SessionRecord,
        projection::parse_session_key,
        rpc::{self, Failure, FailureKind},
    },
};
use serde_json::json;
use sessions_module::{
    model_selection::{
        MatchaSessionModelRuntimeCommand, ResolvedSessionModelSelection,
        SessionModelSelectionBinding, SessionModelSelectionOutcome, SessionModelSelectionRejection,
    },
    send::{NativeEndpoint, SessionSendOutcome},
    state::{SessionIdentity, SessionModelState},
};
use tokio_util::sync::CancellationToken;

pub(super) async fn restore(
    client: &Client,
    identity: &SessionIdentity,
    endpoint_session_id: Option<&str>,
    trace_id: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Option<MatchaSessionModelRuntimeCommand>, SessionSendOutcome> {
    if cancel.is_cancelled() {
        return Err(SessionSendOutcome::Unavailable);
    }
    let record = rpc::bound(
        client,
        identity,
        endpoint_session_id,
    )
    .await
    .map_err(super::model::send_failure)?;
    let native = rpc::call_cancellable(
        client,
        "sessions.native",
        json!({"sessionId":record.session_id.as_str()}),
        cancel,
    )
    .await
    .map_err(super::model::send_failure)?;
    if native.get("sessionId").and_then(|v| v.as_str()) != Some(record.session_id.as_str())
        || native.get("agentId").and_then(|v| v.as_str()) != Some(record.agent_id.as_str())
    {
        return Err(SessionSendOutcome::Unknown);
    }
    match native.get("instanceId") {
        Some(serde_json::Value::String(instance)) if !instance.is_empty() => return Ok(None),
        Some(serde_json::Value::Null) => {}
        _ => return Err(SessionSendOutcome::Unknown),
    }
    if record.model_selection_id.is_none()
        && record.provider_fingerprint.is_none()
        && record.provider_id.is_none()
    {
        return Ok(None);
    }
    let model = record.model.ok_or(SessionSendOutcome::Rejected)?;
    let command = MatchaSessionModelRuntimeCommand::try_new(
        identity.session_key.clone(),
        Some(record.session_id.as_str().to_owned()),
        model,
        record.model_selection_id,
        record.provider_fingerprint,
    )
    .map_err(|_| SessionSendOutcome::Rejected)?
    .with_trace_id(trace_id.map(str::to_owned));
    Ok(Some(command))
}

pub(super) async fn select(
    client: &Client,
    command: ResolvedSessionModelSelection,
    cancel: &CancellationToken,
) -> SessionModelSelectionOutcome {
    use SessionModelSelectionOutcome as Outcome;
    if cancel.is_cancelled() {
        return Outcome::Unavailable;
    }
    if command.endpoint != NativeEndpoint::MatchaAgentLocal {
        return Outcome::target_rejected(SessionModelSelectionRejection::BindingMismatch);
    }
    let Some((agent, id)) = parse_session_key(&command.session_key) else {
        return Outcome::target_rejected(SessionModelSelectionRejection::InvalidSessionKey);
    };
    if command.endpoint_session_id.as_deref() != Some(id) {
        return Outcome::target_rejected(SessionModelSelectionRejection::InvalidSessionKey);
    }
    if let Err(error) = rpc::get(client, id, Some(agent)).await {
        return failure(error);
    }
    let SessionModelSelectionBinding::Matcha {
        model,
        provider_fingerprint,
        ..
    } = &command.binding
    else {
        return Outcome::target_rejected(SessionModelSelectionRejection::BindingMismatch);
    };
    let Ok(mut model_state) = SessionModelState::selected_from_ref(model) else {
        return Outcome::target_rejected(SessionModelSelectionRejection::InvalidModel);
    };
    let provider = match project_session_runtime(client, &command).await {
        Ok(provider) => provider,
        Err(error) => {
            return match error.kind() {
                ProjectionFailureKind::NotSent | ProjectionFailureKind::CredentialUnavailable => {
                    Outcome::Unavailable
                }
                ProjectionFailureKind::Unknown | ProjectionFailureKind::InvalidReadback => {
                    Outcome::OutcomeUnknown
                }
                ProjectionFailureKind::Remote {
                    kind: ProjectionRemoteKind::CommitUnknown,
                    ..
                } => Outcome::OutcomeUnknown,
                ProjectionFailureKind::Remote {
                    kind: ProjectionRemoteKind::Unavailable,
                    ..
                } => Outcome::Unavailable,
                _ => Outcome::target_rejected(
                    SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
                ),
            };
        }
    };
    let result=rpc::call_cancellable(client,"sessions.setModel",json!({
        "sessionId":id,"model":model,"providerId":provider,"modelSelectionId":command.model_selection_id,"providerFingerprint":provider_fingerprint,
    }),cancel).await;
    let receipt = match result {
        Ok(receipt) => receipt,
        Err(error) => return failure(error),
    };
    let record: SessionRecord = match receipt.get("session").cloned().map(rpc::decode) {
        Some(Ok(record)) => record,
        _ => return Outcome::OutcomeUnknown,
    };
    if !record.validate(id, Some(agent))
        || record.model.as_ref() != Some(model)
        || record.provider_id.as_deref() != Some(provider.as_str())
        || record.model_selection_id.as_deref() != Some(command.model_selection_id.as_str())
        || record.provider_fingerprint.as_ref() != Some(provider_fingerprint)
    {
        return Outcome::OutcomeUnknown;
    }
    model_state.selection_id = record.model_selection_id;
    Outcome::Succeeded { model_state }
}
fn failure(error: Failure) -> SessionModelSelectionOutcome {
    use SessionModelSelectionOutcome as Outcome;
    if error.is_not_found() {
        return Outcome::target_rejected(SessionModelSelectionRejection::SessionNotFound);
    }
    match error.kind() {
        FailureKind::Rejected => {
            Outcome::target_rejected(SessionModelSelectionRejection::RuntimeTargetRejected)
        }
        FailureKind::Unknown => Outcome::OutcomeUnknown,
        _ => Outcome::Unavailable,
    }
}
