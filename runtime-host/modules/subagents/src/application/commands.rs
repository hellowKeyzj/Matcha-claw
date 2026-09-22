use tokio::sync::oneshot;

use crate::domain::model::{Command as SubagentCommand, Outcome};

pub(crate) enum SubagentCommandEnvelope {
    Execute {
        command: SubagentCommand,
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
