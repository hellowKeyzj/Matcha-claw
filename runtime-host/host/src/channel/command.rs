use std::fmt;

use foundation::execution::{CommandRoute, QueryRoute};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use super::{
    ChannelKey,
    catalog::{ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome},
    config_read as channel_config_read,
    control::{ChannelControlAction, ChannelControlOutcome},
    credentials as channel_credentials, delete as channel_delete,
    login::Outcome as ChannelLoginOutcome,
    status::{
        ChannelPairingApprovalOutcome, ChannelPairingOutcome, ChannelSnapshotOutcome,
        ChannelStatusFailure, ChannelStatusOutcome,
    },
};

pub(crate) enum ChannelCommand {
    Configure {
        key: ChannelKey,
        values: Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<Result<ChannelConfigureOutcome, ChannelOwnerUnavailable>>,
    },
    Delete {
        key: ChannelKey,
        reply: oneshot::Sender<Result<channel_delete::Outcome, ChannelOwnerUnavailable>>,
    },
    LoginStart {
        key: ChannelKey,
        force: bool,
        timeout_ms: Option<u64>,
        config: Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<Result<ChannelLoginOutcome, ChannelOwnerUnavailable>>,
    },
    LoginWait {
        key: ChannelKey,
        timeout_ms: Option<u64>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: tokio_util::sync::CancellationToken,
        reply: oneshot::Sender<Result<ChannelLoginOutcome, ChannelOwnerUnavailable>>,
    },
    LoginCancel {
        key: ChannelKey,
        reply: oneshot::Sender<Result<ChannelLoginOutcome, ChannelOwnerUnavailable>>,
    },
    Logout {
        key: ChannelKey,
        reply: oneshot::Sender<Result<ChannelLoginOutcome, ChannelOwnerUnavailable>>,
    },
    Control {
        key: ChannelKey,
        action: ChannelControlAction,
        reply: oneshot::Sender<Result<ChannelControlOutcome, ChannelOwnerUnavailable>>,
    },
    PairingApprove {
        key: ChannelKey,
        code: Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<Result<ChannelPairingApprovalOutcome, ChannelOwnerUnavailable>>,
    },
    ValidateCredentials {
        key: ChannelKey,
        config: Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<Result<channel_credentials::Outcome, ChannelOwnerUnavailable>>,
    },
    Shutdown(oneshot::Sender<()>),
}

pub(crate) enum ChannelQuery {
    Catalog {
        reply: oneshot::Sender<ChannelCatalogOutcome>,
    },
    ConfigRead {
        channel_id: String,
        account_id: Option<String>,
        reply: oneshot::Sender<channel_config_read::Outcome>,
    },
    ConfigureForm {
        channel_id: String,
        reply: oneshot::Sender<ChannelConfigureFormOutcome>,
    },
    Pairing {
        channel_id: String,
        account_id: Option<String>,
        reply: oneshot::Sender<ChannelPairingOutcome>,
    },
    Status {
        reply: oneshot::Sender<Result<ChannelStatusOutcome, ChannelStatusFailure>>,
    },
    Snapshot {
        reply: oneshot::Sender<Result<ChannelSnapshotOutcome, ChannelStatusFailure>>,
    },
}

impl ChannelCommand {
    pub(super) fn route(&self) -> CommandRoute<ChannelKey> {
        match self {
            Self::Configure { key, .. }
            | Self::Delete { key, .. }
            | Self::Logout { key, .. }
            | Self::Control { key, .. }
            | Self::PairingApprove { key, .. }
            | Self::ValidateCredentials { key, .. } => CommandRoute::Keyed(key.clone()),
            Self::LoginStart { key, .. }
            | Self::LoginWait { key, .. }
            | Self::LoginCancel { key, .. } => CommandRoute::Keyed(key.channel_scope()),
            Self::Shutdown(_) => CommandRoute::Shutdown,
        }
    }
}

impl ChannelQuery {
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

impl fmt::Debug for ChannelCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configure { key, .. } => formatter
                .debug_struct("Configure")
                .field("key", key)
                .finish_non_exhaustive(),
            Self::Delete { key, .. } => formatter.debug_struct("Delete").field("key", key).finish(),
            Self::LoginStart {
                key,
                force,
                timeout_ms,
                ..
            } => formatter
                .debug_struct("LoginStart")
                .field("key", key)
                .field("force", force)
                .field("timeout_ms", timeout_ms)
                .finish_non_exhaustive(),
            Self::LoginWait {
                key, timeout_ms, ..
            } => formatter
                .debug_struct("LoginWait")
                .field("key", key)
                .field("timeout_ms", timeout_ms)
                .finish_non_exhaustive(),
            Self::LoginCancel { key, .. } => formatter
                .debug_struct("LoginCancel")
                .field("key", key)
                .finish(),
            Self::Logout { key, .. } => formatter.debug_struct("Logout").field("key", key).finish(),
            Self::Control { key, action, .. } => formatter
                .debug_struct("Control")
                .field("key", key)
                .field("action", action)
                .finish(),
            Self::PairingApprove { key, .. } => formatter
                .debug_struct("PairingApprove")
                .field("key", key)
                .finish_non_exhaustive(),
            Self::ValidateCredentials { key, .. } => formatter
                .debug_struct("ValidateCredentials")
                .field("key", key)
                .finish_non_exhaustive(),
            Self::Shutdown(_) => formatter.debug_struct("Shutdown").finish_non_exhaustive(),
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ChannelOwnerUnavailable;

impl std::fmt::Display for ChannelOwnerUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("channel owner is unavailable")
    }
}

impl std::error::Error for ChannelOwnerUnavailable {}
