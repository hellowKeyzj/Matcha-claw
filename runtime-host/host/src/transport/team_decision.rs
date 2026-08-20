use serde_json::{Value, json};

use crate::{owner, transport::authorization::CapabilityDecisionVerifier};

const AUTHORIZATION_ENDPOINT: &str = "/api/team/decision";
const AUTHORIZATION_SCOPE: &str = "team:write";
const AUTHORIZATION_OPERATION: &str = "team.decision.resolve";
const AUTHORIZATION_SUBJECT: &str = "team-decision";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) struct Request {
    run_id: organization::GraphRunId,
    approval_id: String,
    decision: organization::run::approval::ApprovalDecision,
    note: Option<String>,
    idempotency_key: String,
}

pub(crate) enum Delivery {
    Recorded,
    Replayed,
    OutcomeUnknown,
    Rejected,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Recorded | Self::Replayed | Self::OutcomeUnknown => 200,
            Self::Rejected => 409,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Recorded => json!({ "success": true, "outcome": "recorded" }),
            Self::Replayed => json!({ "success": true, "outcome": "replayed" }),
            Self::OutcomeUnknown => json!({ "success": true, "outcome": "outcome-unknown" }),
            Self::Rejected => {
                json!({ "success": false, "error": "Team human decision was rejected" })
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
    let note = match body.get("note") {
        Some(Value::String(note)) if valid_note(note) => Some(note.clone()),
        None => None,
        _ => return Err(DecodeError::Invalid),
    };
    let keys = if note.is_some() {
        ["runId", "approvalId", "decision", "note", "idempotencyKey"].as_slice()
    } else {
        ["runId", "approvalId", "decision", "idempotencyKey"].as_slice()
    };
    if !has_keys(&body, keys) {
        return Err(DecodeError::Invalid);
    }
    let decision = match string(body.get("decision"))? {
        "approve" => organization::run::approval::ApprovalDecision::Approve,
        "deny" => organization::run::approval::ApprovalDecision::Deny,
        "abort" => organization::run::approval::ApprovalDecision::Abort,
        _ => return Err(DecodeError::Invalid),
    };
    Ok(Request {
        run_id: run_id(string(body.get("runId"))?)?,
        approval_id: opaque_id(string(body.get("approvalId"))?)?,
        decision,
        note,
        idempotency_key: opaque_id(string(body.get("idempotencyKey"))?)?,
    })
}

pub(crate) async fn handle(owner: &owner::Handle, request: Request, resolved_at: u64) -> Delivery {
    let approval_id = match organization::run::event::OpaqueId::try_new(request.approval_id) {
        Ok(approval_id) => approval_id,
        Err(_) => return Delivery::Rejected,
    };
    let idempotency_key = match organization::run::event::OpaqueId::try_new(request.idempotency_key)
    {
        Ok(idempotency_key) => idempotency_key,
        Err(_) => return Delivery::Rejected,
    };
    let command = match organization::run::approval::HumanDecisionCommand::new(
        request.run_id,
        approval_id,
        request.decision,
        request.note,
        idempotency_key,
        resolved_at,
    ) {
        Ok(command) => command,
        Err(_) => return Delivery::Rejected,
    };
    match owner.resolve_team_human_decision(command).await {
        Ok(Ok(organization::run::approval::HumanDecisionOutcome::Recorded)) => Delivery::Recorded,
        Ok(Ok(organization::run::approval::HumanDecisionOutcome::Replayed)) => Delivery::Replayed,
        Ok(Err(_)) => Delivery::OutcomeUnknown,
        Err(_) => Delivery::OutcomeUnknown,
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

fn valid_note(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256
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
            json!({ "runId": "run:1", "approvalId": "approval:1", "decision": "approve", "note": "private note canary", "idempotencyKey": "decision:1" }),
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
                    json!({ "runId": "run:1", "approvalId": "approval:1", "decision": "approve", "note": "private note canary", "idempotencyKey": "decision:1" }),
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
            Delivery::Recorded.body(),
            Delivery::Replayed.body(),
            Delivery::OutcomeUnknown.body(),
            Delivery::Rejected.body(),
        ]
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join(
            "
",
        );
        for private in ["private note canary", "token", "native", "session", "path"] {
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
