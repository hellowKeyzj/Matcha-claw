use std::{
    ffi::{OsStr, OsString},
    fmt,
    path::PathBuf,
    sync::Arc,
};

#[cfg(windows)]
use foundation::process::windows_system_root;
use foundation::{
    process::{
        InvalidLaunchSpec, LaunchAttempt, LaunchAttemptFuture, LaunchAttemptMaterializer,
        LaunchSpec, StdioMode, StdioSpec, supervision::LaunchFailure,
    },
    toolchain::{NativeToolchainRuntime, ToolchainEnvProjection},
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
const MATCHACLAW_SESSION_TRACE: &str = "MATCHACLAW_SESSION_TRACE";
const MATCHACLAW_UV_BIN: &str = "MATCHACLAW_UV_BIN";
const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";
const TOOLCHAIN_PRIVATE_ENV_KEYS: [&str; 12] = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "TEMP",
    "TMP",
    "XDG_CACHE_HOME",
    MATCHACLAW_UV_BIN,
    CLAUDE_CONFIG_DIR,
];
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
    pub toolchain: Arc<NativeToolchainRuntime>,
    #[cfg(windows)]
    pub git_bash: PathBuf,
}

impl LaunchInput {
    pub fn try_into_launch_factory(self) -> Result<LaunchFactory, LaunchError> {
        let input = LaunchFactoryInput::try_from(self)?;
        #[cfg(test)]
        let spec = build_spec(&input, None)?;
        #[cfg(not(test))]
        build_spec(&input, None)?;
        storage_root::provision(&input.storage_root)
            .map_err(|_| LaunchError::StorageRootProvision)?;
        Ok(LaunchFactory {
            input,
            #[cfg(test)]
            spec,
        })
    }
}

pub struct LaunchFactory {
    input: LaunchFactoryInput,
    #[cfg(test)]
    spec: LaunchSpec,
}

struct LaunchFactoryInput {
    bun_executable: PathBuf,
    entry: PathBuf,
    working_directory: PathBuf,
    storage_root: PathBuf,
    port: u16,
    secret: Arc<Secret>,
    toolchain: Arc<NativeToolchainRuntime>,
    #[cfg(windows)]
    git_bash: PathBuf,
}

impl TryFrom<LaunchInput> for LaunchFactoryInput {
    type Error = LaunchError;

    fn try_from(input: LaunchInput) -> Result<Self, Self::Error> {
        validate_input(&input)?;
        Ok(Self {
            bun_executable: input.bun_executable,
            entry: input.entry,
            working_directory: input.working_directory,
            storage_root: input.storage_root,
            port: input.port,
            secret: input.secret,
            toolchain: input.toolchain,
            #[cfg(windows)]
            git_bash: input.git_bash,
        })
    }
}

impl LaunchAttemptMaterializer for LaunchFactory {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let input = self.input.clone();
        Box::pin(async move {
            let projection = input.toolchain.private_env_projection().await;
            let spec = build_spec(&input, Some(&projection))
                .map_err(|_| LaunchFailure::PlatformRejected)?;
            Ok(LaunchAttempt::new(spec, ()))
        })
    }
}

impl Clone for LaunchFactoryInput {
    fn clone(&self) -> Self {
        Self {
            bun_executable: self.bun_executable.clone(),
            entry: self.entry.clone(),
            working_directory: self.working_directory.clone(),
            storage_root: self.storage_root.clone(),
            port: self.port,
            secret: Arc::clone(&self.secret),
            toolchain: Arc::clone(&self.toolchain),
            #[cfg(windows)]
            git_bash: self.git_bash.clone(),
        }
    }
}

fn build_spec(
    input: &LaunchFactoryInput,
    toolchain: Option<&ToolchainEnvProjection>,
) -> Result<LaunchSpec, LaunchError> {
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
    let mut public_environment = app_server_environment(std::env::vars_os(), toolchain);
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

fn app_server_environment(
    source: impl IntoIterator<Item = (OsString, OsString)>,
    toolchain: Option<&ToolchainEnvProjection>,
) -> Vec<(OsString, OsString)> {
    let source = source.into_iter().collect::<Vec<_>>();
    let mut environment = vec![
        (FORCE_COLOR.into(), "0".into()),
        (NO_COLOR.into(), "1".into()),
    ];
    for key in TOOLCHAIN_PRIVATE_ENV_KEYS {
        if let Some((_, value)) = source
            .iter()
            .find(|(candidate, _)| environment_key_eq(candidate, OsStr::new(key)))
        {
            push_environment(&mut environment, key, value.clone());
        }
    }
    if source.iter().any(|(candidate, value)| {
        environment_key_eq(candidate, OsStr::new(MATCHACLAW_SESSION_TRACE))
            && value == OsStr::new("1")
    }) {
        push_environment(&mut environment, MATCHACLAW_SESSION_TRACE, "1".into());
    }
    if let Some(toolchain) = toolchain {
        for variable in toolchain.patch() {
            push_environment(
                &mut environment,
                variable.key(),
                variable.value().to_owned(),
            );
        }
    }
    environment
}

#[cfg(windows)]
fn environment_key_eq(left: &OsStr, right: &OsStr) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(not(windows))]
fn environment_key_eq(left: &OsStr, right: &OsStr) -> bool {
    left == right
}

fn push_environment(
    environment: &mut Vec<(OsString, OsString)>,
    key: impl AsRef<OsStr>,
    value: OsString,
) {
    let key = key.as_ref();
    if let Some((_, current)) = environment
        .iter_mut()
        .find(|(candidate, _)| environment_key_eq(candidate, key))
    {
        *current = value;
    } else {
        environment.push((key.to_owned(), value));
    }
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
