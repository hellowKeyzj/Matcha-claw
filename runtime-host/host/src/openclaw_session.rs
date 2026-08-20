use serde::{Deserialize, Serialize};

use openclaw::session::protocol::{
    ChatAbortParams, ChatAbortResult, ChatHistoryResult, ChatSendParams, ChatSendResult,
    ChatSendStatus, HistoryMessage, HistoryRole, RunId, SessionKey,
};
use platform::exchange::InvocationOutcome;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidPayload;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AbortChatRequest {
    session_key: String,
    run_id: Option<String>,
}

impl AbortChatRequest {
    pub(crate) fn into_params(self) -> Result<ChatAbortParams, InvalidPayload> {
        let params = ChatAbortParams::new(identity(self.session_key, SessionKey::try_new)?);
        match self.run_id {
            Some(run_id) => identity(run_id, RunId::try_new).map(|run_id| params.for_run(run_id)),
            None => Ok(params),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendChatRequest {
    session_key: String,
    message: String,
    run_id: String,
}

impl SendChatRequest {
    pub(crate) fn into_params(self) -> Result<ChatSendParams, InvalidPayload> {
        ChatSendParams::try_new(
            identity(self.session_key, SessionKey::try_new)?,
            self.message,
            identity(self.run_id, RunId::try_new)?,
        )
        .map_err(|_| InvalidPayload)
    }
}

fn identity<T>(
    value: String,
    parse: impl FnOnce(String) -> Result<T, openclaw::session::protocol::ValidationError>,
) -> Result<T, InvalidPayload> {
    (!value.trim().is_empty())
        .then_some(value)
        .ok_or(InvalidPayload)
        .and_then(|value| parse(value).map_err(|_| InvalidPayload))
}

#[derive(Serialize)]
pub(crate) struct ChatHistoryResponse {
    messages: Vec<History>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct History {
    role: HistoryRole,
    text: String,
}

impl From<ChatHistoryResult> for ChatHistoryResponse {
    fn from(result: ChatHistoryResult) -> Self {
        Self {
            messages: result.messages.into_iter().map(History::from).collect(),
        }
    }
}

impl From<HistoryMessage> for History {
    fn from(message: HistoryMessage) -> Self {
        Self {
            role: message.role,
            text: message.text,
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum SendChatResponse {
    Succeeded {
        #[serde(rename = "runId")]
        run_id: String,
        status: SendStatus,
    },
    TargetRejected,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SendStatus {
    Started,
    InFlight,
    Ok,
}

impl<E> From<InvocationOutcome<ChatSendResult, E>> for SendChatResponse {
    fn from(outcome: InvocationOutcome<ChatSendResult, E>) -> Self {
        match outcome {
            InvocationOutcome::Succeeded(result) => Self::Succeeded {
                run_id: result.run_id.as_str().to_owned(),
                status: result.status.into(),
            },
            InvocationOutcome::TargetRejected(_) => Self::TargetRejected,
            InvocationOutcome::Cancelled | InvocationOutcome::Unknown => Self::Unknown,
        }
    }
}

impl From<ChatSendStatus> for SendStatus {
    fn from(status: ChatSendStatus) -> Self {
        match status {
            ChatSendStatus::Started => Self::Started,
            ChatSendStatus::InFlight => Self::InFlight,
            ChatSendStatus::Ok => Self::Ok,
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum AbortChatResponse {
    Succeeded { aborted: bool },
    TargetRejected,
    Unknown,
}

impl<E> From<InvocationOutcome<ChatAbortResult, E>> for AbortChatResponse {
    fn from(outcome: InvocationOutcome<ChatAbortResult, E>) -> Self {
        match outcome {
            InvocationOutcome::Succeeded(result) => Self::Succeeded {
                aborted: result.aborted,
            },
            InvocationOutcome::TargetRejected(_) => Self::TargetRejected,
            InvocationOutcome::Cancelled | InvocationOutcome::Unknown => Self::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::*;

    #[test]
    fn history_projection_exposes_only_roles_and_text() {
        let projected = to_value(ChatHistoryResponse::from(ChatHistoryResult {
            messages: vec![
                HistoryMessage {
                    role: HistoryRole::User,
                    text: "private input".into(),
                },
                HistoryMessage {
                    role: HistoryRole::Assistant,
                    text: "private output".into(),
                },
            ],
        }))
        .unwrap();

        assert_eq!(
            projected,
            json!({
                "messages": [
                    { "role": "user", "text": "private input" },
                    { "role": "assistant", "text": "private output" },
                ],
            })
        );
        let rendered = projected.to_string();
        for canary in [
            "sessionKey",
            "sessionId",
            "metadata",
            "rawPayload",
            "private-session-id",
            "private-metadata",
        ] {
            assert!(!rendered.contains(canary));
        }
    }

    #[test]
    fn mutation_projections_preserve_the_delivery_outcome_without_peer_errors() {
        let send = SendChatResponse::from(InvocationOutcome::<_, ()>::Succeeded(ChatSendResult {
            run_id: RunId::try_new("run-1").unwrap(),
            status: ChatSendStatus::InFlight,
        }));
        assert_eq!(
            to_value(send).unwrap(),
            json!({"outcome": "succeeded", "runId": "run-1", "status": "in_flight"})
        );
        assert_eq!(
            to_value(SendChatResponse::from(
                InvocationOutcome::<ChatSendResult, _>::TargetRejected("peer-error")
            ))
            .unwrap(),
            json!({"outcome": "target_rejected"})
        );
        assert_eq!(
            to_value(AbortChatResponse::from(InvocationOutcome::<
                ChatAbortResult,
                (),
            >::Succeeded(
                ChatAbortResult {
                    ok: true,
                    aborted: false,
                    run_ids: vec![RunId::try_new("private-run").unwrap()],
                }
            )))
            .unwrap(),
            json!({"outcome": "succeeded", "aborted": false})
        );
        assert_eq!(
            to_value(SendChatResponse::from(
                InvocationOutcome::<ChatSendResult, ()>::Unknown
            ))
            .unwrap(),
            json!({"outcome": "unknown"})
        );
        assert_eq!(
            to_value(AbortChatResponse::from(InvocationOutcome::<
                ChatAbortResult,
                &str,
            >::TargetRejected(
                "peer-error"
            ),))
            .unwrap(),
            json!({"outcome": "target_rejected"})
        );
        assert_eq!(
            to_value(AbortChatResponse::from(
                InvocationOutcome::<ChatAbortResult, ()>::Unknown
            ))
            .unwrap(),
            json!({"outcome": "unknown"})
        );
    }
}
