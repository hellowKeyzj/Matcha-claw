use environment::Connector;
use foundation::execution::{CommandRoute, QueryRoute};
use tokio::sync::oneshot;

use crate::external_connectors::{
    CatalogOutcome, GetOutcome, ListOutcome, MutationOutcome, ProbeOutcome, SessionIdentity,
    SessionStatusOutcome, StatusOutcome,
};
use crate::transport::provider_accounts::private_auth::Resolver;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum ConnectorOwnerKey {
    Installation,
}

pub(crate) enum ConnectorCommand {
    Upsert {
        connector: Box<Connector>,
        reply: oneshot::Sender<MutationOutcome>,
    },
    Remove {
        id: String,
        reply: oneshot::Sender<MutationOutcome>,
    },
    ConfigurePrivateResolver {
        resolver: Resolver,
        reply: oneshot::Sender<()>,
    },
}

pub(crate) enum ConnectorQuery {
    List {
        reply: oneshot::Sender<ListOutcome>,
    },
    Catalog {
        reply: oneshot::Sender<CatalogOutcome>,
    },
    Status {
        reply: oneshot::Sender<StatusOutcome>,
    },
    Get {
        id: String,
        reply: oneshot::Sender<GetOutcome>,
    },
    Probe {
        id: String,
        reply: oneshot::Sender<ProbeOutcome>,
    },
    SessionStatus {
        identity: SessionIdentity,
        reply: oneshot::Sender<SessionStatusOutcome>,
    },
}

impl ConnectorCommand {
    pub(super) fn route(&self) -> CommandRoute<ConnectorOwnerKey> {
        match self {
            Self::Upsert { .. } | Self::Remove { .. } | Self::ConfigurePrivateResolver { .. } => {
                CommandRoute::Global
            }
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
            | Self::SessionStatus { .. } => QueryRoute::Global,
        }
    }
}
