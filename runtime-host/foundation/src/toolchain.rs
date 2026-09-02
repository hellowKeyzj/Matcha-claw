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

const PYTHON_INSTALL_ARGUMENTS: [&str; 3] = ["python", "install", "3.12"];
const PYTHON_READINESS_ARGUMENTS: [&str; 3] = ["python", "find", "3.12"];
const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(30);
const UV_TOOL_ID: &str = "uv";
const MAX_STDOUT_BYTES: usize = 32 * 1024;

/// Platform distinction that changes bundled executable and PATH probe names.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolchainPlatform {
    Windows,
    Unix,
}

const UNIX_TARGET_NAME: &str = if cfg!(target_os = "macos") {
    "darwin"
} else if cfg!(target_os = "linux") {
    "linux"
} else {
    "unix"
};

impl ToolchainPlatform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }

    fn bundled_uv_name(self) -> &'static str {
        match self {
            Self::Windows => "uv.exe",
            Self::Unix => "uv",
        }
    }

    fn path_probe_name(self) -> &'static str {
        match self {
            Self::Windows => "where.exe",
            Self::Unix => "which",
        }
    }

    fn target_name(self) -> &'static str {
        match self {
            Self::Windows => "win32",
            Self::Unix => UNIX_TARGET_NAME,
        }
    }
}

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

/// Foundation-backed native command execution for local runtime-host toolchain mechanisms.
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
            request.timeout().unwrap_or(INSTALL_TIMEOUT),
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

/// Local runtime-host uv/Python mechanism. It does not own domain/native facts.
pub struct NativeToolchainRuntime {
    platform: ToolchainPlatform,
    arch: String,
    working_directory: PathBuf,
    uv_override: Option<PathBuf>,
    commands: Arc<dyn ToolchainCommandPort>,
}

impl NativeToolchainRuntime {
    pub fn new(
        platform: ToolchainPlatform,
        arch: impl Into<String>,
        working_directory: PathBuf,
        uv_override: Option<PathBuf>,
        commands: Arc<dyn ToolchainCommandPort>,
    ) -> Self {
        Self {
            platform,
            arch: arch.into(),
            working_directory,
            uv_override,
            commands,
        }
    }

    #[cfg(windows)]
    pub fn local(working_directory: PathBuf) -> Arc<Self> {
        Arc::new(Self::new(
            ToolchainPlatform::current(),
            std::env::consts::ARCH,
            working_directory.clone(),
            std::env::var_os("MATCHACLAW_UV_BIN").map(PathBuf::from),
            Arc::new(FoundationToolchainCommandPort::new(working_directory)),
        ))
    }

    #[cfg(unix)]
    pub fn local(working_directory: PathBuf, guardian_executable: PathBuf) -> Arc<Self> {
        Arc::new(Self::new(
            ToolchainPlatform::current(),
            std::env::consts::ARCH,
            working_directory.clone(),
            std::env::var_os("MATCHACLAW_UV_BIN").map(PathBuf::from),
            Arc::new(FoundationToolchainCommandPort::new(
                working_directory,
                guardian_executable,
            )),
        ))
    }

    /// Builds the environment from the current process without exposing environment values.
    pub fn from_process(
        commands: Arc<dyn ToolchainCommandPort>,
    ) -> Result<Self, NativeToolchainRuntimeError> {
        let working_directory = std::env::current_dir()
            .map_err(|_| NativeToolchainRuntimeError::WorkingDirectoryUnavailable)?;
        let uv_override = std::env::var_os("MATCHACLAW_UV_BIN").map(PathBuf::from);
        Ok(Self::new(
            ToolchainPlatform::current(),
            std::env::consts::ARCH,
            working_directory,
            uv_override,
            commands,
        ))
    }

    pub fn bundled_uv_available(&self) -> bool {
        self.bundled_uv_path_candidates()
            .into_iter()
            .any(|path| is_file(&path))
    }

