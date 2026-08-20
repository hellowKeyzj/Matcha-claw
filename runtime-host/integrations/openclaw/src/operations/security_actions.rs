use std::{fmt, sync::Arc};

use serde_json::{Map, Value, json};

use crate::gateway::{
    client::GatewayClient,
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

use super::next_request_id;

const SECURITY_QUICK_AUDIT_METHOD: &str = "security.quick_audit.run";
const SECURITY_INTEGRITY_CHECK_METHOD: &str = "security.integrity.check";
const SECURITY_INTEGRITY_REBASELINE_METHOD: &str = "security.integrity.rebaseline";
const SECURITY_SKILLS_SCAN_METHOD: &str = "security.skills.scan";
const SECURITY_ADVISORIES_CHECK_METHOD: &str = "security.advisories.check";
const SECURITY_REMEDIATION_PREVIEW_METHOD: &str = "security.remediation.preview";
const SECURITY_REMEDIATION_APPLY_METHOD: &str = "security.remediation.apply";
const SECURITY_REMEDIATION_ROLLBACK_METHOD: &str = "security.remediation.rollback";

const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_COUNT: u64 = 100_000;
const MAX_ITEMS: usize = 256;
const MAX_ACTIONS: usize = 256;
const MAX_SKILLS: usize = 256;
const MAX_ISSUES: usize = 256;
const MAX_ADVISORIES: usize = 256;
const MAX_TEXT_BYTES: usize = 4 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 512;
const MAX_OPAQUE_BYTES: usize = 128;
const MAX_SCAN_PATH_BYTES: usize = 4 * 1024;
const MAX_FEED_URL_BYTES: usize = 2 * 1024;

/// Native Gateway facade for the legacy security operation identifiers.
///
/// Only the fixed native methods and their bounded public projections cross
/// this edge. Private plugin fields and native error payloads are never
/// retained in the returned effect.
pub struct SecurityActionsOperation {
    gateway: Arc<GatewayClient>,
}

impl SecurityActionsOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn run(&self, operation_id: &str, input: Value) -> SecurityActionEffect {
        let (action, params) = match Action::from_legacy(operation_id, input) {
            Ok(request) => request,
            Err(()) => return SecurityActionEffect::RuntimeRejected,
        };
        let request = match wire::operations_request(
            next_request_id(action.request_name()),
            action.method(),
            params,
        ) {
            Ok(request) => request,
            Err(_) => return SecurityActionEffect::OutcomeUnknown,
        };
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                SecurityActionEffect::RuntimeRejected
            }
            MutationDelivery::Response(response) => match action.decode(response) {
                Ok(payload) => SecurityActionEffect::Applied(payload),
                Err(()) => SecurityActionEffect::OutcomeUnknown,
            },
            MutationDelivery::NotWritten(_) => SecurityActionEffect::Unavailable,
            MutationDelivery::MayHaveReached(_) => SecurityActionEffect::OutcomeUnknown,
        }
    }
}

impl fmt::Debug for SecurityActionsOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecurityActionsOperation")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SecurityActionEffect {
    Applied(Value),
    RuntimeRejected,
    Unavailable,
    OutcomeUnknown,
}

#[derive(Clone, Copy)]
enum Action {
    QuickAudit,
    IntegrityCheck,
    IntegrityRebaseline,
    SkillsScan,
    AdvisoriesCheck,
    RemediationPreview,
    RemediationApply,
    RemediationRollback,
}

impl Action {
    fn from_legacy(operation_id: &str, input: Value) -> Result<(Self, Value), ()> {
        match operation_id {
            "security.quickAudit" => Ok((Self::QuickAudit, empty_params(input)?)),
            "security.checkIntegrity" => Ok((Self::IntegrityCheck, empty_params(input)?)),
            "security.rebaselineIntegrity" => Ok((Self::IntegrityRebaseline, empty_params(input)?)),
            "security.scanSkills" => Ok((Self::SkillsScan, scan_skills_params(input)?)),
            "security.checkAdvisories" => Ok((Self::AdvisoriesCheck, advisories_params(input)?)),
            "security.previewRemediation" => Ok((Self::RemediationPreview, empty_params(input)?)),
            "security.applyRemediation" => {
                Ok((Self::RemediationApply, remediation_apply_params(input)?))
            }
            "security.rollbackRemediation" => Ok((
                Self::RemediationRollback,
                remediation_rollback_params(input)?,
            )),
            _ => Err(()),
        }
    }

