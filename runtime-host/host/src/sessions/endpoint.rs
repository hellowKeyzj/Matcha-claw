use platform::endpoint::runtime_address::RuntimeEndpoint;

use crate::{runtime::driver::RuntimeDriverIdentity, sessions::state::SessionProvider};

const RUNTIME_KIND: &str = "native-runtime";

/// Native runtime endpoint named by a renderer session request.
///
/// Transport decoders admit any well-formed `native-runtime` address and leave the choice between
/// a Host-owned peer and an unknown one to the session layer, so an unsupported adapter keeps its
/// own outcome instead of failing decode.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeEndpoint {
    OpenClawLocal,
    MatchaAgentLocal,
    Unsupported,
}

impl NativeEndpoint {
    pub(crate) fn parse(
        kind: &str,
        runtime_adapter_id: &str,
        runtime_instance_id: &str,
    ) -> Option<Self> {
        if kind != RUNTIME_KIND {
            return None;
        }
        RuntimeEndpoint::try_new(runtime_adapter_id, runtime_instance_id)
            .ok()
            .map(Self::from_runtime_endpoint)
    }

    pub(crate) fn from_runtime_endpoint(endpoint: RuntimeEndpoint) -> Self {
        if endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
            Self::OpenClawLocal
        } else if endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
            Self::MatchaAgentLocal
        } else {
            Self::Unsupported
        }
    }

    /// The session lane an endpoint-bound command is routed to. An unknown endpoint shares the
    /// OpenClaw lane because routing must stay total; its command is rejected there by outcome.
    pub(crate) const fn provider(self) -> SessionProvider {
        match self {
            Self::OpenClawLocal | Self::Unsupported => SessionProvider::OpenClaw,
            Self::MatchaAgentLocal => SessionProvider::MatchaAgent,
        }
    }

    /// The Host runtime endpoint this address names, or `None` when no Host runtime owns it.
    pub(crate) fn runtime_endpoint(self) -> Option<RuntimeEndpoint> {
        match self {
            Self::OpenClawLocal => Some(RuntimeDriverIdentity::open_claw().endpoint()),
            Self::MatchaAgentLocal => Some(RuntimeDriverIdentity::matcha_agent().endpoint()),
            Self::Unsupported => None,
        }
    }
}
