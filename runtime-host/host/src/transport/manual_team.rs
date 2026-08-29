pub(crate) mod server;

use serde_json::{Value, json};

use crate::{
    composition::ManualTeamCreateOutcome, organization::OrganizationHandle,
    runtime_driver::RuntimeDriverIdentity, transport::authorization::CapabilityDecisionVerifier,
};

const OPERATION_ID: &str = "team.manual.materialize-and-create";
const AUTHORIZATION_ENDPOINT: &str = "/api/team/manual-materialize-and-create";
const AUTHORIZATION_SCOPE: &str = "team:write";
const AUTHORIZATION_SUBJECT: &str = "team-manual-materialize-and-create";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) struct Request {
    team_id: organization::TeamId,
    team_name: String,
    idempotency_key: organization::IdempotencyKey,
    roles: Vec<organization::ManualTeamRoleBinding>,
}

pub(crate) enum Delivery {
    Materialized,
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Materialized | Self::Rejected | Self::OutcomeUnknown => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Materialized => json!({ "status": "materialized" }),
            Self::Rejected => json!({ "status": "rejected" }),
            Self::OutcomeUnknown => json!({ "status": "outcome_unknown" }),
            Self::Unavailable => {
                json!({ "success": false, "error": "Manual Team materialization is unavailable" })
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
            OPERATION_ID,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;

    let Value::Object(body) = value else {
        return Err(DecodeError::Invalid);
    };
    if body.len() != 4
        || !["teamId", "teamName", "idempotencyKey", "roles"]
            .iter()
            .all(|key| body.contains_key(*key))
    {
        return Err(DecodeError::Invalid);
    }

    let team_id =
        organization::TeamId::try_new(text(&body, "teamId")?).map_err(|_| DecodeError::Invalid)?;
    let team_name = text(&body, "teamName")?;
    let idempotency_key = organization::IdempotencyKey::try_new(text(&body, "idempotencyKey")?)
        .map_err(|_| DecodeError::Invalid)?;
    let roles = decode_roles(body.get("roles").ok_or(DecodeError::Invalid)?)?;

    Ok(Request {
        team_id,
        team_name,
        idempotency_key,
        roles,
    })
}

pub(crate) async fn dispatch(owner: &OrganizationHandle, request: Request) -> Delivery {
    let run = match graph_run(&request.team_id, request.idempotency_key.as_str()) {
        Ok(run) => run,
        Err(_) => return Delivery::Rejected,
    };
    let endpoint = organization::RuntimeEndpointReference::try_new(
        RuntimeDriverIdentity::open_claw().runtime_endpoint_reference(),
    )
    .expect("fixed OpenClaw endpoint must be valid");
    match owner
        .manual_team_create(
            request.team_id,
            request.team_name,
            endpoint,
            request.roles,
            request.idempotency_key.clone(),
            run,
            request.idempotency_key.as_str().to_owned(),
        )
        .await
    {
        Ok(ManualTeamCreateOutcome::Created(_)) => Delivery::Materialized,
        Ok(ManualTeamCreateOutcome::Rejected) => Delivery::Rejected,
        Ok(ManualTeamCreateOutcome::OutcomeUnknown) => Delivery::OutcomeUnknown,
        Ok(ManualTeamCreateOutcome::Unavailable) | Err(_) => Delivery::Unavailable,
    }
}

fn decode_roles(value: &Value) -> Result<Vec<organization::ManualTeamRoleBinding>, DecodeError> {
    let Value::Array(roles) = value else {
        return Err(DecodeError::Invalid);
    };
    if roles.is_empty() || roles.len() > 32 {
        return Err(DecodeError::Invalid);
    }
    roles.iter().map(decode_role).collect()
}

fn decode_role(value: &Value) -> Result<organization::ManualTeamRoleBinding, DecodeError> {
    let Value::Object(role) = value else {
        return Err(DecodeError::Invalid);
    };
    if role.len() != 4
        || !["roleId", "agentId", "displayName", "leader"]
            .iter()
            .all(|key| role.contains_key(*key))
    {
        return Err(DecodeError::Invalid);
    }
    let leader = role
        .get("leader")
        .and_then(Value::as_bool)
        .ok_or(DecodeError::Invalid)?;
    organization::ManualTeamRoleBinding::try_new(
        organization::RoleId::try_new(text(role, "roleId")?).map_err(|_| DecodeError::Invalid)?,
        text(role, "displayName")?,
        organization::ManagedAgentReference::try_new(text(role, "agentId")?)
            .map_err(|_| DecodeError::Invalid)?,
        leader,
    )
    .map_err(|_| DecodeError::Invalid)
}

fn text(object: &serde_json::Map<String, Value>, field: &str) -> Result<String, DecodeError> {
    let Some(Value::String(value)) = object.get(field) else {
        return Err(DecodeError::Invalid);
    };
    if value.is_empty()
        || value.len() > 256
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        return Err(DecodeError::Invalid);
    }
    Ok(value.clone())
}

