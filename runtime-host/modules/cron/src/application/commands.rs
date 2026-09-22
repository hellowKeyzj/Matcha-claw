use foundation::execution::{CommandRoute, QueryRoute};
use tokio::sync::oneshot;

use crate::model::{
    CronCreateCommand, CronDeleteCommand, CronDeleteOutcome, CronHistoryCommand,
    CronHistoryOutcome, CronJobMutationOutcome, CronListOutcome, CronTriggerResult,
    CronUpdateCommand,
};
use crate::ports::CronRequestAdmissionClosed;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum CronOwnerKey {}

pub(crate) enum CronCommand {
    Create {
        command: CronCreateCommand,
        reply: oneshot::Sender<CronJobMutationOutcome>,
    },
    Update {
        command: CronUpdateCommand,
        reply: oneshot::Sender<CronJobMutationOutcome>,
    },
    Delete {
        command: CronDeleteCommand,
        reply: oneshot::Sender<CronDeleteOutcome>,
    },
    Trigger {
        job_id: String,
        reply: oneshot::Sender<Result<CronTriggerResult, CronRequestAdmissionClosed>>,
    },
    CancelOperations {
        reply: oneshot::Sender<()>,
    },
}

pub(crate) enum CronQuery {
    List {
        reply: oneshot::Sender<CronListOutcome>,
    },
    LoadHistory {
        command: CronHistoryCommand,
        reply: oneshot::Sender<CronHistoryOutcome>,
    },
}

impl CronCommand {
    pub(crate) fn route(&self) -> CommandRoute<CronOwnerKey> {
        match self {
            Self::Create { .. }
            | Self::Update { .. }
            | Self::Delete { .. }
            | Self::Trigger { .. }
            | Self::CancelOperations { .. } => CommandRoute::Global,
        }
    }
}

impl CronQuery {
    pub(crate) fn route(&self) -> QueryRoute<CronOwnerKey> {
        match self {
            Self::List { .. } | Self::LoadHistory { .. } => QueryRoute::Global,
        }
    }
}
