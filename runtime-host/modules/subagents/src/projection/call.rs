use platform::call::{CallDetail, CallStatus};
use serde::Serialize;

use crate::domain::model::{
    Command, ConfigurationReadFailure, NativeEndpoint, Outcome, SkillConfigurationOutcome,
    ToolConfigurationOutcome,
};

/// Audit identifiers and typed outcome labels only; never native content or configuration.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentCallDetail {
    #[serde(skip)]
    operation: &'static str,
    endpoint: &'static str,
    agent_id: Option<String>,
    run_id: Option<String>,
    outcome: Option<&'static str>,
    read_failure: Option<&'static str>,
}

impl CallDetail for SubagentCallDetail {
    const MODULE: &'static str = "subagents";
}

impl SubagentCallDetail {
    pub(crate) fn from_command(command: &Command) -> Self {
        let agent_id = match command {
            Command::Update { input, .. } => Some(input.agent_id.as_str()),
            Command::Delete { input, .. } => Some(input.agent_id.as_str()),
            Command::ListFiles { agent_id, .. }
            | Command::GetFile { agent_id, .. }
            | Command::SetFile { agent_id, .. }
            | Command::SetDescription { agent_id, .. }
            | Command::SetConfigurationModel { agent_id, .. }
            | Command::SetSkills { agent_id, .. }
            | Command::SkillConfiguration { agent_id, .. }
            | Command::SetSkillConfiguration { agent_id, .. }
            | Command::ToolConfiguration { agent_id, .. }
            | Command::SetToolConfiguration { agent_id, .. }
            | Command::ExportPackage { agent_id, .. }
            | Command::ExportCloudPackage { agent_id, .. } => Some(agent_id.as_str()),
            _ => None,
        };
        Self {
            operation: command_name(command),
            endpoint: match command.endpoint() {
                NativeEndpoint::OpenClawLocal => "openclaw:local",
                NativeEndpoint::MatchaAgentLocal => "matcha-agent:local",
            },
            agent_id: agent_id.and_then(safe_id),
            run_id: None,
            outcome: None,
            read_failure: None,
        }
    }

