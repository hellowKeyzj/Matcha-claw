use serde_json::{Value, json};

use crate::{
    channel::login::ChannelLoginAction,
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod handler;

const OPERATION_ID: &str = "channels.login";
const AUTHORIZATION_ENDPOINT: &str = "/api/channels/login";
const AUTHORIZATION_SCOPE: &str = "channels:write";
const AUTHORIZATION_SUBJECT: &str = "channel-login";
const MAX_IDENTITY_LENGTH: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Request {
    pub(crate) action: ChannelLoginAction,
    pub(crate) channel: String,
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
        crate::channel::trace::ChannelTraceSpan::begin("host.transport.channel_login.decode");
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
        let channel = identity(body.get("channel")).ok_or(DecodeError::Invalid)?;
        let action = body
            .get("action")
            .and_then(Value::as_str)
            .ok_or(DecodeError::Invalid)?;
        let action = match action {
            "start" => {
                reject_unknown(
                    &body,
                    &[
                        "action",
                        "channel",
                        "accountId",
                        "force",
                        "timeoutMs",
                        "config",
                        "agentId",
                    ],
                )?;
                let config = match body.get("config") {
                    Some(value) => crate::channel::login::parse_login_config(value)
                        .ok_or(DecodeError::Invalid)?,
                    None => zeroize::Zeroizing::new(br#"{}"#.to_vec()),
                };
                ChannelLoginAction::Start {
                    force: optional_bool(&body, "force")?.unwrap_or(false),
                    timeout_ms: optional_u64(&body, "timeoutMs")?,
                    account_id: optional_identity(&body, "accountId")?,
                    agent_id: optional_identity(&body, "agentId")?,
                    config,
                }
            }
            "wait" => {
                reject_unknown(
                    &body,
                    &[
                        "action",
                        "channel",
                        "accountId",
                        "sessionKey",
                        "currentQrDataUrl",
                        "timeoutMs",
                    ],
                )?;
                let current_qr_data_url = body
                    .get("currentQrDataUrl")
                    .map(|value| value.as_str().ok_or(DecodeError::Invalid))
                    .transpose()?
                    .map(str::to_owned);
                if current_qr_data_url
                    .as_deref()
                    .is_some_and(|value| !crate::channel::login::valid_qr_data_url(value))
                {
                    return Err(DecodeError::Invalid);
                }
                ChannelLoginAction::Wait {
                    timeout_ms: optional_u64(&body, "timeoutMs")?,
                    account_id: optional_identity(&body, "accountId")?,
                    session_key: optional_identity(&body, "sessionKey")?,
                    current_qr_data_url,
                }
            }
            "cancel" => {
                reject_unknown(&body, &["action", "channel", "accountId"])?;
                ChannelLoginAction::Cancel {
                    account_id: optional_identity(&body, "accountId")?,
                }
            }
            "logout" => {
                reject_unknown(&body, &["action", "channel", "accountId"])?;
                ChannelLoginAction::Logout {
                    account_id: optional_identity(&body, "accountId")?,
                }
            }
            _ => return Err(DecodeError::Invalid),
        };
        Ok(Request { action, channel })
    })();
    span.finish(match &result {
        Ok(_) => "decoded",
        Err(DecodeError::Unauthorized) => "unauthorized",
        Err(DecodeError::Invalid) => "invalid",
    });
    result
}

fn reject_unknown(
    body: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), DecodeError> {
    if body.keys().any(|key| !allowed.contains(&key.as_str())) {
        Err(DecodeError::Invalid)
    } else {
        Ok(())
    }
}

fn optional_identity(
    body: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<String>, DecodeError> {
    body.get(name)
        .map(|value| identity(Some(value)).ok_or(DecodeError::Invalid))
        .transpose()
}

fn optional_bool(
    body: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<bool>, DecodeError> {
    body.get(name)
        .map(|value| value.as_bool().ok_or(DecodeError::Invalid))
        .transpose()
}

fn optional_u64(
    body: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<u64>, DecodeError> {
    let value = body
        .get(name)
        .map(|value| value.as_u64().ok_or(DecodeError::Invalid))
        .transpose()?;
    if !crate::channel::login::valid_timeout(value) {
        return Err(DecodeError::Invalid);
    }
    Ok(value)
}

fn identity(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    (value.len() <= MAX_IDENTITY_LENGTH && crate::channel::login::valid_identity(value))
        .then(|| value.to_owned())
}

pub(crate) enum Delivery {
    Progress(crate::channel::login::LoginProgress),
    Confirmed,
    Cancelled,
    Rejected,
    Unknown,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Rejected => 400,
            Self::Unknown => 503,
            Self::Progress(_) | Self::Confirmed | Self::Cancelled => 200,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Progress(progress) => crate::channel::login::project_progress(progress.clone()),
            Self::Confirmed => json!({"outcome": "confirmed"}),
            Self::Cancelled => json!({"outcome": "cancelled"}),
            Self::Rejected => json!({"outcome": "rejected"}),
            Self::Unknown => json!({"outcome": "unknown"}),
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;
    use crate::transport::common::authorization::CapabilityDecisionVerifier;

    #[test]
    fn logout_confirmation_uses_logout_transport_outcome() {
        assert_eq!(Delivery::Confirmed.body(), json!({"outcome": "confirmed"}));
    }

    #[test]
    fn start_decodes_optional_agent_id() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        let request = decode(
            json!({
                "action": "start",
                "channel": "whatsapp",
                "accountId": "primary",
                "agentId": "main.agent",
                "config": { "token": "secret" },
            }),
            &decision("login-agent"),
            &mut verifier,
            1,
        )
        .expect("login start decodes");

        let crate::channel::login::ChannelLoginAction::Start {
            account_id,
            agent_id,
            config,
            ..
        } = request.action
        else {
            panic!("login start expected");
        };
        assert_eq!(request.channel, "whatsapp");
        assert_eq!(account_id.as_deref(), Some("primary"));
        assert_eq!(agent_id.as_deref(), Some("main.agent"));
        assert!(!String::from_utf8_lossy(config.as_slice()).contains("agentId"));
    }

    #[test]
    fn strict_actions_and_qr_validation_are_enforced() {
        assert!(crate::channel::login::valid_qr_data_url(
            "data:image/png;base64,ok"
        ));
        assert!(!crate::channel::login::valid_qr_data_url(
            "data:image/jpeg;base64,no"
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
            "endpoint": AUTHORIZATION_ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": OPERATION_ID,
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
