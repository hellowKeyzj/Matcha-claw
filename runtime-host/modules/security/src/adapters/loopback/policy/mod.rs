use platform::capability::CapabilityDecisionVerifier;

use serde_json::Value;

pub mod catalog;
pub mod handler;
pub mod wire;

pub const ENDPOINT: &str = "/api/security/policy";
pub const READ_ENDPOINT: &str = "/api/security/policy/current";
pub const AUDIT_ENDPOINT: &str = "/api/security/audit/current";
pub const CATALOG_ENDPOINT: &str = "/api/security/destructive-rule-catalog/current";
pub const OPERATION_ENDPOINT: &str = "/api/security/operation";
pub const OPERATION_RECEIPT_ENDPOINT: &str = "/api/security/operation/receipt";
pub const OPERATION_RECEIPT_SUBJECT: &str = "operation-receipt";
const SCOPE: &str = "security:write";
const CAPABILITY: &str = "security.replace";
const SUBJECT: &str = "security-policy";
const OPERATION_SCOPE: &str = "security:operate";
const OPERATION_SUBJECT: &str = "security-operation";
pub const READ_SCOPE: &str = "security:read";
pub const READ_CAPABILITY: &str = "security.read";
pub const POLICY_READ_SUBJECT: &str = "policy-read";
pub const AUDIT_READ_SUBJECT: &str = "audit-read";

const SECURITY_OPERATION_IDS: &[&str] = &[
    "security.quickAudit",
    "security.checkIntegrity",
    "security.rebaselineIntegrity",
    "security.scanSkills",
    "security.checkAdvisories",
    "security.previewRemediation",
    "security.applyRemediation",
    "security.rollbackRemediation",
];
const MAX_OPERATION_TEXT_BYTES: usize = 4 * 1024;
const MAX_OPERATION_ACTIONS: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeError {
    Unauthorized,
    Invalid,
}

pub fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<(Value, String), DecodeError> {
    let decision = verifier
        .verify(authorization, now, ENDPOINT, SCOPE, CAPABILITY, SUBJECT)
        .map_err(|_| DecodeError::Unauthorized)?;
    valid(&value)
        .then_some((value, decision.correlation().to_owned()))
        .ok_or(DecodeError::Invalid)
}

pub fn decode_operation(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<(String, String, Value), DecodeError> {
    let operation_id = operation_id(&value).ok_or(DecodeError::Invalid)?;
    let decision = verifier
        .verify(
            authorization,
            now,
            OPERATION_ENDPOINT,
            OPERATION_SCOPE,
            operation_id,
            OPERATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;
    let input = valid_operation(&value, operation_id).ok_or(DecodeError::Invalid)?;
    Ok((
        operation_id.to_owned(),
        decision.correlation().to_owned(),
        input,
    ))
}

fn valid(value: &Value) -> bool {
    let Some(body) = value.as_object() else {
        return false;
    };
    if body.len() != 5
        || body.get("id") != Some(&Value::String("security.policy".into()))
        || body.get("operationId") != Some(&Value::String(CAPABILITY.into()))
    {
        return false;
    }
    let valid_scope = body
        .get("scope")
        .and_then(Value::as_object)
        .is_some_and(|scope| {
            scope.len() == 1 && scope.get("kind") == Some(&Value::String("security-policy".into()))
        });
    let valid_target = body
        .get("target")
        .and_then(Value::as_object)
        .is_some_and(|target| {
            target.len() == 1
                && target.get("kind") == Some(&Value::String("security-policy".into()))
        });
    let Some(input) = body.get("input").and_then(Value::as_object) else {
        return false;
    };
    let Some(policy) = input.get("policy").and_then(Value::as_object) else {
        return false;
    };
    valid_scope
        && valid_target
        && input.len() == 1
        && policy.len() == 3
        && matches!(
            policy.get("preset").and_then(Value::as_str),
            Some("strict" | "balanced" | "relaxed")
        )
        && policy
            .get("securityPolicyVersion")
            .and_then(Value::as_u64)
            .is_some_and(|version| version > 0)
        && policy.get("runtime").is_some_and(Value::is_object)
}

fn operation_id(value: &Value) -> Option<&str> {
    let body = value.as_object()?;
    if body.len() != 5 || body.get("id")?.as_str()? != "security.operation" {
        return None;
    }
    let operation_id = body.get("operationId")?.as_str()?;
    SECURITY_OPERATION_IDS
        .contains(&operation_id)
        .then_some(operation_id)
}

fn valid_operation(value: &Value, operation_id: &str) -> Option<Value> {
    let body = value.as_object()?;
    let scope = body.get("scope")?.as_object()?;
    let target = body.get("target")?.as_object()?;
    let scope_kind = scope.get("kind")?.as_str()?;
    let expected_kind = operation_scope_kind(operation_id)?;
    if scope.len() != 1 || scope_kind != expected_kind {
        return None;
    }
    let input = body.get("input")?.as_object()?;
    if valid_operation_target(operation_id, target, input)?
        && valid_operation_input(operation_id, input)
    {
        Some(Value::Object(input.clone()))
    } else {
        None
    }
}

fn operation_scope_kind(operation_id: &str) -> Option<&'static str> {
    match operation_id {
        "security.quickAudit"
        | "security.checkIntegrity"
        | "security.rebaselineIntegrity"
        | "security.scanSkills"
        | "security.checkAdvisories" => Some("security-policy"),
        "security.previewRemediation"
        | "security.applyRemediation"
        | "security.rollbackRemediation" => Some("security-remediation"),
        _ => None,
    }
}

fn valid_operation_target(
    operation_id: &str,
    target: &serde_json::Map<String, Value>,
    input: &serde_json::Map<String, Value>,
) -> Option<bool> {
    let expected_kind = operation_scope_kind(operation_id)?;
    if target.get("kind")?.as_str()? != expected_kind {
        return Some(false);
    }
    if operation_id != "security.rollbackRemediation" {
        return Some(target.len() == 1);
    }
    match target.len() {
        1 => Some(true),
        2 => {
            let target_snapshot = target.get("snapshotId")?.as_str()?;
            let input_snapshot = input.get("snapshotId")?.as_str()?;
            Some(target_snapshot == input_snapshot && bounded_text(target_snapshot))
        }
        _ => Some(false),
    }
}

fn valid_operation_input(operation_id: &str, input: &serde_json::Map<String, Value>) -> bool {
    match operation_id {
        "security.scanSkills" => {
            input.is_empty()
                || (input.len() == 1
                    && input
                        .get("scanPath")
                        .and_then(Value::as_str)
                        .is_some_and(bounded_text))
        }
        "security.checkAdvisories" => {
            input.is_empty()
                || (input.len() == 1
                    && input.get("feedUrl").is_some_and(|value| {
                        value.is_null() || value.as_str().is_some_and(bounded_text)
                    }))
        }
        "security.applyRemediation" => {
            if input.is_empty() {
                return true;
            }
            let Some(actions) = input.get("actions").and_then(Value::as_array) else {
                return false;
            };
            input.len() == 1
                && actions.len() <= MAX_OPERATION_ACTIONS
                && actions
                    .iter()
                    .all(|value| value.as_str().is_some_and(bounded_text))
        }
        "security.rollbackRemediation" => {
            input.is_empty()
                || (input.len() == 1
                    && input.get("snapshotId").is_some_and(|value| {
                        value.is_null() || value.as_str().is_some_and(bounded_text)
                    }))
        }
        _ => input.is_empty(),
    }
}

fn bounded_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPERATION_TEXT_BYTES
        && !value.chars().any(char::is_control)
}