    pub(crate) fn finish(&mut self, outcome: &Outcome) -> CallStatus {
        use CallStatus::{Failed, Rejected, Succeeded, Unknown};
        let (status, label) = match outcome {
            Outcome::Created(_) if self.operation != "subagents.create" => {
                (Unknown, "unexpectedOutcome")
            }
            Outcome::PackageExported(_)
                if !matches!(
                    self.operation,
                    "subagents.package.export" | "subagents.package.exportCloud"
                ) =>
            {
                (Unknown, "unexpectedOutcome")
            }
            Outcome::PackageInstalled(_) if self.operation != "subagents.package.install" => {
                (Unknown, "unexpectedOutcome")
            }
            Outcome::Agents { .. } => (Succeeded, "listed"),
            Outcome::Created(agent) => {
                self.agent_id = safe_id(&agent.agent_id);
                (Succeeded, "created")
            }
            Outcome::WorkspaceInitializationFailed(agent) => {
                self.agent_id = safe_id(&agent.agent_id);
                (Failed, "workspaceInitializationFailed")
            }
            Outcome::Updated(_) => (Succeeded, "updated"),
            Outcome::Deleted(agent) => {
                if agent.succeeded() { (Succeeded, "deleted") }
                else if !agent.native_succeeded() { (Failed, "nativeDeleteFailed") }
                else { (Failed, "sealedPurgeFailed") }
            }
            Outcome::PackageInstallFailed { agent_id, compensation, .. } => {
                self.agent_id = safe_id(agent_id);
                match compensation.outcome {
                    crate::model::CompensationOutcome::Deleted => (Failed, "packageInstallFailedCompensated"),
                    crate::model::CompensationOutcome::OutcomeUnknown => (Unknown, "packageInstallCompensationUnknown"),
                    _ => (Failed, "packageInstallCompensationFailed"),
                }
            }
            Outcome::Files(_) => (Succeeded, "filesListed"),
            Outcome::File(_) => (Succeeded, "fileReturned"),
            Outcome::Configuration(_) => (Succeeded, "configurationRead"),
            Outcome::ConfigurationApplied => (Succeeded, "configurationApplied"),
            Outcome::PackageExported(package) => {
                self.agent_id = safe_id(package.agent_id());
                (Succeeded, "packageExported")
            }
            Outcome::PackageInstalled(package) => {
                self.agent_id = safe_id(package.agent_id());
                (Succeeded, "packageInstalled")
            }
            Outcome::SkillConfiguration(result) => match result {
                SkillConfigurationOutcome::View(_) => (Succeeded, "skillConfigurationRead"),
                SkillConfigurationOutcome::Updated(_) => (Succeeded, "skillConfigurationUpdated"),
                SkillConfigurationOutcome::Stale(_) => (Rejected, "staleRevision"),
                SkillConfigurationOutcome::InvalidSkillKeys { .. } => {
                    (Rejected, "invalidSkillKeys")
                }
                SkillConfigurationOutcome::Unsupported => (Rejected, "unsupported"),
                SkillConfigurationOutcome::Rejected => (Rejected, "rejected"),
                SkillConfigurationOutcome::OutcomeUnknown => (Unknown, "outcomeUnknown"),
                SkillConfigurationOutcome::Unavailable(failure) => {
                    self.read_failure = Some(read_failure(*failure));
                    (Failed, "unavailable")
                }
            },
            Outcome::ToolConfiguration(result) => match result {
                ToolConfigurationOutcome::View(_) => (Succeeded, "toolConfigurationRead"),
                ToolConfigurationOutcome::Updated(_) => (Succeeded, "toolConfigurationUpdated"),
                ToolConfigurationOutcome::Stale(_) => (Rejected, "staleRevision"),
                ToolConfigurationOutcome::InvalidToolKeys(_) => (Rejected, "invalidToolKeys"),
                ToolConfigurationOutcome::Unsupported => (Rejected, "unsupported"),
                ToolConfigurationOutcome::Rejected => (Rejected, "rejected"),
                ToolConfigurationOutcome::OutcomeUnknown => (Unknown, "outcomeUnknown"),
                ToolConfigurationOutcome::Unavailable(failure) => {
                    self.read_failure = Some(read_failure(*failure));
                    (Failed, "unavailable")
                }
            },
            Outcome::Rejected => (Rejected, "rejected"),
            Outcome::Unknown => (Unknown, "outcomeUnknown"),
            Outcome::Unsupported => (Rejected, "unsupported"),
            Outcome::Unavailable => (Failed, "unavailable"),
        };
        self.outcome = Some(label);
        status
    }
}

fn safe_id(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')))
    .then(|| value.to_owned())
}

fn read_failure(failure: ConfigurationReadFailure) -> &'static str {
    match failure {
        ConfigurationReadFailure::Unavailable => "unavailable",
        ConfigurationReadFailure::Rejected => "rejected",
        ConfigurationReadFailure::Protocol => "protocol",
    }
}

pub(crate) fn command_name(command: &Command) -> &'static str {
    match command {
        Command::List { .. } => "subagents.list",
        Command::Create { .. } => "subagents.create",
        Command::Update { .. } => "subagents.update",
        Command::Delete { .. } => "subagents.delete",
        Command::ListFiles { .. } => "subagents.files.list",
        Command::GetFile { .. } => "subagents.files.get",
        Command::SetFile { .. } => "subagents.files.set",
        Command::DisplayConfiguration { .. } => "subagents.displayConfig.get",
        Command::SetDescription { .. } => "subagents.description.set",
        Command::SetConfigurationModel { .. } => "subagents.model.set",
        Command::SetSkills { .. } => "subagents.skills.set",
        Command::SkillConfiguration { .. } => "subagentSkills.get",
        Command::SetSkillConfiguration { .. } => "subagentSkills.set",
        Command::ToolConfiguration { .. } => "subagentTools.get",
        Command::SetToolConfiguration { .. } => "subagentTools.set",
        Command::ExportPackage { .. } => "subagents.package.export",
        Command::ExportCloudPackage { .. } => "subagents.package.exportCloud",
        Command::InstallPackage { .. } => "subagents.package.install",
    }
}
