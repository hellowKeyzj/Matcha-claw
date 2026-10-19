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
    McpApp { identity: String },
    Question { identity: String, id: String },
}

pub(crate) type PeerGlobalState = ();
pub(crate) type PeerLaneState = ();

#[derive(Default)]
pub(crate) struct MatchaReadyProjection {
    process: Option<foundation::process::ProcessObservation>,
    provider: Option<provider_module::ProviderPrivateProjectionEffect>,
    connector: Option<connectors::ports::ConnectorProjectionEffect>,
    sealed: Option<
        Result<matcha_agent::sealed::ProjectionReceipt, matcha_agent::sealed::ProjectionError>,
    >,
}
