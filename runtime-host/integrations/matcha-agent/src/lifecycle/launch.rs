use std::{
    ffi::{OsStr, OsString},
    fmt,
    path::PathBuf,
    sync::Arc,
};

#[cfg(windows)]
use foundation::process::windows_system_root;
use foundation::process::{
    InvalidLaunchSpec, LaunchAttempt, LaunchAttemptFuture, LaunchAttemptMaterializer,
    LaunchMaterializationFailure, LaunchSpec, StdioMode, StdioSpec, supervision::LaunchFailure,
};
use platform::state_dir::CanonicalStateDir;
use toolchain::{NativeToolchain, ToolchainEnvProjection};

use super::{output::StartupDiagnosticCategory, secret::Secret};

#[path = "launch/config.rs"]
mod config;

const APP_SERVER_HOST: &str = "127.0.0.1";
const APP_SERVER_TOKEN_ENV: &str = "MATCHA_APP_SERVER_TOKEN";
const FORCE_COLOR: &str = "FORCE_COLOR";
const NO_COLOR: &str = "NO_COLOR";
const MATCHACLAW_TRACE: &str = "MATCHACLAW_TRACE";
const MATCHACLAW_UV_BIN: &str = "MATCHACLAW_UV_BIN";
const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";
const MATCHA_SEALED_ENDPOINT: &str = "MATCHA_SEALED_ENDPOINT";
const MATCHA_SEALED_TOKEN: &str = "MATCHA_SEALED_TOKEN";
const MATCHA_SEALED_RUNTIME: &str = "MATCHA_SEALED_RUNTIME";
const MATCHA_SEALED_RUNTIME_MATCHA_AGENT: &str = "matcha-agent";
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
    StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped);

pub struct LaunchInput {
    pub server_executable: PathBuf,
    pub cli_executable: PathBuf,
    pub cli_args: Vec<String>,
    pub working_directory: PathBuf,
    pub storage_root: PathBuf,
    pub port: u16,
    pub secret: Arc<Secret>,
    pub toolchain: Arc<NativeToolchain>,
    #[cfg(windows)]
    pub git_bash: PathBuf,
}

impl LaunchInput {
    pub fn try_into_launch_factory(self) -> Result<LaunchFactory, LaunchError> {
        self.try_into_launch_factory_with_sealed_target(None)
    }

    pub fn try_into_launch_factory_with_sealed_target(
        self,
        sealed_target: Option<SealedResourceTarget>,
    ) -> Result<LaunchFactory, LaunchError> {
        let mut input = LaunchFactoryInput::try_from(self)?;
        input.sealed_target = sealed_target;
        #[cfg(test)]
        let spec = build_spec(&input, None)?;
        #[cfg(not(test))]
        build_spec(&input, None)?;
        let home = CanonicalStateDir::provision_private(&input.storage_root)
            .map_err(|_| LaunchError::StorageRootProvision)?;
        Ok(LaunchFactory {
            input,
            home,
            report_diagnostic: Arc::new(|_| {}),
            config_unresolved: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            #[cfg(test)]
            spec,
        })
    }
}

pub struct LaunchFactory {
    input: LaunchFactoryInput,
    home: CanonicalStateDir,
    report_diagnostic: Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync>,
    config_unresolved: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(test)]
    spec: LaunchSpec,
}

#[derive(Clone)]
pub struct SealedResourceTarget {
    pub endpoint: String,
    pub token: String,
}

struct LaunchFactoryInput {
    server_executable: PathBuf,
    cli_executable: PathBuf,
    cli_args: Vec<String>,
    working_directory: PathBuf,
    storage_root: PathBuf,
    port: u16,
    secret: Arc<Secret>,
    toolchain: Arc<NativeToolchain>,
    sealed_target: Option<SealedResourceTarget>,
    #[cfg(windows)]
    git_bash: PathBuf,
}

impl TryFrom<LaunchInput> for LaunchFactoryInput {
    type Error = LaunchError;

    fn try_from(input: LaunchInput) -> Result<Self, Self::Error> {
        validate_input(&input)?;
        Ok(Self {
            server_executable: input.server_executable,
            cli_executable: input.cli_executable,
            cli_args: input.cli_args,
            working_directory: input.working_directory,
            storage_root: input.storage_root,
            port: input.port,
            secret: input.secret,
            toolchain: input.toolchain,
            sealed_target: None,
            #[cfg(windows)]
            git_bash: input.git_bash,
        })
    }
}

