use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use platform::call::CallId;

use crate::domain::model::{Command, NativeEndpoint, Outcome};
use crate::projection::{
    call::command_name,
    public::{Delivery, map_outcome},
};

const CAPACITY: usize = 16;
const RETENTION: Duration = Duration::from_secs(600);
const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
// 256 KiB sealed package, base64 expansion and export metadata.
const EXPORT_RESULT_BUDGET: usize = 512 * 1024;

/// Only this module's admitted mutations can populate the result boundary.
#[derive(Clone)]
pub(crate) enum MutationResult {
    Created(crate::model::AgentCreated),
    WorkspaceInitializationFailed(crate::model::AgentCreated),
    Updated(crate::model::AgentUpdated),
    Deleted(crate::model::AgentDeleted),
    ConfigurationApplied,
    SkillConfiguration(crate::model::SkillConfigurationOutcome),
    ToolConfiguration(crate::model::ToolConfigurationOutcome),
    PackageExported(crate::model::PackageExportReceipt),
    PackageInstalled(crate::model::PackageInstallReceipt),
    PackageInstallFailed {
        agent_id: String,
        failure: crate::model::PackageInstallFailure,
        compensation: crate::model::InstallCompensation,
    },
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
}

impl MutationResult {
    pub(crate) fn from_outcome(outcome: Outcome) -> Self {
        match outcome {
            Outcome::Created(value) => Self::Created(value),
            Outcome::WorkspaceInitializationFailed(value) => {
                Self::WorkspaceInitializationFailed(value)
            }
            Outcome::Updated(value) => Self::Updated(value),
            Outcome::Deleted(value) => Self::Deleted(value),
            Outcome::ConfigurationApplied => Self::ConfigurationApplied,
            Outcome::SkillConfiguration(value) => Self::SkillConfiguration(value),
            Outcome::ToolConfiguration(value) => Self::ToolConfiguration(value),
            Outcome::PackageExported(value) => Self::PackageExported(value),
            Outcome::PackageInstalled(value) => Self::PackageInstalled(value),
            Outcome::PackageInstallFailed {
                agent_id,
                failure,
                compensation,
            } => Self::PackageInstallFailed {
                agent_id,
                failure,
                compensation,
            },
            Outcome::Rejected => Self::Rejected,
            Outcome::Unsupported => Self::Unsupported,
            Outcome::Unavailable => Self::Unavailable,
            _ => Self::Unknown,
        }
    }

    pub(crate) fn delivery(&self) -> Delivery {
        map_outcome(match self.clone() {
            Self::Created(value) => Outcome::Created(value),
            Self::WorkspaceInitializationFailed(value) => {
                Outcome::WorkspaceInitializationFailed(value)
            }
            Self::Updated(value) => Outcome::Updated(value),
            Self::Deleted(value) => Outcome::Deleted(value),
            Self::ConfigurationApplied => Outcome::ConfigurationApplied,
            Self::SkillConfiguration(value) => Outcome::SkillConfiguration(value),
            Self::ToolConfiguration(value) => Outcome::ToolConfiguration(value),
            Self::PackageExported(value) => Outcome::PackageExported(value),
            Self::PackageInstalled(value) => Outcome::PackageInstalled(value),
            Self::PackageInstallFailed {
                agent_id,
                failure,
                compensation,
            } => Outcome::PackageInstallFailed {
                agent_id,
                failure,
                compensation,
            },
            Self::Rejected => Outcome::Rejected,
            Self::Unknown => Outcome::Unknown,
            Self::Unsupported => Outcome::Unsupported,
            Self::Unavailable => Outcome::Unavailable,
        })
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct ResultSubject {
    pub(crate) principal: String,
    pub(crate) operation: String,
    pub(crate) endpoint: NativeEndpoint,
    pub(crate) agent_id: Option<String>,
}

impl ResultSubject {
    pub(crate) fn from_command(command: &Command, principal: String) -> Self {
        let agent_id = match command {
            Command::Update { input, .. } => Some(input.agent_id.clone()),
            Command::Delete { input, .. } => Some(input.agent_id.clone()),
            Command::SetDescription { agent_id, .. }
            | Command::SetConfigurationModel { agent_id, .. }
            | Command::SetSkills { agent_id, .. }
            | Command::SetSkillConfiguration { agent_id, .. }
            | Command::SetToolConfiguration { agent_id, .. }
            | Command::ExportPackage { agent_id, .. }
            | Command::ExportCloudPackage { agent_id, .. } => Some(agent_id.clone()),
            _ => None,
        };
        Self {
            principal,
            operation: command_name(command).into(),
            endpoint: command.endpoint(),
            agent_id,
        }
    }
}

struct Entry {
    subject: ResultSubject,
    budget: usize,
    completed: Option<(Instant, Arc<MutationResult>)>,
}

#[derive(Clone, Default)]
pub(crate) struct MutationResults(Arc<Mutex<HashMap<CallId, Entry>>>);

pub(crate) enum ResultRead {
    Missing,
    Pending,
    Completed(Arc<MutationResult>),
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
        let budget = if matches!(
            subject.operation.as_str(),
            "subagents.package.export" | "subagents.package.exportCloud"
        ) {
            EXPORT_RESULT_BUDGET
        } else {
            0
        };
        if entries.len() >= CAPACITY
            || entries.values().map(|entry| entry.budget).sum::<usize>() + budget > MAX_RESULT_BYTES
        {
            return Err(());
        }
        entries.insert(
            id,
            Entry {
                subject,
                budget,
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

    pub(crate) fn complete(&self, id: &CallId, outcome: Outcome) {
        if let Ok(mut entries) = self.0.lock() {
            if let Some(entry) = entries.get_mut(id) {
                entry.completed = Some((
                    Instant::now(),
                    Arc::new(MutationResult::from_outcome(outcome)),
                ));
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
            Some((_, result)) => ResultRead::Completed(Arc::clone(result)),
            None => ResultRead::Pending,
        }
    }
}

pub(crate) fn is_background_mutation(command: &Command) -> bool {
    matches!(
        command,
        Command::Create { .. }
            | Command::Update { .. }
            | Command::Delete { .. }
            | Command::SetDescription { .. }
            | Command::SetConfigurationModel { .. }
            | Command::SetSkills { .. }
            | Command::SetSkillConfiguration { .. }
            | Command::SetToolConfiguration { .. }
            | Command::InstallPackage { .. }
            | Command::ExportPackage { .. }
            | Command::ExportCloudPackage { .. }
    )
}
