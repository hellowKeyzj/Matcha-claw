use serde::{Deserialize, Serialize};
use serde_json::json;

use openclaw::session::protocol::{
    ChatAbortParams, ChatAbortResult, ChatSendParams, ChatSendResult, ChatSendStatus, RunId,
    SessionKey,
};
use platform::exchange::InvocationOutcome;

use super::{
    CommandInput, CommandOutcome, CommandResult, InvalidPayload, decode, internal_error,
    invalid_input, session_failure,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatSendRequest {
    session_key: String,
    message: String,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatAbortRequest {
    session_key: String,
    run_id: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(super) enum ChatSendResponse {
    Succeeded {
        #[serde(rename = "runId")]
        run_id: String,
        status: ChatSendResponseStatus,
    },
    TargetRejected,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ChatSendResponseStatus {
    Started,
    InFlight,
    Ok,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(super) enum ChatAbortResponse {
    Succeeded { aborted: bool },
    TargetRejected,
    Unknown,
}

pub(super) async fn send_openclaw_chat(
    session: &crate::sessions::SessionHandle,
    input: CommandInput,
) -> CommandOutcome {
    let params = match decode_send(input) {
        Ok(params) => params,
        Err(_) => return invalid_input(),
    };
    let outcome = match session.send_openclaw_chat(params).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => return session_failure(error),
        Err(_) => return internal_error(),
    };
    CommandOutcome::succeeded(CommandResult::private(
        json!({ "result": ChatSendResponse::from(outcome) }),
    ))
}

pub(super) async fn abort_openclaw_chat(
    session: &crate::sessions::SessionHandle,
    input: CommandInput,
) -> CommandOutcome {
    let params = match decode_abort(input) {
        Ok(params) => params,
        Err(_) => return invalid_input(),
    };
    let outcome = match session.abort_openclaw_chat(params).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => return session_failure(error),
        Err(_) => return internal_error(),
    };
    CommandOutcome::succeeded(CommandResult::private(
        json!({ "result": ChatAbortResponse::from(outcome) }),
    ))
}

pub(super) fn decode_send(input: CommandInput) -> Result<ChatSendParams, InvalidPayload> {
    let request = decode::<ChatSendRequest>(input)?;
    ChatSendParams::try_new(
        identity(request.session_key, SessionKey::try_new)?,
        request.message,
        identity(request.run_id, RunId::try_new)?,
    )
    .map_err(|_| InvalidPayload)
}

pub(super) fn decode_abort(input: CommandInput) -> Result<ChatAbortParams, InvalidPayload> {
    let request = decode::<ChatAbortRequest>(input)?;
    let params = ChatAbortParams::new(identity(request.session_key, SessionKey::try_new)?);
    match request.run_id {
        Some(run_id) => identity(run_id, RunId::try_new).map(|run_id| params.for_run(run_id)),
        None => Ok(params),
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

impl<E> From<InvocationOutcome<ChatSendResult, E>> for ChatSendResponse {
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

impl From<ChatSendStatus> for ChatSendResponseStatus {
    fn from(status: ChatSendStatus) -> Self {
        match status {
            ChatSendStatus::Started => Self::Started,
            ChatSendStatus::InFlight => Self::InFlight,
            ChatSendStatus::Ok => Self::Ok,
        }
    }
}

impl<E> From<InvocationOutcome<ChatAbortResult, E>> for ChatAbortResponse {
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
