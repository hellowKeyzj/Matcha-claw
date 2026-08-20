use serde_json::{Value, json};

use crate::{
    channel_status::{ChannelSnapshotOutcome, ChannelStatusOutcome},
    transport::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const ACCOUNTS_OPERATION_ID: &str = "channels.status.read";
const SNAPSHOT_OPERATION_ID: &str = "channels.snapshot.read";
const AUTHORIZATION_ENDPOINT: &str = "/api/channels/status";
const AUTHORIZATION_SCOPE: &str = "channels:read";
const AUTHORIZATION_SUBJECT: &str = "channel-status";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChannelStatusRequest {
    Accounts,
    Snapshot,
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<ChannelStatusRequest, DecodeError> {
    let request = match value {
        Value::Object(body) if body.is_empty() => ChannelStatusRequest::Accounts,
        Value::Object(body)
            if body.len() == 1
                && body.get("operation").and_then(Value::as_str) == Some("snapshot") =>
        {
            ChannelStatusRequest::Snapshot
        }
        _ => return Err(DecodeError::Invalid),
    };
    let operation_id = match request {
        ChannelStatusRequest::Accounts => ACCOUNTS_OPERATION_ID,
        ChannelStatusRequest::Snapshot => SNAPSHOT_OPERATION_ID,
    };
    verifier
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            operation_id,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;
    Ok(request)
}

pub(crate) enum ChannelStatusDelivery {
    Accounts(ChannelStatusOutcome),
    Snapshot(ChannelSnapshotOutcome),
    Unavailable,
}

impl ChannelStatusDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Accounts(_) | Self::Snapshot(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Accounts(outcome) => serde_json::to_value(outcome)
                .expect("Channel status public response is serializable"),
            Self::Snapshot(outcome) => serde_json::to_value(outcome)
                .expect("Channel snapshot public response is serializable"),
            Self::Unavailable => json!({
                "success": false,
                "error": "Channel status is unavailable",
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    #[test]
    fn snapshot_requires_its_own_capability_decision() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert_eq!(
            decode(
                json!({"operation": "snapshot"}),
                &decision(ACCOUNTS_OPERATION_ID, "wrong-capability"),
                &mut verifier,
                1,
            ),
            Err(DecodeError::Unauthorized),
        );
        assert_eq!(
            decode(
                json!({"operation": "snapshot"}),
                &decision(SNAPSHOT_OPERATION_ID, "snapshot-read"),
                &mut verifier,
                1,
            ),
            Ok(ChannelStatusRequest::Snapshot),
        );
    }

    #[test]
    fn snapshot_request_requires_the_exact_fixed_body() {
        for body in [
            json!({"operation": "accounts"}),
            json!({"operation": "snapshot", "extra": true}),
            json!([]),
            json!("snapshot"),
        ] {
            let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
            assert_eq!(
                decode(
                    body,
                    &decision(SNAPSHOT_OPERATION_ID, "invalid-body"),
                    &mut verifier,
                    1,
                ),
                Err(DecodeError::Invalid),
            );
        }
    }

    #[test]
    fn snapshot_delivery_serializes_public_shape_and_fixed_unavailable() {
        let snapshot = ChannelSnapshotOutcome::new(
            1_725_000_000_000,
            vec!["discord".into()],
            std::collections::BTreeMap::from([(
                "discord".into(),
                crate::channel_status::ChannelSummarySnapshot::new(
                    Some(true),
                    Some(true),
                    None,
                    None,
                ),
            )]),
            std::collections::BTreeMap::from([(
                "discord".into(),
                vec![crate::channel_status::ChannelAccountSnapshot::new(
                    "primary".into(),
                    Some(true),
                    Some(true),
                    Some(true),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(crate::channel_status::ChannelProbeSnapshot::new(true)),
                )],
            )]),
            std::collections::BTreeMap::from([("discord".into(), "primary".into())]),
        );
        assert_eq!(ChannelStatusDelivery::Snapshot(snapshot).status_code(), 200);
        assert_eq!(
            ChannelStatusDelivery::Unavailable.body(),
            json!({
                "success": false,
                "error": "Channel status is unavailable",
            })
        );
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[29; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(operation: &str, correlation: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": AUTHORIZATION_ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": operation,
            "subject": AUTHORIZATION_SUBJECT,
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
