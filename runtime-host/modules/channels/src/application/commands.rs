use std::fmt;

use foundation::execution::CommandRoute;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::domain::{
    catalog::ChannelConfigureOutcome,
    control::{ChannelControlAction, ChannelControlOutcome},
    credentials as channel_credentials, delete as channel_delete,
    login::Outcome as ChannelLoginOutcome,
    operations::ChannelKey,
    status::ChannelPairingApprovalOutcome,
};

pub enum ChannelCommand {
    Configure {
        trace: super::trace::CommandTrace,
        key: ChannelKey,
        agent_id: Option<String>,
        values: Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<Result<ChannelConfigureOutcome, ChannelOwnerUnavailable>>,
    },
    Delete {
        trace: super::trace::CommandTrace,
        key: ChannelKey,
        reply: oneshot::Sender<Result<channel_delete::Outcome, ChannelOwnerUnavailable>>,
    },
    LoginStart {
        trace: super::trace::CommandTrace,
        key: ChannelKey,
        force: bool,
        timeout_ms: Option<u64>,
        agent_id: Option<String>,
        config: Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<Result<ChannelLoginOutcome, ChannelOwnerUnavailable>>,
    },
    LoginWait {
        trace: super::trace::CommandTrace,
        key: ChannelKey,
        timeout_ms: Option<u64>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: tokio_util::sync::CancellationToken,
        reply: oneshot::Sender<Result<ChannelLoginOutcome, ChannelOwnerUnavailable>>,
    },
    LoginCancel {
        trace: super::trace::CommandTrace,
        key: ChannelKey,
        reply: oneshot::Sender<Result<ChannelLoginOutcome, ChannelOwnerUnavailable>>,
    },
    Logout {
        trace: super::trace::CommandTrace,
        key: ChannelKey,
        reply: oneshot::Sender<Result<ChannelLoginOutcome, ChannelOwnerUnavailable>>,
    },
    Control {
        trace: super::trace::CommandTrace,
        key: ChannelKey,
        action: ChannelControlAction,
        reply: oneshot::Sender<Result<ChannelControlOutcome, ChannelOwnerUnavailable>>,
    },
    PairingApprove {
        trace: super::trace::CommandTrace,
        key: ChannelKey,
        code: Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<Result<ChannelPairingApprovalOutcome, ChannelOwnerUnavailable>>,
    },
    ValidateCredentials {
        trace: super::trace::CommandTrace,
        key: ChannelKey,
        config: Zeroizing<Vec<u8>>,
        reply: oneshot::Sender<Result<channel_credentials::Outcome, ChannelOwnerUnavailable>>,
    },
}

impl ChannelCommand {
    pub(crate) fn trace(&self) -> Option<&super::trace::CommandTrace> {
        match self {
            Self::Configure { trace, .. } => Some(trace),
            Self::Delete { trace, .. } => Some(trace),
            Self::LoginStart { trace, .. } => Some(trace),
            Self::LoginWait { trace, .. } => Some(trace),
            Self::LoginCancel { trace, .. } => Some(trace),
            Self::Logout { trace, .. } => Some(trace),
            Self::Control { trace, .. } => Some(trace),
            Self::PairingApprove { trace, .. } => Some(trace),
            Self::ValidateCredentials { trace, .. } => Some(trace),
        }
    }

    pub(crate) fn route(&self) -> CommandRoute<ChannelKey> {
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
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChannelOwnerUnavailable;

impl std::fmt::Display for ChannelOwnerUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("channel owner is unavailable")
    }
}

impl std::error::Error for ChannelOwnerUnavailable {}
