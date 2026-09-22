use platform::capability::CapabilityDecisionVerifier;

use organization::run::public_projection as public;
use serde_json::{Value, json};

use crate::OrganizationHandle;

const OPERATION_ID: &str = "team.public.read";
const AUTHORIZATION_ENDPOINT: &str = "/api/team/public";
const AUTHORIZATION_SCOPE: &str = "team:read";
const AUTHORIZATION_SUBJECT: &str = "team-public-projection";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) struct Request {
    team_id: organization::TeamId,
    run_id: organization::GraphRunId,
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
    if body.len() != 2 {
        return Err(DecodeError::Invalid);
    }
    let Some(Value::String(team_id)) = body.get("teamId") else {
        return Err(DecodeError::Invalid);
    };
    let Some(Value::String(run_id)) = body.get("runId") else {
        return Err(DecodeError::Invalid);
    };
    if !valid_identifier(team_id) || !valid_identifier(run_id) {
        return Err(DecodeError::Invalid);
    }

    Ok(Request {
        team_id: organization::TeamId::try_new(team_id.clone())
            .map_err(|_| DecodeError::Invalid)?,
        run_id: organization::GraphRunId::new(run_id.clone()),
    })
}

pub(crate) enum Delivery {
    Available(organization::run::public_projection::TeamPublicProjection),
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
            Self::Available(projection) => public_projection_body(projection),
            Self::Unavailable => json!({
                "success": false,
                "error": "Team public projection is unavailable",
            }),
        }
    }
}

fn public_projection_body(projection: &public::TeamPublicProjection) -> Value {
    let graph = projection.graph();
    json!({
        "teamId": projection.team_id(),
        "runId": projection.run_id(),
        "teamRevision": projection.team_revision(),
        "runtime": format_runtime_state(projection.runtime()),
        "graph": {
            "graphId": graph.graph_id(),
            "workflowPlanId": graph.workflow_plan_id(),
            "title": graph.title(),
            "status": format_graph_status(graph.status()),
            "nodes": graph.nodes().iter().map(node_body).collect::<Vec<_>>(),
            "edges": graph.edges().iter().map(edge_body).collect::<Vec<_>>(),
        },
    })
}

fn node_body(node: &public::TeamPublicNode) -> Value {
    json!({
        "nodeId": node.node_id(),
        "kind": format_node_kind(node.kind()),
        "title": node.title(),
        "roleId": node.role_id(),
        "taskId": node.task_id(),
        "maxAttempts": node.max_attempts(),
        "trigger": node.trigger().map(trigger_body),
        "attempt": {
            "number": node.attempt().number(),
            "status": format_attempt_status(node.attempt().status()),
            "updatedAt": node.attempt().updated_at(),
        },
    })
}

fn trigger_body(trigger: &public::TeamPublicStartTrigger) -> Value {
    match trigger {
        public::TeamPublicStartTrigger::Webhook => json!({ "kind": "webhook" }),
        public::TeamPublicStartTrigger::Cron { expression } => {
            json!({ "kind": "cron", "expression": expression })
        }
    }
}

fn edge_body(edge: &public::TeamPublicEdge) -> Value {
    json!({
        "edgeId": edge.edge_id(),
        "sourceNodeId": edge.source_node_id(),
        "sourcePort": edge.source_port(),
        "targetNodeId": edge.target_node_id(),
        "targetPort": edge.target_port(),
        "action": format_edge_action(edge.action()),
        "status": format_edge_status(edge.status()),
    })
}

fn format_runtime_state(status: public::TeamRuntimeState) -> &'static str {
    match status {
        public::TeamRuntimeState::Confirmed => "confirmed",
        public::TeamRuntimeState::Unknown => "unknown",
    }
}

fn format_graph_status(status: public::TeamPublicGraphStatus) -> &'static str {
    match status {
        public::TeamPublicGraphStatus::Pending => "pending",
        public::TeamPublicGraphStatus::Ready => "ready",
        public::TeamPublicGraphStatus::Running => "running",
        public::TeamPublicGraphStatus::Waiting => "waiting",
        public::TeamPublicGraphStatus::Completed => "completed",
        public::TeamPublicGraphStatus::Failed => "failed",
        public::TeamPublicGraphStatus::Cancelled => "cancelled",
    }
}

