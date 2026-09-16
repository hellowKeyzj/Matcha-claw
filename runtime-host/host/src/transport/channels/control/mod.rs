use serde_json::{Value, json};

use crate::{
    channel::control::{ChannelControlAction, ChannelControlDeliveryOutcome},
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const OPERATION_ID: &str = "channels.runtime.control";
const AUTHORIZATION_ENDPOINT: &str = "/api/channels/control";
const AUTHORIZATION_SCOPE: &str = "channels:write";
const AUTHORIZATION_SUBJECT: &str = "channel-control";
const MAX_IDENTITY_LENGTH: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Request {
    pub(crate) action: ChannelControlAction,
    pub(crate) channel: String,
    pub(crate) account: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    let mut span =
        crate::channel::trace::ChannelTraceSpan::begin("host.transport.channel_control.decode");
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

pub(crate) enum ChannelControlDelivery {
    Outcome(ChannelControlDeliveryOutcome),
    Unavailable,
}

impl ChannelControlDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(outcome) => json!({ "outcome": outcome }),
            Self::Unavailable => json!({
                "success": false,
                "error": "Channel control is unavailable",
            }),
        }
    }
}
