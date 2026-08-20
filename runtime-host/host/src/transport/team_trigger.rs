pub(crate) mod server;

use serde_json::{Value, json};

use crate::{
    composition::{ArmedTrigger, TeamTrigger},
    owner,
    transport::authorization::CapabilityDecisionVerifier,
};

const OPERATION_ID: &str = "team.trigger";
const AUTHORIZATION_ENDPOINT: &str = "/api/team/trigger";
const AUTHORIZATION_SCOPE: &str = "team:write";
const AUTHORIZATION_SUBJECT: &str = "team-trigger";
const WEBHOOK_AUTH_ENDPOINT: &str = "/api/team/webhook-auth";
const WEBHOOK_AUTH_OPERATION_ID: &str = "team.webhook-auth";
const WEBHOOK_AUTHORIZATION_SCOPE: &str = "team:read";
const WEBHOOK_AUTHORIZATION_SUBJECT: &str = "team-webhook-auth";
const WEBHOOK_TOKEN_PREFIX: &str = "mctwh_";
const WEBHOOK_TOKEN_BYTES: usize = 32;

#[derive(Clone)]
pub struct WebhookToken {
    value: Vec<u8>,
    provenance: WebhookTokenProvenance,
}

#[derive(Clone, Copy)]
enum WebhookTokenProvenance {
    PersistedState,
}

impl WebhookTokenProvenance {
    const fn public_source(self) -> &'static str {
        match self {
            Self::PersistedState => "settings",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WebhookAuthProjection {
    source: &'static str,
    masked_token: String,
}

impl WebhookAuthProjection {
    fn body(&self) -> Value {
        json!({
            "success": true,
            "enabled": true,
            "source": self.source,
            "headerName": "x-matchaclaw-webhook-token",
            "authorizationScheme": "Bearer",
            "maskedToken": self.masked_token.as_str(),
            "copySupported": false,
        })
    }
}

impl std::fmt::Debug for WebhookToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WebhookToken([REDACTED])")
    }
}

impl WebhookToken {
    pub fn try_new(value: &str) -> Option<Self> {
        let value = value.as_bytes();
        (value.len() == WEBHOOK_TOKEN_PREFIX.len() + WEBHOOK_TOKEN_BYTES * 2
            && value.starts_with(WEBHOOK_TOKEN_PREFIX.as_bytes())
            && value[WEBHOOK_TOKEN_PREFIX.len()..]
                .iter()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')))
        .then(|| Self {
            value: value.to_vec(),
            provenance: WebhookTokenProvenance::PersistedState,
        })
    }

    fn public_auth_projection(&self) -> WebhookAuthProjection {
        let mut masked_token = String::from(WEBHOOK_TOKEN_PREFIX);
        masked_token.push('…');
        for byte in &self.value[self.value.len() - 4..] {
            masked_token.push(char::from(*byte));
        }
        WebhookAuthProjection {
            source: self.provenance.public_source(),
            masked_token,
        }
    }

    pub fn matches(&self, value: &str) -> bool {
        let value = value.trim().as_bytes();
        let mut difference = self.value.len() ^ value.len();
        for index in 0..self.value.len().max(value.len()) {
            difference |=
                usize::from(*self.value.get(index).unwrap_or(&0) ^ *value.get(index).unwrap_or(&0));
        }
        difference == 0
    }
}

impl Drop for WebhookToken {
    fn drop(&mut self) {
        self.value.fill(0);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) enum Request {
    List {
        team_id: organization::TeamId,
    },
    Fire {
        request: organization::TriggerFireRequest,
    },
    Webhook {
        path: String,
        idempotency_key: String,
    },
}

pub(crate) enum Delivery {
    Auth(WebhookAuthProjection),
    Triggers(Vec<ArmedTrigger>),
    Fired { run_id: String },
    NotFound,
    Rejected,
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Auth(_) | Self::Triggers(_) | Self::Fired { .. } => 200,
            Self::NotFound => 404,
            Self::Rejected => 409,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Auth(projection) => projection.body(),
            Self::Triggers(triggers) => json!({
                "success": true,
                "triggers": triggers.iter().map(trigger_json).collect::<Vec<_>>(),
            }),
            Self::Fired { run_id } => json!({ "success": true, "runId": run_id }),
            Self::NotFound => json!({ "success": false, "error": "Team trigger is unavailable" }),
            Self::Rejected => json!({ "success": false, "error": "Team trigger was rejected" }),
            Self::Unavailable => {
                json!({ "success": false, "error": "Team trigger is unavailable" })
            }
        }
    }
}

