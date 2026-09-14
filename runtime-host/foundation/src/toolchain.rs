use std::{
    ffi::{OsStr, OsString},
    fmt, fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

#[cfg(windows)]
use crate::process::windows_system_root;
use crate::process::{
    LaunchAttempt, LaunchAttemptFuture, LaunchAttemptMaterializer, LaunchSpec, OneShotCompletion,
    OneShotContainment, OneShotRun, OneShotRunner, ProcessObservation, ProcessOutput, ProcessStdio,
    ShutdownOutcome, StdioActivationResult, StdioDrain, StdioDrainResult, StdioMode, StdioSpec,
    supervise,
    supervision::{
        CommandReceipt, CompletionError, GracefulStop, GracefulStopResult, LaunchFailure,
        PolicyFuture, ReadinessProbe, ReadinessResult, RestartDecision, RestartEpisode,
        RestartPolicy, StartOutcome, StartRecovery, StartRecoveryResult, StdioActivation,
        SupervisorFailure,
    },
};
use tokio::io::AsyncReadExt;
use tokio::time::{Instant, timeout_at};

const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STDOUT_BYTES: usize = 32 * 1024;

/// A process result with no native output or path details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolchainCommandOutcome {
    Succeeded,
    Failed,
    Unavailable,
    TimedOut,
    Unknown,
    Unsupported,
}

pub type ToolchainCommandFuture = Pin<Box<dyn Future<Output = ToolchainCommandOutcome> + Send>>;
pub type ToolchainResolveFuture<'a> =
    Pin<Box<dyn Future<Output = ToolchainPythonResolution> + Send + 'a>>;

pub trait ToolchainCommandPort: Send + Sync {
    fn execute(&self, request: ToolchainCommandRequest) -> ToolchainCommandFuture;

    fn resolve_python(&self, request: ToolchainCommandRequest) -> ToolchainResolveFuture<'_> {
        Box::pin(async move {
            match self.execute(request).await {
                ToolchainCommandOutcome::Succeeded => ToolchainPythonResolution::Unknown,
                ToolchainCommandOutcome::Failed => ToolchainPythonResolution::NotReady,
                ToolchainCommandOutcome::Unavailable => ToolchainPythonResolution::Unavailable,
                ToolchainCommandOutcome::TimedOut | ToolchainCommandOutcome::Unknown => {
                    ToolchainPythonResolution::Unknown
                }
                ToolchainCommandOutcome::Unsupported => ToolchainPythonResolution::Unsupported,
            }
        })
    }

    fn resolve_program(&self, program: &Path) -> Option<PathBuf> {
        Some(program.to_owned())
    }
}

/// A bounded, redacted command request.
#[derive(Clone, Eq, PartialEq)]
pub struct ToolchainCommandRequest {
    program: PathBuf,
    arguments: Vec<OsString>,
    timeout: Option<Duration>,
}

impl ToolchainCommandRequest {
    pub fn new(
        program: impl Into<PathBuf>,
        arguments: impl IntoIterator<Item = OsString>,
        timeout: Option<Duration>,
    ) -> Self {
        Self {
            program: program.into(),
            arguments: arguments.into_iter().collect(),
            timeout,
        }
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub const fn timeout(&self) -> Option<Duration> {
        self.timeout
    }
}

impl fmt::Debug for ToolchainCommandRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ToolchainCommandRequest([REDACTED])")
    }
}

/// Explicit result used when no platform process seam has been wired yet.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct UnsupportedToolchainCommandPort;

impl ToolchainCommandPort for UnsupportedToolchainCommandPort {
    fn execute(&self, _: ToolchainCommandRequest) -> ToolchainCommandFuture {
        Box::pin(async { ToolchainCommandOutcome::Unsupported })
    }

    fn resolve_python(&self, _: ToolchainCommandRequest) -> ToolchainResolveFuture<'_> {
        Box::pin(async { ToolchainPythonResolution::Unsupported })
    }

    fn resolve_program(&self, program: &Path) -> Option<PathBuf> {
        Some(program.to_owned())
    }
}

