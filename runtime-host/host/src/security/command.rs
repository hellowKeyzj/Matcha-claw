use serde_json::Value;
use tokio::sync::oneshot;

use crate::{security_delivery, security_emergency::SecurityEmergencyOutcome, security_operation};

pub(crate) enum SecurityCommand {
    ApplySavedPolicyProjection {
        reply: oneshot::Sender<Result<(), ()>>,
    },
    ReplacePolicy {
        correlation: String,
        policy: Value,
        reply: oneshot::Sender<security_delivery::Settlement>,
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
