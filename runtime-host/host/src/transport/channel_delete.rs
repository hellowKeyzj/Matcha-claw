use serde_json::{Value, json};

use crate::{channel_delete::Outcome, transport::authorization::CapabilityDecisionVerifier};

const OPERATION_ID: &str = "channels.config.delete";
const AUTHORIZATION_ENDPOINT: &str = "/api/channels/delete-config";
const AUTHORIZATION_SCOPE: &str = "channels:write";
const AUTHORIZATION_SUBJECT: &str = "channel-config-delete";
const MAX_IDENTITY_LENGTH: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Request {
    pub(crate) channel: String,
    pub(crate) account_id: String,
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
    if body.len() != 2 || !body.contains_key("channel") || !body.contains_key("accountId") {
        return Err(DecodeError::Invalid);
    }
    Ok(Request {
        channel: identity(body.get("channel")).ok_or(DecodeError::Invalid)?,
        account_id: identity(body.get("accountId")).ok_or(DecodeError::Invalid)?,
    })
}

fn identity(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    (!value.is_empty()
        && value.len() <= MAX_IDENTITY_LENGTH
        && !value.contains(char::is_whitespace))
    .then(|| value.to_owned())
}

pub(crate) enum Delivery {
    Outcome(Outcome),
    Unavailable,
}

impl Delivery {
    pub(crate) const fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(outcome) => json!({ "outcome": outcome }),
            Self::Unavailable => json!({ "outcome": "unknown" }),
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::SigningKey;

    use super::*;

    #[test]
    fn delete_request_requires_exact_channel_and_account_fields() {
        let request = decode(
            serde_json::json!({"channel": "whatsapp", "accountId": "primary"}),
            "invalid",
            &mut CapabilityDecisionVerifier::try_new(&verification_key()).unwrap(),
            0,
        );
        assert!(matches!(request, Err(DecodeError::Unauthorized)));
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(SigningKey::from_bytes(&[53; 32]).verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    #[test]
    fn delete_delivery_preserves_each_terminal_outcome() {
        for (outcome, expected) in [
            (Outcome::Confirmed, "confirmed"),
            (Outcome::TargetRejected, "target_rejected"),
            (Outcome::Unknown, "unknown"),
        ] {
            let delivery = Delivery::Outcome(outcome);
            assert_eq!(delivery.status_code(), 200);
            assert_eq!(delivery.body()["outcome"], expected);
        }
    }
}