/// Foundation-backed bounded native command execution for local runtime-host mechanisms.
pub struct FoundationToolchainCommandPort {
    working_directory: PathBuf,
    public_environment: Vec<(OsString, OsString)>,
    #[cfg(unix)]
    guardian_executable: PathBuf,
}

impl FoundationToolchainCommandPort {
    #[cfg(windows)]
    pub fn new(working_directory: PathBuf) -> Self {
        Self {
            working_directory,
            public_environment: toolchain_environment(),
        }
    }

    #[cfg(unix)]
    pub fn new(working_directory: PathBuf, guardian_executable: PathBuf) -> Self {
        Self {
            working_directory,
            public_environment: toolchain_environment(),
            guardian_executable,
        }
    }

    fn environment_value(&self, key: &OsStr) -> Option<&OsStr> {
        self.public_environment
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_os_str())
    }

    fn resolve_path(&self, program: &Path) -> Option<PathBuf> {
        if program.is_absolute() {
            return is_file(program).then(|| program.to_owned());
        }

        let name = program.file_name()?;
        #[cfg(windows)]
        if name.eq_ignore_ascii_case(OsStr::new("where.exe")) {
            if let Some(root) = self.environment_value(OsStr::new("SystemRoot")) {
                let where_path = PathBuf::from(root).join("System32").join("where.exe");
                if let Some(path) = is_file(&where_path).then_some(where_path) {
                    return Some(path);
                }
            }
        }

        let path = self.environment_value(OsStr::new("PATH"))?;
        for entry in std::env::split_paths(path) {
            let directory = if entry.as_os_str().is_empty() {
                self.working_directory.clone()
            } else if entry.is_absolute() {
                entry
            } else {
                self.working_directory.join(entry)
            };
            let candidate = directory.join(name);
            if let Some(path) = is_file(&candidate).then_some(candidate) {
                return Some(path);
            }
            #[cfg(windows)]
            if Path::new(name).extension().is_none() {
                let candidate = directory.join(format!("{}.exe", name.to_string_lossy()));
                if let Some(path) = is_file(&candidate).then_some(candidate) {
                    return Some(path);
                }
            }
        }
        None
    }

    fn launch(
        &self,
        request: &ToolchainCommandRequest,
        stdio: StdioSpec,
    ) -> Result<(LaunchSpec, OneShotContainment, Duration), ToolchainCommandOutcome> {
        let Some(program) = self.resolve_path(request.program()) else {
            return Err(ToolchainCommandOutcome::Unavailable);
        };
        let launch = LaunchSpec::try_new(
            program,
            self.working_directory.clone(),
            request.arguments().to_owned(),
            self.public_environment.clone(),
            stdio,
        )
        .map_err(|_| ToolchainCommandOutcome::Unavailable)?;
        #[cfg(windows)]
        let containment = OneShotContainment::job();
        #[cfg(unix)]
        let containment = OneShotContainment::guardian(self.guardian_executable.clone())
            .map_err(|_| ToolchainCommandOutcome::Unavailable)?;
        Ok((
            launch,
            containment,
            request.timeout().unwrap_or(DEFAULT_COMMAND_TIMEOUT),
        ))
    }
}

impl ToolchainCommandPort for FoundationToolchainCommandPort {
    fn execute(&self, request: ToolchainCommandRequest) -> ToolchainCommandFuture {
        let (launch, containment, deadline) = match self.launch(
            &request,
            StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
        ) {
            Ok(launch) => launch,
            Err(outcome) => return Box::pin(async move { outcome }),
        };
        let run = match OneShotRun::try_new(launch, containment, deadline) {
            Ok(run) => run,
            Err(_) => return Box::pin(async { ToolchainCommandOutcome::Unavailable }),
        };
        let mut operation = match OneShotRunner::new().start(run) {
            Ok(operation) => operation,
            Err(_) => return Box::pin(async { ToolchainCommandOutcome::Unavailable }),
        };
        Box::pin(async move { map_one_shot_completion(operation.wait().await) })
    }

