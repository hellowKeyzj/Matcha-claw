use crate::{
    session::{client::AppServerClientError, model::SessionId},
};

use sessions_module::{
    model_selection::{MatchaProviderRuntimeConfig, SessionModelSelectionOutcome},
    send::{Attachment, SessionSendCommand, SessionSendOutcome},
};

pub(super) fn matcha_native_session_id(endpoint_session_id: Option<&str>) -> Result<SessionId, ()> {
    let session_id = endpoint_session_id.ok_or(())?;
    SessionId::try_new(session_id.to_owned()).map_err(|_| ())
}

pub(super) fn matcha_provider_runtime_trace(
    provider_runtime: &MatchaProviderRuntimeConfig,
) -> serde_json::Value {
    match provider_runtime {
        MatchaProviderRuntimeConfig::AnthropicMessages { base_url, api_key } => {
            serde_json::json!({
                "providerRuntimeKind": "anthropicMessages",
                "hasBaseUrl": base_url.is_some(),
                "hasApiKey": api_key.is_some(),
            })
        }
        MatchaProviderRuntimeConfig::GoogleGenerativeAi { base_url, api_key } => {
            serde_json::json!({
                "providerRuntimeKind": "googleGenerativeAi",
                "hasBaseUrl": base_url.is_some(),
                "hasApiKey": api_key.is_some(),
            })
        }
        MatchaProviderRuntimeConfig::OpenAiChatCompletions { base_url, api_key } => {
            serde_json::json!({
                "providerRuntimeKind": "openAiChatCompletions",
                "hasBaseUrl": base_url.is_some(),
                "hasApiKey": api_key.is_some(),
            })
        }
        MatchaProviderRuntimeConfig::OpenAiResponses { base_url, api_key } => {
            serde_json::json!({
                "providerRuntimeKind": "openAiResponses",
                "hasBaseUrl": base_url.is_some(),
                "hasApiKey": api_key.is_some(),
            })
        }
    }
}

pub(super) fn session_model_selection_outcome_label(
    outcome: &SessionModelSelectionOutcome,
) -> &'static str {
    match outcome {
        SessionModelSelectionOutcome::Succeeded { .. } => "succeeded",
        SessionModelSelectionOutcome::TargetRejected { .. } => "target_rejected",
        SessionModelSelectionOutcome::OutcomeUnknown => "outcome_unknown",
        SessionModelSelectionOutcome::Unsupported => "unsupported",
        SessionModelSelectionOutcome::Unavailable => "unavailable",
    }
}

pub(super) fn matcha_provider_runtime(
    provider_runtime: MatchaProviderRuntimeConfig,
) -> crate::session::request::SessionProviderRuntime {
    match provider_runtime {
        MatchaProviderRuntimeConfig::AnthropicMessages { base_url, api_key } => {
            crate::session::request::SessionProviderRuntime::anthropic_messages(
                base_url,
                api_key.map(|value| value.into_private_string()),
            )
        }
        MatchaProviderRuntimeConfig::GoogleGenerativeAi { base_url, api_key } => {
            crate::session::request::SessionProviderRuntime::google_generative_ai(
                base_url,
                api_key.map(|value| value.into_private_string()),
            )
        }
        MatchaProviderRuntimeConfig::OpenAiChatCompletions { base_url, api_key } => {
            crate::session::request::SessionProviderRuntime::open_ai_chat_completions(
                base_url,
                api_key.map(|value| value.into_private_string()),
            )
        }
        MatchaProviderRuntimeConfig::OpenAiResponses { base_url, api_key } => {
            crate::session::request::SessionProviderRuntime::open_ai_responses(
                base_url,
                api_key.map(|value| value.into_private_string()),
            )
        }
    }
}

pub(super) fn app_server_client_error_kind(error: AppServerClientError) -> &'static str {
    match error {
        AppServerClientError::InvalidEndpoint => "invalid-endpoint",
        AppServerClientError::HealthDeadline => "health-deadline",
        AppServerClientError::HealthFailed => "health-failed",
        AppServerClientError::UpgradeDeadline => "upgrade-deadline",
        AppServerClientError::UpgradeFailed => "upgrade-failed",
        AppServerClientError::InitializeFailed => "initialize-failed",
        AppServerClientError::RequestDeadline => "request-deadline",
        AppServerClientError::ConnectionClosed => "connection-closed",
        AppServerClientError::UnknownResponse => "unknown-response",
        AppServerClientError::Transport => "transport",
        AppServerClientError::Protocol => "protocol",
        AppServerClientError::PeerRejected => "peer-rejected",
        AppServerClientError::SessionNotFound => "session-not-found",
        AppServerClientError::EventRecoveryRequired => "event-recovery-required",
        AppServerClientError::CloseFailed => "close-failed",
    }
}

