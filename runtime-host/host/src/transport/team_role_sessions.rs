use serde_json::{Value, json};

use crate::{
    organization::OrganizationHandle, transport::authorization::CapabilityDecisionVerifier,
};

const OPERATION_ID: &str = "team.role-sessions.list";
const AUTHORIZATION_ENDPOINT: &str = "/api/team/role-sessions";
const AUTHORIZATION_SCOPE: &str = "team:read";
const AUTHORIZATION_SUBJECT: &str = "team-role-session-projection";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) struct Request {
    team_id: organization::TeamId,
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
    if body.len() != 1 {
        return Err(DecodeError::Invalid);
    }
    let Some(Value::String(team_id)) = body.get("teamId") else {
        return Err(DecodeError::Invalid);
    };
    if !valid_identifier(team_id) {
        return Err(DecodeError::Invalid);
    }
    Ok(Request {
        team_id: organization::TeamId::try_new(team_id.clone())
            .map_err(|_| DecodeError::Invalid)?,
    })
}

pub(crate) enum Delivery {
    Available(Vec<organization::TeamRoleSessionProjection>),
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Available(_) => 200,
            Self::Unavailable => 404,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Available(sessions) => json!({
                "success": true,
                "sessions": sessions,
            }),
            Self::Unavailable => json!({
                "success": false,
                "error": "Team role sessions are unavailable",
            }),
        }
    }
}

pub(crate) async fn list(owner: &OrganizationHandle, request: Request) -> Delivery {
    match owner.role_sessions(request.team_id).await {
        Ok(organization::TeamRoleSessionQueryOutcome::Available(sessions)) => {
            Delivery::Available(sessions)
        }
        Ok(organization::TeamRoleSessionQueryOutcome::Unavailable)
        | Ok(organization::TeamRoleSessionQueryOutcome::OutcomeUnknown)
        | Err(_) => Delivery::Unavailable,
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    #[test]
    fn accepts_only_a_signed_fixed_team_request() {
        let request = decode_result(json!({ "teamId": "team:one" })).expect("request");
        assert_eq!(request.team_id.as_str(), "team:one");
        for malformed in [
            json!({}),
            json!({ "teamId": "team:one", "runId": "run:one" }),
        ] {
            assert!(matches!(
                decode_result(malformed),
                Err(DecodeError::Invalid)
            ));
        }
    }

    #[test]
    fn rejects_another_capability_decision() {
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        assert!(matches!(
            decode(
                json!({ "teamId": "team:one" }),
                &decision("team.public.read"),
                &mut verifier,
                1
            ),
            Err(DecodeError::Unauthorized)
        ));
    }

    #[test]
    fn unavailable_delivery_is_fixed_and_redacted() {
        assert_eq!(
            Delivery::Unavailable.body(),
            json!({ "success": false, "error": "Team role sessions are unavailable" })
        );
    }

    fn decode_result(value: Value) -> Result<Request, DecodeError> {
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        decode(value, &decision(OPERATION_ID), &mut verifier, 1)
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

    fn decision(capability: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": AUTHORIZATION_ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": capability,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": 60_000,
            "correlation": "team-role-sessions-test",
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}

pub(crate) mod server;