impl LaunchFactory {
    pub fn report_diagnostics(
        mut self,
        report: Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync>,
    ) -> Self {
        self.report_diagnostic = report;
        self
    }
}

impl LaunchAttemptMaterializer for LaunchFactory {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let input = self.input.clone();
        let home = self.home.clone();
        let unresolved = Arc::clone(&self.config_unresolved);
        let report = Arc::clone(&self.report_diagnostic);
        Box::pin(async move {
            if unresolved.load(std::sync::atomic::Ordering::Acquire) {
                return Err(LaunchMaterializationFailure::new(
                    LaunchFailure::PlatformRejected,
                ));
            }
            let projection = input.toolchain.private_env_projection().await;
            let spec = build_spec(&input, Some(&projection))
                .map_err(|_| LaunchMaterializationFailure::new(LaunchFailure::PlatformRejected))?;
            unresolved.store(true, std::sync::atomic::Ordering::Release);
            let worker_unresolved = Arc::clone(&unresolved);
            let worker_report = Arc::clone(&report);
            let configured = tokio::task::spawn_blocking(move || {
                let result = config::prepare(&home, &input);
                if let Err(failure) = &result {
                    // Keep evidence even if the waiter is cancelled; never print private config.
                    eprintln!("matcha-agent launcher: {failure}");
                    worker_report(StartupDiagnosticCategory::ConfigurationRejected);
                }
                if !result
                    .as_ref()
                    .is_err_and(|failure| failure.outcome_unknown())
                {
                    worker_unresolved.store(false, std::sync::atomic::Ordering::Release);
                }
                result
            })
            .await;
            match configured {
                Ok(Ok(())) => return Ok(LaunchAttempt::new(spec, ())),
                Ok(Err(_)) => {}
                Err(_) => {
                    eprintln!(
                        "matcha-agent launcher: {}",
                        config::ConfigFailure::worker_unknown()
                    );
                    report(StartupDiagnosticCategory::ConfigurationRejected);
                }
            }
            Err(LaunchMaterializationFailure::new(
                LaunchFailure::PlatformRejected,
            ))
        })
    }
}

impl Clone for LaunchFactoryInput {
    fn clone(&self) -> Self {
        Self {
            server_executable: self.server_executable.clone(),
            cli_executable: self.cli_executable.clone(),
            cli_args: self.cli_args.clone(),
            working_directory: self.working_directory.clone(),
            storage_root: self.storage_root.clone(),
            port: self.port,
            secret: Arc::clone(&self.secret),
            toolchain: Arc::clone(&self.toolchain),
            sealed_target: self.sealed_target.clone(),
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
        OsString::from("--home"),
        input.storage_root.clone().into_os_string(),
    ];
    let mut public_environment = app_server_environment(std::env::vars_os(), toolchain);
    push_environment(
        &mut public_environment,
        APP_SERVER_TOKEN_ENV,
        auth_token.as_str().into(),
    );
    if let Some(sealed_target) = &input.sealed_target {
        public_environment.extend(sealed_resource_environment(sealed_target));
    }
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

    let spec = LaunchSpec::try_new(
        input.server_executable.clone(),
        input.working_directory.clone(),
        arguments,
        public_environment,
        APP_SERVER_STDIO,
    )
    .map_err(LaunchError::InvalidSpec)?;
    if !auth_token
        .as_str()
        .bytes()
        .all(|byte| byte.is_ascii_graphic())
    {
        return Err(LaunchError::InvalidInput);
    }
    Ok(spec)
}

fn sealed_resource_environment(target: &SealedResourceTarget) -> [(OsString, OsString); 3] {
    [
        (
            MATCHA_SEALED_ENDPOINT.into(),
            target.endpoint.clone().into(),
        ),
        (MATCHA_SEALED_TOKEN.into(), target.token.clone().into()),
        (
            MATCHA_SEALED_RUNTIME.into(),
            MATCHA_SEALED_RUNTIME_MATCHA_AGENT.into(),
        ),
    ]
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
    let trace = source
        .iter()
        .find(|(candidate, _)| environment_key_eq(candidate, OsStr::new(MATCHACLAW_TRACE)))
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| "0".into());
    push_environment(&mut environment, MATCHACLAW_TRACE, trace);
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
        || !input.server_executable.is_absolute()
        || !input.cli_executable.is_absolute()
        || input.cli_executable.to_str().is_none()
        || input
            .cli_executable
            .as_os_str()
            .to_string_lossy()
            .contains('\0')
        || input
            .cli_args
            .iter()
            .any(|argument| argument.contains('\0'))
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
