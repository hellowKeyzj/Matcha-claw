use tokio::sync::oneshot;

use foundation::execution::CommandRoute;

use crate::{RuntimeState, runtime_driver::RuntimeDriverIdentity};

use super::PeerKey;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StartMatchaError {
    AdmissionClosed,
    RuntimeStart,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StopMatchaError {
    AdmissionClosed,
    RuntimeStop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RestartMatchaError {
    AdmissionClosed,
    RuntimeRestart,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StartOpenClawError {
    AdmissionClosed,
    RuntimeStart,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StopOpenClawError {
    AdmissionClosed,
    RuntimeStop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RestartOpenClawError {
    AdmissionClosed,
    RuntimeRestart,
}

pub(crate) enum PeerCommand {
    AutostartMatcha,
    AutostartOpenClaw,
    StartMatcha {
        reply: oneshot::Sender<Result<RuntimeState, StartMatchaError>>,
    },
    StopMatcha {
        reply: oneshot::Sender<Result<RuntimeState, StopMatchaError>>,
    },
    RestartMatcha {
        reply: oneshot::Sender<Result<RuntimeState, RestartMatchaError>>,
    },
    StartOpenClaw {
        reply: oneshot::Sender<Result<RuntimeState, StartOpenClawError>>,
    },
    StopOpenClaw {
        reply: oneshot::Sender<Result<RuntimeState, StopOpenClawError>>,
    },
    RestartOpenClaw {
        reply: oneshot::Sender<Result<RuntimeState, RestartOpenClawError>>,
    },
}

impl PeerCommand {
    pub(crate) fn route_command(&self) -> CommandRoute<PeerKey> {
        match self {
            Self::AutostartMatcha
            | Self::StartMatcha { .. }
            | Self::StopMatcha { .. }
            | Self::RestartMatcha { .. } => {
                CommandRoute::Keyed(RuntimeDriverIdentity::matcha_agent().endpoint())
            }
            Self::AutostartOpenClaw
            | Self::StartOpenClaw { .. }
            | Self::StopOpenClaw { .. }
            | Self::RestartOpenClaw { .. } => {
                CommandRoute::Keyed(RuntimeDriverIdentity::open_claw().endpoint())
            }
        }
    }
}
