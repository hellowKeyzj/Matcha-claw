use platform::call::CallContext;
use tokio::sync::oneshot;

use crate::{PrepareOutcome, ToolchainRequestAdmissionClosed, ToolchainStatus};

use super::call::ToolchainCallDetail;

pub(crate) enum ToolchainCommand {
    AdmitPrepare {
        call: CallContext<ToolchainCallDetail>,
    },
    Prepare {
        call: Option<CallContext<ToolchainCallDetail>>,
        reply: oneshot::Sender<Result<PrepareOutcome, ToolchainRequestAdmissionClosed>>,
    },
}

pub(crate) enum ToolchainQuery {
    Status {
        call: Option<CallContext<ToolchainCallDetail>>,
        reply: oneshot::Sender<Result<ToolchainStatus, ToolchainRequestAdmissionClosed>>,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum ToolchainOwnerKey {}

impl ToolchainCommand {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<ToolchainOwnerKey> {
        foundation::execution::CommandRoute::Global
    }
}

impl ToolchainQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<ToolchainOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
