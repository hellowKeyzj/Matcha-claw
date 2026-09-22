use std::fmt;

pub mod loopback;

use serde_json::{Map, Value, json};

use crate::projection::{installation, runtime_paths};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallationStatus {
    pub package_exists: bool,
    pub is_built: bool,
    pub version: Option<String>,
}

impl From<installation::Status> for InstallationStatus {
    fn from(status: installation::Status) -> Self {
        Self {
            package_exists: status.package_exists(),
            is_built: status.is_built(),
            version: status.version().map(str::to_owned),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimePaths {
    pub openclaw_directory: String,
    pub config_directory: String,
    pub workspace_directory: String,
    pub task_workspace_directories: Vec<String>,
    pub skills_directory: String,
}

impl From<runtime_paths::RuntimePaths> for RuntimePaths {
    fn from(paths: runtime_paths::RuntimePaths) -> Self {
        Self {
            openclaw_directory: paths.openclaw_directory().to_owned(),
            config_directory: paths.config_directory().to_owned(),
            workspace_directory: paths.workspace_directory().to_owned(),
            task_workspace_directories: paths.task_workspace_directories().to_vec(),
            skills_directory: paths.skills_directory().to_owned(),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct CliCommand {
    pub command: String,
}

impl From<runtime_paths::CliCommand> for CliCommand {
    fn from(command: runtime_paths::CliCommand) -> Self {
        Self {
            command: command.command().to_owned(),
        }
    }
}

impl fmt::Debug for CliCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CliCommand([REDACTED])")
    }
}

pub fn project_installation_status(status: &InstallationStatus) -> Value {
    let mut object = Map::new();
    object.insert("packageExists".into(), json!(status.package_exists));
    object.insert("isBuilt".into(), json!(status.is_built));
    if let Some(version) = status.version.as_ref() {
        object.insert("version".into(), json!(version));
    }
    Value::Object(object)
}

pub fn project_runtime_paths(paths: RuntimePaths) -> Value {
    json!({
        "openclawDirectory": paths.openclaw_directory,
        "configDirectory": paths.config_directory,
        "workspaceDirectory": paths.workspace_directory,
        "taskWorkspaceDirectories": paths.task_workspace_directories,
        "skillsDirectory": paths.skills_directory,
    })
}

pub fn project_cli_command(command: CliCommand) -> Value {
    json!({ "command": command.command })
}
