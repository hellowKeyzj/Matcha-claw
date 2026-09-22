use serde_json::Value;

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    operations::{
        SecurityActionEffect, SecurityEmergencyEffect, SecurityPolicyEffect,
        security_audit::{SecurityAuditEffect, SecurityAuditQuery},
    },
    port::OpenClawGateway,
    projection,
};

pub fn apply_policy_projection(
    state_dir: CanonicalStateDir,
    policy: Value,
) -> Result<(), ::security::ports::SecurityRuntimeFailure> {
    let runtime = policy
        .get("runtime")
        .and_then(Value::as_object)
        .ok_or(::security::ports::SecurityRuntimeFailure::TargetRejected)?;
    projection::security::apply_normalized(state_dir, runtime)
        .map(|_| ())
        .map_err(|_| ::security::ports::SecurityRuntimeFailure::Unknown)
}

pub async fn sync_policy(
    gateway: &OpenClawGateway,
    policy: Value,
) -> ::security::delivery::Outcome {
    map_policy_effect(gateway.sync_security_policy(policy).await)
}

pub async fn run_emergency(
    gateway: &OpenClawGateway,
) -> ::security::emergency::SecurityEmergencyOutcome {
    map_emergency_effect(gateway.run_security_emergency().await)
}

pub async fn query_audit(
    gateway: &OpenClawGateway,
    query: ::security::audit::Query,
) -> ::security::audit::Outcome {
    let Some(native_query) = SecurityAuditQuery::new(query.page, query.page_size) else {
        return ::security::audit::Outcome::Rejected;
    };
    map_audit_effect(gateway.query_security_audit(native_query).await)
}

pub async fn run_operation(
    gateway: &OpenClawGateway,
    operation_id: String,
    input: Value,
) -> ::security::operation::Outcome {
    map_operation_effect(gateway.security_operation(&operation_id, input).await)
}

fn map_policy_effect(effect: SecurityPolicyEffect) -> ::security::delivery::Outcome {
    match effect {
        SecurityPolicyEffect::Applied(_) => ::security::delivery::Outcome::Confirmed,
        SecurityPolicyEffect::RuntimeRejected => ::security::delivery::Outcome::Rejected,
        SecurityPolicyEffect::Unavailable | SecurityPolicyEffect::OutcomeUnknown => {
            ::security::delivery::Outcome::Unknown
        }
    }
}

fn map_emergency_effect(
    effect: SecurityEmergencyEffect,
) -> ::security::emergency::SecurityEmergencyOutcome {
    match effect {
        SecurityEmergencyEffect::Applied(_) => {
            ::security::emergency::SecurityEmergencyOutcome::Applied
        }
        SecurityEmergencyEffect::RuntimeRejected => {
            ::security::emergency::SecurityEmergencyOutcome::Rejected
        }
        SecurityEmergencyEffect::OutcomeUnknown => {
            ::security::emergency::SecurityEmergencyOutcome::OutcomeUnknown
        }
    }
}

fn map_audit_effect(effect: SecurityAuditEffect) -> ::security::audit::Outcome {
    match effect {
        SecurityAuditEffect::Observed(receipt) => {
            ::security::audit::Outcome::Observed(::security::audit::Receipt {
                page: receipt.page(),
                page_size: receipt.page_size(),
                total: receipt.total(),
                items: receipt
                    .items()
                    .iter()
                    .map(|item| ::security::audit::Item {
                        ts: item.ts(),
                        tool_name: item.tool_name().to_string(),
                        risk: item.risk().to_string(),
                        action: item.action().to_string(),
                        decision: item.decision().to_string(),
                        rule_id: item.rule_id().map(String::from),
                    })
                    .collect(),
            })
        }
        SecurityAuditEffect::RuntimeRejected => ::security::audit::Outcome::Rejected,
        SecurityAuditEffect::Unavailable => ::security::audit::Outcome::Unavailable,
        SecurityAuditEffect::OutcomeUnknown => ::security::audit::Outcome::Unknown,
    }
}

fn map_operation_effect(effect: SecurityActionEffect) -> ::security::operation::Outcome {
    match effect {
        SecurityActionEffect::Applied(value) => ::security::operation::Outcome::Confirmed(value),
        SecurityActionEffect::RuntimeRejected => ::security::operation::Outcome::Rejected,
        SecurityActionEffect::Unavailable => ::security::operation::Outcome::Unavailable,
        SecurityActionEffect::OutcomeUnknown => ::security::operation::Outcome::Unknown,
    }
}
