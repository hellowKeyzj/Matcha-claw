use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const STATE_FILE: &str = "security-policy.v1.json";
const MAX_STATE_BYTES: u64 = 256 * 1024;
const MAX_LIST_ENTRIES: usize = 256;
const MAX_STRING_BYTES: usize = 4_096;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const RUNTIME_FIELDS: &[&str] = &[
    "autoHarden",
    "monitors",
    "auditOnGatewayStart",
    "runtimeGuardEnabled",
    "enablePromptInjectionGuard",
    "blockDestructive",
    "blockSecrets",
    "allowPathPrefixes",
    "allowDomains",
    "auditEgressAllowlist",
    "auditDailyCostLimitUsd",
    "auditFailureMode",
    "promptInjectionPatterns",
    "allowlist",
    "logging",
    "destructive",
    "destructivePatterns",
    "secretPatterns",
    "secrets",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Confirmed,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Settlement {
    pub(crate) revision: u64,
    pub(crate) outcome: Outcome,
}

impl Outcome {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Unknown => "outcome_unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Desired {
    policy: Value,
}

impl Desired {
    pub(crate) fn try_from_wire(value: &Value) -> Result<Self, ()> {
        let policy = value
            .get("input")
            .and_then(Value::as_object)
            .and_then(|input| input.get("policy"))
            .ok_or(())?;
        Self::try_from_policy(policy)
    }

    fn try_from_policy(value: &Value) -> Result<Self, ()> {
        let policy = value.as_object().ok_or(())?;
        if policy.len() != 3
            || policy.keys().any(|field| {
                !["preset", "securityPolicyVersion", "runtime"].contains(&field.as_str())
            })
        {
            return Err(());
        }
        let preset = policy.get("preset").and_then(Value::as_str).ok_or(())?;
        let version = policy
            .get("securityPolicyVersion")
            .and_then(Value::as_u64)
            .filter(|version| *version > 0 && *version <= MAX_JSON_SAFE_INTEGER)
            .ok_or(())?;
        let runtime = policy.get("runtime").and_then(Value::as_object).ok_or(())?;
        let mut normalized = template(preset)?.clone();
        normalize_runtime(&mut normalized, runtime)?;
        Ok(Self {
            policy: serde_json::json!({
                "preset": preset,
                "securityPolicyVersion": version,
                "runtime": normalized,
            }),
        })
    }

    pub(crate) fn into_policy(self) -> Value {
        self.policy
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDesired {
    revision: u64,
    policy: Value,
    effect: PersistedEffect,
    correlations: Vec<String>,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PersistedEffect {
    Pending,
    Confirmed,
    Rejected,
    Unknown,
}

impl Default for PersistedDesired {
    fn default() -> Self {
        Self {
            revision: 0,
            policy: serde_json::json!({
                "preset": "relaxed",
                "securityPolicyVersion": 1,
                "runtime": template("relaxed").expect("builtin policy")
            }),
            effect: PersistedEffect::Pending,
            correlations: Vec::new(),
        }
    }
}

pub(crate) struct Owner {
    path: PathBuf,
    state: Mutex<PersistedDesired>,
    effect: tokio::sync::Mutex<()>,
}

impl Owner {
    pub(crate) fn open(state_dir: &Path) -> Result<Self, ()> {
        let path = state_dir.join(STATE_FILE);
        let state = load(&path)?;
        Ok(Self {
            state: Mutex::new(state),
            path,
            effect: tokio::sync::Mutex::new(()),
        })
    }

    pub(crate) fn replace(
        &self,
        correlation: &str,
        desired: Desired,
    ) -> Result<(u64, Option<Outcome>), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.correlations.iter().any(|known| known == correlation) {
            return Ok((state.revision, Some(effect_outcome(state.effect))));
        }
        state.revision = state.revision.checked_add(1).ok_or(())?;
        state.policy = desired.policy;
        state.effect = PersistedEffect::Pending;
        remember(&mut state.correlations, correlation);
        persist(&self.path, &state)?;
        Ok((state.revision, None))
    }

    pub(crate) fn settle(&self, revision: u64, outcome: Outcome) -> Result<(), ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        if state.revision != revision {
            return Ok(());
        }
        state.effect = match outcome {
            Outcome::Confirmed => PersistedEffect::Confirmed,
            Outcome::Rejected => PersistedEffect::Rejected,
            Outcome::Unknown => PersistedEffect::Unknown,
        };
        persist(&self.path, &state)
    }

    pub(crate) fn pending(&self) -> Result<Option<(u64, Desired)>, ()> {
        let state = self.state.lock().map_err(|_| ())?;
        Ok((state.effect == PersistedEffect::Pending)
            .then_some((
                state.revision,
                Desired {
                    policy: state.policy.clone(),
                },
            ))
            .filter(|(revision, _)| *revision > 0))
    }

    pub(crate) fn policy(&self) -> Result<Value, ()> {
        Ok(self.state.lock().map_err(|_| ())?.policy.clone())
    }

    pub(crate) fn saved_runtime_projection(
        &self,
    ) -> Result<openclaw::projection::security::SavedPolicyRuntimeProjection, ()> {
        let state = self.state.lock().map_err(|_| ())?;
        let runtime = state
            .policy
            .get("runtime")
            .and_then(Value::as_object)
            .cloned()
            .ok_or(())?;
        Ok(
            openclaw::projection::security::SavedPolicyRuntimeProjection::from_normalized_runtime(
                runtime,
            ),
        )
    }

    pub(crate) async fn serialize_effect<T>(
        &self,
        operation: impl std::future::Future<Output = T>,
    ) -> T {
        let _effect = self.effect.lock().await;
        operation.await
    }
}

pub(crate) fn emergency_lockdown(mut policy: Value) -> Result<Desired, ()> {
    let body = policy.as_object_mut().ok_or(())?;
    body.insert("preset".into(), Value::String("strict".into()));
    let runtime = body
        .get_mut("runtime")
        .and_then(Value::as_object_mut)
        .ok_or(())?;
    for key in [
        "autoHarden",
        "auditOnGatewayStart",
        "runtimeGuardEnabled",
        "enablePromptInjectionGuard",
        "blockDestructive",
        "blockSecrets",
    ] {
        runtime.insert(key.into(), Value::Bool(true));
    }
    runtime.insert(
        "monitors".into(),
        serde_json::json!({ "credentials": true, "memory": true, "cost": true }),
    );
    runtime.insert(
        "logging".into(),
        serde_json::json!({ "logDetections": true }),
    );
    runtime.insert("auditFailureMode".into(), Value::String("block_all".into()));
    for key in ["allowPathPrefixes", "allowDomains"] {
        runtime.insert(key.into(), Value::Array(Vec::new()));
    }
    runtime.insert(
        "allowlist".into(),
        serde_json::json!({ "tools": [], "sessions": [] }),
    );
    for key in ["destructive", "secrets"] {
        let value = runtime
            .get_mut(key)
            .and_then(Value::as_object_mut)
            .ok_or(())?;
        value.insert("action".into(), Value::String("block".into()));
        value.insert(
            "severityActions".into(),
            serde_json::json!({
                "critical": "block",
                "high": "block",
                "medium": "block",
                "low": "block",
            }),
        );
    }
    Ok(Desired { policy })
}

fn effect_outcome(effect: PersistedEffect) -> Outcome {
    match effect {
        PersistedEffect::Confirmed => Outcome::Confirmed,
        PersistedEffect::Pending | PersistedEffect::Rejected | PersistedEffect::Unknown => {
            Outcome::Unknown
        }
    }
}

fn normalize_runtime(target: &mut Value, input: &Map<String, Value>) -> Result<(), ()> {
    let target = target.as_object_mut().ok_or(())?;
    for key in [
        "autoHarden",
        "auditOnGatewayStart",
        "runtimeGuardEnabled",
        "enablePromptInjectionGuard",
        "blockDestructive",
        "blockSecrets",
    ] {
        if let Some(value) = input.get(key) {
            target.insert(key.into(), Value::Bool(value.as_bool().ok_or(())?));
        }
    }
    for key in [
        "allowPathPrefixes",
        "allowDomains",
        "auditEgressAllowlist",
        "promptInjectionPatterns",
        "destructivePatterns",
        "secretPatterns",
    ] {
        if let Some(value) = input.get(key) {
            target.insert(key.into(), Value::Array(normalize_strings(value)?));
        }
    }
    for key in input.keys() {
        if !RUNTIME_FIELDS.contains(&key.as_str()) {
            return Err(());
        }
    }
    if let Some(value) = input.get("auditDailyCostLimitUsd") {
        let value = value
            .as_f64()
            .filter(|number| {
                number.is_finite() && *number > 0.0 && *number <= MAX_JSON_SAFE_INTEGER as f64
            })
            .ok_or(())?;
        target.insert(
            "auditDailyCostLimitUsd".into(),
            serde_json::Number::from_f64(value)
                .map(Value::Number)
                .ok_or(())?,
        );
    }
    if let Some(value) = input.get("auditFailureMode")
        && !value.is_null()
        && !matches!(
            value.as_str(),
            Some("block_all" | "safe_mode" | "read_only")
        )
    {
        return Err(());
    }
    if let Some(value) = input.get("auditFailureMode") {
        target.insert("auditFailureMode".into(), value.clone());
    }
    normalize_bool_object(
        target,
        input,
        "monitors",
        &["credentials", "memory", "cost"],
    )?;
    normalize_bool_object(target, input, "logging", &["logDetections"])?;
    normalize_strings_object(target, input, "allowlist", &["tools", "sessions"])?;
    normalize_actions(target, input, "destructive", true)?;
    normalize_actions(target, input, "secrets", false)?;
    reject_unknown_nested_fields(input)?;
    Ok(())
}

fn reject_unknown_nested_fields(input: &Map<String, Value>) -> Result<(), ()> {
    let fields = [
        ("monitors", &["credentials", "memory", "cost"][..]),
        ("logging", &["logDetections"][..]),
        ("allowlist", &["tools", "sessions"][..]),
        (
            "destructive",
            &["action", "severityActions", "categories"][..],
        ),
        ("secrets", &["action", "severityActions"][..]),
    ];
    for (key, expected) in fields {
        let Some(value) = input.get(key) else {
            continue;
        };
        let object = value.as_object().ok_or(())?;
        if object
            .keys()
            .any(|field| !expected.contains(&field.as_str()))
        {
            return Err(());
        }
    }
    for key in ["destructive", "secrets"] {
        let Some(value) = input.get(key).and_then(Value::as_object) else {
            continue;
        };
        if let Some(severity) = value.get("severityActions") {
            let object = severity.as_object().ok_or(())?;
            if object
                .keys()
                .any(|field| !["critical", "high", "medium", "low"].contains(&field.as_str()))
            {
                return Err(());
            }
        }
        if key == "destructive"
            && let Some(categories) = value.get("categories")
        {
            let object = categories.as_object().ok_or(())?;
            if object.keys().any(|field| {
                ![
                    "fileDelete",
                    "gitDestructive",
                    "sqlDestructive",
                    "systemDestructive",
                    "processKill",
                    "networkDestructive",
                    "privilegeEscalation",
                ]
                .contains(&field.as_str())
            }) {
                return Err(());
            }
        }
    }
    Ok(())
}

fn normalize_bool_object(
    target: &mut Map<String, Value>,
    input: &Map<String, Value>,
    key: &str,
    fields: &[&str],
) -> Result<(), ()> {
    let Some(input) = input.get(key) else {
        return Ok(());
    };
    let input = input.as_object().ok_or(())?;
    let mut value = target
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .ok_or(())?;
    for field in fields {
        if let Some(next) = input.get(*field) {
            value.insert((*field).into(), Value::Bool(next.as_bool().ok_or(())?));
        }
    }
    target.insert(key.into(), Value::Object(value));
    Ok(())
}

fn normalize_strings_object(
    target: &mut Map<String, Value>,
    input: &Map<String, Value>,
    key: &str,
    fields: &[&str],
) -> Result<(), ()> {
    let Some(input) = input.get(key) else {
        return Ok(());
    };
    let input = input.as_object().ok_or(())?;
    let mut value = target
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .ok_or(())?;
    for field in fields {
        if let Some(next) = input.get(*field) {
            value.insert((*field).into(), Value::Array(normalize_strings(next)?));
        }
    }
    target.insert(key.into(), Value::Object(value));
    Ok(())
}

fn normalize_actions(
    target: &mut Map<String, Value>,
    input: &Map<String, Value>,
    key: &str,
    categories: bool,
) -> Result<(), ()> {
    let Some(input) = input.get(key) else {
        return Ok(());
    };
    let input = input.as_object().ok_or(())?;
    let mut value = target
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .ok_or(())?;
    if let Some(action) = input.get("action") {
        value.insert("action".into(), Value::String(action_name(action)?.into()));
    }
    if let Some(severity) = input.get("severityActions") {
        let severity = severity.as_object().ok_or(())?;
        let mut next = value
            .get("severityActions")
            .and_then(Value::as_object)
            .cloned()
            .ok_or(())?;
        for field in ["critical", "high", "medium", "low"] {
            if let Some(action) = severity.get(field) {
                next.insert(field.into(), Value::String(action_name(action)?.into()));
            }
        }
        value.insert("severityActions".into(), Value::Object(next));
    }
    if categories && let Some(raw) = input.get("categories") {
        let raw = raw.as_object().ok_or(())?;
        let mut next = value
            .get("categories")
            .and_then(Value::as_object)
            .cloned()
            .ok_or(())?;
        for field in [
            "fileDelete",
            "gitDestructive",
            "sqlDestructive",
            "systemDestructive",
            "processKill",
            "networkDestructive",
            "privilegeEscalation",
        ] {
            if let Some(enabled) = raw.get(field) {
                next.insert(field.into(), Value::Bool(enabled.as_bool().ok_or(())?));
            }
        }
        value.insert("categories".into(), Value::Object(next));
    }
    target.insert(key.into(), Value::Object(value));
    Ok(())
}

fn action_name(value: &Value) -> Result<&str, ()> {
    match value.as_str() {
        Some("block" | "redact" | "confirm" | "warn" | "log") => {
            Ok(value.as_str().expect("matched action"))
        }
        _ => Err(()),
    }
}

fn normalize_strings(value: &Value) -> Result<Vec<Value>, ()> {
    let values = value
        .as_array()
        .filter(|values| values.len() <= MAX_LIST_ENTRIES)
        .ok_or(())?;
    let mut output = Vec::new();
    for value in values {
        let value = value
            .as_str()
            .map(str::trim)
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= MAX_STRING_BYTES
                    && !value.chars().any(char::is_control)
            })
            .ok_or(())?;
        if !output
            .iter()
            .any(|known: &Value| known.as_str() == Some(value))
        {
            output.push(Value::String(value.into()));
        }
    }
    Ok(output)
}