    pub fn bundled_uv_path_candidates(&self) -> Vec<PathBuf> {
        let executable = self.platform.bundled_uv_name();
        let target = format!("{}-{}", self.platform.target_name(), self.arch);
        let mut candidates = Vec::new();

        if let Some(path) = self.uv_override.as_ref() {
            push_candidate(&mut candidates, path, &self.working_directory);
        }
        push_candidate(
            &mut candidates,
            &self
                .working_directory
                .join("resources")
                .join("bin")
                .join(&target)
                .join(executable),
            &self.working_directory,
        );
        push_candidate(
            &mut candidates,
            &self.working_directory.join("bin").join(executable),
            &self.working_directory,
        );
        candidates
    }

    async fn uv_path(&self) -> Result<PathBuf, UvResolution> {
        if let Some(path) = self
            .bundled_uv_path_candidates()
            .into_iter()
            .find(|path| fs::metadata(path).is_ok_and(|metadata| metadata.is_file()))
        {
            return Ok(path);
        }

        let request = ToolchainCommandRequest::new(
            self.platform.path_probe_name(),
            [OsString::from(UV_TOOL_ID)],
            Some(PATH_PROBE_TIMEOUT),
        );
        match self.commands.execute(request).await {
            ToolchainCommandOutcome::Succeeded => self
                .commands
                .resolve_program(Path::new(UV_TOOL_ID))
                .ok_or(UvResolution::Unavailable),
            ToolchainCommandOutcome::Failed | ToolchainCommandOutcome::Unavailable => {
                Err(UvResolution::Unavailable)
            }
            ToolchainCommandOutcome::TimedOut | ToolchainCommandOutcome::Unknown => {
                Err(UvResolution::Unknown)
            }
            ToolchainCommandOutcome::Unsupported => Err(UvResolution::Unsupported),
        }
    }

    pub async fn observe(&self) -> ToolchainStatus {
        match self.uv_path().await {
            Ok(executable) => ToolchainStatus {
                uv: ToolAvailability::Available,
                python: self.observe_python(&executable).await,
            },
            Err(UvResolution::Unavailable) => ToolchainStatus {
                uv: ToolAvailability::Unavailable,
                python: PythonReadiness::Unavailable,
            },
            Err(UvResolution::Unknown) => ToolchainStatus {
                uv: ToolAvailability::Unknown,
                python: PythonReadiness::Unknown,
            },
            Err(UvResolution::Unsupported) => ToolchainStatus {
                uv: ToolAvailability::Unsupported,
                python: PythonReadiness::Unsupported,
            },
        }
    }

    async fn observe_python(&self, executable: &Path) -> PythonReadiness {
        let request = ToolchainCommandRequest::new(
            executable.to_owned(),
            PYTHON_READINESS_ARGUMENTS.iter().map(OsString::from),
            Some(PATH_PROBE_TIMEOUT),
        );
        match self.commands.execute(request).await {
            ToolchainCommandOutcome::Succeeded => PythonReadiness::Ready,
            ToolchainCommandOutcome::Failed => PythonReadiness::NotReady,
            ToolchainCommandOutcome::Unavailable => PythonReadiness::Unavailable,
            ToolchainCommandOutcome::TimedOut | ToolchainCommandOutcome::Unknown => {
                PythonReadiness::Unknown
            }
            ToolchainCommandOutcome::Unsupported => PythonReadiness::Unsupported,
        }
    }