fn format_node_kind(kind: public::TeamPublicNodeKind) -> &'static str {
    match kind {
        public::TeamPublicNodeKind::Start => "start",
        public::TeamPublicNodeKind::Work => "work",
        public::TeamPublicNodeKind::Review => "review",
        public::TeamPublicNodeKind::HumanDecision => "human_decision",
        public::TeamPublicNodeKind::ScriptReview => "script_review",
        public::TeamPublicNodeKind::Join => "join",
        public::TeamPublicNodeKind::End => "end",
    }
}

fn format_attempt_status(status: public::TeamPublicAttemptStatus) -> &'static str {
    match status {
        public::TeamPublicAttemptStatus::Pending => "pending",
        public::TeamPublicAttemptStatus::Ready => "ready",
        public::TeamPublicAttemptStatus::Running => "running",
        public::TeamPublicAttemptStatus::Waiting => "waiting",
        public::TeamPublicAttemptStatus::Completed => "completed",
        public::TeamPublicAttemptStatus::Failed => "failed",
        public::TeamPublicAttemptStatus::Cancelled => "cancelled",
    }
}

fn format_edge_action(action: public::TeamPublicEdgeAction) -> &'static str {
    match action {
        public::TeamPublicEdgeAction::Activate => "activate",
        public::TeamPublicEdgeAction::Rework => "rework",
        public::TeamPublicEdgeAction::Gate => "gate",
        public::TeamPublicEdgeAction::Finish => "finish",
    }
}

fn format_edge_status(status: public::TeamPublicEdgeStatus) -> &'static str {
    match status {
        public::TeamPublicEdgeStatus::Waiting => "waiting",
        public::TeamPublicEdgeStatus::Satisfied => "satisfied",
    }
}

pub(crate) async fn read(owner: &OrganizationHandle, request: Request) -> Delivery {
    match owner
        .team_run_public_projection(request.team_id, request.run_id)
        .await
    {
        Ok(organization::run::public_projection::TeamPublicQueryOutcome::Available(projection)) => {
            Delivery::Available(projection)
        }
        Ok(organization::run::public_projection::TeamPublicQueryOutcome::Unavailable) | Err(_) => {
            Delivery::Unavailable
        }
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
    fn decodes_only_the_fixed_team_and_run_request_after_matching_authorization() {
        let request = decode_with_authorization(json!({
            "teamId": "team:one",
            "runId": "run:one",
        }));
        assert_eq!(request.team_id.as_str(), "team:one");
        assert_eq!(request.run_id.as_str(), "run:one");

        for malformed in [
            json!({ "teamId": "team:one" }),
            json!({ "teamId": "team:one", "runId": "run:one", "diagnostics": true }),
            json!({ "teamId": "team:one", "runId": "run:\u{0}one" }),
            json!({ "teamId": "team:one", "runId": "run:\none" }),
        ] {
            assert!(matches!(
                decode_result(malformed),
                Err(DecodeError::Invalid)
            ));
        }
    }

    #[test]
    fn rejects_decisions_bound_to_another_public_capability() {
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        let authorization = decision(
            "/api/channels/status",
            "channels:read",
            "channels.status.read",
        );

        assert!(matches!(
            decode(
                json!({ "teamId": "team:one", "runId": "run:one" }),
                &authorization,
                &mut verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));
    }

    #[test]
    fn unavailable_delivery_is_fixed_and_redacted() {
        let delivery = Delivery::Unavailable;
        assert_eq!(delivery.status_code(), 404);
        assert_eq!(
            delivery.body(),
            json!({
                "success": false,
                "error": "Team public projection is unavailable",
            })
        );
    }

    fn decode_with_authorization(value: Value) -> Request {
        decode_result(value).expect("valid fixed request")
    }

    fn decode_result(value: Value) -> Result<Request, DecodeError> {
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        let authorization = decision(AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, OPERATION_ID);
        decode(value, &authorization, &mut verifier, 1)
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

    fn decision(endpoint: &str, scope: &str, capability: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": endpoint,
            "scope": scope,
            "capability": capability,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": 60_000,
            "correlation": "team-public-test",
            "revision": "test",
        });
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}

pub(crate) mod handler;