pub(super) fn load_session_failure_outcome(error: AppServerClientError) -> SessionSendOutcome {
    match error {
        AppServerClientError::SessionNotFound | AppServerClientError::PeerRejected => {
            SessionSendOutcome::Rejected
        }
        AppServerClientError::HealthDeadline
        | AppServerClientError::HealthFailed
        | AppServerClientError::UpgradeDeadline
        | AppServerClientError::UpgradeFailed
        | AppServerClientError::InitializeFailed
        | AppServerClientError::RequestDeadline
        | AppServerClientError::ConnectionClosed
        | AppServerClientError::Transport => SessionSendOutcome::Unavailable,
        AppServerClientError::InvalidEndpoint
        | AppServerClientError::UnknownResponse
        | AppServerClientError::Protocol
        | AppServerClientError::EventRecoveryRequired
        | AppServerClientError::CloseFailed => SessionSendOutcome::Unknown,
    }
}

pub(super) fn session_prompt_params(
    command: SessionSendCommand,
    session_id: SessionId,
) -> Result<crate::session::request::SessionPromptParams, ()> {
    let run_id = command.request_run_identity().ok_or(())?.to_owned();
    let run_id = crate::session::model::RunId::try_new(run_id).map_err(|_| ())?;
    let params = crate::session::request::SessionPromptParams::try_new(session_id, command.message)
        .map_err(|_| ())?
        .with_run_id(run_id);
    if command.attachments.is_empty() {
        return Ok(params);
    }
    let attachments = command
        .attachments
        .into_iter()
        .map(map_attachment)
        .collect::<Result<Vec<_>, ()>>()?;
    let attachments =
        crate::session::request::AttachmentPromptPayload::try_new(attachments).map_err(|_| ())?;
    Ok(params.with_attachments(attachments))
}

fn map_attachment(attachment: Attachment) -> Result<crate::session::request::PromptAttachment, ()> {
    crate::session::request::PromptAttachment::try_new(
        attachment.file_name,
        attachment.mime_type,
        attachment.content,
    )
    .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::*;
    use sessions_module::send::NativeEndpoint;

    fn native_session_id(value: &str) -> SessionId {
        SessionId::try_new(value.to_owned()).unwrap()
    }

    #[test]
    fn text_send_omits_the_app_server_attachment_payload() {
        let params = session_prompt_params(
            SessionSendCommand::try_new(
                NativeEndpoint::MatchaAgentLocal,
                "session-1".into(),
                None,
                "renderer-route:test".into(),
                "describe this".into(),
                Some("run-1".into()),
                None,
                None,
                vec![],
                None,
            )
            .unwrap(),
            native_session_id("native-session-1"),
        )
        .unwrap();

        assert_eq!(
            to_value(params).unwrap(),
            json!({
                "sessionId": "native-session-1",
                "prompt": "describe this",
                "runId": "run-1",
            })
        );
    }

    #[test]
    fn session_prompt_params_uses_resolved_matcha_session_binding() {
        let params = session_prompt_params(
            SessionSendCommand::try_new(
                NativeEndpoint::MatchaAgentLocal,
                "matcha-agent:matcha:native-session-1".into(),
                Some("native-session-1".into()),
                "renderer-route:test".into(),
                "describe this".into(),
                Some("run-1".into()),
                None,
                None,
                vec![],
                None,
            )
            .unwrap(),
            native_session_id("native-session-1"),
        )
        .unwrap();

        assert_eq!(to_value(params).unwrap()["sessionId"], "native-session-1");
    }

    #[test]
    fn idempotency_only_send_uses_request_run_identity() {
        let params = session_prompt_params(
            SessionSendCommand::try_new(
                NativeEndpoint::MatchaAgentLocal,
                "session-1".into(),
                None,
                "renderer-route:test".into(),
                "describe this".into(),
                None,
                Some("idempotency-1".into()),
                None,
                vec![],
                None,
            )
            .unwrap(),
            native_session_id("native-session-1"),
        )
        .unwrap();

        assert_eq!(
            to_value(params).unwrap(),
            json!({
                "sessionId": "native-session-1",
                "prompt": "describe this",
                "runId": "idempotency-1",
            })
        );
    }

    #[test]
    fn attachment_send_maps_to_the_typed_app_server_attachment_payload() {
        let params = session_prompt_params(
            SessionSendCommand::try_new(
                NativeEndpoint::MatchaAgentLocal,
                "session-1".into(),
                None,
                "renderer-route:test".into(),
                "describe this".into(),
                Some("run-1".into()),
                None,
                None,
                vec![Attachment {
                    mime_type: "application/pdf".into(),
                    file_name: "review.pdf".into(),
                    content: "aGVsbG8=".into(),
                }],
                None,
            )
            .unwrap(),
            native_session_id("native-session-1"),
        )
        .unwrap();

        let payload = to_value(params).unwrap();
        assert_eq!(
            payload,
            json!({
                "sessionId": "native-session-1",
                "prompt": "describe this",
                "runId": "run-1",
                "payload": {
                    "version": "attachments-v1",
                    "attachments": [{
                        "name": "review.pdf",
                        "mediaType": "application/pdf",
                        "data": "aGVsbG8="
                    }],
                },
            })
        );
        assert!(!payload.to_string().contains("private-image.png"));
    }
}
