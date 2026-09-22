use std::sync::Arc;

use crate::{domain::Connector, ports::ConnectorSecretResolverPort};
use foundation::execution::CommandRoute;
use tokio::sync::oneshot;

use super::{
    ConnectorOwnerKey,
    receipts::{
        ConnectorMutationReceipt, ConnectorSessionMcpServerEnabledReceipt,
        ConnectorSessionMcpServerEnabledTarget,
    },
};

pub(crate) enum ConnectorCommand {
    Upsert {
        connector: Box<Connector>,
        reply: oneshot::Sender<ConnectorMutationReceipt>,
    },
    Remove {
        id: String,
        reply: oneshot::Sender<ConnectorMutationReceipt>,
    },
    ConfigurePrivateResolver {
        resolver: Arc<dyn ConnectorSecretResolverPort>,
        reply: oneshot::Sender<()>,
    },
    SetSessionMcpServerEnabled {
        target: ConnectorSessionMcpServerEnabledTarget,
        reply: oneshot::Sender<ConnectorSessionMcpServerEnabledReceipt>,
    },
}

impl ConnectorCommand {
    pub(crate) fn route(&self) -> CommandRoute<ConnectorOwnerKey> {
        match self {
            Self::Upsert { .. }
            | Self::Remove { .. }
            | Self::ConfigurePrivateResolver { .. }
            | Self::SetSessionMcpServerEnabled { .. } => CommandRoute::Global,
        }
    }
}
