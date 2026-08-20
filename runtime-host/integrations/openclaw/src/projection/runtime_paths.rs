use std::{fmt, path::Path};

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    workspace::{OpenClawWorkspaceAccess, WorkspaceDirectoryFailure},
};

const SKILLS_DIRECTORY: &str = "skills";
const CLI_ENTRY: &str = "openclaw.mjs";

#[derive(Clone, Eq, PartialEq)]
pub struct RuntimePaths {
    openclaw_directory: String,
    config_directory: String,
    workspace_directory: String,
    task_workspace_directories: Vec<String>,
    skills_directory: String,
}

impl RuntimePaths {
    pub fn inspect(
        openclaw_dir: &Path,
        state_dir: &CanonicalStateDir,
        workspace: &OpenClawWorkspaceAccess,
    ) -> Result<Self, RuntimePathsError> {
        let openclaw_directory = path_text(openclaw_dir)?;
        let config_directory = path_text(state_dir.as_path())?;
        let task_workspace_directories = workspace
            .maintenance_workspace_directories()
            .map_err(|_| RuntimePathsError::Unavailable)?
            .into_iter()
            .map(|directory| directory.as_str().to_owned())
            .collect::<Vec<_>>();
        let workspace_directory = task_workspace_directories
            .first()
            .cloned()
            .ok_or(RuntimePathsError::Unavailable)?;
        let skills_directory = path_text(&state_dir.as_path().join(SKILLS_DIRECTORY))?;
        Ok(Self {
            openclaw_directory,
            config_directory,
            workspace_directory,
            task_workspace_directories,
            skills_directory,
        })
    }

    pub fn openclaw_directory(&self) -> &str {
        &self.openclaw_directory
    }

    pub fn config_directory(&self) -> &str {
        &self.config_directory
    }

    pub fn workspace_directory(&self) -> &str {
        &self.workspace_directory
    }

    pub fn task_workspace_directories(&self) -> &[String] {
        &self.task_workspace_directories
    }

    pub fn skills_directory(&self) -> &str {
        &self.skills_directory
    }
}

impl fmt::Debug for RuntimePaths {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RuntimePaths([REDACTED])")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct CliCommand {
    command: String,
}

impl CliCommand {
    pub fn inspect(openclaw_dir: &Path) -> Result<Self, CliCommandError> {
        if !openclaw_dir.join("package.json").is_file() || !openclaw_dir.join(CLI_ENTRY).is_file() {
            return Err(CliCommandError::Unavailable);
        }
        let bin_name = if cfg!(windows) {
            "openclaw.cmd"
        } else {
            "openclaw"
        };
        let bin_path = openclaw_dir
            .parent()
            .map(|parent| parent.join(".bin").join(bin_name))
            .ok_or(CliCommandError::Unavailable)?;
        let command = if bin_path.is_file() {
            format_wrapper(&bin_path)?
        } else {
            format_node(&openclaw_dir.join(CLI_ENTRY))?
        };
        Ok(Self { command })
    }

    pub fn command(&self) -> &str {
        &self.command
    }
}

impl fmt::Debug for CliCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CliCommand([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimePathsError {
    Unavailable,
}

impl fmt::Display for RuntimePathsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw runtime paths are unavailable")
    }
}

impl std::error::Error for RuntimePathsError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CliCommandError {
    Unavailable,
}

impl fmt::Display for CliCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw CLI command is unavailable")
    }
}

impl std::error::Error for CliCommandError {}

fn path_text(path: &Path) -> Result<String, RuntimePathsError> {
    path.to_str()
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or(RuntimePathsError::Unavailable)
}

fn format_wrapper(path: &Path) -> Result<String, CliCommandError> {
    let path = path
        .to_str()
        .filter(|value| !value.is_empty())
        .ok_or(CliCommandError::Unavailable)?;
    Ok(if cfg!(windows) {
        format!("& '{path}'")
    } else {
        format!("\"{path}\"")
    })
}

fn format_node(path: &Path) -> Result<String, CliCommandError> {
    let path = path
        .to_str()
        .filter(|value| !value.is_empty())
        .ok_or(CliCommandError::Unavailable)?;
    Ok(if cfg!(windows) {
        format!("node '{path}'")
    } else {
        format!("node \"{path}\"")
    })
}