    pub async fn install_uv(&self) -> UvInstallOutcome {
        let executable = match self.uv_path().await {
            Ok(path) => path,
            Err(UvResolution::Unavailable) => return UvInstallOutcome::Unavailable,
            Err(UvResolution::Unknown) => return UvInstallOutcome::Unknown,
            Err(UvResolution::Unsupported) => return UvInstallOutcome::Unsupported,
        };
        let install = ToolchainCommandRequest::new(
            executable.clone(),
            PYTHON_INSTALL_ARGUMENTS.iter().map(OsString::from),
            Some(INSTALL_TIMEOUT),
        );
        match self.commands.execute(install).await {
            ToolchainCommandOutcome::Succeeded => {
                let readiness = ToolchainCommandRequest::new(
                    executable,
                    PYTHON_READINESS_ARGUMENTS.iter().map(OsString::from),
                    Some(PATH_PROBE_TIMEOUT),
                );
                match self.commands.execute(readiness).await {
                    ToolchainCommandOutcome::Succeeded => UvInstallOutcome::Installed,
                    ToolchainCommandOutcome::Failed => UvInstallOutcome::Rejected,
                    ToolchainCommandOutcome::Unavailable => UvInstallOutcome::Unavailable,
                    ToolchainCommandOutcome::TimedOut | ToolchainCommandOutcome::Unknown => {
                        UvInstallOutcome::Unknown
                    }
                    ToolchainCommandOutcome::Unsupported => UvInstallOutcome::Unsupported,
                }
            }
            ToolchainCommandOutcome::Failed => UvInstallOutcome::Rejected,
            ToolchainCommandOutcome::Unavailable => UvInstallOutcome::Unavailable,
            ToolchainCommandOutcome::TimedOut | ToolchainCommandOutcome::Unknown => {
                UvInstallOutcome::Unknown
            }
            ToolchainCommandOutcome::Unsupported => UvInstallOutcome::Unsupported,
        }
    }

    pub async fn private_env_projection(&self) -> ToolchainEnvProjection {
        let executable = match self.uv_path().await {
            Ok(path) => path,
            Err(UvResolution::Unavailable) => return ToolchainEnvProjection::unavailable(),
            Err(UvResolution::Unknown) => return ToolchainEnvProjection::unknown(),
            Err(UvResolution::Unsupported) => return ToolchainEnvProjection::unsupported(),
        };
        let request = ToolchainCommandRequest::new(
            executable.clone(),
            PYTHON_READINESS_ARGUMENTS.iter().map(OsString::from),
            Some(PATH_PROBE_TIMEOUT),
        );
        match self.commands.resolve_python(request).await {
            ToolchainPythonResolution::Ready(python) => {
                let mut patch = Vec::new();
                if let Some(directory) = python.parent() {
                    patch.push(PrivateEnvVar::new("PATH", prepend_path(directory)));
                }
                patch.push(PrivateEnvVar::new(
                    "MATCHACLAW_UV_BIN",
                    executable.into_os_string(),
                ));
                ToolchainEnvProjection::ready(patch)
            }
            ToolchainPythonResolution::NotReady => ToolchainEnvProjection::not_ready(),
            ToolchainPythonResolution::Unavailable => ToolchainEnvProjection::unavailable(),
            ToolchainPythonResolution::Unknown => ToolchainEnvProjection::unknown(),
            ToolchainPythonResolution::Unsupported => ToolchainEnvProjection::unsupported(),
        }
    }
}

impl fmt::Debug for NativeToolchainRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeToolchainRuntime([REDACTED])")
    }
}

fn push_candidate(candidates: &mut Vec<PathBuf>, path: &Path, base: &Path) {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        base.join(path)
    };
    if !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

fn prepend_path(directory: &Path) -> OsString {
    let mut paths = vec![directory.to_owned()];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(paths).unwrap_or_else(|_| directory.as_os_str().to_owned())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UvResolution {
    Unavailable,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeToolchainRuntimeError {
    WorkingDirectoryUnavailable,
}

impl fmt::Display for NativeToolchainRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Toolchain working directory is unavailable")
    }
}

