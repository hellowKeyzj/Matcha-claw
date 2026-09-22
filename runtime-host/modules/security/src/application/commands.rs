use std::fmt;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::{
    delivery::Settlement as SecurityPolicyDeliverySettlement, emergency::SecurityEmergencyOutcome,
    operation as security_operation,
};

pub enum SecurityCommand {
    ApplySavedPolicyProjection {
        reply: oneshot::Sender<Result<(), ()>>,
    },
    ReplacePolicy {
        correlation: String,
        policy: Value,
        reply: oneshot::Sender<SecurityPolicyDeliverySettlement>,
    },
    RecoverPending {
        reply: oneshot::Sender<()>,
    },
    Emergency {
        correlation: String,
        reply: oneshot::Sender<SecurityEmergencyOutcome>,
    },
    Operation {
        correlation: String,
        operation_id: String,
        input: Value,
        reply: oneshot::Sender<security_operation::Outcome>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SecurityOwnerUnavailable;

impl fmt::Display for SecurityOwnerUnavailable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("security owner is unavailable")
    }
}

impl std::error::Error for SecurityOwnerUnavailable {}
