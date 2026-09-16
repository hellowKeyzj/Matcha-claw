use serde_json::{Map, Value};

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecurityPolicyDesired {
    policy: Value,
}

impl SecurityPolicyDesired {
    pub fn try_from_wire(value: &Value) -> Result<Self, ()> {
        let policy = value
            .get("input")
            .and_then(Value::as_object)
            .and_then(|input| input.get("policy"))
            .ok_or(())?;
        Self::try_from_policy(policy)
    }

    pub fn try_from_policy(value: &Value) -> Result<Self, ()> {
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

    pub fn into_policy(self) -> Value {
        self.policy
    }
}

impl Default for SecurityPolicyDesired {
    fn default() -> Self {
        Self {
            policy: serde_json::json!({
                "preset": "relaxed",
                "securityPolicyVersion": 1,
                "runtime": template("relaxed").expect("builtin policy")
            }),
        }
    }
}

pub fn emergency_lockdown(mut policy: Value) -> Result<SecurityPolicyDesired, ()> {
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
    Ok(SecurityPolicyDesired { policy })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_deduplicated_runtime_lists_and_persists() {
        let desired = SecurityPolicyDesired::try_from_wire(&serde_json::json!({"input":{"policy":{"preset":"strict","securityPolicyVersion":1,"runtime":{"allowDomains":[" api.example.com ","api.example.com"]}}}})).unwrap();
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
        let policy = desired.into_policy();
        let runtime = &policy["runtime"];
        assert_eq!(policy["preset"], "strict");
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
            SecurityPolicyDesired::try_from_wire(&serde_json::json!({
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
}