    fn resolve_python(&self, request: ToolchainCommandRequest) -> ToolchainResolveFuture<'_> {
        let (launch, containment, deadline) = match self.launch(
            &request,
            StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Null),
        ) {
            Ok(launch) => launch,
            Err(outcome) => {
                return Box::pin(async move { ToolchainPythonResolution::from(outcome) });
            }
        };
        Box::pin(async move { run_stdout(launch, containment, deadline).await })
    }

    fn resolve_program(&self, program: &Path) -> Option<PathBuf> {
        self.resolve_path(program)
    }
}

fn is_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

fn toolchain_environment() -> Vec<(OsString, OsString)> {
    const KEYS: [&str; 10] = [
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
    ];
    let mut environment = KEYS
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect::<Vec<_>>();
    #[cfg(windows)]
    if let Ok(root) = windows_system_root() {
        environment.push((OsString::from("SystemRoot"), root));
    }
    environment
}

fn map_one_shot_completion(completion: OneShotCompletion) -> ToolchainCommandOutcome {
    match completion {
        OneShotCompletion::UnavailableBeforeDispatch => ToolchainCommandOutcome::Unavailable,
        OneShotCompletion::Succeeded => ToolchainCommandOutcome::Succeeded,
        OneShotCompletion::Failed => ToolchainCommandOutcome::Failed,
        OneShotCompletion::OutcomeUnknown => ToolchainCommandOutcome::Unknown,
    }
}

async fn run_stdout(
    launch: LaunchSpec,
    containment: OneShotContainment,
    deadline: Duration,
) -> ToolchainPythonResolution {
    let deadline_at = match Instant::now().checked_add(deadline) {
        Some(deadline_at) => deadline_at,
        None => return ToolchainPythonResolution::Unknown,
    };
    let containment = containment.into_process_containment();
    let resolved_python = Arc::new(Mutex::new(None));
    let mut supervisor = supervise(
        containment,
        CapturedLaunch::new(launch, deadline_at),
        CaptureStdout::new(Arc::clone(&resolved_python)),
        ImmediateReady,
        StdoutDrainGrace,
        FailRecovery,
        HaltRestart,
    );
    let handle = supervisor.handle();
    let execution = async {
        let start = settle_start(handle.start().await).await?;
        if let Some(outcome) = start {
            return Ok(outcome);
        }
        let mut snapshots = handle.subscribe();
        loop {
            let snapshot = snapshots.borrow().clone();
            if let Some(failure) = snapshot.failure() {
                return Ok(match failure {
                    SupervisorFailure::Exited(exit) if exit.exit_code() == Some(0) => {
                        resolved_python
                            .lock()
                            .expect("python resolution lock poisoned")
                            .clone()
                            .map(ToolchainPythonResolution::Ready)
                            .unwrap_or(ToolchainPythonResolution::Unknown)
                    }
                    SupervisorFailure::Exited(_)
                    | SupervisorFailure::LaunchFailed(_)
                    | SupervisorFailure::StdioFailed
                    | SupervisorFailure::ReadinessFailed => ToolchainPythonResolution::NotReady,
                    SupervisorFailure::Termination(_) => ToolchainPythonResolution::Unknown,
                });
            }
            snapshots
                .changed()
                .await
                .map_err(|_| ToolchainPythonResolution::Unknown)?;
        }
    };
    let resolution = match timeout_at(deadline_at, execution).await {
        Ok(Ok(resolution)) => resolution,
        Ok(Err(resolution)) => resolution,
        Err(_) => ToolchainPythonResolution::Unknown,
    };
    let shutdown_confirmed = shutdown_is_confirmed(handle.shutdown().await).await;
    let joined = supervisor.join().await.is_ok();
    if shutdown_confirmed && joined {
        resolution
    } else {
        ToolchainPythonResolution::Unknown
    }
}

async fn shutdown_is_confirmed(receipt: CommandReceipt<ShutdownOutcome>) -> bool {
    match receipt {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
            matches!(completion.wait().await, Ok(ShutdownOutcome::Terminated(_)))
        }
        CommandReceipt::AlreadySatisfied => true,
        CommandReceipt::Busy | CommandReceipt::Rejected(_) | CommandReceipt::ShuttingDown => false,
    }
}

