use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::{
    channel::catalog::{
        ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome,
    },
    transport::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

pub(crate) fn channel_trace_id(headers: &[(String, String)]) -> Option<String> {
    crate::transport::session_trace::trace_id(headers)
        .filter(|value| {
            value.len() == 36
                && value.bytes().enumerate().all(|(index, byte)| {
                    if matches!(index, 8 | 13 | 18 | 23) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                })
        })
        .map(str::to_owned)
}

const CATALOG_OPERATION: &str = "channels.catalog.read";
const CONFIG_OPERATION: &str = "channels.configure";
const CATALOG_ENDPOINT: &str = "/api/channels/catalog";
const CONFIG_ENDPOINT: &str = "/api/channels/configure";
const CATALOG_SCOPE: &str = "channels:read";
const CONFIG_SCOPE: &str = "channels:write";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) enum Request {
    Catalog,
    ConfigureForm {
        channel: String,
    },
    ConfigureApply {
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: Zeroizing<Vec<u8>>,
    },
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    let mut span =
        crate::channel::trace::ChannelTraceSpan::begin("host.transport.channel_catalog.decode");
    let result = (|| {
        let object = value.as_object().ok_or(DecodeError::Invalid)?;
        if object.is_empty() {
            verifier
                .verify(
                    authorization,
                    now,
                    CATALOG_ENDPOINT,
                    CATALOG_SCOPE,
                    CATALOG_OPERATION,
                    "channel-catalog",
                )
                .map_err(|_| DecodeError::Unauthorized)?;
            return Ok(Request::Catalog);
        }

        verifier
            .verify(
                authorization,
                now,
                CONFIG_ENDPOINT,
                CONFIG_SCOPE,
                CONFIG_OPERATION,
                "channel-configure",
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        let channel = identity(object.get("channel")).ok_or(DecodeError::Invalid)?;
        match object.get("action").and_then(Value::as_str) {
            Some("form") if object.len() == 2 => Ok(Request::ConfigureForm { channel }),
            Some("apply")
                if object.len() == 4 || (object.len() == 5 && object.contains_key("agentId")) =>
            {
                if object.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "action" | "channel" | "accountId" | "agentId" | "values"
                    )
                }) {
                    return Err(DecodeError::Invalid);
                }
                let account_id = identity(object.get("accountId")).ok_or(DecodeError::Invalid)?;
                let agent_id = object
                    .get("agentId")
                    .map(|value| identity(Some(value)).ok_or(DecodeError::Invalid))
                    .transpose()?;
                let values = object.get("values").ok_or(DecodeError::Invalid)?;
                if !values.is_object() {
                    return Err(DecodeError::Invalid);
                }
                let values = serde_json::to_vec(values)
                    .map(Zeroizing::new)
                    .map_err(|_| DecodeError::Invalid)?;
                Ok(Request::ConfigureApply {
                    channel,
                    account_id,
                    agent_id,
                    values,
                })
            }
            _ => Err(DecodeError::Invalid),
        }
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
    (valid_identifier(value)).then(|| value.to_owned())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

pub(crate) enum Delivery {
    Catalog(ChannelCatalogOutcome),
    ConfigureForm(ChannelConfigureFormOutcome),
    Configure(ChannelConfigureOutcome),
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Catalog(ChannelCatalogOutcome::Catalog(_))
            | Self::ConfigureForm(ChannelConfigureFormOutcome::Form(_))
            | Self::Configure(
                ChannelConfigureOutcome::Confirmed
                | ChannelConfigureOutcome::TargetRejected
                | ChannelConfigureOutcome::Unknown,
            ) => 200,
            Self::Catalog(_)
            | Self::ConfigureForm(ChannelConfigureFormOutcome::Unknown)
            | Self::Unavailable => 503,
            Self::ConfigureForm(ChannelConfigureFormOutcome::TargetRejected) => 400,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Catalog(ChannelCatalogOutcome::Catalog(catalog)) => {
                serde_json::to_value(catalog).expect("catalog serializable")
            }
            Self::ConfigureForm(ChannelConfigureFormOutcome::Form(form)) => {
                serde_json::to_value(form).expect("channel configure form serializable")
            }
            Self::ConfigureForm(ChannelConfigureFormOutcome::TargetRejected) => {
                json!({"outcome": "rejected"})
            }
            Self::ConfigureForm(ChannelConfigureFormOutcome::Unknown) => {
                json!({"outcome": "unknown"})
            }
            Self::Configure(outcome) => json!({
                "outcome": outcome,
            }),
            Self::Catalog(ChannelCatalogOutcome::Rejected) => {
                json!({"success": false, "error": "Channel catalog was rejected"})
            }
            Self::Catalog(ChannelCatalogOutcome::Unknown) | Self::Unavailable => {
                json!({"success": false, "error": "Channel catalog is unavailable"})
            }
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
    fn configure_apply_accepts_optional_agent_id_without_values_injection() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        let request = decode(
            json!({
                "action": "apply",
                "channel": "whatsapp",
                "accountId": "primary",
                "agentId": "main.agent",
                "values": { "token": "secret" },
            }),
            &decision("agent-config"),
            &mut verifier,
            1,
        )
        .expect("configure apply decodes");

        let Request::ConfigureApply {
            channel,
            account_id,
            agent_id,
            values,
        } = request
        else {
            panic!("configure apply expected");
        };
        assert_eq!(channel, "whatsapp");
        assert_eq!(account_id, "primary");
        assert_eq!(agent_id.as_deref(), Some("main.agent"));
        assert!(!String::from_utf8_lossy(values.as_slice()).contains("agentId"));
    }

    #[test]
    fn configure_apply_rejects_unknown_fifth_field() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(matches!(
            decode(
                json!({
                    "action": "apply",
                    "channel": "whatsapp",
                    "accountId": "primary",
                    "values": {},
                    "extra": true,
                }),
                &decision("unknown-field"),
                &mut verifier,
                1,
            ),
            Err(DecodeError::Invalid),
        ));
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

    fn decision(correlation: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": CONFIG_ENDPOINT,
            "scope": CONFIG_SCOPE,
            "capability": CONFIG_OPERATION,
            "subject": "channel-configure",
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
