use tokio::sync::oneshot;

use foundation::execution::CommandRoute;

use crate::{RuntimeState, composition::runtime_ports::RuntimeDriverIdentity};

use super::PeerKey;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeStartCommandError {
    AdmissionClosed,
    RuntimeStart,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeStopCommandError {
    AdmissionClosed,
    RuntimeStop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeRestartCommandError {
    AdmissionClosed,
    RuntimeRestart,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AutostartOpenClawError {
    PeerUnavailable,
    RuntimeStart,
}

pub(crate) enum PeerCommand {
    AutostartMatcha,
    AutostartOpenClaw {
        reply: oneshot::Sender<Result<RuntimeState, AutostartOpenClawError>>,
    },
    StartRuntime {
        endpoint: PeerKey,
        reply: oneshot::Sender<Result<RuntimeState, RuntimeStartCommandError>>,
    },
    StopRuntime {
        endpoint: PeerKey,
        reply: oneshot::Sender<Result<RuntimeState, RuntimeStopCommandError>>,
    },
    RestartRuntime {
        endpoint: PeerKey,
        reply: oneshot::Sender<Result<RuntimeState, RuntimeRestartCommandError>>,
    },
}

impl PeerCommand {
    pub(crate) fn route_command(&self) -> CommandRoute<PeerKey> {
        match self {
            Self::AutostartMatcha => {
                CommandRoute::Keyed(RuntimeDriverIdentity::matcha_agent().endpoint())
            }
            Self::AutostartOpenClaw { .. } => {
                CommandRoute::Keyed(RuntimeDriverIdentity::open_claw().endpoint())
            }
            Self::StartRuntime { endpoint, .. }
            | Self::StopRuntime { endpoint, .. }
            | Self::RestartRuntime { endpoint, .. } => CommandRoute::Keyed(endpoint.clone()),
        }
    }
}
