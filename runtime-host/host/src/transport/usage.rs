use serde::Serialize;
use serde_json::Value;

use crate::transport::authorization::CapabilityDecisionVerifier;

pub(crate) mod server;

const AUTHORIZATION_ENDPOINT: &str = "/api/usage/recent";
const AUTHORIZATION_SCOPE: &str = "openclaw:usage-history:read";
const AUTHORIZATION_CAPABILITY: &str = "openclaw.usage.history";
const AUTHORIZATION_SUBJECT: &str = "openclaw-usage-history";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) fn decode_limit(
    authorization: &str,
    raw_limit: Option<&str>,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<usize, DecodeError> {
    verifier
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            AUTHORIZATION_CAPABILITY,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;
    match raw_limit {
        None => Ok(openclaw::usage::UsageHistory::default_limit()),
        Some(value) => value
            .parse::<usize>()
            .ok()
            .filter(|value| *value > 0 && *value <= openclaw::usage::UsageHistory::max_limit())
            .ok_or(DecodeError::Invalid),
    }
}

pub(crate) enum UsageDelivery {
    Ok(UsageResponse),
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageResponse {
    entries: Vec<UsageEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageEntry {
    session_id: String,
    agent_id: String,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost_usd: Option<f64>,
}

impl UsageDelivery {
    pub(crate) fn from_native(
        result: Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageHistoryError>,
    ) -> Self {
        match result {
            Ok(entries) => Self::Ok(UsageResponse {
                entries: entries
                    .into_iter()
                    .map(|entry| UsageEntry {
                        session_id: entry.session_id().to_owned(),
                        agent_id: entry.agent_id().to_owned(),
                        timestamp: entry.timestamp().to_owned(),
                        model: entry.model().map(str::to_owned),
                        provider: entry.provider().map(str::to_owned),
                        input_tokens: entry.input_tokens(),
                        output_tokens: entry.output_tokens(),
                        cache_read_tokens: entry.cache_read_tokens(),
                        cache_write_tokens: entry.cache_write_tokens(),
                        total_tokens: entry.total_tokens(),
                        cost_usd: entry.cost_usd(),
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
            Self::Ok(response) => {
                serde_json::to_value(response).expect("Usage public response is serializable")
            }
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "OpenClaw usage history is unavailable",
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
    fn decodes_only_a_fresh_fixed_usage_decision_and_limit() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert_eq!(
            decode_limit(
                &decision(AUTHORIZATION_CAPABILITY, "usage:one"),
                Some("12"),
                &mut verifier,
                1
            ),
            Ok(12),
        );
        assert_eq!(
            decode_limit(
                &decision(AUTHORIZATION_CAPABILITY, "usage:default"),
                None,
                &mut verifier,
                1
            ),
            Ok(openclaw::usage::UsageHistory::default_limit()),
        );
    }

    #[test]
    fn rejects_wrong_replayed_or_invalid_usage_decisions() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert_eq!(
            decode_limit(
                &decision("other.capability", "wrong"),
                Some("1"),
                &mut verifier,
                1
            ),
            Err(DecodeError::Unauthorized),
        );
        let replay = decision(AUTHORIZATION_CAPABILITY, "replay");
        assert!(decode_limit(&replay, Some("1"), &mut verifier, 1).is_ok());
        assert_eq!(
            decode_limit(&replay, Some("1"), &mut verifier, 1),
            Err(DecodeError::Unauthorized),
        );
        assert_eq!(
            decode_limit(
                &decision(AUTHORIZATION_CAPABILITY, "invalid"),
                Some("1001"),
                &mut verifier,
                1
            ),
            Err(DecodeError::Invalid),
        );
    }

    #[test]
    fn public_projection_exposes_validated_identity_and_omits_private_transcript_data() {
        let root = std::env::temp_dir().join(format!(
            "runtime-host-usage-public-projection-{}",
            std::process::id()
        ));
        let sessions = root.join("agents").join("main").join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("session-1.jsonl"),
            r#"{"timestamp":"2026-04-03T00:00:00.000Z","message":{"role":"assistant","usage":{"total":14}}}"#,
        )
        .unwrap();
        let native = openclaw::usage::UsageHistory::new(&root).recent(1).unwrap();
        let body = UsageDelivery::from_native(Ok(native)).body();
        let entry = body
            .get("entries")
            .and_then(Value::as_array)
            .unwrap()
            .first()
            .unwrap();
        assert_eq!(entry.get("sessionId"), Some(&json!("session-1")));
        assert_eq!(entry.get("agentId"), Some(&json!("main")));
        let serialized = body.to_string();
        for private_field in ["transcript", "path", "raw"] {
            assert!(!serialized.contains(private_field));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unavailable_response_is_redacted() {
        let body =
            UsageDelivery::from_native(Err(openclaw::usage::UsageHistoryError::Unavailable)).body();
        assert_eq!(
            body,
            json!({ "success": false, "error": "OpenClaw usage history is unavailable" })
        );
        assert!(!body.to_string().contains("private native failure"));
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[37; 32])
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
            "principal": "usage-test",
            "endpoint": AUTHORIZATION_ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": capability,
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
