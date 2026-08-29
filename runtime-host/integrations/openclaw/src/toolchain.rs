use std::{
    ffi::{OsStr, OsString},
    fmt, fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

#[cfg(windows)]
use foundation::process::windows_system_root;
use foundation::process::{
    LaunchSpec, OneShotCompletion, OneShotContainment, OneShotRun, OneShotRunner, StdioMode,
    StdioSpec,
};
use serde::Serialize;

use crate::{lifecycle::state_dir::CanonicalStateDir, projection::tool_permission};

const PYTHON_INSTALL_ARGUMENTS: [&str; 3] = ["python", "install", "3.12"];
const PYTHON_READINESS_ARGUMENTS: [&str; 3] = ["python", "find", "3.12"];
const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(30);
const UV_TOOL_ID: &str = "uv";
const PYTHON_TOOL_ID: &str = "python-3.12";

/// The platform distinction that changes the bundled executable and PATH probe names.
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

/// The only command seam needed by the Toolchain owner.
///
/// The concrete process implementation belongs to the platform/runtime integration. Keeping it as
/// a narrow port lets this owner preserve command and outcome semantics without making Foundation
/// execution a second Toolchain fact owner or recreating a Host-wide job queue.
pub type ToolchainCommandFuture = Pin<Box<dyn Future<Output = ToolchainCommandOutcome> + Send>>;

pub trait ToolchainCommandPort: Send + Sync {
    fn execute(&self, request: ToolchainCommandRequest) -> ToolchainCommandFuture;

    fn resolve_program(&self, program: &Path) -> Option<PathBuf> {
        Some(program.to_owned())
    }
}

/// A bounded, output-free command request.
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

    fn resolve_program(&self, program: &Path) -> Option<PathBuf> {
        Some(program.to_owned())
    }
}

/// Foundation-backed native command execution for the Toolchain owner.
///
/// The child receives only the process environment needed by uv and is always launched through
/// Foundation's contained one-shot runner. No command output crosses this seam.
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
}

