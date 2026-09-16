use std::fmt;

use foundation::execution::QueryRoute;
use tokio::sync::oneshot;

use super::{
    ChannelKey,
    catalog::{ChannelCatalogOutcome, ChannelConfigureFormOutcome},
    config_read as channel_config_read,
    status::{
        ChannelPairingOutcome, ChannelSnapshotOutcome, ChannelStatusFailure, ChannelStatusOutcome,
    },
};

pub(crate) enum ChannelQuery {
    Catalog {
        trace: super::trace::CommandTrace,
        reply: oneshot::Sender<ChannelCatalogOutcome>,
    },
    ConfigRead {
        trace: super::trace::CommandTrace,
        channel_id: String,
        account_id: Option<String>,
        reply: oneshot::Sender<channel_config_read::Outcome>,
    },
    ConfigureForm {
        trace: super::trace::CommandTrace,
        channel_id: String,
        reply: oneshot::Sender<ChannelConfigureFormOutcome>,
    },
    Pairing {
        trace: super::trace::CommandTrace,
        channel_id: String,
        account_id: Option<String>,
        reply: oneshot::Sender<ChannelPairingOutcome>,
    },
    Status {
        trace: super::trace::CommandTrace,
        reply: oneshot::Sender<Result<ChannelStatusOutcome, ChannelStatusFailure>>,
    },
    Snapshot {
        trace: super::trace::CommandTrace,
        reply: oneshot::Sender<Result<ChannelSnapshotOutcome, ChannelStatusFailure>>,
    },
}

impl ChannelQuery {
    pub(super) fn trace(&self) -> &super::trace::CommandTrace {
        match self {
            Self::Catalog { trace, .. } => trace,
            Self::ConfigRead { trace, .. } => trace,
            Self::ConfigureForm { trace, .. } => trace,
            Self::Pairing { trace, .. } => trace,
            Self::Status { trace, .. } => trace,
            Self::Snapshot { trace, .. } => trace,
        }
    }

    pub(super) fn route(&self) -> QueryRoute<ChannelKey> {
        match self {
            Self::Catalog { .. }
            | Self::ConfigRead { .. }
            | Self::ConfigureForm { .. }
            | Self::Pairing { .. }
            | Self::Status { .. }
            | Self::Snapshot { .. } => QueryRoute::Direct,
        }
    }
}

impl fmt::Debug for ChannelQuery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Catalog { .. } => formatter.debug_struct("Catalog").finish(),
            Self::ConfigRead {
                channel_id,
                account_id,
                ..
            } => formatter
                .debug_struct("ConfigRead")
                .field("channel_id", channel_id)
                .field("account_id", account_id)
                .finish(),
            Self::ConfigureForm { channel_id, .. } => formatter
                .debug_struct("ConfigureForm")
                .field("channel_id", channel_id)
                .finish(),
            Self::Pairing {
                channel_id,
                account_id,
                ..
            } => formatter
                .debug_struct("Pairing")
                .field("channel_id", channel_id)
                .field("account_id", account_id)
                .finish(),
            Self::Status { .. } => formatter.debug_struct("Status").finish(),
            Self::Snapshot { .. } => formatter.debug_struct("Snapshot").finish(),
        }
    }
}