impl From<WorkspaceDirectoryFailure> for RuntimePathsError {
    fn from(_: WorkspaceDirectoryFailure) -> Self {
        Self::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    use super::*;

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must follow Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "openclaw-runtime-paths-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn provision_state(&self) -> CanonicalStateDir {
            CanonicalStateDir::provision(self.0.join("state")).unwrap()
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn runtime_paths_follow_canonical_state_and_configured_workspace_selection() {
        let root = TestRoot::new();
        let state_dir = root.provision_state();
        let default_workspace = root.0.join("default-workspace");
        let reviewer_workspace = root.0.join("reviewer-workspace");
        fs::write(
            state_dir.as_path().join("openclaw.json"),
            serde_json::to_vec(&json!({
                "agents": {
                    "defaults": { "workspace": default_workspace },
                    "list": [
                        { "id": "reviewer", "workspace": reviewer_workspace },
                        { "id": "internal", "workspace": state_dir.as_path().join("teambuddy/internal") }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let workspace = OpenClawWorkspaceAccess::new(state_dir.clone());
        let openclaw_dir = root.0.join("openclaw");
        fs::create_dir(&openclaw_dir).unwrap();

        let paths = RuntimePaths::inspect(&openclaw_dir, &state_dir, &workspace).unwrap();

        assert_eq!(paths.openclaw_directory(), openclaw_dir.to_str().unwrap());
        assert_eq!(
            paths.config_directory(),
            state_dir.as_path().to_str().unwrap()
        );
        assert_eq!(
            paths.workspace_directory(),
            default_workspace.to_str().unwrap()
        );
        assert_eq!(
            paths.task_workspace_directories(),
            &[
                default_workspace.to_str().unwrap().to_owned(),
                reviewer_workspace.to_str().unwrap().to_owned()
            ]
        );
        assert_eq!(
            paths.skills_directory(),
            state_dir.as_path().join("skills").to_str().unwrap()
        );
        assert_eq!(format!("{paths:?}"), "RuntimePaths([REDACTED])");
    }

    #[test]
    fn cli_command_prefers_the_package_wrapper_then_falls_back_to_node_entry() {
        let root = TestRoot::new();
        let package_root = root.0.join("node_modules/openclaw");
        fs::create_dir_all(&package_root).unwrap();
        fs::write(package_root.join("package.json"), "{}").unwrap();
        fs::write(package_root.join(CLI_ENTRY), "").unwrap();

        let fallback = CliCommand::inspect(&package_root).unwrap();
        let expected_entry = package_root.join(CLI_ENTRY).to_str().unwrap().to_owned();
        let expected_fallback = if cfg!(windows) {
            format!("node '{expected_entry}'")
        } else {
            format!("node \"{expected_entry}\"")
        };
        assert_eq!(fallback.command(), expected_fallback);

        let bin = root.0.join("node_modules").join(".bin");
        fs::create_dir_all(&bin).unwrap();
        let bin_name = if cfg!(windows) {
            "openclaw.cmd"
        } else {
            "openclaw"
        };
        let bin_path = bin.join(bin_name);
        fs::write(&bin_path, "").unwrap();

        let wrapper = CliCommand::inspect(&package_root).unwrap();
        let expected_bin = bin_path.to_str().unwrap();
        let expected_wrapper = if cfg!(windows) {
            format!("& '{expected_bin}'")
        } else {
            format!("\"{expected_bin}\"")
        };
        assert_eq!(wrapper.command(), expected_wrapper);
        assert_eq!(format!("{wrapper:?}"), "CliCommand([REDACTED])");
    }

    #[test]
    fn cli_failures_are_fixed_without_paths_or_fixture_contents() {
        let root = TestRoot::new();
        let unavailable = root.0.join("private-package-root");

        let error = CliCommand::inspect(&unavailable).unwrap_err();
        let rendered = format!("{error:?} {error}");

        assert_eq!(error, CliCommandError::Unavailable);
        assert!(!rendered.contains(unavailable.to_string_lossy().as_ref()));
    }
}
