use std::{
    fmt,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};

#[cfg(unix)]
use foundation::process::InvalidGuardianExecutable;
use foundation::process::{ProcessContainment, supervise};
use toolchain::NativeToolchain;

use super::lifecycle::MatchaPeer;
use crate::{
    client::Client,
    lifecycle::{
        launch::{LaunchError, LaunchFactory, LaunchInput},
        output::StartupDiagnosticCategory,
        readiness::AppServerReadiness,
        recovery::StartupRecovery,
        restart::CrashRestartPolicy,
        secret::Secret,
        shutdown::MatchaGracefulStop,
        stdio::MatchaStdioActivation,
    },
};

pub struct MatchaPeerInput {
    pub server_executable: PathBuf,
    pub cli_executable: PathBuf,
    pub cli_args: Vec<String>,
    pub working_directory: PathBuf,
    pub storage_root: PathBuf,
    pub port: u16,
    pub toolchain: Arc<NativeToolchain>,
    pub report_diagnostic: Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync>,
    #[cfg(windows)]
    pub git_bash: PathBuf,
    #[cfg(unix)]
    pub guardian_executable: PathBuf,
}

pub struct MatchaPeerFactory {
    launch: LaunchFactory,
    working_directory: PathBuf,
    endpoint: SocketAddr,
    secret: Arc<Secret>,
    report_diagnostic: Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync>,
    #[cfg(unix)]
    guardian_executable: PathBuf,
}

impl fmt::Debug for MatchaPeerFactory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MatchaPeerFactory")
            .finish_non_exhaustive()
    }
}

impl MatchaPeerFactory {
    pub fn try_new(input: MatchaPeerInput, secret: Secret) -> Result<Self, ConstructionError> {
        let endpoint = SocketAddr::from((Ipv4Addr::LOCALHOST, input.port));
        let secret = Arc::new(secret);
        let working_directory = input.working_directory.clone();
        let launch = LaunchInput {
            server_executable: input.server_executable,
            cli_executable: input.cli_executable,
            cli_args: input.cli_args,
            working_directory: input.working_directory,
            storage_root: input.storage_root,
            port: input.port,
            secret: Arc::clone(&secret),
            toolchain: input.toolchain,
            #[cfg(windows)]
            git_bash: input.git_bash,
        }
        .try_into_launch_factory()?
        .report_diagnostics(Arc::clone(&input.report_diagnostic));

        #[cfg(unix)]
        if !input.guardian_executable.is_absolute() {
            return Err(ConstructionError::Guardian(InvalidGuardianExecutable));
        }

        Ok(Self {
            launch,
            working_directory,
            endpoint,
            secret,
            report_diagnostic: input.report_diagnostic,
            #[cfg(unix)]
            guardian_executable: input.guardian_executable,
        })
    }

    pub fn build(self) -> MatchaPeer {
        let native = Client::new(self.endpoint, self.secret);
        let report_diagnostic = self.report_diagnostic;
        let stdio_activation = MatchaStdioActivation::new(Arc::new(move |diagnostic| {
            report_diagnostic(diagnostic.category());
        }));
        let readiness = AppServerReadiness::new(native.clone());
        let graceful_stop = MatchaGracefulStop::new(native.clone());

        #[cfg(windows)]
        let containment = ProcessContainment::job();
        #[cfg(unix)]
        let containment = ProcessContainment::guardian(self.guardian_executable)
            .expect("validated Matcha guardian executable must be absolute");
        let supervisor = supervise(
            containment,
            self.launch,
            stdio_activation,
            readiness,
            graceful_stop,
            StartupRecovery::new(),
            CrashRestartPolicy::new(),
        );
        let handle = supervisor.handle();

        MatchaPeer::new(handle, supervisor, self.working_directory, native)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConstructionError {
    Launch(LaunchError),
    #[cfg(unix)]
    Guardian(InvalidGuardianExecutable),
}

impl fmt::Display for ConstructionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Launch(error) => error.fmt(formatter),
            #[cfg(unix)]
            Self::Guardian(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ConstructionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Launch(error) => Some(error),
            #[cfg(unix)]
            Self::Guardian(error) => Some(error),
        }
    }
}

impl From<LaunchError> for ConstructionError {
    fn from(error: LaunchError) -> Self {
        Self::Launch(error)
    }
}
