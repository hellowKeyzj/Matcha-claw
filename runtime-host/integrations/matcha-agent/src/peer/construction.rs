use std::{
    fmt,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};

#[cfg(unix)]
use foundation::process::InvalidGuardianExecutable;
use foundation::process::{ProcessContainment, supervise};

use super::lifecycle::MatchaPeer;
use crate::{
    lifecycle::{
        launch::{LaunchError, LaunchFactory, LaunchInput},
        output::StartupDiagnosticCategory,
        readiness::AppServerReadiness,
        recovery::StartupRecovery,
        restart::CrashRestartPolicy,
        secret::Secret,
        shutdown::MatchaGracefulStop,
        stdio::{MatchaStdinControl, MatchaStdioActivation},
    },
    session::client::{AppServerClientError, AppServerEndpoint},
};

pub struct MatchaPeerInput {
    pub bun_executable: PathBuf,
    pub entry: PathBuf,
    pub working_directory: PathBuf,
    pub storage_root: PathBuf,
    pub port: u16,
    pub report_diagnostic: Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync>,
    #[cfg(windows)]
    pub git_bash: PathBuf,
    #[cfg(unix)]
    pub guardian_executable: PathBuf,
}

pub struct MatchaPeerFactory {
    launch: LaunchFactory,
    working_directory: PathBuf,
    endpoint: AppServerEndpoint,
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
        let endpoint =
            AppServerEndpoint::try_new(SocketAddr::from((Ipv4Addr::LOCALHOST, input.port)))
                .map_err(ConstructionError::Endpoint)?;
        let secret = Arc::new(secret);
        let working_directory = input.working_directory.clone();
        let launch = LaunchInput {
            bun_executable: input.bun_executable,
            entry: input.entry,
            working_directory: input.working_directory,
            storage_root: input.storage_root,
            port: input.port,
            secret: Arc::clone(&secret),
            #[cfg(windows)]
            git_bash: input.git_bash,
        }
        .try_into_launch_factory()?;

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
        let stdin = MatchaStdinControl::new();
        let report_diagnostic = self.report_diagnostic;
        let stdio_activation = MatchaStdioActivation::new(
            stdin.clone(),
            Arc::new(move |diagnostic| report_diagnostic(diagnostic.category())),
        );
        let readiness = AppServerReadiness::new(self.endpoint, Arc::clone(&self.secret));
        let graceful_stop = MatchaGracefulStop::new(stdin);

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

        MatchaPeer::new(
            handle,
            supervisor,
            self.working_directory,
            self.endpoint,
            self.secret,
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConstructionError {
    Endpoint(AppServerClientError),
    Launch(LaunchError),
    #[cfg(unix)]
    Guardian(InvalidGuardianExecutable),
}

impl fmt::Display for ConstructionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Endpoint(error) => error.fmt(formatter),
            Self::Launch(error) => error.fmt(formatter),
            #[cfg(unix)]
            Self::Guardian(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ConstructionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Endpoint(error) => Some(error),
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
