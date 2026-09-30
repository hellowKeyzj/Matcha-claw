use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use platform::call::{CallId, CallStatus};
use serde::Deserialize;

use crate::{
    call::{CronCallDetail, Outcome, safe_id},
    model::{CronDeleteOutcome, CronJobMutationOutcome},
    projection::JobResponse,
};

const CAPACITY: usize = 16;
const RETENTION: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MutationKind {
    Create,
    Update,
    Delete,
}

impl MutationKind {
    pub(crate) const fn command(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct ResultSubject {
    pub(crate) principal: String,
    pub(crate) command: MutationKind,
    pub(crate) job_id: Option<String>,
}

#[derive(Clone)]
pub(crate) enum MutationResult {
    Job { id: String, job: Box<JobResponse> },
    Removed(bool),
    Rejected,
    Unknown,
    Unavailable,
}

impl MutationResult {
    pub(crate) fn job(outcome: CronJobMutationOutcome) -> Self {
        match outcome {
            CronJobMutationOutcome::Applied(job) => {
                let id = job.id.clone();
                match JobResponse::try_from(*job) {
                    Ok(job) => Self::Job {
                        id,
                        job: Box::new(job),
                    },
                    Err(_) => Self::Unknown,
                }
            }
            CronJobMutationOutcome::Rejected => Self::Rejected,
            CronJobMutationOutcome::OutcomeUnknown => Self::Unknown,
            CronJobMutationOutcome::Unavailable => Self::Unavailable,
        }
    }

    pub(crate) fn deleted(outcome: CronDeleteOutcome) -> Self {
        match outcome {
            CronDeleteOutcome::Applied(receipt) => Self::Removed(receipt.removed),
            CronDeleteOutcome::Rejected => Self::Rejected,
            CronDeleteOutcome::OutcomeUnknown => Self::Unknown,
            CronDeleteOutcome::Unavailable => Self::Unavailable,
        }
    }

    pub(crate) fn finish_detail(&self, detail: &mut CronCallDetail) -> (CallStatus, Outcome) {
        match self {
            Self::Job { id, .. } => {
                detail.job_id = safe_id(id);
                (CallStatus::Succeeded, Outcome::Applied)
            }
            Self::Removed(removed) => {
                detail.removed = Some(*removed);
                (CallStatus::Succeeded, Outcome::Applied)
            }
            Self::Rejected => (CallStatus::Rejected, Outcome::Rejected),
            Self::Unknown => (CallStatus::Unknown, Outcome::OutcomeUnknown),
            Self::Unavailable => (CallStatus::Failed, Outcome::Unavailable),
        }
    }
}

struct Entry {
    subject: ResultSubject,
    completed: Option<(Instant, MutationResult)>,
}

#[derive(Clone, Default)]
pub(crate) struct MutationResults(Arc<Mutex<HashMap<CallId, Entry>>>);

pub(crate) enum ResultRead {
    Missing,
    Pending,
    Completed(MutationResult),
}

impl MutationResults {
    pub(crate) fn reserve(&self, id: CallId, subject: ResultSubject) -> Result<(), ()> {
        let mut entries = self.0.lock().map_err(|_| ())?;
        entries.retain(|_, entry| {
            entry
                .completed
                .as_ref()
                .is_none_or(|(at, _)| at.elapsed() < RETENTION)
        });
        if entries.len() >= CAPACITY {
            return Err(());
        }
        entries.insert(
            id,
            Entry {
                subject,
                completed: None,
            },
        );
        Ok(())
    }

    pub(crate) fn remove(&self, id: &CallId) {
        if let Ok(mut entries) = self.0.lock() {
            entries.remove(id);
        }
    }

    pub(crate) fn complete(&self, id: &CallId, result: MutationResult) {
        if let Ok(mut entries) = self.0.lock() {
            if let Some(entry) = entries.get_mut(id) {
                entry.completed = Some((Instant::now(), result));
            }
        }
    }

    pub(crate) fn read(&self, id: &CallId, subject: &ResultSubject) -> ResultRead {
        let Ok(mut entries) = self.0.lock() else {
            return ResultRead::Missing;
        };
        entries.retain(|_, entry| {
            entry
                .completed
                .as_ref()
                .is_none_or(|(at, _)| at.elapsed() < RETENTION)
        });
        let Some(entry) = entries.get(id).filter(|entry| &entry.subject == subject) else {
            return ResultRead::Missing;
        };
        match &entry.completed {
            Some((_, result)) => ResultRead::Completed(result.clone()),
            None => ResultRead::Pending,
        }
    }
}
