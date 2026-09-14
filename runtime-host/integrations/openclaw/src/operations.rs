use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use serde_json::{Map, Value};

pub mod channel_config;
pub mod channel_control;
pub mod channel_credentials;
mod channel_identity;
pub mod channel_login;
pub mod channel_pairing;
pub mod channel_status;
pub mod plugin_refresh;
pub mod provider_models;
pub mod provider_native_config;
pub mod weixin_login;

use crate::gateway::{
    client::{GatewayClient, GatewayClientError},
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

mod security_actions;
pub mod security_audit;
mod security_policy;
pub mod settings_config;

pub use security_actions::{SecurityActionEffect, SecurityActionsOperation};
pub use security_policy::{
    SecurityMonitorEffect, SecurityMonitorOperation, SecurityMonitorReceipt, SecurityPolicyEffect,
    SecurityPolicyOperation, SecurityPolicyReceipt,
};

const SECURITY_EMERGENCY_RUN_METHOD: &str = "security.emergency.run";
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy)]
pub(crate) enum OperationsReadError {
    Unavailable,
    Rejected,
    Protocol,
}

pub(crate) async fn read_gateway(
    gateway: &GatewayClient,
    request: wire::RpcRequest,
) -> Result<GatewayResponse, OperationsReadError> {
    gateway.rpc_query(request).await.map_err(map_read_error)
}

/// Narrow native edge for the fixed `security.emergency.run` mutation.
///
/// It retains only the authenticated Gateway client and returns an opaque
/// receipt. Gateway payload, policy, configuration, and evidence stay inside
/// this integration.
pub struct SecurityEmergencyOperation {
    gateway: Arc<GatewayClient>,
}

impl SecurityEmergencyOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn run(&self) -> SecurityEmergencyEffect {
        run_security_emergency(&self.gateway).await
    }
}

impl fmt::Debug for SecurityEmergencyOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecurityEmergencyOperation")
            .finish_non_exhaustive()
    }
}

async fn run_security_emergency(gateway: &GatewayClient) -> SecurityEmergencyEffect {
    let request = match security_emergency_run_request(next_request_id("security-emergency")) {
        Ok(request) => request,
        Err(_) => return SecurityEmergencyEffect::OutcomeUnknown,
    };
    match gateway.rpc_mutation(request).await {
        MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
            SecurityEmergencyEffect::RuntimeRejected
        }
        MutationDelivery::Response(response) => match decode_security_emergency(response) {
            Ok(receipt) => SecurityEmergencyEffect::Applied(receipt),
            Err(_) => SecurityEmergencyEffect::OutcomeUnknown,
        },
        MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
            SecurityEmergencyEffect::OutcomeUnknown
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SecurityEmergencyReceipt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityEmergencyEffect {
    Applied(SecurityEmergencyReceipt),
    RuntimeRejected,
    OutcomeUnknown,
}

fn next_request_id(operation: &str) -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("matcha-{operation}-{sequence}")
}

fn security_emergency_run_request(request_id: String) -> Result<wire::RpcRequest, wire::WireError> {
    wire::operations_request(
        request_id,
        SECURITY_EMERGENCY_RUN_METHOD,
        Value::Object(Map::new()),
    )
}

fn decode_security_emergency(response: GatewayResponse) -> Result<SecurityEmergencyReceipt, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(
        &payload,
        &[
            "backend",
            "lockdownApplied",
            "lockdown",
            "incidentId",
            "appliedAt",
            "evidenceDir",
            "reportPath",
            "runtimeSnapshotPath",
            "recentChanges",
            "recommendations",
            "skippedChecks",
        ],
    )?;
    if payload.get("backend").and_then(Value::as_str) != Some("security-core")
        || payload.get("lockdownApplied").and_then(Value::as_bool) != Some(true)
        || !required_non_empty_string(&payload, "incidentId")
        || required_u64(&payload, "appliedAt")? == 0
        || !required_non_empty_string(&payload, "evidenceDir")
        || !required_non_empty_string(&payload, "reportPath")
        || !required_non_empty_string(&payload, "runtimeSnapshotPath")
    {
        return Err(());
    }
    for field in ["recentChanges", "recommendations", "skippedChecks"] {
        if !required_array(&payload, field)?
            .iter()
            .all(|item| item.as_str().is_some_and(|value| !value.is_empty()))
        {
            return Err(());
        }
    }
    let lockdown = required_object(&payload, "lockdown")?;
    require_exact_fields(
        lockdown,
        &[
            "preset",
            "blockDestructive",
            "blockSecrets",
            "runtimeGuardEnabled",
            "enablePromptInjectionGuard",
            "allowlistedTools",
            "allowlistedSessions",
            "allowDomains",
        ],
    )?;
    if lockdown.get("preset").and_then(Value::as_str) != Some("strict")
        || lockdown.get("blockDestructive").and_then(Value::as_bool) != Some(true)
        || lockdown.get("blockSecrets").and_then(Value::as_bool) != Some(true)
        || lockdown.get("runtimeGuardEnabled").and_then(Value::as_bool) != Some(true)
        || lockdown
            .get("enablePromptInjectionGuard")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(());
    }
    for field in ["allowlistedTools", "allowlistedSessions", "allowDomains"] {
        required_u64(lockdown, field)?;
    }
    Ok(SecurityEmergencyReceipt)
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
    if payload.len() != expected.len() {
        return Err(());
    }
    reject_unknown_fields(payload, expected)
}

fn reject_unknown_fields(payload: &Map<String, Value>, expected: &[&str]) -> Result<(), ()> {
    if payload
        .keys()
        .any(|field| !expected.contains(&field.as_str()))
    {
        return Err(());
    }
    Ok(())
}

fn required_object<'a>(
    payload: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Map<String, Value>, ()> {
    payload.get(field).and_then(Value::as_object).ok_or(())
}

fn required_array<'a>(payload: &'a Map<String, Value>, field: &str) -> Result<&'a [Value], ()> {
    payload
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or(())
}

fn required_u64(payload: &Map<String, Value>, field: &str) -> Result<u64, ()> {
    payload
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
        .ok_or(())
}

fn required_non_empty_string(payload: &Map<String, Value>, field: &str) -> bool {
    payload
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

fn map_read_error(error: GatewayClientError) -> OperationsReadError {
    match error {
        GatewayClientError::RpcFailed => OperationsReadError::Rejected,
        GatewayClientError::Protocol => OperationsReadError::Protocol,
        _ => OperationsReadError::Unavailable,
    }
}

#[cfg(test)]
mod tests;