impl ToolchainCommandPort for FoundationToolchainCommandPort {
    fn execute(&self, request: ToolchainCommandRequest) -> ToolchainCommandFuture {
        let Some(program) = self.resolve_path(request.program()) else {
            return Box::pin(async { ToolchainCommandOutcome::Unavailable });
        };
        let launch = LaunchSpec::try_new(
            program,
            self.working_directory.clone(),
            request.arguments().to_owned(),
            self.public_environment.clone(),
            StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
        );
        let launch = match launch {
            Ok(launch) => launch,
            Err(_) => return Box::pin(async { ToolchainCommandOutcome::Unavailable }),
        };
        #[cfg(windows)]
        let containment = OneShotContainment::job();
        #[cfg(unix)]
        let containment = match OneShotContainment::guardian(self.guardian_executable.clone()) {
            Ok(containment) => containment,
            Err(_) => return Box::pin(async { ToolchainCommandOutcome::Unavailable }),
        };
        let deadline = request.timeout().unwrap_or(INSTALL_TIMEOUT);
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

/// Integration-owned path and command environment for OpenClaw's Toolchain facts.
///
/// The path order follows the active delivery contract: explicit override, development resources,
/// then the packaged resources root. It is intentionally not serializable.
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

    async fn observe(&self) -> ToolchainStatus {
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

    async fn install_uv(&self) -> UvInstallOutcome {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolAvailability {
    Available,
    Unavailable,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PythonReadiness {
    Ready,
    NotReady,
    Unknown,
    Unavailable,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainCatalog {
    entries: Vec<ToolchainEntry>,
}

impl ToolchainCatalog {
    pub fn entries(&self) -> &[ToolchainEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainEntry {
    id: String,
    status: ToolAvailability,
}

impl ToolchainEntry {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn status(&self) -> ToolAvailability {
        self.status
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PermissionReadOutcome {
    Observed(tool_permission::Mode),
    Unavailable,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PermissionWriteOutcome {
    Unchanged,
    Written,
    Unavailable,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolchainWriteRequest {
    Permission(tool_permission::Mode),
    InstallUv,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolchainWriteOutcome {
    Permission(PermissionWriteOutcome),
    InstallUv(UvInstallOutcome),
}

/// OpenClaw Integration owner for local Toolchain facts and the existing config permission owner.
pub struct OpenClawToolchain {
    state_dir: CanonicalStateDir,
    runtime: Arc<NativeToolchainRuntime>,
}

impl OpenClawToolchain {
    pub fn new(state_dir: CanonicalStateDir, runtime: NativeToolchainRuntime) -> Self {
        Self {
            state_dir,
            runtime: Arc::new(runtime),
        }
    }

    pub async fn read(&self) -> ToolchainStatus {
        self.status().await
    }

    pub async fn status(&self) -> ToolchainStatus {
        self.runtime.observe().await
    }

    pub async fn list(&self) -> ToolchainCatalog {
        let status = self.status().await;
        ToolchainCatalog {
            entries: vec![
                ToolchainEntry {
                    id: UV_TOOL_ID.to_owned(),
                    status: status.uv,
                },
                ToolchainEntry {
                    id: PYTHON_TOOL_ID.to_owned(),
                    status: match status.python {
                        PythonReadiness::Ready => ToolAvailability::Available,
                        PythonReadiness::NotReady => ToolAvailability::Unavailable,
                        PythonReadiness::Unknown => ToolAvailability::Unknown,
                        PythonReadiness::Unavailable => ToolAvailability::Unavailable,
                        PythonReadiness::Unsupported => ToolAvailability::Unsupported,
                    },
                },
            ],
        }
    }

    pub fn read_permission(&self) -> PermissionReadOutcome {
        match tool_permission::Mode::read(self.state_dir.clone()) {
            Ok(mode) => PermissionReadOutcome::Observed(mode),
            Err(tool_permission::Error::Unavailable) => PermissionReadOutcome::Unavailable,
            Err(tool_permission::Error::Unknown) => PermissionReadOutcome::Unknown,
        }
    }

    pub fn write_permission(&self, mode: tool_permission::Mode) -> PermissionWriteOutcome {
        match mode.apply(self.state_dir.clone()) {
            Ok(tool_permission::Effect::Unchanged) => PermissionWriteOutcome::Unchanged,
            Ok(tool_permission::Effect::Written) => PermissionWriteOutcome::Written,
            Err(tool_permission::Error::Unavailable) => PermissionWriteOutcome::Unavailable,
            Err(tool_permission::Error::Unknown) => PermissionWriteOutcome::Unknown,
        }
    }

    pub async fn install_uv(&self) -> UvInstallOutcome {
        self.runtime.install_uv().await
    }

    pub async fn write(&self, request: ToolchainWriteRequest) -> ToolchainWriteOutcome {
        match request {
            ToolchainWriteRequest::Permission(mode) => {
                ToolchainWriteOutcome::Permission(self.write_permission(mode))
            }
            ToolchainWriteRequest::InstallUv => {
                ToolchainWriteOutcome::InstallUv(self.install_uv().await)
            }
        }
    }
}

impl fmt::Debug for OpenClawToolchain {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClawToolchain([REDACTED])")
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    use super::*;

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestRoot {
        path: PathBuf,
        state_dir: CanonicalStateDir,
    }

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must follow Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("openclaw-toolchain-{nanos}-{sequence}"));
            fs::create_dir_all(&path).unwrap();
            let state_dir = CanonicalStateDir::provision(path.join("state")).unwrap();
            Self { path, state_dir }
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
        requests: Mutex<Vec<ToolchainCommandRequest>>,
    }

    impl FakeCommands {
        fn new(outcomes: impl IntoIterator<Item = ToolchainCommandOutcome>) -> Arc<Self> {
            Arc::new(Self {
                outcomes: Mutex::new(outcomes.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
            })
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

        fn resolve_program(&self, program: &Path) -> Option<PathBuf> {
            Some(program.to_owned())
        }
    }

    #[tokio::test]
    async fn bundled_uv_is_available_without_a_path_probe() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([ToolchainCommandOutcome::Succeeded]);
        let bundled = root.bundled_uv(ToolchainPlatform::Unix);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"uv").unwrap();
        let owner = OpenClawToolchain::new(
            root.state_dir.clone(),
            root.runtime(ToolchainPlatform::Unix, commands.clone()),
        );

        let status = owner.read().await;
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
    async fn missing_bundled_uv_uses_the_platform_path_probe_with_the_legacy_timeout() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([
            ToolchainCommandOutcome::Succeeded,
            ToolchainCommandOutcome::Succeeded,
        ]);
        let owner = OpenClawToolchain::new(
            root.state_dir.clone(),
            root.runtime(ToolchainPlatform::Windows, commands.clone()),
        );

        let status = owner.status().await;
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
        let owner = OpenClawToolchain::new(
            root.state_dir.clone(),
            root.runtime(ToolchainPlatform::Unix, commands.clone()),
        );

        assert_eq!(owner.install_uv().await, UvInstallOutcome::Installed);
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
        let owner = OpenClawToolchain::new(
            root.state_dir.clone(),
            root.runtime(ToolchainPlatform::Unix, commands.clone()),
        );

        assert_eq!(owner.install_uv().await, UvInstallOutcome::Installed);
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
            let owner = OpenClawToolchain::new(
                root.state_dir.clone(),
                root.runtime(ToolchainPlatform::Unix, commands),
            );
            assert_eq!(owner.install_uv().await, expected);
            fs::remove_file(&bundled).unwrap();
        }
    }

    #[tokio::test]
    async fn status_and_list_expose_only_safe_facts_and_preserve_unknown_readiness() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([ToolchainCommandOutcome::TimedOut]);
        let owner = OpenClawToolchain::new(
            root.state_dir.clone(),
            root.runtime(ToolchainPlatform::Unix, commands),
        );

        let status = owner.status().await;
        assert_eq!(status.uv(), ToolAvailability::Unknown);
        assert_eq!(status.python(), PythonReadiness::Unknown);
        let catalog = owner.list().await;
        assert_eq!(
            serde_json::to_value(&catalog).unwrap(),
            json!({
                "entries": [
                    { "id": "uv", "status": "unknown" },
                    { "id": "python-3.12", "status": "unknown" }
                ]
            })
        );
        let rendered = serde_json::to_string(&catalog).unwrap();
        assert!(!rendered.contains(root.path.to_string_lossy().as_ref()));
        assert_eq!(format!("{owner:?}"), "OpenClawToolchain([REDACTED])");
    }

    #[tokio::test]
    async fn permission_read_write_uses_the_existing_permission_owner_and_readback() {
        let root = TestRoot::new();
        let owner = OpenClawToolchain::new(
            root.state_dir.clone(),
            root.runtime(
                ToolchainPlatform::Unix,
                FakeCommands::new([ToolchainCommandOutcome::Unsupported]),
            ),
        );

        assert_eq!(
            owner.read_permission(),
            PermissionReadOutcome::Observed(tool_permission::Mode::FullAccess)
        );
        assert_eq!(
            owner
                .write(ToolchainWriteRequest::Permission(
                    tool_permission::Mode::Default
                ))
                .await,
            ToolchainWriteOutcome::Permission(PermissionWriteOutcome::Written)
        );
        assert_eq!(
            owner.read_permission(),
            PermissionReadOutcome::Observed(tool_permission::Mode::Default)
        );
        assert_eq!(
            owner.write_permission(tool_permission::Mode::Default),
            PermissionWriteOutcome::Unchanged
        );
    }

    #[test]
    fn permission_outcomes_retain_unavailable_and_unknown_categories() {
        assert_eq!(
            PermissionWriteOutcome::Unavailable,
            PermissionWriteOutcome::Unavailable
        );
        assert_eq!(
            PermissionWriteOutcome::Unknown,
            PermissionWriteOutcome::Unknown
        );
        assert_eq!(
            PermissionWriteOutcome::Unsupported,
            PermissionWriteOutcome::Unsupported
        );
        assert_eq!(
            PermissionReadOutcome::Unknown,
            PermissionReadOutcome::Unknown
        );
        assert_eq!(
            PermissionReadOutcome::Unsupported,
            PermissionReadOutcome::Unsupported
        );
    }
}
