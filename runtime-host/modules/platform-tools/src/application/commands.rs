use platform::call::CallContext;
use tokio::sync::oneshot;

use crate::{PlatformToolsCallDetail, PlatformToolsOutcome};

pub(crate) enum PlatformToolsCommand {}

pub(crate) enum PlatformToolsQuery {
    List {
        reply: oneshot::Sender<PlatformToolsOutcome>,
        call: Option<CallContext<PlatformToolsCallDetail>>,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum PlatformToolsOwnerKey {}

impl PlatformToolsCommand {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<PlatformToolsOwnerKey> {
        match *self {}
    }
}

impl PlatformToolsQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<PlatformToolsOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
