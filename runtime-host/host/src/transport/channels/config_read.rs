use serde_json::{Value, json};

use crate::{
    channel::config_read::{Outcome, valid_identity},
    transport::common::authorization::CapabilityDecisionVerifier,
};

const OPERATION_ID: &str = "channels.config.read";
const AUTHORIZATION_ENDPOINT: &str = "/api/channels/config/read";
const AUTHORIZATION_SCOPE: &str = "channels:read";
const AUTHORIZATION_SUBJECT: &str = "channel-config-read";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Request {
    pub(crate) channel: String,
    pub(crate) account_id: Option<String>,
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    let mut span =
        crate::channel::trace::ChannelTraceSpan::begin("host.transport.channel_config_read.decode");
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
        if !((body.len() == 1 && body.contains_key("channel"))
            || (body.len() == 2 && body.contains_key("channel") && body.contains_key("accountId")))
        {
            return Err(DecodeError::Invalid);
        }
        let channel = identity(body.get("channel")).ok_or(DecodeError::Invalid)?;
        let account_id = body
            .get("accountId")
            .map(|value| identity(Some(value)).ok_or(DecodeError::Invalid))
            .transpose()?;
        Ok(Request {
            channel,
            account_id,
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
    value
        .and_then(Value::as_str)
        .filter(|value| valid_identity(value))
        .map(str::to_owned)
}

pub(crate) enum Delivery {
    Outcome(Outcome),
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(Outcome::Values(_)) => 200,
            Self::Outcome(Outcome::TargetRejected) => 400,
            Self::Outcome(Outcome::Unavailable | Outcome::Unknown) | Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(Outcome::Values(projection)) => json!({ "values": projection.values() }),
            Self::Outcome(Outcome::TargetRejected) => {
                json!({"success": false, "error": "Channel configuration request was rejected"})
            }
            Self::Outcome(Outcome::Unavailable) | Self::Unavailable => {
                json!({"success": false, "error": "Channel configuration is unavailable"})
            }
            Self::Outcome(Outcome::Unknown) => {
                json!({"success": false, "error": "Channel configuration outcome is unknown"})
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use crate::channel::config_read::Projection;

    use super::*;

    #[test]
    fn decode_requires_the_fixed_read_capability() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert_eq!(
            decode(
                json!({"channel": "discord", "accountId": "primary"}),
                &decision("channels.catalog.read", "wrong-capability"),
                &mut verifier,
                1,
            ),
            Err(DecodeError::Unauthorized),
        );

        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert_eq!(
            decode(
                json!({"channel": "discord", "accountId": "primary"}),
                &decision(OPERATION_ID, "config-read"),
                &mut verifier,
                1,
            ),
            Ok(Request {
                channel: "discord".into(),
                account_id: Some("primary".into()),
            }),
        );
    }

    #[test]
    fn decode_requires_the_complete_fixed_authorization_tuple() {
        for (endpoint, scope, capability, subject) in [
            (
                "/api/channels/catalog",
                AUTHORIZATION_SCOPE,
                OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            ),
            (
                AUTHORIZATION_ENDPOINT,
                "channels:write",
                OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            ),
            (
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                "channels.catalog.read",
                AUTHORIZATION_SUBJECT,
            ),
            (
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                OPERATION_ID,
                "channel-catalog",
            ),
        ] {
            let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
            assert_eq!(
                decode(
                    json!({"channel": "discord"}),
                    &decision_with_claims(endpoint, scope, capability, subject, "wrong-tuple"),
                    &mut verifier,
                    1,
                ),
                Err(DecodeError::Unauthorized),
            );
        }
    }

    #[test]
    fn decode_requires_exact_body_and_valid_identities() {
        for body in [
            json!({}),
            json!({"channel": "discord", "accountId": "primary", "extra": true}),
            json!({"channel": "discord", "accountId": ""}),
            json!({"channel": "nested/discord"}),
            json!([]),
        ] {
            let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
            assert_eq!(
                decode(
                    body,
                    &decision(OPERATION_ID, "invalid-body"),
                    &mut verifier,
                    1
                ),
                Err(DecodeError::Invalid),
            );
        }

        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert_eq!(
            decode(
                json!({"channel": "discord"}),
                &decision(OPERATION_ID, "without-account"),
                &mut verifier,
                1,
            ),
            Ok(Request {
                channel: "discord".into(),
                account_id: None,
            }),
        );
    }

    #[test]
    fn delivery_keeps_rejection_unavailability_and_unknown_distinct() {
        let projection =
            Projection::from_source(BTreeMap::from([("enabled".into(), "true".into())])).unwrap();
        let success = Delivery::Outcome(Outcome::Values(projection));
        assert_eq!(success.status_code(), 200);
        assert_eq!(success.body(), json!({"values": {"enabled": "true"}}));

        let rejected = Delivery::Outcome(Outcome::TargetRejected);
        assert_eq!(rejected.status_code(), 400);
        assert_eq!(
            rejected.body(),
            json!({"success": false, "error": "Channel configuration request was rejected"}),
        );

        let unavailable = Delivery::Outcome(Outcome::Unavailable);
        assert_eq!(unavailable.status_code(), 503);
        assert_eq!(
            unavailable.body(),
            json!({"success": false, "error": "Channel configuration is unavailable"}),
        );

        let unknown = Delivery::Outcome(Outcome::Unknown);
        assert_eq!(unknown.status_code(), 503);
        assert_eq!(
            unknown.body(),
            json!({"success": false, "error": "Channel configuration outcome is unknown"}),
        );
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[31; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(operation: &str, correlation: &str) -> String {
        decision_with_claims(
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            operation,
            AUTHORIZATION_SUBJECT,
            correlation,
        )
    }

    fn decision_with_claims(
        endpoint: &str,
        scope: &str,
        capability: &str,
        subject: &str,
        correlation: &str,
    ) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": endpoint,
            "scope": scope,
            "capability": capability,
            "subject": subject,
            "expiresAt": 60_000,
            "correlation": correlation,
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