async fn settle_start(
    receipt: CommandReceipt<StartOutcome>,
) -> Result<Option<ToolchainPythonResolution>, ToolchainPythonResolution> {
    match receipt {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
            match completion.wait().await {
                Ok(StartOutcome::Started) => Ok(None),
                Ok(StartOutcome::Cancelled { .. }) => Ok(Some(ToolchainPythonResolution::Unknown)),
                Err(CompletionError::Failed(SupervisorFailure::LaunchFailed(_))) => {
                    Ok(Some(ToolchainPythonResolution::Unavailable))
                }
                Err(CompletionError::Failed(SupervisorFailure::Exited(exit))) => {
                    Ok(Some(if exit.exit_code() == Some(0) {
                        ToolchainPythonResolution::Unknown
                    } else {
                        ToolchainPythonResolution::NotReady
                    }))
                }
                Err(_) => Err(ToolchainPythonResolution::Unknown),
            }
        }
        CommandReceipt::Busy | CommandReceipt::Rejected(_) => {
            Ok(Some(ToolchainPythonResolution::Unavailable))
        }
        CommandReceipt::AlreadySatisfied | CommandReceipt::ShuttingDown => {
            Ok(Some(ToolchainPythonResolution::Unknown))
        }
    }
}

struct CapturedLaunch {
    launch: Option<LaunchSpec>,
    deadline_at: Instant,
}

impl CapturedLaunch {
    const fn new(launch: LaunchSpec, deadline_at: Instant) -> Self {
        Self {
            launch: Some(launch),
            deadline_at,
        }
    }
}

impl LaunchAttemptMaterializer for CapturedLaunch {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let launch = self.launch.take();
        let deadline_at = self.deadline_at;
        Box::pin(async move {
            if Instant::now() >= deadline_at {
                return Err(LaunchFailure::PlatformRejected.into());
            }
            let Some(launch) = launch else {
                return Err(LaunchFailure::PlatformRejected.into());
            };
            Ok(LaunchAttempt::new(launch, ()))
        })
    }
}

struct CaptureStdout {
    resolved_python: Arc<Mutex<Option<PathBuf>>>,
}

impl CaptureStdout {
    fn new(resolved_python: Arc<Mutex<Option<PathBuf>>>) -> Self {
        Self { resolved_python }
    }
}

impl StdioActivation for CaptureStdout {
    fn activate(
        &self,
        _: ProcessObservation,
        stdio: ProcessStdio,
        _: tokio_util::sync::CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        let resolved_python = Arc::clone(&self.resolved_python);
        Box::pin(async move {
            let (stdin, stdout, stderr) = stdio.into_parts();
            if stdin.is_some() || stderr.is_some() {
                return StdioActivationResult::Unavailable;
            }
            let Some(stdout) = stdout else {
                return StdioActivationResult::Unavailable;
            };
            StdioActivationResult::Activated(StdioDrain::new(read_stdout(stdout, resolved_python)))
        })
    }
}

async fn read_stdout(
    mut stdout: ProcessOutput,
    resolved_python: Arc<Mutex<Option<PathBuf>>>,
) -> StdioDrainResult {
    let mut output = Vec::new();
    loop {
        let before = output.len();
        if before >= MAX_STDOUT_BYTES {
            return StdioDrainResult::Unavailable;
        }
        let limit = (MAX_STDOUT_BYTES - before).min(4096) as u64;
        match AsyncReadExt::take(&mut stdout, limit)
            .read_to_end(&mut output)
            .await
        {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => return StdioDrainResult::Unavailable,
        }
        if output.len() == before {
            break;
        }
    }
    let path = String::from_utf8_lossy(&output).trim().to_owned();
    if path.is_empty() {
        return StdioDrainResult::Unavailable;
    }
    *resolved_python
        .lock()
        .expect("python resolution lock poisoned") = Some(PathBuf::from(path));
    StdioDrainResult::Drained
}

#[derive(Clone, Copy)]
struct ImmediateReady;

impl ReadinessProbe for ImmediateReady {
    fn wait_ready(
        &self,
        _: ProcessObservation,
        _: tokio_util::sync::CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        Box::pin(async { ReadinessResult::Ready })
    }
}

