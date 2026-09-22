mod actor;
mod command;
mod handle;
mod matcha;
mod openclaw;
mod query;
mod status;

pub(crate) use actor::{PeerOwner, PeerStartupState};
pub(crate) use command::{
    PeerCommand, RestartOpenClawError, RuntimeRestartCommandError, RuntimeStartCommandError,
    RuntimeStopCommandError, StartOpenClawError, StopOpenClawError,
};
pub(crate) use handle::PeerHandle;
pub(crate) use query::PeerQuery;

pub(crate) type PeerKey = platform::endpoint::runtime_address::RuntimeEndpoint;
pub(crate) type PeerGlobalState = ();
pub(crate) type PeerLaneState = ();
