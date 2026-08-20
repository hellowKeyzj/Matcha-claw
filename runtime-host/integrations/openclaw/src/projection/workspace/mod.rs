use std::{fmt, fs, path::Path};

use crate::workspace::replace_regular_file;

mod context;
mod directory;
#[cfg(any(test, feature = "test-support"))]
mod fixture;
mod identity;
mod state;

pub use directory::{
    AgentWorkspaceDirectory, ManagedWorkspaceTemplateDirectory, WorkspaceContextDirectory,
    WorkspaceTemplateDirectory,
};
#[cfg(any(test, feature = "test-support"))]
pub use fixture::WorkspaceProjectionFixture;

use state::{read_state, write_state};

const WORKSPACE_STATE_DIRECTORY: &str = ".openclaw";
const WORKSPACE_STATE_FILE: &str = "workspace-state.json";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceTemplateFile {
    Agents,
    Soul,
    Tools,
    Identity,
    User,
    Heartbeat,
    Bootstrap,
}

impl WorkspaceTemplateFile {
    const CORE: [Self; 6] = [
        Self::Agents,
        Self::Soul,
        Self::Tools,
        Self::Identity,
        Self::User,
        Self::Heartbeat,
    ];

    const ALL: [Self; 7] = [
        Self::Agents,
        Self::Soul,
        Self::Tools,
        Self::Identity,
        Self::User,
        Self::Heartbeat,
        Self::Bootstrap,
    ];

    pub fn file_name(self) -> &'static str {
        match self {
            Self::Agents => "AGENTS.md",
            Self::Soul => "SOUL.md",
            Self::Tools => "TOOLS.md",
            Self::Identity => "IDENTITY.md",
            Self::User => "USER.md",
            Self::Heartbeat => "HEARTBEAT.md",
            Self::Bootstrap => "BOOTSTRAP.md",
        }
    }
}

pub struct AgentWorkspaceMaterializationRequest {
    workspace: AgentWorkspaceDirectory,
    templates: WorkspaceTemplateDirectory,
    managed_templates: Option<ManagedWorkspaceTemplateDirectory>,
    context: Option<WorkspaceContextDirectory>,
}

impl AgentWorkspaceMaterializationRequest {
    pub fn new(workspace: AgentWorkspaceDirectory, templates: WorkspaceTemplateDirectory) -> Self {
        Self {
            workspace,
            templates,
            managed_templates: None,
            context: None,
        }
    }

    pub fn with_managed_templates(mut self, templates: ManagedWorkspaceTemplateDirectory) -> Self {
        self.managed_templates = Some(templates);
        self
    }

    pub fn with_context(mut self, context: WorkspaceContextDirectory) -> Self {
        self.context = Some(context);
        self
    }
}

impl fmt::Debug for AgentWorkspaceMaterializationRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AgentWorkspaceMaterializationRequest([REDACTED])")
    }
}

pub struct AgentWorkspaceProjection;

