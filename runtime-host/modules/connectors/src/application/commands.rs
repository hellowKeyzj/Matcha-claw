use std::sync::Arc;

use crate::call::ConnectorCall;

use crate::ports::ConnectorProjectionEffect;
use crate::{domain::{Connector, ConnectorPatch}, ports::ConnectorSecretResolverPort};
use foundation::execution::CommandRoute;
use platform::endpoint::runtime_address::RuntimeEndpoint;
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
        call: Option<ConnectorCall>,
        reply: oneshot::Sender<ConnectorMutationReceipt>,
    },
    Update {
        id: String,
        patch: Box<ConnectorPatch>,
        call: Option<ConnectorCall>,
        reply: oneshot::Sender<ConnectorMutationReceipt>,
    },
    Remove {
        id: String,
        call: Option<ConnectorCall>,
        reply: oneshot::Sender<ConnectorMutationReceipt>,
    },
    ConfigurePrivateResolver {
        resolver: Arc<dyn ConnectorSecretResolverPort>,
        reply: oneshot::Sender<()>,
    },
    ReprojectPrivateProjection {
        endpoint: RuntimeEndpoint,
        reply: oneshot::Sender<ConnectorProjectionEffect>,
    },
    SetSessionMcpServerEnabled {
        target: ConnectorSessionMcpServerEnabledTarget,
        call: Option<ConnectorCall>,
        reply: oneshot::Sender<ConnectorSessionMcpServerEnabledReceipt>,
    },
}

impl ConnectorCommand {
    pub(crate) fn route(&self) -> CommandRoute<ConnectorOwnerKey> {
        match self {
            Self::Upsert { .. }
            | Self::Update { .. }
            | Self::Remove { .. }
            | Self::ConfigurePrivateResolver { .. }
            | Self::ReprojectPrivateProjection { .. }
            | Self::SetSessionMcpServerEnabled { .. } => CommandRoute::Global,
        }
    }
}
