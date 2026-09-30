use std::sync::Arc;

use platform::call::{CallLogError, CallReceipt};
use runtime_directory::call::RuntimeControlCallContext;
use tokio::sync::{OnceCell, oneshot};

use foundation::execution::CommandRoute;

use crate::{RuntimeState, composition::runtime_ports::RuntimeDriverIdentity};

use super::PeerKey;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeStartCommandError {
    RuntimeStart(crate::RuntimeStartFailure),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeStopCommandError {
    AdmissionClosed,
    RuntimeStop(crate::RuntimeLifecycleFailure),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeRestartCommandError {
    RuntimeRestart(crate::RuntimeLifecycleFailure),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AutostartOpenClawError {
    PeerUnavailable,
    RuntimeStart,
}

#[derive(Clone)]
pub(crate) struct RuntimeLifecycleCall {
    pub(super) context: RuntimeControlCallContext,
    admission: Arc<OnceCell<Result<CallReceipt, CallLogError>>>,
}

impl RuntimeLifecycleCall {
    pub(super) fn new(context: RuntimeControlCallContext) -> Self {
        Self {
            context,
            admission: Arc::new(OnceCell::new()),
        }
    }

    pub(super) async fn accepted(&self) -> Result<CallReceipt, CallLogError> {
        // The queued owner shares admission and can finish it after the HTTP waiter drops.
        self.admission
            .get_or_init(|| self.context.accepted())
            .await
            .clone()
    }
}

pub(crate) enum PeerCommand {
    AutostartMatcha,
    AutostartOpenClaw {
        reply: oneshot::Sender<Result<RuntimeState, AutostartOpenClawError>>,
    },
    StartRuntime {
        endpoint: PeerKey,
        call: RuntimeLifecycleCall,
    },
    StopRuntime {
        endpoint: PeerKey,
        call: Option<RuntimeLifecycleCall>,
        reply: Option<oneshot::Sender<Result<RuntimeState, RuntimeStopCommandError>>>,
    },
    RestartRuntime {
        endpoint: PeerKey,
        call: RuntimeLifecycleCall,
    },
    RestartOpenClawAfterPluginChange {
        reply: oneshot::Sender<Result<RuntimeState, RuntimeRestartCommandError>>,
    },
}

impl PeerCommand {
    pub(crate) fn route_command(&self) -> CommandRoute<PeerKey> {
        match self {
            Self::AutostartMatcha => {
                CommandRoute::Keyed(RuntimeDriverIdentity::matcha_agent().endpoint())
            }
            Self::AutostartOpenClaw { .. } | Self::RestartOpenClawAfterPluginChange { .. } => {
                CommandRoute::Keyed(RuntimeDriverIdentity::open_claw().endpoint())
            }
            Self::StartRuntime { endpoint, .. }
            | Self::StopRuntime { endpoint, .. }
            | Self::RestartRuntime { endpoint, .. } => CommandRoute::Keyed(endpoint.clone()),
        }
    }
}
