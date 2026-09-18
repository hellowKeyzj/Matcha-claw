use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::matcha_history::{Command, Outcome, Role},
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod handler;

const CAPABILITY_ID: &str = "matcha-agent.chat.history";
const OPERATION_ID: &str = "matcha-agent.chat.history";
const AUTHORIZATION_ENDPOINT: &str = "/api/matcha-agent/chat/history";
const AUTHORIZATION_SCOPE: &str = "matcha-agent:chat-history:read";
const AUTHORIZATION_SUBJECT: &str = "matcha-agent-chat-history";
const MAX_SESSION_ID_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MatchaHistoryRequest {
    id: String,
    operation_id: String,
    session_id: String,
}

impl MatchaHistoryRequest {
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
            && !request.session_id.trim().is_empty()
            && request.session_id.len() <= MAX_SESSION_ID_BYTES
            && !request.session_id.contains('\0'))
        .then_some(request)
        .ok_or(DecodeError::Invalid)
    }

    pub(crate) fn into_command(self) -> Result<Command, DecodeError> {
        Command::new(self.session_id).ok_or(DecodeError::Invalid)
    }
}

pub(crate) enum MatchaHistoryDelivery {
    Ok(MatchaHistoryResponse),
    Unavailable,
}

pub(crate) struct MatchaHistoryResponse {
    messages: Vec<MatchaHistoryMessage>,
}

struct MatchaHistoryMessage {
    role: &'static str,
    text: String,
}

impl MatchaHistoryDelivery {
    pub(crate) fn from_outcome(outcome: Outcome) -> Self {
        match outcome {
            Outcome::Complete(history) => Self::Ok(MatchaHistoryResponse {
                messages: history
                    .messages()
                    .iter()
                    .map(|message| MatchaHistoryMessage {
                        role: match message.role() {
                            Role::User => "user",
                            Role::Assistant => "assistant",
                        },
                        text: message.text().to_owned(),
                    })
                    .collect(),
            }),
            Outcome::Incomplete | Outcome::Unavailable => Self::Unavailable,
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
            Self::Ok(response) => serde_json::json!({
                "messages": response.messages.iter().map(|message| {
                    serde_json::json!({
                        "role": message.role,
                        "text": &message.text,
                    })
                }).collect::<Vec<_>>(),
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Matcha Agent chat history is unavailable",
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::sessions::matcha_history::{History, Message};

    #[test]
    fn projects_only_safe_native_text_history() {
        let delivery =
            MatchaHistoryDelivery::from_outcome(Outcome::Complete(History::test_only(vec![
                Message::test_only(Role::User, "private text".into()),
            ])));
        assert_eq!(
            delivery.body(),
            json!({"messages": [{"role": "user", "text": "private text"}]}),
        );
    }

    #[test]
    fn incomplete_native_history_is_redacted_and_unavailable() {
        let body = MatchaHistoryDelivery::from_outcome(Outcome::Incomplete).body();
        assert_eq!(
            body,
            json!({"success": false, "error": "Matcha Agent chat history is unavailable"})
        );
    }
}
