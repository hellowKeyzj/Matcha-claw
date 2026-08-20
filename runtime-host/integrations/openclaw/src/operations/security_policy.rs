use std::sync::Arc;

use serde_json::{Map, Value};

use crate::gateway::{
    client::GatewayClient,
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

use super::{OperationsReadError, next_request_id, read_gateway};

const SECURITY_POLICY_SYNC_METHOD: &str = "security.policy.sync";
const SECURITY_MONITOR_STATUS_METHOD: &str = "security.monitor.status";
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_POLICY_BYTES: usize = 256 * 1024;
const MAX_ALERTS: usize = 256;
const MAX_ALERT_TEXT_BYTES: usize = 4 * 1024;
const SECURITY_PRESETS: &[&str] = &["strict", "balanced", "relaxed"];
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
    "secrets",
    "destructivePatterns",
    "secretPatterns",
];
const MONITOR_NAMES: &[&str] = &[
    "credential-monitor",
    "memory-integrity-monitor",
    "cost-monitor",
];
const HOOK_NAMES: &[&str] = &[
    "before_agent_start",
    "before_tool_call",
    "tool_result_persist",
    "message_received",
    "after_tool_call",
];

pub struct SecurityPolicyOperation {
    gateway: Arc<GatewayClient>,
}

impl SecurityPolicyOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn sync(&self, policy: Value) -> SecurityPolicyEffect {
        let intent = match PolicyIntent::try_from(policy) {
            Ok(intent) => intent,
            Err(()) => return SecurityPolicyEffect::RuntimeRejected,
        };
        let request = match wire::operations_request(
            next_request_id("security-policy-sync"),
            SECURITY_POLICY_SYNC_METHOD,
            intent.payload.clone(),
        ) {
            Ok(request) => request,
            Err(_) => return SecurityPolicyEffect::OutcomeUnknown,
        };
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                SecurityPolicyEffect::RuntimeRejected
            }
            MutationDelivery::Response(response) => match decode_security_policy(response, &intent)
            {
                Ok(receipt) => SecurityPolicyEffect::Applied(receipt),
                Err(()) => SecurityPolicyEffect::OutcomeUnknown,
            },
            MutationDelivery::NotWritten(_) => SecurityPolicyEffect::Unavailable,
            MutationDelivery::MayHaveReached(_) => SecurityPolicyEffect::OutcomeUnknown,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PolicyIntent {
    payload: Value,
    preset: String,
    security_policy_version: u64,
}

