use std::fmt;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::application::call::SecurityCall;

pub enum SecurityCommand {
    ApplySavedPolicyProjection {
        reply: oneshot::Sender<Result<(), ()>>,
    },
    ReplacePolicy {
        correlation: String,
        policy: Value,
        call: SecurityCall,
    },
    RecoverPending {
        reply: oneshot::Sender<()>,
    },
    Emergency {
        correlation: String,
        call: SecurityCall,
    },
    Operation {
        correlation: String,
        operation_id: String,
        input: Value,
        call: SecurityCall,
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