    const fn method(self) -> &'static str {
        match self {
            Self::QuickAudit => SECURITY_QUICK_AUDIT_METHOD,
            Self::IntegrityCheck => SECURITY_INTEGRITY_CHECK_METHOD,
            Self::IntegrityRebaseline => SECURITY_INTEGRITY_REBASELINE_METHOD,
            Self::SkillsScan => SECURITY_SKILLS_SCAN_METHOD,
            Self::AdvisoriesCheck => SECURITY_ADVISORIES_CHECK_METHOD,
            Self::RemediationPreview => SECURITY_REMEDIATION_PREVIEW_METHOD,
            Self::RemediationApply => SECURITY_REMEDIATION_APPLY_METHOD,
            Self::RemediationRollback => SECURITY_REMEDIATION_ROLLBACK_METHOD,
        }
    }

    const fn request_name(self) -> &'static str {
        match self {
            Self::QuickAudit => "security-quick-audit",
            Self::IntegrityCheck => "security-integrity-check",
            Self::IntegrityRebaseline => "security-integrity-rebaseline",
            Self::SkillsScan => "security-skills-scan",
            Self::AdvisoriesCheck => "security-advisories-check",
            Self::RemediationPreview => "security-remediation-preview",
            Self::RemediationApply => "security-remediation-apply",
            Self::RemediationRollback => "security-remediation-rollback",
        }
    }

    fn decode(self, response: GatewayResponse) -> Result<Value, ()> {
        match self {
            Self::QuickAudit => decode_quick_audit(response),
            Self::IntegrityCheck => decode_integrity_check(response),
            Self::IntegrityRebaseline => decode_integrity_rebaseline(response),
            Self::SkillsScan => decode_skills_scan(response),
            Self::AdvisoriesCheck => decode_advisories_check(response),
            Self::RemediationPreview => decode_remediation_preview(response),
            Self::RemediationApply => decode_remediation_apply(response),
            Self::RemediationRollback => decode_remediation_rollback(response),
        }
    }
}

fn empty_params(value: Value) -> Result<Value, ()> {
    let Value::Object(object) = value else {
        return Err(());
    };
    object
        .is_empty()
        .then_some(Value::Object(Map::new()))
        .ok_or(())
}

fn scan_skills_params(value: Value) -> Result<Value, ()> {
    let object = exact_input_object(value, &["scanPath"])?;
    let Some(scan_path) = object.get("scanPath") else {
        return Ok(Value::Object(Map::new()));
    };
    let scan_path = bounded_text(scan_path, MAX_SCAN_PATH_BYTES)?;
    Ok(json!({ "scanPath": scan_path }))
}

fn advisories_params(value: Value) -> Result<Value, ()> {
    let object = exact_input_object(value, &["feedUrl"])?;
    let Some(feed_url) = object.get("feedUrl") else {
        return Ok(Value::Object(Map::new()));
    };
    if feed_url.is_null() {
        return Ok(Value::Object(Map::new()));
    }
    let feed_url = bounded_text(feed_url, MAX_FEED_URL_BYTES)?;
    Ok(json!({ "feedUrl": feed_url }))
}

fn remediation_apply_params(value: Value) -> Result<Value, ()> {
    let object = exact_input_object(value, &["actions"])?;
    let Some(actions) = object.get("actions") else {
        return Ok(Value::Object(Map::new()));
    };
    let actions = actions
        .as_array()
        .filter(|items| items.len() <= MAX_ACTIONS)
        .ok_or(())?;
    let actions = actions
        .iter()
        .map(|action| bounded_identifier(action, MAX_IDENTIFIER_BYTES))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({ "actions": actions }))
}

fn remediation_rollback_params(value: Value) -> Result<Value, ()> {
    let object = exact_input_object(value, &["snapshotId"])?;
    let Some(snapshot_id) = object.get("snapshotId") else {
        return Ok(Value::Object(Map::new()));
    };
    if snapshot_id.is_null() {
        return Ok(Value::Object(Map::new()));
    }
    let snapshot_id = bounded_identifier(snapshot_id, MAX_IDENTIFIER_BYTES)?;
    Ok(json!({ "snapshotId": snapshot_id }))
}

fn exact_input_object(value: Value, expected: &[&str]) -> Result<Map<String, Value>, ()> {
    let Value::Object(object) = value else {
        return Err(());
    };
    if object.len() > expected.len()
        || object
            .keys()
            .any(|field| !expected.contains(&field.as_str()))
    {
        return Err(());
    }
    Ok(object)
}

