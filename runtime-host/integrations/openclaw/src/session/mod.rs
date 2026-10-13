pub(crate) mod adapters;
pub mod assembler;
pub(crate) mod event_router;
pub mod events;
pub mod facts;
pub(crate) mod goal;
pub(crate) mod ingest;
pub mod operation;
pub mod projection;
pub mod protocol;
pub(crate) mod reducer;
mod body;
pub mod replay;
pub(crate) mod trace;
pub mod window;

use platform::endpoint::runtime_address::RuntimeEndpoint;

pub use projection::CanonicalIngressResult;
pub use replay::{
    CanonicalSessionReplay, SessionReplayError, SessionReplaySourceError, SessionReplaySourcePage,
    SessionReplaySourceRow, SessionReplaySourceSkip, SessionReplaySourceSkipReason,
    load_session_replay_source, materialize_session_replay, materialize_session_replay_rows,
};

pub fn session_ownership_key(
    endpoint: RuntimeEndpoint,
    agent_id: &str,
    session_key: &str,
    _endpoint_session_id: &str,
) -> (RuntimeEndpoint, Option<String>, String) {
    (endpoint, Some(agent_id.to_owned()), session_key.to_owned())
}
