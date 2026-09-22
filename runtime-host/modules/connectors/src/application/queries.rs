use foundation::execution::QueryRoute;
use tokio::sync::oneshot;

use super::{
    ConnectorOwnerKey,
    receipts::{
        ConnectorCatalogReceipt, ConnectorGetReceipt, ConnectorListReceipt, ConnectorProbeReceipt,
        ConnectorSessionStatusReceipt, ConnectorSessionTarget, ConnectorStatusReceipt,
        OpenClawMcpServersReceipt,
    },
};

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

impl ConnectorQuery {
    pub(crate) fn route(&self) -> QueryRoute<ConnectorOwnerKey> {
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