fn decode_quick_audit(response: GatewayResponse) -> Result<Value, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(
        &payload,
        [
            "backend",
            "startupAudit",
            "integrity",
            "skillScan",
            "advisories",
        ]
        .as_slice(),
    )?;
    require_backend(&payload)?;
    Ok(json!({
        "backend": "security-core",
        "startupAudit": decode_startup_audit(payload.get("startupAudit").ok_or(())?)?,
        "integrity": decode_integrity_object(payload.get("integrity").ok_or(())?)?,
        "skillScan": decode_skill_scan_object(payload.get("skillScan").ok_or(())?)?,
        "advisories": decode_advisories_object(payload.get("advisories").ok_or(())?)?,
    }))
}

fn decode_integrity_check(response: GatewayResponse) -> Result<Value, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(
        &payload,
        [
            "backend",
            "checked",
            "tampered",
            "missing",
            "noBaseline",
            "items",
        ]
        .as_slice(),
    )?;
    require_backend(&payload)?;
    decode_integrity_object(&Value::Object(payload_without_backend(&payload)))
        .map(|integrity| with_backend(integrity))
}

fn decode_integrity_rebaseline(response: GatewayResponse) -> Result<Value, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(&payload, ["backend", "created", "files"].as_slice())?;
    require_backend(&payload)?;
    let created = required_count(&payload, "created")?;
    let files = required_array(&payload, "files", MAX_ITEMS)?
        .iter()
        .map(|file| bounded_basename(file, MAX_IDENTIFIER_BYTES))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "backend": "security-core",
        "created": created,
        "files": files,
    }))
}

fn decode_skills_scan(response: GatewayResponse) -> Result<Value, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(
        &payload,
        ["backend", "total", "suspicious", "clean", "skills"].as_slice(),
    )?;
    require_backend(&payload)?;
    decode_skill_scan_object(&Value::Object(payload_without_backend(&payload))).map(with_backend)
}

fn decode_advisories_check(response: GatewayResponse) -> Result<Value, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(
        &payload,
        ["backend", "reachable", "advisories", "criticalOrHigh"].as_slice(),
    )?;
    require_backend(&payload)?;
    decode_advisories_object(&Value::Object(payload_without_backend(&payload))).map(with_backend)
}

fn decode_remediation_preview(response: GatewayResponse) -> Result<Value, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(&payload, ["backend", "actions"].as_slice())?;
    require_backend(&payload)?;
    let actions = required_array(&payload, "actions", MAX_ACTIONS)?
        .iter()
        .map(decode_remediation_action)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "backend": "security-core",
        "actions": actions,
    }))
}

fn decode_remediation_apply(response: GatewayResponse) -> Result<Value, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(
        &payload,
        ["backend", "actions", "snapshotId", "applied"].as_slice(),
    )?;
    require_backend(&payload)?;
    let actions = required_array(&payload, "actions", MAX_ACTIONS)?
        .iter()
        .map(|action| bounded_identifier(action, MAX_IDENTIFIER_BYTES))
        .collect::<Result<Vec<_>, _>>()?;
    let snapshot_id = safe_opaque(payload.get("snapshotId").ok_or(())?)?;
    let applied = payload.get("applied").and_then(Value::as_bool).ok_or(())?;
    Ok(json!({
        "backend": "security-core",
        "actions": actions,
        "snapshotId": snapshot_id,
        "applied": applied,
    }))
}

fn decode_remediation_rollback(response: GatewayResponse) -> Result<Value, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(&payload, ["backend", "restored", "snapshotId"].as_slice())?;
    require_backend(&payload)?;
    let restored = required_count(&payload, "restored")?;
    let snapshot_id = required_nullable_identifier(&payload, "snapshotId")?;
    Ok(json!({
        "backend": "security-core",
        "restored": restored,
        "snapshotId": snapshot_id,
    }))
}

fn decode_startup_audit(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    require_exact_fields(object, ["ok", "checks", "issues"].as_slice())?;
    let ok = object.get("ok").and_then(Value::as_bool).ok_or(())?;
    let checks = required_safe_u64(object, "checks")?;
    let issues = required_safe_u64(object, "issues")?;
    if checks > 500 || issues > checks {
        return Err(());
    }
    Ok(json!({ "ok": ok, "checks": checks, "issues": issues }))
}

