use tokio::sync::oneshot;

use crate::PlatformToolsOutcome;

pub(crate) enum PlatformToolsCommand {}

pub(crate) enum PlatformToolsQuery {
    List {
        reply: oneshot::Sender<PlatformToolsOutcome>,
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
