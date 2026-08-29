use serde_json::Value;
use tokio::sync::oneshot;

use crate::security_audit;

pub(crate) enum SecurityQuery {
    CurrentPolicy {
        reply: oneshot::Sender<Result<Value, ()>>,
    },
    Audit {
        query: security_audit::Query,
        reply: oneshot::Sender<security_audit::Outcome>,
    },
}

impl SecurityQuery {
    pub(super) fn route(
        &self,
    ) -> foundation::execution::QueryRoute<super::actor::SecurityPartitionKey> {
        match self {
            Self::CurrentPolicy { .. } | Self::Audit { .. } => {
                foundation::execution::QueryRoute::Global
            }
        }
    }
}