fn decode_integrity_object(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    require_exact_fields(
        object,
        ["checked", "tampered", "missing", "noBaseline", "items"].as_slice(),
    )?;
    let items = required_array(object, "items", MAX_ITEMS)?
        .iter()
        .map(decode_integrity_item)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "checked": required_count(object, "checked")?,
        "tampered": required_count(object, "tampered")?,
        "missing": required_count(object, "missing")?,
        "noBaseline": required_count(object, "noBaseline")?,
        "items": items,
    }))
}

fn decode_integrity_item(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    require_exact_fields(object, ["file", "status"].as_slice())?;
    let file = bounded_basename(object.get("file").ok_or(())?, MAX_IDENTIFIER_BYTES)?;
    let status = required_enum(
        object,
        "status",
        &["intact", "tampered", "missing", "no-baseline"],
    )?;
    Ok(json!({ "file": file, "status": status }))
}

fn decode_skill_scan_object(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    require_exact_fields(
        object,
        ["total", "suspicious", "clean", "skills"].as_slice(),
    )?;
    let skills = required_array(object, "skills", MAX_SKILLS)?
        .iter()
        .map(decode_skill)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "total": required_count(object, "total")?,
        "suspicious": required_count(object, "suspicious")?,
        "clean": required_count(object, "clean")?,
        "skills": skills,
    }))
}

fn decode_skill(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    require_exact_fields(object, ["name", "safe", "issues"].as_slice())?;
    let name = bounded_basename(object.get("name").ok_or(())?, MAX_IDENTIFIER_BYTES)?;
    let issues = required_array(object, "issues", MAX_ISSUES)?
        .iter()
        .map(decode_skill_issue)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "name": name,
        "safe": object.get("safe").and_then(Value::as_bool).ok_or(())?,
        "issues": issues,
    }))
}

fn decode_skill_issue(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    require_exact_fields(object, ["id", "severity"].as_slice())?;
    let id = bounded_identifier(object.get("id").ok_or(())?, MAX_IDENTIFIER_BYTES)?;
    let severity = required_severity(object, "severity", &["critical", "high", "medium"])?;
    Ok(json!({ "id": id, "severity": severity }))
}

fn decode_advisories_object(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    require_exact_fields(
        object,
        ["reachable", "advisories", "criticalOrHigh"].as_slice(),
    )?;
    let advisories = required_array(object, "advisories", MAX_ADVISORIES)?
        .iter()
        .map(decode_advisory)
        .collect::<Result<Vec<_>, _>>()?;
    let critical_or_high = required_array(object, "criticalOrHigh", MAX_ADVISORIES)?
        .iter()
        .map(decode_advisory)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "reachable": object.get("reachable").and_then(Value::as_bool).ok_or(())?,
        "advisories": advisories,
        "criticalOrHigh": critical_or_high,
    }))
}

fn decode_advisory(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    if object.len() < 3
        || object.len() > 4
        || object
            .keys()
            .any(|field| !["id", "severity", "title", "action"].contains(&field.as_str()))
    {
        return Err(());
    }
    let id = bounded_identifier(object.get("id").ok_or(())?, MAX_IDENTIFIER_BYTES)?;
    let severity = bounded_identifier(object.get("severity").ok_or(())?, MAX_IDENTIFIER_BYTES)?;
    let title = bounded_text(object.get("title").ok_or(())?, MAX_TEXT_BYTES)?;
    let mut projected = Map::new();
    projected.insert("id".into(), Value::String(id));
    projected.insert("severity".into(), Value::String(severity));
    projected.insert("title".into(), Value::String(title));
    if let Some(action) = object.get("action") {
        projected.insert(
            "action".into(),
            Value::String(bounded_text(action, MAX_TEXT_BYTES)?),
        );
    }
    Ok(Value::Object(projected))
}

fn decode_remediation_action(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    require_exact_fields(object, ["id", "title", "risk"].as_slice())?;
    let id = bounded_identifier(object.get("id").ok_or(())?, MAX_IDENTIFIER_BYTES)?;
    let title = bounded_text(object.get("title").ok_or(())?, MAX_TEXT_BYTES)?;
    let risk = required_enum(object, "risk", &["critical", "high", "medium", "low"])?;
    Ok(json!({ "id": id, "title": title, "risk": risk }))
}

