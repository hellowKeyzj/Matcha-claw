use serde_json::Value;
use tokio::sync::oneshot;

use crate::{audit as security_audit, owner::SecurityPartitionKey};

pub enum SecurityQuery {
    CurrentPolicy {
        reply: oneshot::Sender<Result<Value, ()>>,
    },
    Audit {
        query: security_audit::Query,
        reply: oneshot::Sender<security_audit::Outcome>,
    },
}

impl SecurityQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<SecurityPartitionKey> {
        match self {
            Self::CurrentPolicy { .. } | Self::Audit { .. } => {
                foundation::execution::QueryRoute::Global
            }
        }
    }
}
