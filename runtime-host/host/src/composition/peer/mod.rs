mod actor;
mod command;
mod handle;
mod matcha;
mod openclaw;
mod query;
mod status;

pub(crate) use actor::{PeerOwner, PeerStartupState};
pub(crate) use command::{
    AutostartOpenClawError, PeerCommand, RuntimeRestartCommandError, RuntimeStartCommandError,
    RuntimeStopCommandError,
};
pub(crate) use handle::PeerHandle;
pub(crate) use query::PeerQuery;

pub(crate) type PeerKey = platform::endpoint::runtime_address::RuntimeEndpoint;
pub(crate) type PeerGlobalState = ();
pub(crate) type PeerLaneState = ();