impl std::error::Error for NativeToolchainRuntimeError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolAvailability {
    Available,
    Unavailable,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PythonReadiness {
    Ready,
    NotReady,
    Unknown,
    Unavailable,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolchainStatus {
    uv: ToolAvailability,
    python: PythonReadiness,
}

impl ToolchainStatus {
    pub fn uv(&self) -> ToolAvailability {
        self.uv
    }

    pub fn python(&self) -> PythonReadiness {
        self.python
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UvInstallOutcome {
    Installed,
    Rejected,
    Unknown,
    Unavailable,
    Unsupported,
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
    fn ready(patch: Vec<PrivateEnvVar>) -> Self {
        Self {
            status: ToolchainEnvProjectionStatus::Ready,
            patch,
        }
    }

    fn not_ready() -> Self {
        Self::empty(ToolchainEnvProjectionStatus::NotReady)
    }

    fn unavailable() -> Self {
        Self::empty(ToolchainEnvProjectionStatus::Unavailable)
    }

    fn unknown() -> Self {
        Self::empty(ToolchainEnvProjectionStatus::Unknown)
    }

    fn unsupported() -> Self {
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
    fn new(key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
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

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap, VecDeque},
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestRoot {
        path: PathBuf,
    }

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must follow Unix epoch")
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("foundation-toolchain-{nanos}-{sequence}"));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn runtime(
            &self,
            platform: ToolchainPlatform,
            commands: Arc<FakeCommands>,
        ) -> NativeToolchainRuntime {
            NativeToolchainRuntime::new(platform, "x64", self.path.clone(), None, commands)
        }

        fn bundled_uv(&self, platform: ToolchainPlatform) -> PathBuf {
            let executable = match platform {
                ToolchainPlatform::Windows => "uv.exe",
                ToolchainPlatform::Unix => "uv",
            };
            self.path
                .join("resources/bin")
                .join(format!("{}-x64", platform.target_name()))
                .join(executable)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    struct FakeCommands {
        outcomes: Mutex<VecDeque<ToolchainCommandOutcome>>,
        python: Mutex<VecDeque<ToolchainPythonResolution>>,
        requests: Mutex<Vec<ToolchainCommandRequest>>,
        resolved: Mutex<HashMap<PathBuf, PathBuf>>,
    }

    impl FakeCommands {
        fn new(outcomes: impl IntoIterator<Item = ToolchainCommandOutcome>) -> Arc<Self> {
            Arc::new(Self {
                outcomes: Mutex::new(outcomes.into_iter().collect()),
                python: Mutex::new(VecDeque::new()),
                requests: Mutex::new(Vec::new()),
                resolved: Mutex::new(HashMap::new()),
            })
        }

        fn with_python(python: impl IntoIterator<Item = ToolchainPythonResolution>) -> Arc<Self> {
            Arc::new(Self {
                outcomes: Mutex::new(VecDeque::new()),
                python: Mutex::new(python.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
                resolved: Mutex::new(HashMap::new()),
            })
        }

        fn map_program(&self, program: impl Into<PathBuf>, resolved: impl Into<PathBuf>) {
            self.resolved
                .lock()
                .unwrap()
                .insert(program.into(), resolved.into());
        }

        fn requests(&self) -> Vec<ToolchainCommandRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl ToolchainCommandPort for FakeCommands {
        fn execute(&self, request: ToolchainCommandRequest) -> ToolchainCommandFuture {
            self.requests.lock().unwrap().push(request);
            let outcome = self
                .outcomes
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(ToolchainCommandOutcome::Unknown);
            Box::pin(async move { outcome })
        }

        fn resolve_python(&self, request: ToolchainCommandRequest) -> ToolchainResolveFuture<'_> {
            self.requests.lock().unwrap().push(request);
            let outcome = self
                .python
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(ToolchainPythonResolution::Unknown);
            Box::pin(async move { outcome })
        }

        fn resolve_program(&self, program: &Path) -> Option<PathBuf> {
            self.resolved
                .lock()
                .unwrap()
                .get(program)
                .cloned()
                .or_else(|| Some(program.to_owned()))
        }
    }

    #[tokio::test]
    async fn bundled_uv_is_available_without_a_path_probe() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([ToolchainCommandOutcome::Succeeded]);
        let bundled = root.bundled_uv(ToolchainPlatform::Unix);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"uv").unwrap();
        let runtime = root.runtime(ToolchainPlatform::Unix, commands.clone());

        let status = runtime.observe().await;
        assert_eq!(status.uv(), ToolAvailability::Available);
        assert_eq!(status.python(), PythonReadiness::Ready);
        let requests = commands.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].program(), bundled);
        assert_eq!(
            requests[0].arguments(),
            &[
                OsString::from("python"),
                OsString::from("find"),
                OsString::from("3.12")
            ]
        );
        assert_eq!(requests[0].timeout(), Some(PATH_PROBE_TIMEOUT));
    }

    #[tokio::test]
    async fn missing_bundled_uv_uses_the_platform_path_probe_with_the_path_probe_timeout() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([
            ToolchainCommandOutcome::Succeeded,
            ToolchainCommandOutcome::Succeeded,
        ]);
        let runtime = root.runtime(ToolchainPlatform::Windows, commands.clone());

        let status = runtime.observe().await;
        assert_eq!(status.uv(), ToolAvailability::Available);
        assert_eq!(status.python(), PythonReadiness::Ready);
        let requests = commands.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].program(), Path::new("where.exe"));
        assert_eq!(requests[0].arguments(), &[OsString::from("uv")]);
        assert_eq!(requests[0].timeout(), Some(PATH_PROBE_TIMEOUT));
        assert_eq!(requests[1].program(), Path::new("uv"));
        assert_eq!(
            requests[1].arguments(),
            &[
                OsString::from("python"),
                OsString::from("find"),
                OsString::from("3.12")
            ]
        );
        assert_eq!(requests[1].timeout(), Some(PATH_PROBE_TIMEOUT));
    }

    #[test]
    fn native_candidates_preserve_override_development_and_packaged_layouts() {
        let root = TestRoot::new();
        let runtime = NativeToolchainRuntime::new(
            ToolchainPlatform::Windows,
            "x64",
            root.path.clone(),
            Some(PathBuf::from("override/uv.exe")),
            Arc::new(UnsupportedToolchainCommandPort),
        );
        let candidates = runtime.bundled_uv_path_candidates();

        assert_eq!(candidates[0], root.path.join("override/uv.exe"));
        assert!(candidates.contains(&root.path.join("resources/bin/win32-x64/uv.exe")));
        assert!(candidates.contains(&root.path.join("bin/uv.exe")));
        assert_eq!(format!("{runtime:?}"), "NativeToolchainRuntime([REDACTED])");
    }

    #[tokio::test]
    async fn install_uses_bundled_uv_and_the_fixed_python_install_arguments() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([
            ToolchainCommandOutcome::Succeeded,
            ToolchainCommandOutcome::Succeeded,
        ]);
        let bundled = root.bundled_uv(ToolchainPlatform::Unix);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"uv").unwrap();
        let runtime = root.runtime(ToolchainPlatform::Unix, commands.clone());

        assert_eq!(runtime.install_uv().await, UvInstallOutcome::Installed);
        let requests = commands.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].program(), bundled);
        assert_eq!(
            requests[0].arguments(),
            &[
                OsString::from("python"),
                OsString::from("install"),
                OsString::from("3.12")
            ]
        );
        assert_eq!(requests[0].timeout(), Some(INSTALL_TIMEOUT));
        assert_eq!(requests[1].program(), bundled);
        assert_eq!(
            requests[1].arguments(),
            &[
                OsString::from("python"),
                OsString::from("find"),
                OsString::from("3.12")
            ]
        );
        assert_eq!(requests[1].timeout(), Some(PATH_PROBE_TIMEOUT));
    }

    #[tokio::test]
    async fn path_probe_and_install_use_uv_when_no_bundled_binary_exists() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([
            ToolchainCommandOutcome::Succeeded,
            ToolchainCommandOutcome::Succeeded,
            ToolchainCommandOutcome::Succeeded,
        ]);
        let runtime = root.runtime(ToolchainPlatform::Unix, commands.clone());

        assert_eq!(runtime.install_uv().await, UvInstallOutcome::Installed);
        let requests = commands.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].program(), Path::new("which"));
        assert_eq!(requests[1].program(), Path::new("uv"));
        assert_eq!(requests[2].program(), Path::new("uv"));
        assert_eq!(
            requests[2].arguments(),
            &[
                OsString::from("python"),
                OsString::from("find"),
                OsString::from("3.12")
            ]
        );
    }

    #[tokio::test]
    async fn command_failures_are_never_projected_as_success() {
        let root = TestRoot::new();
        for (command_outcome, expected) in [
            (ToolchainCommandOutcome::Failed, UvInstallOutcome::Rejected),
            (
                ToolchainCommandOutcome::Unavailable,
                UvInstallOutcome::Unavailable,
            ),
            (ToolchainCommandOutcome::TimedOut, UvInstallOutcome::Unknown),
            (ToolchainCommandOutcome::Unknown, UvInstallOutcome::Unknown),
            (
                ToolchainCommandOutcome::Unsupported,
                UvInstallOutcome::Unsupported,
            ),
        ] {
            let commands = FakeCommands::new([command_outcome]);
            let bundled = root.bundled_uv(ToolchainPlatform::Unix);
            fs::create_dir_all(bundled.parent().unwrap()).unwrap();
            fs::write(&bundled, b"uv").unwrap();
            let runtime = root.runtime(ToolchainPlatform::Unix, commands);
            assert_eq!(runtime.install_uv().await, expected);
            fs::remove_file(&bundled).unwrap();
        }
    }

    #[tokio::test]
    async fn status_exposes_only_safe_facts_and_preserves_unknown_readiness() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([ToolchainCommandOutcome::TimedOut]);
        let runtime = root.runtime(ToolchainPlatform::Unix, commands);

        let status = runtime.observe().await;
        assert_eq!(status.uv(), ToolAvailability::Unknown);
        assert_eq!(status.python(), PythonReadiness::Unknown);
        assert_eq!(
            format!("{status:?}"),
            "ToolchainStatus { uv: Unknown, python: Unknown }"
        );
    }

    #[tokio::test]
    async fn private_env_projection_uses_python_find_without_exposing_paths_in_debug() {
        let root = TestRoot::new();
        let python = root.path.join("python/bin/python.exe");
        let commands =
            FakeCommands::with_python([ToolchainPythonResolution::Ready(python.clone())]);
        let bundled = root.bundled_uv(ToolchainPlatform::Unix);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"uv").unwrap();
        let runtime = root.runtime(ToolchainPlatform::Unix, commands.clone());

        let projection = runtime.private_env_projection().await;

        assert_eq!(projection.status(), ToolchainEnvProjectionStatus::Ready);
        assert_eq!(projection.patch().len(), 2);
        assert_eq!(projection.patch()[0].key(), OsStr::new("PATH"));
        assert!(
            std::env::split_paths(projection.patch()[0].value())
                .next()
                .is_some_and(|path| path == python.parent().unwrap())
        );
        assert_eq!(projection.patch()[1].key(), OsStr::new("MATCHACLAW_UV_BIN"));
        let rendered = format!("{projection:?} {:?}", projection.patch()[0]);
        assert!(!rendered.contains(root.path.to_string_lossy().as_ref()));
        assert!(!rendered.contains("MATCHACLAW_UV_BIN"));
        assert!(!rendered.contains("PATH"));
        let requests = commands.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].program(), bundled);
        assert_eq!(
            requests[0].arguments(),
            &[
                OsString::from("python"),
                OsString::from("find"),
                OsString::from("3.12")
            ]
        );
    }

    #[tokio::test]
    async fn private_env_projection_does_not_copy_secret_environment_keys() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([ToolchainCommandOutcome::Succeeded]);
        commands.map_program("uv", root.path.join("uv"));
        let runtime = root.runtime(ToolchainPlatform::Unix, commands.clone());

        let projection = runtime.private_env_projection().await;

        assert_eq!(projection.status(), ToolchainEnvProjectionStatus::Unknown);
        for variable in projection.patch() {
            let key = variable.key().to_string_lossy().to_ascii_uppercase();
            let value = variable.value().to_string_lossy().to_ascii_uppercase();
            assert!(!key.contains("SECRET"));
            assert!(!key.contains("TOKEN"));
            assert!(!key.contains("KEY"));
            assert!(!value.contains("SECRET"));
            assert!(!value.contains("TOKEN"));
        }
    }
}