#[derive(Clone, Copy)]
struct StdoutDrainGrace;

impl GracefulStop for StdoutDrainGrace {
    fn grace_period(&self) -> Duration {
        Duration::from_millis(250)
    }

    fn request_stop(
        &self,
        _: ProcessObservation,
        _: tokio_util::sync::CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        Box::pin(async { GracefulStopResult::Rejected })
    }
}

#[derive(Clone, Copy)]
struct FailRecovery;

impl StartRecovery for FailRecovery {
    fn recover(
        &self,
        _: SupervisorFailure,
        _: tokio_util::sync::CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        Box::pin(async { StartRecoveryResult::Fail })
    }
}

#[derive(Clone, Copy)]
struct HaltRestart;

impl RestartPolicy for HaltRestart {
    fn decide(&self, _: &SupervisorFailure, _: RestartEpisode) -> RestartDecision {
        RestartDecision::Halt
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum ToolchainPythonResolution {
    Ready(PathBuf),
    NotReady,
    Unavailable,
    Unknown,
    Unsupported,
}

impl From<ToolchainCommandOutcome> for ToolchainPythonResolution {
    fn from(outcome: ToolchainCommandOutcome) -> Self {
        match outcome {
            ToolchainCommandOutcome::Succeeded => Self::Unknown,
            ToolchainCommandOutcome::Failed => Self::NotReady,
            ToolchainCommandOutcome::Unavailable => Self::Unavailable,
            ToolchainCommandOutcome::TimedOut | ToolchainCommandOutcome::Unknown => Self::Unknown,
            ToolchainCommandOutcome::Unsupported => Self::Unsupported,
        }
    }
}

impl fmt::Debug for ToolchainPythonResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ready(_) => formatter.write_str("ToolchainPythonResolution::Ready([REDACTED])"),
            Self::NotReady => formatter.write_str("ToolchainPythonResolution::NotReady"),
            Self::Unavailable => formatter.write_str("ToolchainPythonResolution::Unavailable"),
            Self::Unknown => formatter.write_str("ToolchainPythonResolution::Unknown"),
            Self::Unsupported => formatter.write_str("ToolchainPythonResolution::Unsupported"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolchainEnvProjectionStatus {
    Ready,
    NotReady,
    Unavailable,
    Unknown,
    Unsupported,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ToolchainEnvProjection {
    status: ToolchainEnvProjectionStatus,
    patch: Vec<PrivateEnvVar>,
}

impl ToolchainEnvProjection {
    pub fn ready(patch: Vec<PrivateEnvVar>) -> Self {
        Self {
            status: ToolchainEnvProjectionStatus::Ready,
            patch,
        }
    }

    pub fn not_ready() -> Self {
        Self::empty(ToolchainEnvProjectionStatus::NotReady)
    }

    pub fn unavailable() -> Self {
        Self::empty(ToolchainEnvProjectionStatus::Unavailable)
    }

    pub fn unknown() -> Self {
        Self::empty(ToolchainEnvProjectionStatus::Unknown)
    }

    pub fn unsupported() -> Self {
        Self::empty(ToolchainEnvProjectionStatus::Unsupported)
    }

    const fn empty(status: ToolchainEnvProjectionStatus) -> Self {
        Self {
            status,
            patch: Vec::new(),
        }
    }

    pub fn status(&self) -> ToolchainEnvProjectionStatus {
        self.status
    }

    pub fn patch(&self) -> &[PrivateEnvVar] {
        &self.patch
    }
}

impl fmt::Debug for ToolchainEnvProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolchainEnvProjection")
            .field("status", &self.status)
            .field("patch", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct PrivateEnvVar {
    key: OsString,
    value: OsString,
}

impl PrivateEnvVar {
    pub fn new(key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        Self {
            key: key.into(),
            value: value.into(),
        }
    }

    pub fn key(&self) -> &OsStr {
        &self.key
    }

    pub fn value(&self) -> &OsStr {
        &self.value
    }
}

impl fmt::Debug for PrivateEnvVar {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PrivateEnvVar([REDACTED])")
    }
}