impl AgentWorkspaceProjection {
    pub fn materialize(
        request: AgentWorkspaceMaterializationRequest,
    ) -> Result<AgentWorkspaceMaterialization, WorkspaceProjectionError> {
        let workspace = identity::ensure_workspace(request.workspace.as_path())?;
        let template_directory = identity::directory(request.templates.as_path())?;
        let templates = load_core_templates(&template_directory)?;
        let managed_templates = request
            .managed_templates
            .as_ref()
            .map(|directory| identity::directory(directory.as_path()))
            .transpose()?;
        let state_directory = workspace.join(WORKSPACE_STATE_DIRECTORY);
        identity::ensure_directory(&state_directory)?;
        let state_path = state_directory.join(WORKSPACE_STATE_FILE);
        let mut state = read_state(&state_path)?;

        let mut initialized_files = Vec::new();
        for file in WorkspaceTemplateFile::CORE {
            let path = workspace.join(file.file_name());
            let upstream = template(&templates, file);
            if identity::write_if_missing(&path, upstream)? {
                initialized_files.push(file);
                continue;
            }
            if let Some(managed_templates) = &managed_templates {
                migrate_template(&path, upstream, managed_templates, file)?;
            }
        }

        let bootstrap_path = workspace.join(WorkspaceTemplateFile::Bootstrap.file_name());
        let mut bootstrap_exists = identity::read_regular(&bootstrap_path)?.is_some();
        let profile_is_configured = workspace_profile_is_configured(&workspace, &templates)?;
        let mut state_changed = state.requires_canonical_write();

        if !state.bootstrap_seeded && bootstrap_exists {
            state.seed_now()?;
            state_changed = true;
        }

        if !state.completed() && state.bootstrap_seeded && !bootstrap_exists {
            state.complete_now()?;
            state_changed = true;
        }

        if !state.completed() && bootstrap_exists && profile_is_configured {
            identity::remove_regular(&bootstrap_path)?;
            bootstrap_exists = false;
            if !state.bootstrap_seeded {
                state.seed_now()?;
            }
            state.complete_now()?;
            state_changed = true;
        }

        if !state.bootstrap_seeded && !state.completed() && !bootstrap_exists {
            if profile_is_configured || workspace_has_user_content(&workspace)? {
                state.complete_now()?;
                state_changed = true;
            } else {
                let bootstrap =
                    load_template(&template_directory, WorkspaceTemplateFile::Bootstrap)?;
                if identity::write_if_missing(&bootstrap_path, &bootstrap)? {
                    initialized_files.push(WorkspaceTemplateFile::Bootstrap);
                }
                bootstrap_exists = identity::read_regular(&bootstrap_path)?.is_some();
                if bootstrap_exists {
                    state.seed_now()?;
                    state_changed = true;
                }
            }
        }

        if state_changed {
            write_state(&state_path, &state)?;
        }
        if let Some(context) = request.context {
            context::merge(context.as_path(), &workspace)?;
        }

        Ok(AgentWorkspaceMaterialization {
            initialized_files,
            bootstrap: if state.completed() || !bootstrap_exists {
                WorkspaceBootstrapStatus::Complete
            } else {
                WorkspaceBootstrapStatus::Pending
            },
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentWorkspaceMaterialization {
    initialized_files: Vec<WorkspaceTemplateFile>,
    bootstrap: WorkspaceBootstrapStatus,
}

impl AgentWorkspaceMaterialization {
    pub fn initialized_files(&self) -> &[WorkspaceTemplateFile] {
        &self.initialized_files
    }

    pub fn bootstrap(&self) -> WorkspaceBootstrapStatus {
        self.bootstrap
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceBootstrapStatus {
    Pending,
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceProjectionError {
    InvalidPath,
    ClockUnavailable,
    TemplateUnavailable,
    WorkspaceUnavailable,
    StateUnavailable,
}

impl fmt::Display for WorkspaceProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => formatter.write_str("OpenClaw workspace path is invalid"),
            Self::ClockUnavailable => {
                formatter.write_str("OpenClaw workspace clock is unavailable")
            }
            Self::TemplateUnavailable => {
                formatter.write_str("OpenClaw workspace template is unavailable")
            }
            Self::WorkspaceUnavailable => formatter.write_str("OpenClaw workspace is unavailable"),
            Self::StateUnavailable => {
                formatter.write_str("OpenClaw workspace state is unavailable")
            }
        }
    }
}

impl std::error::Error for WorkspaceProjectionError {}

fn template(templates: &[(WorkspaceTemplateFile, String)], file: WorkspaceTemplateFile) -> &str {
    templates
        .iter()
        .find(|(candidate, _)| *candidate == file)
        .map(|(_, content)| content.as_str())
        .expect("fixed workspace template set must contain every template file")
}

fn load_core_templates(
    template_directory: &Path,
) -> Result<Vec<(WorkspaceTemplateFile, String)>, WorkspaceProjectionError> {
    WorkspaceTemplateFile::CORE
        .iter()
        .map(|file| load_template(template_directory, *file).map(|content| (*file, content)))
        .collect()
}

fn load_template(
    template_directory: &Path,
    file: WorkspaceTemplateFile,
) -> Result<String, WorkspaceProjectionError> {
    identity::read_regular(&template_directory.join(file.file_name()))
        .map_err(|_| WorkspaceProjectionError::TemplateUnavailable)?
        .map(strip_front_matter)
        .ok_or(WorkspaceProjectionError::TemplateUnavailable)
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

fn migrate_template(
    workspace: &Path,
    upstream: &str,
    managed_templates: &Path,
    file: WorkspaceTemplateFile,
) -> Result<(), WorkspaceProjectionError> {
    let Some(current) = identity::read_regular(workspace)? else {
        return Ok(());
    };
    if normalize_template(&current) != normalize_template(upstream) {
        return Ok(());
    }
    let managed = identity::read_regular(&managed_templates.join(file.file_name()))?
        .ok_or(WorkspaceProjectionError::TemplateUnavailable)?;
    let directory = workspace
        .parent()
        .ok_or(WorkspaceProjectionError::WorkspaceUnavailable)?;
    replace_regular_file(directory, file.file_name(), managed.as_bytes())
        .map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)
}

fn normalize_template(content: &str) -> &str {
    content.trim_end_matches(['\r', '\n'])
}

fn workspace_profile_is_configured(
    workspace: &Path,
    templates: &[(WorkspaceTemplateFile, String)],
) -> Result<bool, WorkspaceProjectionError> {
    for file in WorkspaceTemplateFile::CORE {
        let template = template(templates, file);
        if identity::read_regular(&workspace.join(file.file_name()))?
            .is_some_and(|content| content != template)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn workspace_has_user_content(workspace: &Path) -> Result<bool, WorkspaceProjectionError> {
    for entry in
        fs::read_dir(workspace).map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?
    {
        let entry = entry.map_err(|_| WorkspaceProjectionError::WorkspaceUnavailable)?;
        let name = entry.file_name();
        if !WorkspaceTemplateFile::ALL
            .iter()
            .any(|file| name == file.file_name())
            && name != WORKSPACE_STATE_DIRECTORY
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests;
