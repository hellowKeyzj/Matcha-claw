use environment::connectors::Connector;
use foundation::execution::{CommandRoute, QueryRoute};
use tokio::sync::oneshot;

use super::receipt::{
    ConnectorCatalogReceipt, ConnectorGetReceipt, ConnectorListReceipt, ConnectorMutationReceipt,
    ConnectorProbeReceipt, ConnectorSessionMcpServerEnabledReceipt,
    ConnectorSessionMcpServerEnabledTarget, ConnectorSessionStatusReceipt, ConnectorSessionTarget,
    ConnectorStatusReceipt, OpenClawMcpServersReceipt,
};
use crate::provider::auth::Resolver;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum ConnectorOwnerKey {}

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
        resolver: Resolver,
        reply: oneshot::Sender<()>,
    },
    SetSessionMcpServerEnabled {
        target: ConnectorSessionMcpServerEnabledTarget,
        reply: oneshot::Sender<ConnectorSessionMcpServerEnabledReceipt>,
    },
}

pub(crate) enum ConnectorQuery {
    List {
        reply: oneshot::Sender<ConnectorListReceipt>,
    },
    Catalog {
        reply: oneshot::Sender<ConnectorCatalogReceipt>,
    },
    Status {
        reply: oneshot::Sender<ConnectorStatusReceipt>,
    },
    Get {
        id: String,
        reply: oneshot::Sender<ConnectorGetReceipt>,
    },
    Probe {
        id: String,
        reply: oneshot::Sender<ConnectorProbeReceipt>,
    },
    SessionStatus {
        target: ConnectorSessionTarget,
        reply: oneshot::Sender<ConnectorSessionStatusReceipt>,
    },
    OpenClawMcpServers {
        reply: oneshot::Sender<OpenClawMcpServersReceipt>,
    },
}

impl ConnectorCommand {
    pub(super) fn route(&self) -> CommandRoute<ConnectorOwnerKey> {
        match self {
            Self::Upsert { .. }
            | Self::Remove { .. }
            | Self::ConfigurePrivateResolver { .. }
            | Self::SetSessionMcpServerEnabled { .. } => CommandRoute::Global,
        }
    }
}

impl ConnectorQuery {
    pub(super) fn route(&self) -> QueryRoute<ConnectorOwnerKey> {
        match self {
            Self::List { .. }
            | Self::Catalog { .. }
            | Self::Status { .. }
            | Self::Get { .. }
            | Self::Probe { .. }
            | Self::SessionStatus { .. }
            | Self::OpenClawMcpServers { .. } => QueryRoute::Global,
        }
    }
}
