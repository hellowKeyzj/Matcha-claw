use foundation::execution::QueryRoute;

use crate::call::ConnectorCall;
use tokio::sync::oneshot;

use super::{
    ConnectorOwnerKey,
    receipts::{
        ConnectorCatalogReceipt, ConnectorGetReceipt, ConnectorListReceipt, ConnectorSessionTarget,
        OpenClawMcpServersReceipt,
    },
};

pub(crate) enum ConnectorQuery {
    List {
        call: Option<ConnectorCall>,
        reply: oneshot::Sender<ConnectorListReceipt>,
    },
    Catalog {
        call: Option<ConnectorCall>,
        reply: oneshot::Sender<ConnectorCatalogReceipt>,
    },
    Status {
        call: ConnectorCall,
    },
    Get {
        id: String,
        call: Option<ConnectorCall>,
        reply: oneshot::Sender<ConnectorGetReceipt>,
    },
    Probe {
        id: String,
        call: ConnectorCall,
    },
    SessionStatus {
        target: ConnectorSessionTarget,
        session_identity: crate::delivery::SessionIdentity,
        call: ConnectorCall,
    },
    OpenClawMcpServers {
        call: Option<ConnectorCall>,
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
