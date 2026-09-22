use tokio::sync::oneshot;

use crate::{PrepareOutcome, ToolchainRequestAdmissionClosed, ToolchainStatus};

pub(crate) enum ToolchainCommand {
    Prepare {
        reply: oneshot::Sender<Result<PrepareOutcome, ToolchainRequestAdmissionClosed>>,
    },
}

pub(crate) enum ToolchainQuery {
    Status {
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