fn graph_run(
    team_id: &organization::TeamId,
    idempotency_key: &str,
) -> Result<organization::GraphRunFacts, ()> {
    let run_id = organization::GraphRunId::new(format!("manual:{idempotency_key}"));
    let definition = organization::GraphDefinition::new(
        format!("manual:{idempotency_key}"),
        "manual-materialization",
        run_id,
        "Manual Team",
        vec![organization::NodeDefinition::start(
            organization::NodeId::new("start"),
            "Start",
            std::num::NonZeroU32::MIN,
            None,
        )],
        Vec::new(),
    )
    .map_err(|_| ())?;
    organization::GraphRunFacts::new(
        team_id.clone(),
        organization::TeamRevision::initial(),
        organization::GraphState::initialize(definition, 0),
        None,
    )
    .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    #[test]
    fn decodes_only_a_sealed_manual_team_request() {
        let request =
            decode_with_authorization(valid_request(), OPERATION_ID).expect("valid request");
        assert_eq!(request.team_id.as_str(), "team:manual");
        assert_eq!(request.roles.len(), 2);

        for invalid in [
            json!({ "teamId": "team:manual", "teamName": "Manual", "idempotencyKey": "manual:one", "roles": [], "workspacePath": "C:/private" }),
            json!({ "teamId": "team:manual", "teamName": "Manual", "idempotencyKey": "manual:one", "roles": [{ "roleId": "leader", "agentId": "agent:lead", "displayName": "Lead", "workspaceBinding": "binding.lead", "leader": true }] }),
            json!({ "teamId": "team:manual", "teamName": "Manual", "idempotencyKey": "manual:one", "roles": [{ "roleId": "leader", "agentId": "agent:lead", "displayName": "Lead", "leader": false }] }),
            json!({ "teamId": "team:manual", "teamName": "Manual", "idempotencyKey": "manual:one", "roles": [{ "roleId": "leader", "agentId": "agent:lead", "displayName": "Lead", "leader": true, "rawWorkspace": "/private" }] }),
        ] {
            assert!(matches!(
                decode_with_authorization(invalid, OPERATION_ID),
                Err(DecodeError::Invalid)
            ));
        }
    }

    #[test]
    fn rejects_a_decision_for_another_operation_without_redeeming_it() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(matches!(
            decode(
                valid_request(),
                &decision("team.skill.materialize", "wrong"),
                &mut verifier,
                1
            ),
            Err(DecodeError::Unauthorized)
        ));
        assert!(
            decode(
                valid_request(),
                &decision(OPERATION_ID, "right"),
                &mut verifier,
                1
            )
            .is_ok()
        );
    }

    #[test]
    fn materialization_outcomes_are_closed_and_redacted() {
        assert_eq!(
            Delivery::Materialized.body(),
            json!({ "status": "materialized" })
        );
        assert_eq!(Delivery::Rejected.body(), json!({ "status": "rejected" }));
        assert_eq!(
            Delivery::OutcomeUnknown.body(),
            json!({ "status": "outcome_unknown" })
        );
        assert_eq!(
            Delivery::Unavailable.body(),
            json!({ "success": false, "error": "Manual Team materialization is unavailable" }),
        );
        for delivery in [
            Delivery::Materialized,
            Delivery::Rejected,
            Delivery::OutcomeUnknown,
            Delivery::Unavailable,
        ] {
            let body = delivery.body().to_string();
            assert!(!body.contains("runId"));
            assert!(!body.contains("workspace"));
            assert!(!body.contains("agent:"));
        }
    }

    fn valid_request() -> Value {
        json!({
            "teamId": "team:manual",
            "teamName": "Manual Team",
            "idempotencyKey": "manual:one",
            "roles": [
                { "roleId": "leader", "agentId": "agent:lead", "displayName": "Lead", "leader": true },
                { "roleId": "reviewer", "agentId": "agent:reviewer", "displayName": "Reviewer", "leader": false }
            ]
        })
    }

    fn decode_with_authorization(value: Value, operation: &str) -> Result<Request, DecodeError> {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        decode(value, &decision(operation, "test"), &mut verifier, 1)
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