fn success_payload_object(response: GatewayResponse) -> Result<Map<String, Value>, ()> {
    match response {
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } => Ok(payload),
        GatewayResponse::Failure { .. } | GatewayResponse::Success { .. } => Err(()),
    }
}

fn require_exact_fields(object: &Map<String, Value>, expected: &[&str]) -> Result<(), ()> {
    if object.len() != expected.len()
        || object
            .keys()
            .any(|field| !expected.contains(&field.as_str()))
    {
        return Err(());
    }
    Ok(())
}

fn require_backend(object: &Map<String, Value>) -> Result<(), ()> {
    (object.get("backend").and_then(Value::as_str) == Some("security-core"))
        .then_some(())
        .ok_or(())
}

fn payload_without_backend(payload: &Map<String, Value>) -> Map<String, Value> {
    payload
        .iter()
        .filter(|(field, _)| field.as_str() != "backend")
        .map(|(field, value)| (field.clone(), value.clone()))
        .collect()
}

fn with_backend(value: Value) -> Value {
    let Value::Object(mut object) = value else {
        return Value::Null;
    };
    object.insert("backend".into(), Value::String("security-core".into()));
    let mut projected = Map::new();
    projected.insert(
        "backend".into(),
        object.remove("backend").unwrap_or(Value::Null),
    );
    projected.extend(object);
    Value::Object(projected)
}

fn required_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    max_items: usize,
) -> Result<&'a [Value], ()> {
    object
        .get(field)
        .and_then(Value::as_array)
        .filter(|items| items.len() <= max_items)
        .map(Vec::as_slice)
        .ok_or(())
}

fn required_safe_u64(object: &Map<String, Value>, field: &str) -> Result<u64, ()> {
    object
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
        .ok_or(())
}

fn required_count(object: &Map<String, Value>, field: &str) -> Result<u64, ()> {
    required_safe_u64(object, field)?
        .le(&MAX_COUNT)
        .then_some(())
        .ok_or(())?;
    required_safe_u64(object, field)
}

fn required_enum<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    allowed: &[&str],
) -> Result<&'a str, ()> {
    let value = object.get(field).and_then(Value::as_str).ok_or(())?;
    allowed.contains(&value).then_some(value).ok_or(())
}

fn required_severity<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    allowed: &[&str],
) -> Result<&'a str, ()> {
    required_enum(object, field, allowed)
}

fn required_nullable_identifier(object: &Map<String, Value>, field: &str) -> Result<Value, ()> {
    let value = object.get(field).ok_or(())?;
    if value.is_null() {
        return Ok(Value::String("none".into()));
    }
    Ok(Value::String(safe_opaque(value)?))
}

fn safe_opaque(value: &Value) -> Result<String, ()> {
    let Some(value) = value.as_str() else {
        return Ok("unknown".into());
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok("none".into());
    }
    if value.len() > MAX_OPAQUE_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Ok("unknown".into());
    }
    Ok(value.to_owned())
}

fn bounded_text(value: &Value, max_bytes: usize) -> Result<String, ()> {
    let value = value.as_str().ok_or(())?;
    if value.is_empty()
        || value.len() > max_bytes
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(());
    }
    Ok(value.to_owned())
}

fn bounded_identifier(value: &Value, max_bytes: usize) -> Result<String, ()> {
    let value = bounded_text(value, max_bytes)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(());
    }
    Ok(value)
}

