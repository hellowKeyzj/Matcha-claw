use serde_json::{Value, json};

use crate::control::{ChannelControlAction, ChannelControlDeliveryOutcome};
use platform::capability::CapabilityDecisionVerifier;

pub mod handler;

const OPERATION_ID: &str = "channels.runtime.control";
const AUTHORIZATION_ENDPOINT: &str = "/api/channels/control";
const AUTHORIZATION_SCOPE: &str = "channels:write";
const AUTHORIZATION_SUBJECT: &str = "channel-control";
const MAX_IDENTITY_LENGTH: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub action: ChannelControlAction,
    pub channel: String,
    pub account: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeError {
    Unauthorized,
    Invalid,
}

pub fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    let mut span = crate::trace::ChannelTraceSpan::begin("channel.loopback.channel_control.decode");
    let result = (|| {
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
        let Value::Object(body) = value else {
            return Err(DecodeError::Invalid);
        };
        if body.len() != 3
            || !body.contains_key("action")
            || !body.contains_key("channel")
            || !body.contains_key("accountId")
        {
            return Err(DecodeError::Invalid);
        }
        let action = match body.get("action").and_then(Value::as_str) {
            Some("connect") => ChannelControlAction::Connect,
            Some("disconnect") => ChannelControlAction::Disconnect,
            _ => return Err(DecodeError::Invalid),
        };
        let channel = identity(body.get("channel")).ok_or(DecodeError::Invalid)?;
        let account = identity(body.get("accountId")).ok_or(DecodeError::Invalid)?;
        Ok(Request {
            action,
            channel,
            account,
        })
    })();
    span.finish(match &result {
        Ok(_) => "decoded",
        Err(DecodeError::Unauthorized) => "unauthorized",
        Err(DecodeError::Invalid) => "invalid",
    });
    result
}

fn identity(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    (!value.is_empty()
        && value.len() <= MAX_IDENTITY_LENGTH
        && !value.contains(char::is_whitespace))
    .then(|| value.to_owned())
}

pub enum ChannelControlDelivery {
    Outcome(ChannelControlDeliveryOutcome),
    Unavailable,
}

impl ChannelControlDelivery {
    pub fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub fn body(&self) -> Value {
        match self {
            Self::Outcome(outcome) => json!({ "outcome": outcome }),
            Self::Unavailable => json!({
                "success": false,
                "error": "Channel control is unavailable",
            }),
        }
    }
}