impl TryFrom<Value> for PolicyIntent {
    type Error = ();

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        let encoded = serde_json::to_vec(&value).map_err(|_| ())?;
        if encoded.len() > MAX_POLICY_BYTES {
            return Err(());
        }
        let object = value.as_object().ok_or(())?;
        require_exact_fields(object, &["preset", "securityPolicyVersion", "runtime"])?;
        let preset = object
            .get("preset")
            .and_then(Value::as_str)
            .filter(|preset| SECURITY_PRESETS.contains(preset))
            .ok_or(())?
            .to_owned();
        let security_policy_version = required_safe_u64(object, "securityPolicyVersion")?;
        if security_policy_version == 0 {
            return Err(());
        }
        let runtime = object.get("runtime").and_then(Value::as_object).ok_or(())?;
        validate_runtime(runtime)?;
        Ok(Self {
            payload: value,
            preset,
            security_policy_version,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecurityPolicyReceipt {
    preset: String,
    security_policy_version: u64,
    override_agent_count: u64,
}

impl SecurityPolicyReceipt {
    pub fn preset(&self) -> &str {
        &self.preset
    }

    pub const fn security_policy_version(&self) -> u64 {
        self.security_policy_version
    }

    pub const fn override_agent_count(&self) -> u64 {
        self.override_agent_count
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SecurityPolicyEffect {
    Applied(SecurityPolicyReceipt),
    RuntimeRejected,
    Unavailable,
    OutcomeUnknown,
}

pub struct SecurityMonitorOperation {
    gateway: Arc<GatewayClient>,
}

impl SecurityMonitorOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn observe(&self) -> SecurityMonitorEffect {
        let request = match wire::operations_request(
            next_request_id("security-monitor-status"),
            SECURITY_MONITOR_STATUS_METHOD,
            Value::Object(Map::new()),
        ) {
            Ok(request) => request,
            Err(_) => return SecurityMonitorEffect::OutcomeUnknown,
        };
        let response = match read_gateway(&self.gateway, request).await {
            Ok(response) => response,
            Err(OperationsReadError::Rejected) => return SecurityMonitorEffect::RuntimeRejected,
            Err(OperationsReadError::Unavailable) => return SecurityMonitorEffect::Unavailable,
            Err(OperationsReadError::Protocol) => return SecurityMonitorEffect::OutcomeUnknown,
        };
        match response {
            GatewayResponse::Failure { .. } => SecurityMonitorEffect::RuntimeRejected,
            response => match decode_security_monitor_status(response) {
                Ok(receipt) => SecurityMonitorEffect::Observed(receipt),
                Err(()) => SecurityMonitorEffect::OutcomeUnknown,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SecurityMonitorReceipt {
    credentials_running: bool,
    memory_running: bool,
    cost_running: bool,
}

impl SecurityMonitorReceipt {
    pub const fn credentials_running(self) -> bool {
        self.credentials_running
    }

    pub const fn memory_running(self) -> bool {
        self.memory_running
    }

    pub const fn cost_running(self) -> bool {
        self.cost_running
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityMonitorEffect {
    Observed(SecurityMonitorReceipt),
    RuntimeRejected,
    Unavailable,
    OutcomeUnknown,
}

fn validate_runtime(runtime: &Map<String, Value>) -> Result<(), ()> {
    if runtime
        .keys()
        .any(|field| !RUNTIME_FIELDS.contains(&field.as_str()))
    {
        return Err(());
    }
    validate_nested_fields(runtime, "monitors", &["credentials", "memory", "cost"])?;
    validate_nested_fields(runtime, "logging", &["logDetections"])?;
    validate_nested_fields(runtime, "allowlist", &["tools", "sessions"])?;
    validate_nested_fields(
        runtime,
        "destructive",
        &["action", "severityActions", "categories"],
    )?;
    validate_nested_fields(runtime, "secrets", &["action", "severityActions"])?;
    for key in ["destructive", "secrets"] {
        let Some(value) = runtime.get(key) else {
            continue;
        };
        let object = value.as_object().ok_or(())?;
        validate_nested_fields(
            object,
            "severityActions",
            &["critical", "high", "medium", "low"],
        )?;
        if key == "destructive" {
            validate_nested_fields(
                object,
                "categories",
                &[
                    "fileDelete",
                    "gitDestructive",
                    "sqlDestructive",
                    "systemDestructive",
                    "processKill",
                    "networkDestructive",
                    "privilegeEscalation",
                ],
            )?;
        }
    }
    Ok(())
}

fn validate_nested_fields(
    object: &Map<String, Value>,
    field: &str,
    expected: &[&str],
) -> Result<(), ()> {
    let Some(value) = object.get(field) else {
        return Ok(());
    };
    let value = value.as_object().ok_or(())?;
    if value.keys().any(|key| !expected.contains(&key.as_str())) {
        return Err(());
    }
    Ok(())
}

fn decode_security_policy(
    response: GatewayResponse,
    intent: &PolicyIntent,
) -> Result<SecurityPolicyReceipt, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(
        &payload,
        &[
            "preset",
            "securityPolicyVersion",
            "overrideAgentCount",
            "backend",
        ],
    )?;
    if payload.get("backend").and_then(Value::as_str) != Some("security-core")
        || payload.get("preset").and_then(Value::as_str) != Some(intent.preset.as_str())
        || required_safe_u64(&payload, "securityPolicyVersion")? != intent.security_policy_version
    {
        return Err(());
    }
    Ok(SecurityPolicyReceipt {
        preset: intent.preset.clone(),
        security_policy_version: intent.security_policy_version,
        override_agent_count: required_safe_u64(&payload, "overrideAgentCount")?,
    })
}

fn decode_security_monitor_status(response: GatewayResponse) -> Result<SecurityMonitorReceipt, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(&payload, &["backend", "monitors", "hookLatency"])?;
    if payload.get("backend").and_then(Value::as_str) != Some("security-core") {
        return Err(());
    }
    let monitors = payload
        .get("monitors")
        .and_then(Value::as_object)
        .ok_or(())?;
    require_exact_fields(monitors, &["credentials", "memory", "cost"])?;
    let credentials_running = decode_monitor(monitors, "credentials")?;
    let memory_running = decode_monitor(monitors, "memory")?;
    let cost_running = decode_monitor(monitors, "cost")?;
    decode_hook_latency(payload.get("hookLatency").ok_or(())?)?;
    Ok(SecurityMonitorReceipt {
        credentials_running,
        memory_running,
        cost_running,
    })
}

fn decode_monitor(monitors: &Map<String, Value>, name: &str) -> Result<bool, ()> {
    let monitor = monitors.get(name).and_then(Value::as_object).ok_or(())?;
    if monitor
        .keys()
        .any(|field| !["running", "lastCheck", "alerts"].contains(&field.as_str()))
        || !monitor.contains_key("running")
        || !monitor.contains_key("alerts")
    {
        return Err(());
    }
    if let Some(last_check) = monitor.get("lastCheck")
        && !last_check.is_null()
        && !last_check
            .as_str()
            .is_some_and(|value| safe_text(value, MAX_ALERT_TEXT_BYTES))
    {
        return Err(());
    }
    let alerts = monitor.get("alerts").and_then(Value::as_array).ok_or(())?;
    if alerts.len() > MAX_ALERTS {
        return Err(());
    }
    for alert in alerts {
        decode_alert(alert)?;
    }
    monitor.get("running").and_then(Value::as_bool).ok_or(())
}

fn decode_alert(value: &Value) -> Result<(), ()> {
    let alert = value.as_object().ok_or(())?;
    let expected = ["timestamp", "severity", "monitor", "message", "details"];
    if alert
        .keys()
        .any(|field| !expected.contains(&field.as_str()))
        || alert.len() < 4
        || alert.len() > expected.len()
        || !alert.contains_key("timestamp")
        || !alert.contains_key("severity")
        || !alert.contains_key("monitor")
        || !alert.contains_key("message")
    {
        return Err(());
    }
    for field in ["timestamp", "severity", "monitor", "message"] {
        if !alert
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| safe_text(value, MAX_ALERT_TEXT_BYTES))
        {
            return Err(());
        }
    }
    if !MONITOR_NAMES.contains(&alert["monitor"].as_str().ok_or(())?)
        || !["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
            .contains(&alert["severity"].as_str().ok_or(())?)
    {
        return Err(());
    }
    if let Some(details) = alert.get("details")
        && !details.is_null()
        && !details
            .as_str()
            .is_some_and(|value| safe_text(value, MAX_ALERT_TEXT_BYTES))
    {
        return Err(());
    }
    Ok(())
}

fn decode_hook_latency(value: &Value) -> Result<(), ()> {
    let latency = value.as_object().ok_or(())?;
    require_exact_fields(latency, HOOK_NAMES)?;
    for hook in HOOK_NAMES {
        let summary = latency.get(*hook).and_then(Value::as_object).ok_or(())?;
        require_exact_fields(summary, &["count", "p50Ms", "p95Ms", "lastMs", "maxMs"])?;
        for field in ["count", "p50Ms", "p95Ms", "lastMs", "maxMs"] {
            required_safe_u64(summary, field)?;
        }
    }
    Ok(())
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

fn require_exact_fields(payload: &Map<String, Value>, expected: &[&str]) -> Result<(), ()> {
    if payload.len() != expected.len()
        || payload
            .keys()
            .any(|field| !expected.contains(&field.as_str()))
    {
        return Err(());
    }
    Ok(())
}

fn required_safe_u64(payload: &Map<String, Value>, field: &str) -> Result<u64, ()> {
    payload
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
        .ok_or(())
}

fn safe_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}
