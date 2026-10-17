use foundation::execution::{CommandRoute, QueryRoute};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use tokio::sync::oneshot;

use crate::model::{
    CronCreateCommand, CronDeleteCommand, CronHistoryCommand, CronHistoryOutcome, CronListOutcome,
    CronTriggerResult, CronUpdateCommand,
};
use crate::{call::CronCall, ports::CronRequestAdmissionClosed};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum CronOwnerKey {
    Job(String, String),
}

pub(crate) enum MutationCommand {
    Create(CronCreateCommand),
    Update(CronUpdateCommand),
    Delete(CronDeleteCommand),
}

impl MutationCommand {
    pub(crate) fn kind(&self) -> super::results::MutationKind {
        match self {
            Self::Create(_) => super::results::MutationKind::Create,
            Self::Update(_) => super::results::MutationKind::Update,
            Self::Delete(_) => super::results::MutationKind::Delete,
        }
    }

    pub(crate) fn job_id(&self) -> Option<&str> {
        match self {
            Self::Create(_) => None,
            Self::Update(command) => Some(&command.job_id),
            Self::Delete(command) => Some(&command.job_id),
        }
    }

    pub(crate) fn detail(&self) -> crate::call::CronCallDetail {
        let mut detail = self
            .job_id()
            .map(crate::call::CronCallDetail::job)
            .unwrap_or_default();
        match self {
            Self::Create(command) => {
                detail.schedule_kind = Some((&command.schedule).into());
                detail.enabled = Some(command.enabled);
            }
            Self::Update(command) => {
                detail.schedule_kind = command.schedule.as_ref().map(Into::into);
                detail.enabled = command.enabled;
            }
            Self::Delete(_) => {}
        }
        detail
    }
}

pub(crate) enum CronCommand {
    Mutate {
        endpoint: RuntimeEndpoint,
        command: MutationCommand,
        call: CronCall,
    },
    Trigger {
        endpoint: RuntimeEndpoint,
        job_id: String,
        call: Option<CronCall>,
        reply: oneshot::Sender<Result<CronTriggerResult, CronRequestAdmissionClosed>>,
    },
    CancelOperations {
        reply: oneshot::Sender<()>,
    },
}

pub(crate) enum CronQuery {
    List {
        endpoint: RuntimeEndpoint,
        call: Option<CronCall>,
        reply: oneshot::Sender<CronListOutcome>,
    },
    LoadHistory {
        endpoint: RuntimeEndpoint,
        command: CronHistoryCommand,
        call: Option<CronCall>,
        reply: oneshot::Sender<CronHistoryOutcome>,
    },
}

impl CronCommand {
    pub(crate) fn route(&self) -> CommandRoute<CronOwnerKey> {
        match self {
            Self::Mutate {
                endpoint, command, ..
            } => match command.job_id() {
                Some(job_id) => CommandRoute::Keyed(CronOwnerKey::Job(
                    endpoint.canonical_key(),
                    job_id.to_owned(),
                )),
                None => CommandRoute::Exclusive,
            },
            Self::Trigger {
                endpoint, job_id, ..
            } => CommandRoute::Keyed(CronOwnerKey::Job(endpoint.canonical_key(), job_id.clone())),
            Self::CancelOperations { .. } => CommandRoute::Exclusive,
        }
    }
}

impl CronQuery {
    pub(crate) fn route(&self) -> QueryRoute<CronOwnerKey> {
        match self {
            Self::List { .. } => QueryRoute::Exclusive,
            Self::LoadHistory {
                endpoint, command, ..
            } => QueryRoute::Keyed(CronOwnerKey::Job(
                endpoint.canonical_key(),
                command.job_id().to_owned(),
            )),
        }
    }
}
