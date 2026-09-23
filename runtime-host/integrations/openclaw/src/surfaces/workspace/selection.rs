use std::path::{Component, Path, PathBuf};

use serde_json::Value;

pub(crate) struct OpenClawWorkspaceSelector {
    config_directory: PathBuf,
    main: WorkspaceSelection,
    agents: Vec<ConfiguredAgentWorkspace>,
    maintenance_roots: Vec<PathBuf>,
}

impl OpenClawWorkspaceSelector {
    pub(crate) fn new(
        config_directory: &Path,
        config: &Value,
    ) -> Result<Self, WorkspaceSelectionError> {
        let config_directory = normalize_path(config_directory).ok_or(WorkspaceSelectionError)?;
        let agents = configured_agents(config);
        let main = defaults_workspace(config)
            .map(WorkspaceSelection::new)
            .or_else(|| {
                agents
                    .iter()
                    .find(|agent| agent.id == "main" || agent.is_default)
                    .map(ConfiguredAgentWorkspace::selection)
            })
            .unwrap_or_else(|| WorkspaceSelection::new(config_directory.join("workspace")));

        let mut maintenance_roots = Vec::new();
        push_maintenance_root(&mut maintenance_roots, main.as_path(), &config_directory);
        if let Some(workspace) = defaults_workspace(config) {
            push_maintenance_root(&mut maintenance_roots, &workspace, &config_directory);
        }
        for agent in &agents {
            push_maintenance_root(&mut maintenance_roots, agent.workspace(), &config_directory);
        }

        Ok(Self {
            config_directory,
            main,
            agents,
            maintenance_roots,
        })
    }

    pub(crate) fn select(&self, session_key: &str) -> Option<WorkspaceSelection> {
        let Some(agent_id) = session_agent_id(session_key) else {
            return Some(self.main.clone());
        };
        if agent_id == "main" {
            return Some(self.main.clone());
        }
        self.agents
            .iter()
            .find(|agent| agent.id == agent_id)
            .map(ConfiguredAgentWorkspace::selection)
            .or_else(|| {
                Some(WorkspaceSelection::new(
                    self.config_directory
                        .join("workspace-subagents")
                        .join(normalize_subagent_name_to_slug(agent_id)),
                ))
            })
    }

    pub(crate) fn maintenance_roots(&self) -> &[PathBuf] {
        &self.maintenance_roots
    }
}

#[derive(Clone)]
pub(crate) struct WorkspaceSelection {
    workspace: PathBuf,
}

impl WorkspaceSelection {
    fn new(workspace: PathBuf) -> Self {
        Self { workspace }
    }

    pub(in crate::surfaces::workspace) fn as_path(&self) -> &Path {
        &self.workspace
    }
}

struct ConfiguredAgentWorkspace {
    id: String,
    workspace: PathBuf,
    is_default: bool,
}

impl ConfiguredAgentWorkspace {
    fn selection(&self) -> WorkspaceSelection {
        WorkspaceSelection::new(self.workspace.clone())
    }

    fn workspace(&self) -> &Path {
        &self.workspace
    }
}

fn defaults_workspace(config: &Value) -> Option<PathBuf> {
    workspace_value(config.get("agents")?.get("defaults")?.get("workspace"))
}

fn configured_agents(config: &Value) -> Vec<ConfiguredAgentWorkspace> {
    let Some(agents) = config.get("agents").and_then(Value::as_object) else {
        return Vec::new();
    };
    if let Some(entries) = agents.get("entries").and_then(Value::as_object) {
        return entries
            .iter()
            .filter_map(|(id, agent)| {
                let id = agent_id(id)?;
                let agent = agent.as_object()?;
                let workspace = workspace_value(agent.get("workspace"))?;
                Some(ConfiguredAgentWorkspace {
                    id: id.to_owned(),
                    workspace,
                    is_default: agent_is_default(agent),
                })
            })
            .collect();
    }
    agents
        .get("list")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|agent| {
            let agent = agent.as_object()?;
            let id = agent.get("id").and_then(Value::as_str).and_then(agent_id)?;
            let workspace = workspace_value(agent.get("workspace"))?;
            Some(ConfiguredAgentWorkspace {
                id: id.to_owned(),
                workspace,
                is_default: agent_is_default(agent),
            })
        })
        .collect()
}

fn agent_is_default(agent: &serde_json::Map<String, Value>) -> bool {
    agent.get("default").or_else(|| agent.get("isDefault")) == Some(&Value::Bool(true))
}

fn workspace_value(value: Option<&Value>) -> Option<PathBuf> {
    normalize_path(Path::new(value?.as_str()?.trim()))
}

fn normalize_path(path: &Path) -> Option<PathBuf> {
    let path = expand_home_path(path)?;
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(component) => normalized.push(component),
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some() {
                    normalized.pop();
                }
            }
        }
    }
    (!normalized.as_os_str().is_empty()).then_some(normalized)
}

fn expand_home_path(path: &Path) -> Option<PathBuf> {
    let value = path.to_str()?;
    if !value.starts_with('~') {
        return Some(path.to_path_buf());
    }
    let home = home_directory()?.to_string_lossy().into_owned();
    Some(PathBuf::from(format!("{home}{}", &value[1..])))
}

fn home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                Some(PathBuf::from(drive).join(path))
            })
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn normalize_subagent_name_to_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut pending_separator = false;
    for character in name.trim().chars() {
        if character.is_ascii_alphanumeric() {
            if pending_separator && !slug.is_empty() {
                slug.push('-');
            }
            pending_separator = false;
            slug.push(character.to_ascii_lowercase());
        } else {
            pending_separator = true;
        }
    }
    if slug.is_empty() || slug.chars().all(|character| character.is_ascii_digit()) {
        "agent".to_owned()
    } else {
        slug
    }
}

fn session_agent_id(session_key: &str) -> Option<&str> {
    let scoped = session_key.trim().strip_prefix("agent:")?;
    let agent = scoped.split(':').next()?.trim();
    agent_id(agent)
}

fn agent_id(value: &str) -> Option<&str> {
    (!value.is_empty() && value.trim() == value && value.len() <= 256 && !value.contains(':'))
        .then_some(value)
}

fn push_maintenance_root(roots: &mut Vec<PathBuf>, candidate: &Path, config_directory: &Path) {
    let teambuddy_root = config_directory.join("teambuddy");
    if candidate != teambuddy_root && !candidate.starts_with(&teambuddy_root) {
        let candidate = candidate.to_path_buf();
        if !roots.contains(&candidate) {
            roots.push(candidate);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct WorkspaceSelectionError;
