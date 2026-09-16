use serde_json::{Value, json};

use crate::{
    security::emergency::SecurityEmergencyOutcome,
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const CAPABILITY_ID: &str = "security.emergency";
const OPERATION_ID: &str = CAPABILITY_ID;
const AUTHORIZATION_ENDPOINT: &str = "/api/security/emergency";
const AUTHORIZATION_SCOPE: &str = "security:write";
const AUTHORIZATION_SUBJECT: &str = "security-emergency";

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
) -> Result<String, DecodeError> {
    let decision = verifier
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            OPERATION_ID,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;
    matches!(value, Value::Object(ref body) if body.is_empty())
        .then_some(decision.correlation().to_owned())
        .ok_or(DecodeError::Invalid)
}

pub(crate) enum SecurityEmergencyDelivery {
    Outcome(SecurityEmergencyOutcome),
    Unavailable,
}

impl From<SecurityEmergencyOutcome> for SecurityEmergencyDelivery {
    fn from(outcome: SecurityEmergencyOutcome) -> Self {
        match outcome {
            SecurityEmergencyOutcome::Unavailable => Self::Unavailable,
            outcome => Self::Outcome(outcome),
        }
    }
}

impl SecurityEmergencyDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(outcome) => json!({ "outcome": emergency_outcome_code(*outcome) }),
            Self::Unavailable => json!({
                "success": false,
                "error": "Security emergency is unavailable",
            }),
        }
    }
}

const fn emergency_outcome_code(outcome: SecurityEmergencyOutcome) -> &'static str {
    match outcome {
        SecurityEmergencyOutcome::Applied => "applied",
        SecurityEmergencyOutcome::Rejected => "target_rejected",
        SecurityEmergencyOutcome::OutcomeUnknown => "outcome_unknown",
        SecurityEmergencyOutcome::Unavailable => "unavailable",
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    #[test]
    fn accepts_the_electron_emergency_capability() {
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");

        assert_eq!(
            decode(
                json!({}),
                &decision(CAPABILITY_ID, "electron-emergency"),
                &mut verifier,
                1,
            ),
            Ok("electron-emergency".into())
        );
    }

    #[test]
    fn outcome_unknown_does_not_expose_native_evidence() {
        let body = SecurityEmergencyDelivery::from(SecurityEmergencyOutcome::OutcomeUnknown).body();
        assert_eq!(body, json!({ "outcome": "outcome_unknown" }));
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[43; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(capability: &str, correlation: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "electron-main-local",
            "endpoint": AUTHORIZATION_ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": capability,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": 60_000,
            "correlation": correlation,
            "revision": "1",
        });
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize payload"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