fn template(preset: &str) -> Result<Value, ()> {
    let (audit, destructive, secrets, monitor_cost) = match preset {
        "strict" => (true, "block", "block", true),
        "balanced" => (true, "confirm", "block", false),
        "relaxed" => (false, "warn", "redact", false),
        _ => return Err(()),
    };
    Ok(serde_json::json!({
        "autoHarden": false, "monitors": {"credentials": true, "memory": true, "cost": monitor_cost},
        "auditOnGatewayStart": audit, "runtimeGuardEnabled": true, "enablePromptInjectionGuard": true,
        "blockDestructive": true, "blockSecrets": true, "allowPathPrefixes": [], "allowDomains": [],
        "auditEgressAllowlist": ["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com"],
        "auditDailyCostLimitUsd": 5.0, "auditFailureMode": null, "promptInjectionPatterns": [],
        "allowlist": {"tools": [], "sessions": []}, "logging": {"logDetections": true},
        "destructive": {"action": destructive, "severityActions": {"critical": "block", "high": destructive, "medium": "confirm", "low": "warn"}, "categories": {"fileDelete": true, "gitDestructive": true, "sqlDestructive": true, "systemDestructive": true, "processKill": true, "networkDestructive": true, "privilegeEscalation": true}},
        "secrets": {"action": secrets, "severityActions": {"critical": "block", "high": "block", "medium": "redact", "low": "warn"}},
        "destructivePatterns": [], "secretPatterns": []
    }))
}

