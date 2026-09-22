use tokio::sync::oneshot;

use crate::domain::model::{UsageEntry, UsageReadError};

pub(crate) enum UsageCommand {}

pub(crate) enum UsageQuery {
    Recent {
        limit: usize,
        reply: oneshot::Sender<Result<Vec<UsageEntry>, UsageReadError>>,
    },
    SessionTimeseries {
        agent_id: String,
        session_id: String,
        reply: oneshot::Sender<Result<Vec<UsageEntry>, UsageReadError>>,
    },
    DefaultLimit {
        reply: oneshot::Sender<usize>,
    },
    MaxLimit {
        reply: oneshot::Sender<usize>,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum UsageOwnerKey {}

impl UsageCommand {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<UsageOwnerKey> {
        match *self {}
    }
}

impl UsageQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<UsageOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
