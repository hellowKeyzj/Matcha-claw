use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{RuntimeSessionError, transport::authorization::CapabilityDecisionVerifier};

pub(crate) mod server;

const CAPABILITY_ID: &str = "openclaw.chat.history";
const OPERATION_ID: &str = "openclaw.chat.history";
const AUTHORIZATION_ENDPOINT: &str = "/api/openclaw/chat/history";
const AUTHORIZATION_SCOPE: &str = "openclaw:chat-history:read";
const AUTHORIZATION_SUBJECT: &str = "openclaw-chat-history";
const MAX_SESSION_KEY_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenClawHistoryRequest {
    id: String,
    operation_id: String,
    session_key: String,
}

impl OpenClawHistoryRequest {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        let request = serde_json::from_value::<Self>(value).map_err(|_| DecodeError::Invalid)?;
        (request.id == CAPABILITY_ID
            && request.operation_id == OPERATION_ID
            && !request.session_key.trim().is_empty()
            && request.session_key.len() <= MAX_SESSION_KEY_BYTES
            && !request.session_key.contains('\0'))
        .then_some(request)
        .ok_or(DecodeError::Invalid)
    }

    pub(crate) fn into_params(
        self,
    ) -> Result<openclaw::session::protocol::ChatHistoryParams, DecodeError> {
        openclaw::session::protocol::SessionKey::try_new(self.session_key)
            .map(openclaw::session::protocol::ChatHistoryParams::new)
            .map_err(|_| DecodeError::Invalid)
    }
}

pub(crate) enum OpenClawHistoryDelivery {
    Ok(OpenClawHistoryResponse),
    Unavailable,
}

#[derive(Serialize)]
pub(crate) struct OpenClawHistoryResponse {
    messages: Vec<OpenClawHistoryMessage>,
}

#[derive(Serialize)]
struct OpenClawHistoryMessage {
    role: openclaw::session::protocol::HistoryRole,
    text: String,
}

impl OpenClawHistoryDelivery {
    pub(crate) fn from_native<E>(
        result: Result<openclaw::session::protocol::ChatHistoryResult, RuntimeSessionError<E>>,
    ) -> Self {
        match result {
            Ok(result) => Self::Ok(OpenClawHistoryResponse {
                messages: result
                    .messages
                    .into_iter()
                    .map(|message| OpenClawHistoryMessage {
                        role: message.role,
                        text: message.text,
                    })
                    .collect(),
            }),
            Err(_) => Self::Unavailable,
        }
    }

    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Ok(response) => serde_json::to_value(response)
                .expect("OpenClaw history public response is serializable"),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "OpenClaw chat history is unavailable",
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn projects_only_peer_text_history() {
        let delivery = OpenClawHistoryDelivery::from_native::<()>(Ok(
            openclaw::session::protocol::ChatHistoryResult {
                messages: vec![openclaw::session::protocol::HistoryMessage {
                    role: openclaw::session::protocol::HistoryRole::User,
                    text: "private text".into(),
                }],
            },
        ));
        assert_eq!(
            delivery.body(),
            json!({"messages": [{"role": "user", "text": "private text"}]}),
        );
    }

    #[test]
    fn native_failure_is_redacted_and_unavailable() {
        let body = OpenClawHistoryDelivery::from_native::<&str>(Err(RuntimeSessionError::Client(
            "private native failure",
        )))
        .body();
        assert_eq!(
            body,
            json!({"success": false, "error": "OpenClaw chat history is unavailable"})
        );
        assert!(!body.to_string().contains("private native failure"));
    }
}
