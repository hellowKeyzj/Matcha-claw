use std::{future::Future, pin::Pin};

use serde_json::Value;

use crate::{
    audit, delivery::Outcome as SecurityPolicyDeliveryOutcome, emergency::SecurityEmergencyOutcome,
    operation as security_operation,
};

pub type SecurityFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait SecurityRuntimeDirectory: Send + Sync {
    fn security_ops(&self) -> Option<&dyn SecurityOps>;

    fn restart_security_runtime<'a>(&'a self) -> SecurityFuture<'a, bool>;
}

pub trait SecurityOps: Send + Sync {
    fn apply_security_policy_projection<'a>(
        &'a self,
        policy: Value,
    ) -> SecurityFuture<'a, Result<(), SecurityRuntimeFailure>>;

    fn sync_security_policy<'a>(
        &'a self,
        policy: Value,
    ) -> SecurityFuture<'a, SecurityPolicyDeliveryOutcome>;

    fn run_security_emergency<'a>(&'a self) -> SecurityFuture<'a, SecurityEmergencyOutcome>;

    fn query_security_audit<'a>(
        &'a self,
        query: audit::Query,
    ) -> SecurityFuture<'a, audit::Outcome>;

    fn security_operation<'a>(
        &'a self,
        operation_id: String,
        input: Value,
    ) -> SecurityFuture<'a, security_operation::Outcome>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityRuntimeFailure {
    Unsupported,
    Unavailable,
    TargetRejected,
    Unknown,
}
