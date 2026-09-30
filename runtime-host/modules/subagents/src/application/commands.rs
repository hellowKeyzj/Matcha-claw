use std::sync::Arc;
use tokio::sync::{OnceCell, oneshot};

use platform::call::{CallContext, CallLogError, CallReceipt};

use crate::{
    domain::model::{Command as SubagentCommand, Outcome},
    projection::call::SubagentCallDetail,
};

pub(crate) enum SubagentCommandEnvelope {
    Execute {
        command: SubagentCommand,
        call: Option<CallContext<SubagentCallDetail>>,
        detail: SubagentCallDetail,
        admission: Option<Arc<OnceCell<Result<CallReceipt, CallLogError>>>>,
        reply: oneshot::Sender<Outcome>,
    },
}

pub(crate) enum SubagentQuery {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum SubagentOwnerKey {}

impl SubagentCommandEnvelope {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<SubagentOwnerKey> {
        foundation::execution::CommandRoute::Global
    }
}

impl SubagentQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<SubagentOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