fn bounded_basename(value: &Value, max_bytes: usize) -> Result<String, ()> {
    let value = bounded_text(value, max_bytes)?;
    if value.contains(['/', '\\']) || value == "." || value == ".." {
        return Err(());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn success(payload: Value) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: "test-request".into(),
            payload: Some(payload),
        }
    }

    #[test]
    fn security_action_mapping_uses_fixed_native_methods() {
        let methods = [
            ("security.quickAudit", SECURITY_QUICK_AUDIT_METHOD),
            ("security.checkIntegrity", SECURITY_INTEGRITY_CHECK_METHOD),
            (
                "security.rebaselineIntegrity",
                SECURITY_INTEGRITY_REBASELINE_METHOD,
            ),
            ("security.scanSkills", SECURITY_SKILLS_SCAN_METHOD),
            ("security.checkAdvisories", SECURITY_ADVISORIES_CHECK_METHOD),
            (
                "security.previewRemediation",
                SECURITY_REMEDIATION_PREVIEW_METHOD,
            ),
            (
                "security.applyRemediation",
                SECURITY_REMEDIATION_APPLY_METHOD,
            ),
            (
                "security.rollbackRemediation",
                SECURITY_REMEDIATION_ROLLBACK_METHOD,
            ),
        ];

        for (operation_id, method) in methods {
            let (action, params) = Action::from_legacy(operation_id, json!({})).unwrap();
            assert_eq!(action.method(), method);
            assert_eq!(params, json!({}));
        }
        assert!(Action::from_legacy("quickAudit", json!({})).is_err());
    }

    #[test]
    fn security_action_input_rejects_unknown_fields_and_bounds_values() {
        assert!(
            Action::from_legacy(
                "security.scanSkills",
                json!({"scanPath": "skills", "private": "canary"}),
            )
            .is_err()
        );
        assert!(
            Action::from_legacy("security.applyRemediation", json!({"actions": ["fix_1"]}),)
                .is_ok()
        );
        assert!(
            Action::from_legacy("security.applyRemediation", json!({"actions": ["fix/1"]}),)
                .is_err()
        );
        assert!(
            Action::from_legacy("security.rollbackRemediation", json!({"snapshotId": null}),)
                .is_ok()
        );
    }

    #[test]
    fn security_action_decoders_match_public_projections() {
        let quick_audit = decode_quick_audit(success(json!({
            "backend": "security-core",
            "startupAudit": {"ok": false, "checks": 3, "issues": 1},
            "integrity": {
                "checked": 1,
                "tampered": 0,
                "missing": 0,
                "noBaseline": 1,
                "items": [{"file": "config.json", "status": "no-baseline"}]
            },
            "skillScan": {
                "total": 1,
                "suspicious": 1,
                "clean": 0,
                "skills": [{
                    "name": "demo_skill",
                    "safe": false,
                    "issues": [{"id": "unsafe-tool", "severity": "critical"}]
                }]
            },
            "advisories": {"reachable": true, "advisories": [], "criticalOrHigh": []}
        })))
        .unwrap();
        assert_eq!(
            quick_audit["startupAudit"],
            json!({"ok": false, "checks": 3, "issues": 1})
        );
        assert_eq!(
            quick_audit["skillScan"]["skills"][0]["issues"][0]["severity"],
            "critical"
        );

        let applied = decode_remediation_apply(success(json!({
            "backend": "security-core",
            "actions": ["fix_1"],
            "snapshotId": "snapshot_1",
            "applied": true
        })))
        .unwrap();
        assert_eq!(
            applied,
            json!({
                "backend": "security-core",
                "actions": ["fix_1"],
                "snapshotId": "snapshot_1",
                "applied": true
            })
        );

        let rollback = decode_remediation_rollback(success(json!({
            "backend": "security-core",
            "restored": 1,
            "snapshotId": null
        })))
        .unwrap();
        assert_eq!(rollback["snapshotId"], "none");
    }

    #[test]
    fn security_action_decoders_reject_private_or_legacy_shapes() {
        let mut unexpected = json!({
            "backend": "security-core",
            "startupAudit": {"ok": true, "checks": 1, "issues": 0},
            "integrity": {"checked": 0, "tampered": 0, "missing": 0, "noBaseline": 0, "items": []},
            "skillScan": {"total": 0, "suspicious": 0, "clean": 0, "skills": []},
            "advisories": {"reachable": true, "advisories": [], "criticalOrHigh": []}
        });
        unexpected["privateCanary"] = json!("do-not-project");
        assert!(decode_quick_audit(success(unexpected)).is_err());
        assert!(decode_quick_audit(success(json!({
            "backend": "security-core",
            "startupAudit": {"passed": true, "total": 1, "issues": 0},
            "integrity": {"checked": 0, "tampered": 0, "missing": 0, "noBaseline": 0, "items": []},
            "skillScan": {"total": 0, "suspicious": 0, "clean": 0, "skills": []},
            "advisories": {"reachable": true, "advisories": [], "criticalOrHigh": []}
        })))
        .is_err());
        assert!(
            decode_remediation_apply(success(json!({
                "backend": "security-core",
                "applied": ["fix_1"]
            })))
            .is_err()
        );
        let private_snapshot = decode_remediation_apply(success(json!({
            "backend": "security-core",
            "actions": [],
            "snapshotId": "C:\\\\private\\snapshot",
            "applied": false
        })))
        .unwrap();
        assert_eq!(private_snapshot["snapshotId"], "unknown");
    }
}
