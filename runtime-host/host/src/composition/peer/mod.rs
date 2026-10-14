mod actor;
mod command;
mod handle;
mod matcha;
mod openclaw;
mod ports;
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

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) enum PeerLaneKey {
    Lifecycle(PeerKey),
    McpApp { session_key: String },
    Question { identity: String, id: String },
}

pub(crate) type PeerGlobalState = ();
pub(crate) type PeerLaneState = ();
