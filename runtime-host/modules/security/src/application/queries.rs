use platform::call::CallContext;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::{
    application::call::SecurityCallDetail, audit as security_audit,
    operation as security_operation, owner::SecurityPartitionKey,
};

pub enum SecurityQuery {
    CurrentPolicy {
        reply: oneshot::Sender<Result<Value, ()>>,
        context: CallContext<SecurityCallDetail>,
    },
    Audit {
        query: security_audit::Query,
        reply: oneshot::Sender<security_audit::Outcome>,
        context: CallContext<SecurityCallDetail>,
    },
    OperationReceipt {
        correlation: String,
        reply: oneshot::Sender<Result<Option<security_operation::Outcome>, ()>>,
        context: CallContext<SecurityCallDetail>,
    },
}

impl SecurityQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<SecurityPartitionKey> {
        match self {
            Self::Audit { .. } | Self::OperationReceipt { .. } => foundation::execution::QueryRoute::Direct,
            Self::CurrentPolicy { .. } => foundation::execution::QueryRoute::Global,
        }
    }
}
