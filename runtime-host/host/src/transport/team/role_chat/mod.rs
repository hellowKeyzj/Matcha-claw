use serde_json::{Value, json};

use crate::{
    organization::OrganizationHandle, transport::common::authorization::CapabilityDecisionVerifier,
};

const AUTHORIZATION_ENDPOINT: &str = "/api/team/role-chat";
const AUTHORIZATION_SCOPE: &str = "team:write";
const AUTHORIZATION_OPERATION: &str = "team.role-chat.submit";
const AUTHORIZATION_SUBJECT: &str = "team-role-chat";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) struct Request {
    team_id: organization::TeamId,
    run_id: organization::GraphRunId,
    role_id: organization::RoleId,
    message: String,
    idempotency_key: String,
}

pub(crate) enum Delivery {
    Accepted,
    Rejected,
    OutcomeUnknown,
}

impl Delivery {
    pub(crate) const fn status_code(&self) -> u16 {
        match self {
            Self::Accepted | Self::Rejected => 200,
            Self::OutcomeUnknown => 409,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Accepted => json!({ "success": true, "outcome": "accepted" }),
            Self::Rejected => json!({ "success": true, "outcome": "rejected" }),
            Self::OutcomeUnknown => {
                json!({ "success": false, "outcome": "outcome-unknown", "error": "Team role chat outcome is unknown" })
            }
        }
    }
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
            AUTHORIZATION_OPERATION,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;
    let Value::Object(body) = value else {
        return Err(DecodeError::Invalid);
    };
    if !has_keys(
        &body,
        &["teamId", "runId", "roleId", "message", "idempotencyKey"],
    ) {
        return Err(DecodeError::Invalid);
    }
    let team_id = organization::TeamId::try_new(string(body.get("teamId"))?.to_owned())
        .map_err(|_| DecodeError::Invalid)?;
    let run_id = run_id(string(body.get("runId"))?)?;
    let role_id = organization::RoleId::try_new(string(body.get("roleId"))?.to_owned())
        .map_err(|_| DecodeError::Invalid)?;
    let message = string(body.get("message"))?;
    if message.trim().is_empty() || message.len() > 16 * 1024 {
        return Err(DecodeError::Invalid);
    }
    Ok(Request {
        team_id,
        run_id,
        role_id,
        message: message.to_owned(),
        idempotency_key: opaque_id(string(body.get("idempotencyKey"))?)?,
    })
}

pub(crate) async fn handle(
    owner: &OrganizationHandle,
    request: Request,
    requested_at: u64,
) -> Delivery {
    let sessions = match owner.role_sessions(request.team_id.clone()).await {
        Ok(organization::TeamRoleSessionQueryOutcome::Available(sessions)) => sessions,
        Ok(organization::TeamRoleSessionQueryOutcome::Unavailable) => return Delivery::Rejected,
        Ok(organization::TeamRoleSessionQueryOutcome::OutcomeUnknown) | Err(_) => {
            return Delivery::OutcomeUnknown;
        }
    };
    if !sessions.iter().any(|session| {
        session.run_id() == request.run_id.as_str() && session.role_id() == request.role_id.as_str()
    }) {
        return Delivery::Rejected;
    }
    let admission = match organization::RoleChatAdmission::new(
        request.team_id,
        request.run_id,
        request.role_id,
        request.message,
        request.idempotency_key,
        requested_at,
    ) {
        Ok(admission) => admission,
        Err(_) => return Delivery::Rejected,
    };
    match owner.role_message_submit(admission).await {
        Ok(Ok(organization::RoleChatAdmissionOutcome::Accepted { .. })) => Delivery::Accepted,
        Ok(Ok(organization::RoleChatAdmissionOutcome::Rejected(_))) => Delivery::Rejected,
        Ok(Ok(organization::RoleChatAdmissionOutcome::OutcomeUnknown)) | Ok(Err(_)) | Err(_) => {
            Delivery::OutcomeUnknown
        }
    }
}

fn has_keys(body: &serde_json::Map<String, Value>, keys: &[&str]) -> bool {
    body.len() == keys.len() && keys.iter().all(|key| body.contains_key(*key))
}

fn string(value: Option<&Value>) -> Result<&str, DecodeError> {
    value.and_then(Value::as_str).ok_or(DecodeError::Invalid)
}

fn run_id(value: &str) -> Result<organization::GraphRunId, DecodeError> {
    valid_identifier(value)
        .then(|| organization::GraphRunId::new(value.to_owned()))
        .ok_or(DecodeError::Invalid)
}

fn opaque_id(value: &str) -> Result<String, DecodeError> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':')))
    .then(|| value.to_owned())
    .ok_or(DecodeError::Invalid)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::Signer as _;
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    use super::*;

    const NOW: u64 = 1_000;

    #[test]
    fn decode_requires_the_fixed_signed_team_delivery_claims() {
        assert!(decode(
            json!({ "teamId": "team:1", "runId": "run:1", "roleId": "leader", "message": "private message canary", "idempotencyKey": "role-chat:1" }),
            &decision(AUTHORIZATION_OPERATION, AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, AUTHORIZATION_SUBJECT),
            &mut verifier(),
            NOW,
        )
        .is_ok());
        for authorization in [
            decision(
                "wrong.capability",
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                AUTHORIZATION_SUBJECT,
            ),
            decision(
                AUTHORIZATION_OPERATION,
                "/api/team/wrong",
                AUTHORIZATION_SCOPE,
                AUTHORIZATION_SUBJECT,
            ),
            decision(
                AUTHORIZATION_OPERATION,
                AUTHORIZATION_ENDPOINT,
                "team:read",
                AUTHORIZATION_SUBJECT,
            ),
            decision(
                AUTHORIZATION_OPERATION,
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                "wrong-subject",
            ),
        ] {
            assert!(matches!(
                decode(
                    json!({ "teamId": "team:1", "runId": "run:1", "roleId": "leader", "message": "private message canary", "idempotencyKey": "role-chat:1" }),
                    &authorization,
                    &mut verifier(),
                    NOW
                ),
                Err(DecodeError::Unauthorized)
            ));
        }
    }

    #[test]
    fn delivery_projection_is_closed_and_redacted() {
        let rendered = [
            Delivery::Accepted.body(),
            Delivery::Rejected.body(),
            Delivery::OutcomeUnknown.body(),
        ]
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join(
            "
",
        );
        for private in [
            "private message canary",
            "token",
            "native",
            "session",
            "path",
        ] {
            assert!(!rendered.contains(private));
        }
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[17; 32])
    }

    fn verifier() -> CapabilityDecisionVerifier {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        CapabilityDecisionVerifier::try_new(&URL_SAFE_NO_PAD.encode(bytes)).expect("verifier")
    }

    fn decision(capability: &str, endpoint: &str, scope: &str, subject: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": endpoint,
            "scope": scope,
            "capability": capability,
            "subject": subject,
            "expiresAt": NOW + 1,
            "correlation": "team-delivery-test",
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("payload"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}

pub(crate) mod server;
