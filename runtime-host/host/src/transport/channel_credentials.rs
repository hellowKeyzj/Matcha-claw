use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::{channel_credentials::Outcome, transport::authorization::CapabilityDecisionVerifier};

const OPERATION_ID: &str = "channels.credentials.validate";
const AUTHORIZATION_ENDPOINT: &str = "/api/channels/credentials/validate";
const AUTHORIZATION_SCOPE: &str = "channels:write";
const AUTHORIZATION_SUBJECT: &str = "channel-credentials";
const MAX_CONFIG_KEYS: usize = 64;
const MAX_CONFIG_VALUE_BYTES: usize = 131_072;
const MAX_CONFIG_TOTAL_BYTES: usize = 262_144;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) struct Request {
    pub(crate) channel: String,
    pub(crate) config: Zeroizing<Vec<u8>>,
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
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
    if body.len() != 2 || !body.contains_key("channelType") || !body.contains_key("config") {
        return Err(DecodeError::Invalid);
    }
    let channel = identity(body.get("channelType")).ok_or(DecodeError::Invalid)?;
    let config = body
        .get("config")
        .and_then(Value::as_object)
        .ok_or(DecodeError::Invalid)?;
    if config.len() > MAX_CONFIG_KEYS
        || config.iter().any(|(key, value)| {
            !identity_str(key)
                || !value.is_string()
                || value
                    .as_str()
                    .is_some_and(|value| value.len() > MAX_CONFIG_VALUE_BYTES)
        })
    {
        return Err(DecodeError::Invalid);
    }
    let total = config
        .values()
        .filter_map(Value::as_str)
        .try_fold(0usize, |total, value| total.checked_add(value.len()))
        .ok_or(DecodeError::Invalid)?;
    if total > MAX_CONFIG_TOTAL_BYTES {
        return Err(DecodeError::Invalid);
    }
    let config = serde_json::to_vec(config)
        .map(Zeroizing::new)
        .map_err(|_| DecodeError::Invalid)?;
    Ok(Request { channel, config })
}

fn identity(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    identity_str(value).then(|| value.to_owned())
}

fn identity_str(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

pub(crate) enum Delivery {
    Outcome(Outcome),
    Unavailable,
}

impl Delivery {
    pub(crate) const fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(Outcome::Validated(_)) => 200,
            Self::Outcome(Outcome::TargetRejected) => 400,
            Self::Outcome(Outcome::Unknown) | Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(Outcome::Validated(validation)) => serde_json::to_value(validation)
                .expect("Channel credentials validation is serializable"),
            Self::Outcome(Outcome::TargetRejected) => {
                json!({
                    "success": false,
                    "valid": false,
                    "errors": ["Channel credentials request was rejected"],
                })
            }
            Self::Outcome(Outcome::Unknown) => {
                json!({"success": false, "error": "Channel credentials validation is unavailable"})
            }
            Self::Unavailable => {
                json!({"success": false, "error": "Channel credentials validation is unavailable"})
            }
        }
    }
}