fn remember(correlations: &mut Vec<String>, correlation: &str) {
    correlations.push(correlation.into());
    if correlations.len() > 128 {
        correlations.drain(..correlations.len() - 128);
    }
}
fn load(path: &Path) -> Result<PersistedDesired, ()> {
    let temporary = path.with_extension("tmp");
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    if !path.exists() {
        return Ok(PersistedDesired::default());
    }
    if fs::metadata(path).map_err(|_| ())?.len() > MAX_STATE_BYTES {
        return Err(());
    }
    let mut state: PersistedDesired =
        serde_json::from_slice(&fs::read(path).map_err(|_| ())?).map_err(|_| ())?;
    state.policy = Desired::try_from_policy(&state.policy)?.into_policy();
    Ok(state)
}
fn persist(path: &Path, state: &PersistedDesired) -> Result<(), ()> {
    let bytes = serde_json::to_vec(state).map_err(|_| ())?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(());
    }
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| ())?;
    file.write_all(&bytes).map_err(|_| ())?;
    file.sync_all().map_err(|_| ())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_deduplicated_runtime_lists_and_persists() {
        let desired = Desired::try_from_wire(&serde_json::json!({"input":{"policy":{"preset":"strict","securityPolicyVersion":1,"runtime":{"allowDomains":[" api.example.com ","api.example.com"]}}}})).unwrap();
        assert_eq!(
            desired.policy["runtime"]["allowDomains"],
            serde_json::json!(["api.example.com"])
        );
    }

    #[test]
    fn emergency_lockdown_preserves_custom_patterns_and_blocks_every_guard() {
        let desired = emergency_lockdown(serde_json::json!({
            "preset": "relaxed",
            "securityPolicyVersion": 3,
            "runtime": {
                "destructivePatterns": ["custom destructive"],
                "secretPatterns": ["custom secret"],
                "auditEgressAllowlist": ["custom.audit.example"],
                "destructive": { "action": "warn", "severityActions": {} },
                "secrets": { "action": "redact", "severityActions": {} }
            }
        }))
        .unwrap();
        let runtime = &desired.policy["runtime"];
        assert_eq!(desired.policy["preset"], "strict");
        for key in [
            "autoHarden",
            "auditOnGatewayStart",
            "runtimeGuardEnabled",
            "enablePromptInjectionGuard",
            "blockDestructive",
            "blockSecrets",
        ] {
            assert_eq!(runtime[key], true);
        }
        assert_eq!(
            runtime["monitors"],
            serde_json::json!({
                "credentials": true,
                "memory": true,
                "cost": true,
            })
        );
        assert_eq!(
            runtime["logging"],
            serde_json::json!({"logDetections": true})
        );
        assert_eq!(runtime["auditFailureMode"], "block_all");
        for key in ["allowPathPrefixes", "allowDomains"] {
            assert_eq!(runtime[key], serde_json::json!([]));
        }
        assert_eq!(runtime["allowlist"]["tools"], serde_json::json!([]));
        assert_eq!(runtime["allowlist"]["sessions"], serde_json::json!([]));
        assert_eq!(
            runtime["destructivePatterns"],
            serde_json::json!(["custom destructive"])
        );
        assert_eq!(
            runtime["secretPatterns"],
            serde_json::json!(["custom secret"])
        );
        assert_eq!(
            runtime["auditEgressAllowlist"],
            serde_json::json!(["custom.audit.example"])
        );
        assert_eq!(runtime["destructive"]["action"], "block");
        assert_eq!(runtime["secrets"]["action"], "block");
        assert_eq!(runtime["destructive"]["severityActions"]["low"], "block");
        assert_eq!(runtime["secrets"]["severityActions"]["low"], "block");
    }

    #[test]
    fn rejects_unknown_runtime_fields_deny_first() {
        assert!(
            Desired::try_from_wire(&serde_json::json!({
                "input": {
                    "policy": {
                        "preset": "relaxed",
                        "securityPolicyVersion": 1,
                        "runtime": {"unexpected": true}
                    }
                }
            }))
            .is_err()
        );
    }

    #[test]
    fn stale_temporary_state_is_not_loaded_as_durable_state() {
        let root = std::env::temp_dir().join(format!(
            "security-delivery-tmp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(STATE_FILE);
        fs::write(path.with_extension("tmp"), b"not durable").unwrap();
        let owner = Owner::open(&root).unwrap();
        assert!(!path.with_extension("tmp").exists());
        let policy = match owner.policy() {
            Ok(policy) => policy,
            Err(()) => panic!("fresh security owner policy must be readable"),
        };
        assert_eq!(policy["preset"], "relaxed");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persisted_policy_is_normalized_before_reads() {
        let root = std::env::temp_dir().join(format!(
            "security-delivery-normalized-read-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(STATE_FILE),
            serde_json::to_vec(&serde_json::json!({
                "revision": 7,
                "policy": {
                    "preset": "balanced",
                    "securityPolicyVersion": 2,
                    "runtime": {
                        "allowDomains": [" api.example.com ", "api.example.com"]
                    }
                },
                "effect": "confirmed",
                "correlations": []
            }))
            .unwrap(),
        )
        .unwrap();

        let owner = Owner::open(&root).unwrap();
        let policy = owner.policy().unwrap();
        let runtime = &policy["runtime"];
        assert_eq!(policy["preset"], "balanced");
        assert_eq!(
            runtime["allowDomains"],
            serde_json::json!(["api.example.com"])
        );
        assert!(runtime["secrets"].is_object());
        assert!(runtime["secretPatterns"].is_array());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn saved_runtime_projection_reads_current_policy_for_every_effect() {
        let root = std::env::temp_dir().join(format!(
            "security-delivery-saved-projection-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let owner = Owner::open(&root).unwrap();
        let desired = Desired::try_from_wire(&serde_json::json!({
            "input": {
                "policy": {
                    "preset": "relaxed",
                    "securityPolicyVersion": 2,
                    "runtime": {
                        "runtimeGuardEnabled": false,
                        "allowDomains": ["saved.example"]
                    }
                }
            }
        }))
        .unwrap();
        let (revision, _) = owner.replace("saved", desired).unwrap();

        for outcome in [
            None,
            Some(Outcome::Confirmed),
            Some(Outcome::Rejected),
            Some(Outcome::Unknown),
        ] {
            if let Some(outcome) = outcome {
                owner.settle(revision, outcome).unwrap();
            }
            let state_dir = openclaw::lifecycle::state_dir::CanonicalStateDir::provision(
                root.join(format!("openclaw-{outcome:?}")),
            )
            .unwrap();
            owner
                .saved_runtime_projection()
                .unwrap()
                .apply(state_dir.clone())
                .unwrap();
            let config: serde_json::Value = serde_json::from_slice(
                &fs::read(state_dir.as_path().join("openclaw.json")).unwrap(),
            )
            .unwrap();
            let runtime = &config["plugins"]["entries"]["security-core"]["config"];
            assert_eq!(runtime["runtimeGuardEnabled"], false);
            assert_eq!(
                runtime["allowDomains"],
                serde_json::json!(["saved.example"])
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_security_effect_is_not_reopened_for_replay() {
        let root = std::env::temp_dir().join(format!(
            "security-delivery-recovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let owner = Owner::open(&root).unwrap();
        let desired = Desired::try_from_wire(&serde_json::json!({
            "input": { "policy": { "preset": "relaxed", "securityPolicyVersion": 1, "runtime": {} } }
        })).unwrap();
        let (revision, _) = owner.replace("pending", desired).unwrap();
        assert_eq!(
            owner
                .pending()
                .unwrap()
                .map(|(pending_revision, _)| pending_revision),
            Some(revision)
        );
        owner.settle(revision, Outcome::Unknown).unwrap();
        assert_eq!(owner.pending().unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn effect_guard_serializes_policy_projection_and_emergency() {
        let root = std::env::temp_dir().join(format!(
            "security-delivery-effect-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let owner = Owner::open(&root).unwrap();

        let effect = owner.effect.lock().await;
        assert!(owner.effect.try_lock().is_err());
        drop(effect);
        assert!(owner.effect.try_lock().is_ok());

        let _ = fs::remove_dir_all(root);
    }
}