pub(crate) fn decode_webhook_auth(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<(), DecodeError> {
    let Value::Object(body) = value else {
        return Err(DecodeError::Invalid);
    };
    if !body.is_empty() {
        return Err(DecodeError::Invalid);
    }
    verifier
        .verify(
            authorization,
            now,
            WEBHOOK_AUTH_ENDPOINT,
            WEBHOOK_AUTHORIZATION_SCOPE,
            WEBHOOK_AUTH_OPERATION_ID,
            WEBHOOK_AUTHORIZATION_SUBJECT,
        )
        .map(|_| ())
        .map_err(|_| DecodeError::Unauthorized)
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    let Value::Object(body) = value else {
        return Err(DecodeError::Invalid);
    };
    let Some(Value::String(action)) = body.get("action") else {
        return Err(DecodeError::Invalid);
    };
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
    match action.as_str() {
        "list" if has_keys(&body, &["action", "teamId"]) => Ok(Request::List {
            team_id: team_id(body.get("teamId"))?,
        }),
        "fire"
            if has_keys(
                &body,
                &["action", "runId", "startNodeId", "source", "idempotencyKey"],
            ) =>
        {
            let source = match string(body.get("source"))? {
                "cron" => organization::TriggerSource::Cron,
                "webhook" => organization::TriggerSource::Webhook,
                _ => return Err(DecodeError::Invalid),
            };
            Ok(Request::Fire {
                request: organization::TriggerFireRequest::try_new(
                    string(body.get("runId"))?,
                    string(body.get("startNodeId"))?,
                    source,
                    string(body.get("idempotencyKey"))?,
                )
                .map_err(|_| DecodeError::Invalid)?,
            })
        }
        _ => Err(DecodeError::Invalid),
    }
}

pub(crate) async fn handle(
    owner: &owner::Handle,
    _webhook_token: &WebhookToken,
    request: Request,
    fired_at: u64,
) -> Delivery {
    match request {
        Request::List { team_id } => match owner.armed_team_triggers(Some(team_id)).await {
            Ok(triggers) => Delivery::Triggers(triggers),
            Err(_) => Delivery::Unavailable,
        },
        Request::Fire { request } => fire(owner, request, fired_at).await,
        Request::Webhook {
            path,
            idempotency_key,
        } => match owner
            .team_runtime(crate::owner::TeamRuntimeCommand::WebhookTriggerFire {
                webhook_path: path,
                idempotency_key,
                fired_at,
            })
            .await
        {
            Ok(crate::owner::TeamRuntimeCommandOutcome::WebhookTriggerFire(Ok(
                organization::TeamTriggerFireOutcome::Recorded(request)
                | organization::TeamTriggerFireOutcome::Replayed(request),
            ))) => Delivery::Fired {
                run_id: request.trigger.run_id,
            },
            Ok(crate::owner::TeamRuntimeCommandOutcome::WebhookTriggerFire(Ok(
                organization::TeamTriggerFireOutcome::NotFound,
            ))) => Delivery::NotFound,
            Ok(crate::owner::TeamRuntimeCommandOutcome::WebhookTriggerFire(Ok(
                organization::TeamTriggerFireOutcome::Rejected
                | organization::TeamTriggerFireOutcome::Conflicting { .. },
            ))) => Delivery::Rejected,
            Ok(crate::owner::TeamRuntimeCommandOutcome::WebhookTriggerFire(Ok(
                organization::TeamTriggerFireOutcome::Unknown,
            )))
            | Ok(crate::owner::TeamRuntimeCommandOutcome::WebhookTriggerFire(Err(
                crate::owner::TeamRuntimeStatus::OutcomeUnknown,
            ))) => Delivery::Unavailable,
            Ok(crate::owner::TeamRuntimeCommandOutcome::WebhookTriggerFire(Err(
                crate::owner::TeamRuntimeStatus::Rejected,
            ))) => Delivery::Rejected,
            Ok(crate::owner::TeamRuntimeCommandOutcome::WebhookTriggerFire(Err(
                crate::owner::TeamRuntimeStatus::Unavailable,
            )))
            | Err(_) => Delivery::Unavailable,
            Ok(_) => Delivery::Unavailable,
        },
    }
}

async fn fire(
    owner: &owner::Handle,
    request: organization::TriggerFireRequest,
    fired_at: u64,
) -> Delivery {
    let run_id = request.run_id.clone();
    match owner.fire_team_run_trigger(request, fired_at).await {
        Ok(Ok(_)) => Delivery::Fired { run_id },
        Ok(Err(_)) => Delivery::Rejected,
        Err(_) => Delivery::Unavailable,
    }
}

fn trigger_json(trigger: &ArmedTrigger) -> Value {
    match &trigger.trigger {
        TeamTrigger::Webhook { .. } => json!({
            "teamId": trigger.team_id.as_str(), "runId": trigger.run_id.as_str(),
            "startNodeId": trigger.start_node_id, "trigger": { "kind": "webhook" },
        }),
        TeamTrigger::Cron { .. } => json!({
            "teamId": trigger.team_id.as_str(), "runId": trigger.run_id.as_str(),
            "startNodeId": trigger.start_node_id, "trigger": { "kind": "cron" },
        }),
    }
}

fn has_keys(body: &serde_json::Map<String, Value>, keys: &[&str]) -> bool {
    body.len() == keys.len() && keys.iter().all(|key| body.contains_key(*key))
}

fn string(value: Option<&Value>) -> Result<&str, DecodeError> {
    value.and_then(Value::as_str).ok_or(DecodeError::Invalid)
}

fn team_id(value: Option<&Value>) -> Result<organization::TeamId, DecodeError> {
    let value = string(value)?;
    organization::TeamId::try_new(value.to_owned()).map_err(|_| DecodeError::Invalid)
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    #[test]
    fn webhook_token_accepts_only_the_persisted_state_grammar() {
        let valid = format!("mctwh_{}", "0123456789abcdef".repeat(4));
        assert!(WebhookToken::try_new(&valid).is_some());

        for invalid in [
            "",
            "mctwh_",
            "MCTWH_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "mctwh_0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
            "mctwh_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde",
            "mctwh_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
        ] {
            assert!(WebhookToken::try_new(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn auth_action_returns_a_source_backed_masked_projection() {
        let value = format!("mctwh_{}", "0123456789abcdef".repeat(4));
        let token = WebhookToken::try_new(&value).expect("valid webhook token");
        let delivery = Delivery::Auth(token.public_auth_projection());

        assert_eq!(delivery.status_code(), 200);
        assert_eq!(
            delivery.body(),
            json!({
                "success": true,
                "enabled": true,
                "source": "settings",
                "headerName": "x-matchaclaw-webhook-token",
                "authorizationScheme": "Bearer",
                "maskedToken": "mctwh_…cdef",
                "copySupported": false,
            }),
        );
        let body = serde_json::to_string(&delivery.body()).expect("serialize projection");
        assert!(!body.contains("0123456789abcdef"));
    }

    #[test]
    fn webhook_auth_requires_dedicated_endpoint_and_empty_body() {
        let authorization = decision_at(
            WEBHOOK_AUTH_ENDPOINT,
            WEBHOOK_AUTHORIZATION_SCOPE,
            WEBHOOK_AUTH_OPERATION_ID,
            WEBHOOK_AUTHORIZATION_SUBJECT,
        );
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");

        assert!(decode_webhook_auth(json!({}), &authorization, &mut verifier, 1).is_ok());
        assert!(matches!(
            decode_webhook_auth(
                json!({ "action": "auth" }),
                &authorization,
                &mut verifier,
                1
            ),
            Err(DecodeError::Invalid)
        ));
    }

    #[test]
    fn trigger_decode_rejects_auth_action() {
        let authorization = decision_at(
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            OPERATION_ID,
            AUTHORIZATION_SUBJECT,
        );
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        assert!(matches!(
            decode(
                json!({ "action": "auth" }),
                &authorization,
                &mut verifier,
                1
            ),
            Err(DecodeError::Invalid)
        ));
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

    fn decision_at(endpoint: &str, scope: &str, capability: &str, subject: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": endpoint,
            "scope": scope,
            "capability": capability,
            "subject": subject,
            "expiresAt": 60_000,
            "correlation": format!("team-webhook-auth-test-{scope}-{capability}"),
            "revision": "test",
        });
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
