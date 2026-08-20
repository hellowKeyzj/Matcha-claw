use std::{ffi::OsString, fmt, path::PathBuf, sync::Arc};

#[cfg(windows)]
use foundation::process::windows_system_root;
use foundation::process::{
    InvalidLaunchSpec, LaunchAttempt, LaunchAttemptFuture, LaunchAttemptMaterializer, LaunchSpec,
    StdioMode, StdioSpec,
};

use super::secret::Secret;

#[cfg(unix)]
#[path = "launch/storage_root_posix.rs"]
mod storage_root;
#[cfg(windows)]
#[path = "launch/storage_root_windows.rs"]
mod storage_root;

const APP_SERVER_HOST: &str = "127.0.0.1";
const FORCE_COLOR: &str = "FORCE_COLOR";
const NO_COLOR: &str = "NO_COLOR";
#[cfg(windows)]
const SYSTEM_ROOT: &str = "SystemRoot";
#[cfg(windows)]
const CLAUDE_CODE_GIT_BASH_PATH: &str = "CLAUDE_CODE_GIT_BASH_PATH";
const APP_SERVER_STDIO: StdioSpec =
    StdioSpec::new(StdioMode::Piped, StdioMode::Piped, StdioMode::Piped);

pub struct LaunchInput {
    pub bun_executable: PathBuf,
    pub entry: PathBuf,
    pub working_directory: PathBuf,
    pub storage_root: PathBuf,
    pub port: u16,
    pub secret: Arc<Secret>,
    #[cfg(windows)]
    pub git_bash: PathBuf,
}

impl LaunchInput {
    pub fn try_into_launch_factory(self) -> Result<LaunchFactory, LaunchError> {
        validate_input(&self)?;
        let factory = LaunchFactory {
            spec: build_spec(&self)?,
        };
        storage_root::provision(&self.storage_root)
            .map_err(|_| LaunchError::StorageRootProvision)?;
        Ok(factory)
    }
}

pub struct LaunchFactory {
    spec: LaunchSpec,
}

impl LaunchAttemptMaterializer for LaunchFactory {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let spec = self.spec.clone();
        Box::pin(async move { Ok(LaunchAttempt::new(spec, ())) })
    }
}

fn build_spec(input: &LaunchInput) -> Result<LaunchSpec, LaunchError> {
    let auth_token = input.secret.issue_bearer_token();
    let arguments = [
        input.entry.clone().into_os_string(),
        OsString::from("app-server"),
        OsString::from("--host"),
        OsString::from(APP_SERVER_HOST),
        OsString::from("--port"),
        OsString::from(input.port.to_string()),
        OsString::from("--storage-root"),
        input.storage_root.clone().into_os_string(),
        OsString::from("--auth-token"),
        OsString::from(auth_token.as_str()),
    ];
    let mut public_environment = vec![
        (FORCE_COLOR.into(), "0".into()),
        (NO_COLOR.into(), "1".into()),
    ];
    #[cfg(windows)]
    {
        public_environment.push((
            SYSTEM_ROOT.into(),
            windows_system_root().map_err(|_| LaunchError::InvalidInput)?,
        ));
        public_environment.push((
            CLAUDE_CODE_GIT_BASH_PATH.into(),
            input.git_bash.clone().into_os_string(),
        ));
    }

    LaunchSpec::try_new(
        input.bun_executable.clone(),
        input.working_directory.clone(),
        arguments,
        public_environment,
        APP_SERVER_STDIO,
    )
    .map_err(LaunchError::InvalidSpec)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchError {
    InvalidInput,
    InvalidSpec(InvalidLaunchSpec),
    StorageRootProvision,
}

impl fmt::Display for LaunchError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput => output.write_str("matcha-agent launch input is invalid"),
            Self::InvalidSpec(error) => write!(
                output,
                "matcha-agent launch specification is invalid: {error}"
            ),
            Self::StorageRootProvision => {
                output.write_str("matcha-agent storage root provision failed")
            }
        }
    }
}

impl std::error::Error for LaunchError {}

fn validate_input(input: &LaunchInput) -> Result<(), LaunchError> {
    if input.port == 0
        || !input.bun_executable.is_absolute()
        || !input.entry.is_absolute()
        || !input.working_directory.is_absolute()
        || !input.storage_root.is_absolute()
    {
        return Err(LaunchError::InvalidInput);
    }
    #[cfg(windows)]
    if !input.git_bash.is_absolute() {
        return Err(LaunchError::InvalidInput);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
