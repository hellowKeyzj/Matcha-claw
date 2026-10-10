use std::sync::Arc;

use platform::call::{CallLogError, CallReceipt};
use runtime_directory::call::RuntimeControlCallContext;
use tokio::sync::{OnceCell, OwnedMutexGuard, oneshot};

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
        reservation: Option<OwnedMutexGuard<()>>,
        reply: oneshot::Sender<Result<RuntimeState, AutostartOpenClawError>>,
    },
    StartRuntime {
        reservation: Option<OwnedMutexGuard<()>>,
        endpoint: PeerKey,
        call: RuntimeLifecycleCall,
    },
    StopRuntime {
        reservation: Option<OwnedMutexGuard<()>>,
        endpoint: PeerKey,
        call: Option<RuntimeLifecycleCall>,
        reply: Option<oneshot::Sender<Result<RuntimeState, RuntimeStopCommandError>>>,
    },
    RestartRuntime {
        reservation: Option<OwnedMutexGuard<()>>,
        endpoint: PeerKey,
        call: RuntimeLifecycleCall,
    },
    RepairRuntime {
        endpoint: PeerKey,
        call: RuntimeLifecycleCall,
        reservation: Option<OwnedMutexGuard<()>>,
    },
    RestartOpenClawAfterPluginChange {
        reservation: Option<OwnedMutexGuard<()>>,
        reply: oneshot::Sender<Result<RuntimeState, RuntimeRestartCommandError>>,
    },
}

impl PeerCommand {
    pub(super) fn reserve_lifecycle(&mut self, driver: &openclaw::driver::OpenClawDriver) -> bool {
        if !matches!(self.route_command(), CommandRoute::Keyed(key) if key == RuntimeDriverIdentity::open_claw().endpoint()) {
            return true;
        }
        let Some(permit) = driver.try_reserve_lifecycle() else {
            return false;
        };
        let reservation = match self {
            Self::AutostartOpenClaw { reservation, .. }
            | Self::StartRuntime { reservation, .. }
            | Self::StopRuntime { reservation, .. }
            | Self::RestartRuntime { reservation, .. }
            | Self::RepairRuntime { reservation, .. }
            | Self::RestartOpenClawAfterPluginChange { reservation, .. } => reservation,
            Self::AutostartMatcha => unreachable!("Matcha has no OpenClaw reservation"),
        };
        *reservation = Some(permit);
        true
    }

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
            | Self::RestartRuntime { endpoint, .. }
            | Self::RepairRuntime { endpoint, .. } => CommandRoute::Keyed(endpoint.clone()),
        }
    }
}
