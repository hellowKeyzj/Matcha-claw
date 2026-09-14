use std::{fmt, path::Path};

use crate::workspace::replace_regular_file;

mod context;
mod directory;
#[cfg(any(test, feature = "test-support"))]
mod fixture;
mod identity;

pub use context::ContextMerge;
pub use directory::{
    AgentWorkspaceDirectory, MatchaWorkspaceTemplateDirectory, WorkspaceContextDirectory,
};
#[cfg(any(test, feature = "test-support"))]
pub use fixture::WorkspaceProjectionFixture;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceTemplateFile {
    Agents,
    Soul,
    Identity,
    User,
    Heartbeat,
    Bootstrap,
}

impl WorkspaceTemplateFile {
    const MAIN_AGENT: [Self; 5] = [
        Self::Agents,
        Self::Soul,
        Self::Identity,
        Self::User,
        Self::Heartbeat,
    ];

    #[cfg(any(test, feature = "test-support"))]
    const ALL: [Self; 6] = [
        Self::Agents,
        Self::Soul,
        Self::Identity,
        Self::User,
        Self::Heartbeat,
        Self::Bootstrap,
    ];

    pub fn file_name(self) -> &'static str {
        match self {
            Self::Agents => "AGENTS.md",
            Self::Soul => "SOUL.md",
            Self::Identity => "IDENTITY.md",
            Self::User => "USER.md",
            Self::Heartbeat => "HEARTBEAT.md",
            Self::Bootstrap => "BOOTSTRAP.md",
        }
    }
}

pub struct MatchaWorkspaceOverlay;

impl MatchaWorkspaceOverlay {
    pub fn seed_main_agent_templates(
        workspace: AgentWorkspaceDirectory,
        templates: MatchaWorkspaceTemplateDirectory,
    ) -> Result<(), WorkspaceProjectionError> {
        let workspace = identity::ensure_workspace(workspace.as_path())?;
        let template_directory = identity::directory(templates.as_path())?;

        for file in WorkspaceTemplateFile::MAIN_AGENT {
            let Some(content) = try_load_template(&template_directory, file)? else {
                continue;
            };
            identity::write_if_missing(&workspace.join(file.file_name()), &content)?;
        }

        identity::remove_regular(&workspace.join(WorkspaceTemplateFile::Bootstrap.file_name()))
    }

    pub fn preseed_identity(
        workspace: AgentWorkspaceDirectory,
        templates: MatchaWorkspaceTemplateDirectory,
    ) -> Result<(), WorkspaceProjectionError> {
        let workspace = identity::ensure_workspace(workspace.as_path())?;
        let template_directory = identity::directory(templates.as_path())?;
        let matcha_identity = load_template(&template_directory, WorkspaceTemplateFile::Identity)?;
        let identity_path = workspace.join(WorkspaceTemplateFile::Identity.file_name());

        match identity::read_regular(&identity_path)? {
            None => {
                identity::write_if_missing(&identity_path, &matcha_identity)?;
            }
            Some(existing)
                if existing != matcha_identity && is_openclaw_identity_template(&existing) =>
            {
                replace_regular_file(
                    &workspace,
                    WorkspaceTemplateFile::Identity.file_name(),
                    matcha_identity.as_bytes(),
                )
                .map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
            }
            Some(_) => {}
        }

        identity::remove_regular(&workspace.join(WorkspaceTemplateFile::Bootstrap.file_name()))
    }

    pub fn merge_context(
        workspace: AgentWorkspaceDirectory,
        context: WorkspaceContextDirectory,
    ) -> Result<ContextMerge, WorkspaceProjectionError> {
        context::merge(context.as_path(), workspace.as_path())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceProjectionError {
    InvalidPath,
    TemplateUnavailable,
    WorkspaceUnavailable,
}

impl fmt::Display for WorkspaceProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => formatter.write_str("OpenClaw workspace path is invalid"),
            Self::TemplateUnavailable => {
                formatter.write_str("OpenClaw workspace template is unavailable")
            }
            Self::WorkspaceUnavailable => formatter.write_str("OpenClaw workspace is unavailable"),
        }
    }
}

impl std::error::Error for WorkspaceProjectionError {}

fn load_template(
    template_directory: &Path,
    file: WorkspaceTemplateFile,
) -> Result<String, WorkspaceProjectionError> {
    try_load_template(template_directory, file)?
        .ok_or(WorkspaceProjectionError::TemplateUnavailable)
}

fn try_load_template(
    template_directory: &Path,
    file: WorkspaceTemplateFile,
) -> Result<Option<String>, WorkspaceProjectionError> {
    identity::read_regular(&template_directory.join(file.file_name()))
        .map_err(|_| WorkspaceProjectionError::TemplateUnavailable)
        .map(|content| content.map(strip_front_matter))
}

fn strip_front_matter(content: String) -> String {
    if !content.starts_with("---") {
        return content;
    }
    let Some(end) = content[3..].find("\n---") else {
        return content;
    };
    content[(end + 3 + "\n---".len())..].trim_start().to_owned()
}

fn is_openclaw_identity_template(content: &str) -> bool {
    let normalized = content.replace("\r\n", "\n");
    normalized.contains("# IDENTITY.md - Who Am I?")
        && normalized.contains("_(pick something you like)_")
        && normalized.contains("- **Name:**")
        && normalized.contains("- **Emoji:**")
}

#[cfg(test)]
mod tests;
