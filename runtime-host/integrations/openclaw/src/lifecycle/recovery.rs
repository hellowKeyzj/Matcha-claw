use std::{
    ffi::{OsStr, OsString},
    fmt,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use foundation::process::supervision::{
    LaunchFailure, PolicyFuture, StartRecovery, StartRecoveryResult, SupervisorFailure,
};
#[cfg(windows)]
use foundation::process::windows_system_root;
use tokio_util::sync::CancellationToken;

use super::{
    launch::OpenClawLaunchInput,
    logs::{LifecycleDiagnostic, LifecycleDiagnosticCategory, LifecycleDiagnosticState},
};

const MAX_STARTUP_RETRIES: u8 = 2;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const DOCTOR_REPAIR_TIMEOUT: Duration = Duration::from_secs(60);
const ELECTRON_RUN_AS_NODE: &str = "ELECTRON_RUN_AS_NODE";
const PATH_ENV: &str = "PATH";
const OPENCLAW_NO_RESPAWN: &str = "OPENCLAW_NO_RESPAWN";
const OPENCLAW_STATE_DIR: &str = "OPENCLAW_STATE_DIR";
const UV_PYTHON_INSTALL_MIRROR: &str = "UV_PYTHON_INSTALL_MIRROR";
const UV_PYTHON_INSTALL_MIRROR_URL: &str =
    "https://registry.npmmirror.com/-/binary/python-build-standalone/";
const UV_INDEX_URL: &str = "UV_INDEX_URL";
const UV_INDEX_MIRROR_URL: &str = "https://pypi.tuna.tsinghua.edu.cn/simple/";
#[cfg(windows)]
const SYSTEM_ROOT: &str = "SystemRoot";
const DOCTOR_ARGS: [&str; 4] = ["doctor", "--fix", "--yes", "--non-interactive"];

#[derive(Clone, Copy)]
enum StartupFailure {
    ResourceUnavailable,
    ReadinessFailed,
    Exited,
    Diagnostic(LifecycleDiagnosticCategory),
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidConfigRepairDecision {
    Repaired,
    Unrepaired,
    Rejected,
}

pub type InvalidConfigRepairFuture =
    Pin<Box<dyn Future<Output = InvalidConfigRepairDecision> + Send + 'static>>;

pub trait InvalidConfigRepair: Send + Sync + 'static {
    fn repair(&self, cancellation: CancellationToken) -> InvalidConfigRepairFuture;
}

struct NoInvalidConfigRepair;

impl InvalidConfigRepair for NoInvalidConfigRepair {
    fn repair(&self, _cancellation: CancellationToken) -> InvalidConfigRepairFuture {
        Box::pin(async { InvalidConfigRepairDecision::Unrepaired })
    }
}

#[derive(Clone)]
pub struct OpenClawDoctorRepair {
    spec: Arc<DoctorRepairSpec>,
    runner: Arc<dyn DoctorRepairRunner>,
}

impl OpenClawDoctorRepair {
    pub fn new(input: OpenClawLaunchInput) -> Result<Self, DoctorRepairError> {
        Ok(Self::with_runner(
            input,
            Arc::new(ProcessDoctorRepairRunner),
        )?)
    }

    pub fn with_runner(
        input: OpenClawLaunchInput,
        runner: Arc<dyn DoctorRepairRunner>,
    ) -> Result<Self, DoctorRepairError> {
        Ok(Self {
            spec: Arc::new(DoctorRepairSpec::new(input)?),
            runner,
        })
    }
}

impl InvalidConfigRepair for OpenClawDoctorRepair {
    fn repair(&self, cancellation: CancellationToken) -> InvalidConfigRepairFuture {
        let spec = Arc::clone(&self.spec);
        let runner = Arc::clone(&self.runner);
        Box::pin(async move { runner.run(&spec, cancellation).await.into() })
    }
}

#[derive(Clone)]
pub struct DoctorRepairSpec {
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    timeout: Duration,
}

impl DoctorRepairSpec {
    fn new(input: OpenClawLaunchInput) -> Result<Self, DoctorRepairError> {
        validate_repair_input(&input)?;
        let mut environment = vec![
            (ELECTRON_RUN_AS_NODE.into(), "1".into()),
            (OPENCLAW_NO_RESPAWN.into(), "1".into()),
            (OPENCLAW_STATE_DIR.into(), input.state_dir.as_path().into()),
        ];
        if let Some((key, path)) = path_environment(&input.working_directory) {
            environment.push((key, path));
        }
        environment.extend(uv_environment());
        #[cfg(windows)]
        environment.push((
            SYSTEM_ROOT.into(),
            windows_system_root().map_err(|_| DoctorRepairError::InvalidInput)?,
        ));
        Ok(Self {
            executable: input.electron_image,
            working_directory: input.openclaw_dir,
            arguments: std::iter::once(input.entry.into_os_string())
                .chain(DOCTOR_ARGS.into_iter().map(OsString::from))
                .collect(),
            environment,
            timeout: DOCTOR_REPAIR_TIMEOUT,
        })
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn working_directory(&self) -> &Path {
        &self.working_directory
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub fn environment(&self) -> &[(OsString, OsString)] {
        &self.environment
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }
}

impl fmt::Debug for DoctorRepairSpec {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("DoctorRepairSpec(<redacted>)")
    }
}

pub trait DoctorRepairRunner: Send + Sync + 'static {
    fn run(&self, spec: &DoctorRepairSpec, cancellation: CancellationToken) -> DoctorRepairFuture;
}

pub type DoctorRepairFuture = Pin<Box<dyn Future<Output = DoctorRepairOutcome> + Send + 'static>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DoctorRepairOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

impl From<DoctorRepairOutcome> for InvalidConfigRepairDecision {
    fn from(outcome: DoctorRepairOutcome) -> Self {
        match outcome {
            DoctorRepairOutcome::Succeeded => Self::Repaired,
            DoctorRepairOutcome::Failed => Self::Unrepaired,
            DoctorRepairOutcome::Cancelled => Self::Rejected,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DoctorRepairError {
    InvalidInput,
}

impl fmt::Display for DoctorRepairError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("OpenClaw doctor repair input is invalid")
    }
}

impl std::error::Error for DoctorRepairError {}

struct ProcessDoctorRepairRunner;

impl DoctorRepairRunner for ProcessDoctorRepairRunner {
    fn run(&self, spec: &DoctorRepairSpec, cancellation: CancellationToken) -> DoctorRepairFuture {
        let spec = spec.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || run_doctor_repair_process(&spec, cancellation))
                .await
                .unwrap_or(DoctorRepairOutcome::Failed)
        })
    }
}

fn run_doctor_repair_process(
    spec: &DoctorRepairSpec,
    cancellation: CancellationToken,
) -> DoctorRepairOutcome {
    if cancellation.is_cancelled() {
        return DoctorRepairOutcome::Cancelled;
    }
    let mut child = match spawn_doctor_repair(spec) {
        Ok(child) => child,
        Err(_) => return DoctorRepairOutcome::Failed,
    };
    let deadline = Instant::now() + spec.timeout;
    loop {
        if cancellation.is_cancelled() {
            terminate_child(&mut child);
            return DoctorRepairOutcome::Cancelled;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    DoctorRepairOutcome::Succeeded
                } else {
                    DoctorRepairOutcome::Failed
                };
            }
            Ok(None) => {}
            Err(_) => {
                terminate_child(&mut child);
                return DoctorRepairOutcome::Failed;
            }
        }
        if Instant::now() >= deadline {
            terminate_child(&mut child);
            return DoctorRepairOutcome::Failed;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn spawn_doctor_repair(spec: &DoctorRepairSpec) -> Result<Child, std::io::Error> {
    let mut command = Command::new(&spec.executable);
    command
        .args(&spec.arguments)
        .current_dir(&spec.working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .envs(spec.environment.iter().cloned());
    command.spawn()
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn validate_repair_input(input: &OpenClawLaunchInput) -> Result<(), DoctorRepairError> {
    if !input.electron_image.is_absolute()
        || !input.working_directory.is_absolute()
        || !input.openclaw_dir.is_absolute()
        || !input.entry.is_absolute()
        || input.state_dir.as_path().as_os_str().is_empty()
    {
        return Err(DoctorRepairError::InvalidInput);
    }
    Ok(())
}

fn path_environment(working_directory: &Path) -> Option<(OsString, OsString)> {
    let inherited = inherited_path_environment();
    if let Some(path) = bundled_bin_path(working_directory) {
        let (key, current) = inherited.unwrap_or_else(|| (preferred_path_key(), OsString::new()));
        return Some((key, prepend_path(&path, &current)));
    }
    inherited
}

fn uv_environment() -> [(OsString, OsString); 2] {
    [
        (
            UV_PYTHON_INSTALL_MIRROR.into(),
            UV_PYTHON_INSTALL_MIRROR_URL.into(),
        ),
        (UV_INDEX_URL.into(), UV_INDEX_MIRROR_URL.into()),
    ]
}

fn bundled_bin_path(working_directory: &Path) -> Option<PathBuf> {
    let packaged = working_directory.join("bin");
    if packaged.is_dir() {
        return Some(packaged);
    }

    let target = bundled_target_name()?;
    let development = working_directory.join("resources").join("bin").join(target);
    development.is_dir().then_some(development)
}

fn bundled_target_name() -> Option<String> {
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return None;
    };
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some(format!("{platform}-{architecture}"))
}

fn inherited_path_environment() -> Option<(OsString, OsString)> {
    select_path_environment(std::env::vars_os(), cfg!(windows))
}

fn select_path_environment(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
    windows: bool,
) -> Option<(OsString, OsString)> {
    let mut selected: Option<(OsString, OsString)> = None;
    for (key, value) in environment {
        if !key.eq_ignore_ascii_case(OsStr::new(PATH_ENV)) {
            continue;
        }
        let should_replace = selected.as_ref().is_none_or(|(selected_key, _)| {
            path_key_priority(&key, windows) < path_key_priority(selected_key.as_os_str(), windows)
        });
        if should_replace {
            selected = Some((key, value));
        }
    }
    selected
}

fn path_key_priority(key: &OsStr, windows: bool) -> u8 {
    if windows {
        if key == OsStr::new("Path") {
            0
        } else if key == OsStr::new(PATH_ENV) {
            1
        } else {
            2
        }
    } else if key == OsStr::new(PATH_ENV) {
        0
    } else {
        1
    }
}

fn preferred_path_key() -> OsString {
    if cfg!(windows) {
        OsString::from("Path")
    } else {
        OsString::from(PATH_ENV)
    }
}

fn prepend_path(entry: &Path, current: &OsStr) -> OsString {
    let delimiter = if cfg!(windows) { ";" } else { ":" };
    if current.is_empty() {
        entry.as_os_str().to_owned()
    } else {
        let mut value = entry.as_os_str().to_owned();
        value.push(delimiter);
        value.push(current);
        value
    }
}

pub struct OpenClawStartRecovery {
    first_episode_attempts: Arc<AtomicU8>,
    invalid_config_repair_attempted: Arc<AtomicBool>,
    diagnostics: LifecycleDiagnosticState,
    invalid_config_repair: Arc<dyn InvalidConfigRepair>,
}

impl OpenClawStartRecovery {
    pub fn new() -> Self {
        Self::with_diagnostics_and_invalid_config_repair(
            LifecycleDiagnostic::state(),
            Arc::new(NoInvalidConfigRepair),
        )
    }

    pub fn with_diagnostics(diagnostics: LifecycleDiagnosticState) -> Self {
        Self::with_diagnostics_and_invalid_config_repair(
            diagnostics,
            Arc::new(NoInvalidConfigRepair),
        )
    }

    pub fn with_diagnostics_and_invalid_config_repair(
        diagnostics: LifecycleDiagnosticState,
        invalid_config_repair: Arc<dyn InvalidConfigRepair>,
    ) -> Self {
        Self {
            first_episode_attempts: Arc::new(AtomicU8::new(0)),
            invalid_config_repair_attempted: Arc::new(AtomicBool::new(false)),
            diagnostics,
            invalid_config_repair,
        }
    }
}

impl Default for OpenClawStartRecovery {
    fn default() -> Self {
        Self::new()
    }
}

impl StartRecovery for OpenClawStartRecovery {
    fn recover(
        &self,
        failure: SupervisorFailure,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        let first_episode_attempts = Arc::clone(&self.first_episode_attempts);
        let invalid_config_repair_attempted = Arc::clone(&self.invalid_config_repair_attempted);
        let diagnostics = self.diagnostics.clone();
        let invalid_config_repair = Arc::clone(&self.invalid_config_repair);

        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StartRecoveryResult::Cancelled;
            }
            match classify_startup_failure_with_diagnostics(&failure, &diagnostics) {
                StartupFailure::Diagnostic(LifecycleDiagnosticCategory::ConfigurationRejected) => {
                    if invalid_config_repair_attempted.swap(true, Ordering::Relaxed) {
                        return StartRecoveryResult::Fail;
                    }
                    match invalid_config_repair.repair(cancellation.clone()).await {
                        InvalidConfigRepairDecision::Repaired => {
                            StartRecoveryResult::RetryAfter(RETRY_DELAY)
                        }
                        InvalidConfigRepairDecision::Unrepaired => StartRecoveryResult::Fail,
                        InvalidConfigRepairDecision::Rejected => StartRecoveryResult::Rejected,
                    }
                }
                failure if is_recoverable_startup_failure(failure) => {
                    match first_episode_attempts.fetch_update(
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                        |attempts| {
                            (attempts < MAX_STARTUP_RETRIES).then_some(attempts.saturating_add(1))
                        },
                    ) {
                        Ok(_) => StartRecoveryResult::RetryAfter(RETRY_DELAY),
                        Err(_) => StartRecoveryResult::Fail,
                    }
                }
                _ => StartRecoveryResult::Fail,
            }
        })
    }
}

fn classify_startup_failure_with_diagnostics(
    failure: &SupervisorFailure,
    diagnostics: &LifecycleDiagnosticState,
) -> StartupFailure {
    if matches!(
        failure,
        SupervisorFailure::ReadinessFailed | SupervisorFailure::Exited(_)
    ) {
        if let Some(diagnostic) = latest_startup_diagnostic(diagnostics) {
            return StartupFailure::Diagnostic(diagnostic);
        }
    }
    match failure {
        SupervisorFailure::LaunchFailed(LaunchFailure::ResourceUnavailable) => {
            StartupFailure::ResourceUnavailable
        }
        SupervisorFailure::ReadinessFailed => StartupFailure::ReadinessFailed,
        SupervisorFailure::Exited(_) => StartupFailure::Exited,
        _ => StartupFailure::Other,
    }
}

fn latest_startup_diagnostic(
    diagnostics: &LifecycleDiagnosticState,
) -> Option<LifecycleDiagnosticCategory> {
    diagnostics
        .snapshot()
        .into_iter()
        .rev()
        .find(|category| is_startup_diagnostic(*category))
}

const fn is_startup_diagnostic(category: LifecycleDiagnosticCategory) -> bool {
    matches!(
        category,
        LifecycleDiagnosticCategory::ConfigurationRejected
            | LifecycleDiagnosticCategory::PortConflict
            | LifecycleDiagnosticCategory::BindRejected
            | LifecycleDiagnosticCategory::StartupFailed
    )
}

fn is_recoverable_startup_failure(failure: StartupFailure) -> bool {
    matches!(
        failure,
        StartupFailure::ResourceUnavailable
            | StartupFailure::ReadinessFailed
            | StartupFailure::Exited
            | StartupFailure::Diagnostic(LifecycleDiagnosticCategory::StartupFailed)
    )
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsString,
        fs,
        future::Future,
        path::{Path, PathBuf},
        sync::{
            Arc, Barrier,
            atomic::{AtomicU64, AtomicUsize, Ordering as AtomicOrdering},
        },
        task::{Context, Poll, Waker},
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    use foundation::process::TerminationFailure;

    use crate::gateway::auth::GatewaySecret;
    use platform::state_dir::CanonicalStateDir;

    use super::*;

    fn resolve(future: PolicyFuture<StartRecoveryResult>) -> StartRecoveryResult {
        let mut context = Context::from_waker(Waker::noop());
        let mut future = future;

        match Future::poll(future.as_mut(), &mut context) {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("startup recovery decision must be immediate"),
        }
    }

    fn recover(policy: &OpenClawStartRecovery, failure: SupervisorFailure) -> StartRecoveryResult {
        resolve(policy.recover(failure, CancellationToken::new()))
    }

    fn recover_async(
        policy: &OpenClawStartRecovery,
        failure: SupervisorFailure,
    ) -> StartRecoveryResult {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(policy.recover(failure, CancellationToken::new()))
    }

    const SECRET_CANARY: &str = "synthetic-openclaw-recovery-token";
    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot {
        cleanup_root: PathBuf,
        state_dir: CanonicalStateDir,
        working_directory: PathBuf,
        openclaw_dir: PathBuf,
        entry: PathBuf,
        electron_image: PathBuf,
    }

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, AtomicOrdering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let cleanup_root = std::env::temp_dir().join(format!(
                "openclaw-recovery-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&cleanup_root).unwrap();
            let state_dir = CanonicalStateDir::provision(cleanup_root.join("state")).unwrap();
            let working_directory = cleanup_root.join("working");
            let openclaw_dir = cleanup_root.join("openclaw");
            fs::create_dir(&working_directory).unwrap();
            fs::create_dir(&openclaw_dir).unwrap();
            let entry = openclaw_dir.join("openclaw.mjs");
            fs::write(&entry, b"").unwrap();
            let electron_image = executable_path(&cleanup_root);
            fs::write(&electron_image, b"").unwrap();
            Self {
                cleanup_root,
                state_dir,
                working_directory,
                openclaw_dir,
                entry,
                electron_image,
            }
        }

        fn launch_input(&self) -> OpenClawLaunchInput {
            OpenClawLaunchInput {
                electron_image: self.electron_image.clone(),
                working_directory: self.working_directory.clone(),
                openclaw_dir: self.openclaw_dir.clone(),
                entry: self.entry.clone(),
                state_dir: self.state_dir.clone(),
                port: 18_789,
                secret: Arc::new(GatewaySecret::new(SECRET_CANARY.into()).unwrap()),
            }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.cleanup_root);
        }
    }

    fn executable_path(root: &Path) -> PathBuf {
        root.join(if cfg!(windows) {
            "MatchaClaw.exe"
        } else {
            "MatchaClaw"
        })
    }

    fn diagnostic(category: LifecycleDiagnosticCategory) -> LifecycleDiagnostic {
        LifecycleDiagnostic::new(super::super::logs::LogStream::Stderr, category)
    }

    #[test]
    fn retries_only_recoverable_startup_failure_classes() {
        let recoverable = [
            StartupFailure::ResourceUnavailable,
            StartupFailure::ReadinessFailed,
            StartupFailure::Exited,
        ];

        for failure in recoverable {
            assert!(is_recoverable_startup_failure(failure));
        }
        assert!(is_recoverable_startup_failure(StartupFailure::Diagnostic(
            LifecycleDiagnosticCategory::StartupFailed
        )));

        assert!(!is_recoverable_startup_failure(StartupFailure::Diagnostic(
            LifecycleDiagnosticCategory::ConfigurationRejected
        )));
        assert!(!is_recoverable_startup_failure(StartupFailure::Diagnostic(
            LifecycleDiagnosticCategory::PortConflict
        )));
        assert!(!is_recoverable_startup_failure(StartupFailure::Diagnostic(
            LifecycleDiagnosticCategory::BindRejected
        )));
        assert!(!is_recoverable_startup_failure(StartupFailure::Other));
    }

    #[test]
    fn maps_typed_supervisor_failures_to_startup_failure_classes() {
        let recoverable = [
            SupervisorFailure::LaunchFailed(LaunchFailure::ResourceUnavailable),
            SupervisorFailure::ReadinessFailed,
        ];
        let diagnostics = LifecycleDiagnosticState::new();
        for failure in recoverable {
            assert!(is_recoverable_startup_failure(
                classify_startup_failure_with_diagnostics(&failure, &diagnostics)
            ));
        }

        let unrecoverable = [
            SupervisorFailure::LaunchFailed(LaunchFailure::ArtifactUnavailable),
            SupervisorFailure::LaunchFailed(LaunchFailure::PermissionDenied),
            SupervisorFailure::LaunchFailed(LaunchFailure::PlatformRejected),
            SupervisorFailure::StdioFailed,
            SupervisorFailure::Termination(TerminationFailure::AuthorityLost),
            SupervisorFailure::Termination(TerminationFailure::CleanupUnconfirmed),
        ];
        for failure in unrecoverable {
            assert!(matches!(
                classify_startup_failure_with_diagnostics(&failure, &diagnostics),
                StartupFailure::Other
            ));
        }
    }

    #[test]
    fn maps_latest_lifecycle_diagnostic_to_startup_failure_class() {
        let diagnostics = LifecycleDiagnosticState::new();
        diagnostics.record(diagnostic(
            LifecycleDiagnosticCategory::ConfigurationRejected,
        ));
        assert!(matches!(
            classify_startup_failure_with_diagnostics(
                &SupervisorFailure::ReadinessFailed,
                &diagnostics,
            ),
            StartupFailure::Diagnostic(LifecycleDiagnosticCategory::ConfigurationRejected)
        ));

        diagnostics.record(diagnostic(LifecycleDiagnosticCategory::PortConflict));
        assert!(matches!(
            classify_startup_failure_with_diagnostics(
                &SupervisorFailure::ReadinessFailed,
                &diagnostics,
            ),
            StartupFailure::Diagnostic(LifecycleDiagnosticCategory::PortConflict)
        ));
    }

    #[test]
    fn rejects_port_conflict_and_bind_rejected_without_consuming_retry_budget() {
        for category in [
            LifecycleDiagnosticCategory::PortConflict,
            LifecycleDiagnosticCategory::BindRejected,
        ] {
            let diagnostics = LifecycleDiagnosticState::new();
            diagnostics.record(diagnostic(category));
            let policy = OpenClawStartRecovery::with_diagnostics(diagnostics);

            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::Fail,
            );
            assert_eq!(
                recover(
                    &policy,
                    SupervisorFailure::LaunchFailed(LaunchFailure::ResourceUnavailable),
                ),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
    }

    #[test]
    fn doctor_repair_spec_matches_legacy_doctor_fix_command() {
        let root = TestRoot::new();
        let repair = OpenClawDoctorRepair::with_runner(
            root.launch_input(),
            Arc::new(RepairProbe::new(InvalidConfigRepairDecision::Repaired)),
        )
        .unwrap();
        let spec = repair.spec.as_ref();

        assert_eq!(spec.executable(), root.electron_image.as_path());
        assert_eq!(spec.working_directory(), root.openclaw_dir.as_path());
        assert_eq!(
            spec.arguments(),
            [
                root.entry.clone().into_os_string(),
                "doctor".into(),
                "--fix".into(),
                "--yes".into(),
                "--non-interactive".into(),
            ]
        );
        assert_eq!(spec.timeout(), DOCTOR_REPAIR_TIMEOUT);
        assert!(
            spec.environment()
                .contains(&(ELECTRON_RUN_AS_NODE.into(), "1".into()))
        );
        assert!(
            spec.environment()
                .contains(&(OPENCLAW_NO_RESPAWN.into(), "1".into()))
        );
        assert!(
            spec.environment()
                .contains(&(OPENCLAW_STATE_DIR.into(), root.state_dir.as_path().into()))
        );
        assert!(
            spec.environment()
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case(OsStr::new(PATH_ENV)))
        );
        assert!(!spec.environment().iter().any(|(key, value)| {
            key == "OPENCLAW_CONFIG_PATH"
                || value == root.state_dir.as_path().join("openclaw.json").as_os_str()
                || value == OsString::from(SECRET_CANARY).as_os_str()
        }));
    }

    #[test]
    fn doctor_repair_spec_prepends_bundled_bin_to_path() {
        let root = TestRoot::new();
        let bundled = root.working_directory.join("bin");
        fs::create_dir(&bundled).unwrap();
        let repair = OpenClawDoctorRepair::with_runner(
            root.launch_input(),
            Arc::new(RepairProbe::new(InvalidConfigRepairDecision::Repaired)),
        )
        .unwrap();
        let inherited = inherited_path_environment();
        let (key, current) = inherited.unwrap_or_else(|| (preferred_path_key(), OsString::new()));

        assert!(
            repair
                .spec
                .environment()
                .contains(&(key, prepend_path(&bundled, &current)))
        );
    }

    #[test]
    fn doctor_repair_spec_debug_redacts_paths_and_secret_material() {
        let root = TestRoot::new();
        let repair = OpenClawDoctorRepair::with_runner(
            root.launch_input(),
            Arc::new(RepairProbe::new(InvalidConfigRepairDecision::Repaired)),
        )
        .unwrap();

        let rendered = format!("{:?}", repair.spec);

        assert!(!rendered.contains(root.cleanup_root.to_string_lossy().as_ref()));
        assert!(!rendered.contains(SECRET_CANARY));
    }

    #[test]
    fn doctor_repair_runner_maps_outcome_to_decision_and_receives_cancellation() {
        let root = TestRoot::new();
        for (outcome, decision) in [
            (
                DoctorRepairOutcome::Succeeded,
                InvalidConfigRepairDecision::Repaired,
            ),
            (
                DoctorRepairOutcome::Failed,
                InvalidConfigRepairDecision::Unrepaired,
            ),
            (
                DoctorRepairOutcome::Cancelled,
                InvalidConfigRepairDecision::Rejected,
            ),
        ] {
            let runner = Arc::new(DoctorRunnerProbe::new(outcome));
            let repair =
                OpenClawDoctorRepair::with_runner(root.launch_input(), runner.clone()).unwrap();
            let cancellation = CancellationToken::new();
            cancellation.cancel();

            assert_eq!(
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(repair.repair(cancellation)),
                decision
            );
            assert_eq!(runner.calls(), 1);
            assert!(runner.last_cancelled());
            assert_eq!(
                runner.last_arguments(),
                vec![
                    root.entry.clone().into_os_string(),
                    "doctor".into(),
                    "--fix".into(),
                    "--yes".into(),
                    "--non-interactive".into(),
                ]
            );
        }
    }

    #[test]
    fn invalid_config_uses_one_injected_repair_decision() {
        let diagnostics = LifecycleDiagnosticState::new();
        diagnostics.record(diagnostic(
            LifecycleDiagnosticCategory::ConfigurationRejected,
        ));
        let repair = Arc::new(RepairProbe::new(InvalidConfigRepairDecision::Repaired));
        let policy = OpenClawStartRecovery::with_diagnostics_and_invalid_config_repair(
            diagnostics,
            repair.clone(),
        );

        assert_eq!(
            recover_async(&policy, SupervisorFailure::ReadinessFailed),
            StartRecoveryResult::RetryAfter(RETRY_DELAY),
        );
        assert_eq!(
            recover_async(&policy, SupervisorFailure::ReadinessFailed),
            StartRecoveryResult::Fail,
        );
        assert_eq!(repair.calls(), 1);
    }

    #[test]
    fn invalid_config_repair_can_reject_or_leave_unrepaired_without_retrying() {
        for (repair_decision, recovery_decision) in [
            (
                InvalidConfigRepairDecision::Unrepaired,
                StartRecoveryResult::Fail,
            ),
            (
                InvalidConfigRepairDecision::Rejected,
                StartRecoveryResult::Rejected,
            ),
        ] {
            let diagnostics = LifecycleDiagnosticState::new();
            diagnostics.record(diagnostic(
                LifecycleDiagnosticCategory::ConfigurationRejected,
            ));
            let policy = OpenClawStartRecovery::with_diagnostics_and_invalid_config_repair(
                diagnostics,
                Arc::new(RepairProbe::new(repair_decision)),
            );

            assert_eq!(
                recover_async(&policy, SupervisorFailure::ReadinessFailed),
                recovery_decision,
            );
        }
    }

    struct RepairProbe {
        decision: InvalidConfigRepairDecision,
        calls: AtomicUsize,
    }

    impl RepairProbe {
        fn new(decision: InvalidConfigRepairDecision) -> Self {
            Self {
                decision,
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(AtomicOrdering::Relaxed)
        }
    }

    impl InvalidConfigRepair for RepairProbe {
        fn repair(&self, _cancellation: CancellationToken) -> InvalidConfigRepairFuture {
            self.calls.fetch_add(1, AtomicOrdering::Relaxed);
            let decision = self.decision;
            Box::pin(async move { decision })
        }
    }

    impl DoctorRepairRunner for RepairProbe {
        fn run(
            &self,
            _spec: &DoctorRepairSpec,
            _cancellation: CancellationToken,
        ) -> DoctorRepairFuture {
            self.calls.fetch_add(1, AtomicOrdering::Relaxed);
            let decision = self.decision;
            Box::pin(async move {
                match decision {
                    InvalidConfigRepairDecision::Repaired => DoctorRepairOutcome::Succeeded,
                    InvalidConfigRepairDecision::Unrepaired => DoctorRepairOutcome::Failed,
                    InvalidConfigRepairDecision::Rejected => DoctorRepairOutcome::Cancelled,
                }
            })
        }
    }

    struct DoctorRunnerProbe {
        outcome: DoctorRepairOutcome,
        calls: AtomicUsize,
        last_cancelled: AtomicBool,
        last_arguments: std::sync::Mutex<Vec<OsString>>,
    }

    impl DoctorRunnerProbe {
        fn new(outcome: DoctorRepairOutcome) -> Self {
            Self {
                outcome,
                calls: AtomicUsize::new(0),
                last_cancelled: AtomicBool::new(false),
                last_arguments: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(AtomicOrdering::Relaxed)
        }

        fn last_cancelled(&self) -> bool {
            self.last_cancelled.load(AtomicOrdering::Relaxed)
        }

        fn last_arguments(&self) -> Vec<OsString> {
            self.last_arguments.lock().unwrap().clone()
        }
    }

    impl DoctorRepairRunner for DoctorRunnerProbe {
        fn run(
            &self,
            spec: &DoctorRepairSpec,
            cancellation: CancellationToken,
        ) -> DoctorRepairFuture {
            self.calls.fetch_add(1, AtomicOrdering::Relaxed);
            self.last_cancelled
                .store(cancellation.is_cancelled(), AtomicOrdering::Relaxed);
            *self.last_arguments.lock().unwrap() = spec.arguments().to_vec();
            let outcome = self.outcome;
            Box::pin(async move { outcome })
        }
    }

    #[test]
    fn first_startup_episode_allows_two_retries_after_the_initial_attempt() {
        let policy = OpenClawStartRecovery::new();

        for _ in 0..MAX_STARTUP_RETRIES {
            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
        assert_eq!(
            recover(&policy, SupervisorFailure::ReadinessFailed),
            StartRecoveryResult::Fail,
        );
    }

    #[test]
    fn unrecoverable_failures_do_not_consume_or_reset_the_episode_budget() {
        let policy = OpenClawStartRecovery::new();

        assert_eq!(
            recover(
                &policy,
                SupervisorFailure::LaunchFailed(LaunchFailure::PermissionDenied),
            ),
            StartRecoveryResult::Fail,
        );
        for _ in 0..MAX_STARTUP_RETRIES {
            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
        assert_eq!(
            recover(
                &policy,
                SupervisorFailure::LaunchFailed(LaunchFailure::ArtifactUnavailable),
            ),
            StartRecoveryResult::Fail,
        );
        assert_eq!(
            recover(&policy, SupervisorFailure::ReadinessFailed),
            StartRecoveryResult::Fail,
        );
    }

    #[test]
    fn cancellation_precedes_failure_classification_and_budget_consumption() {
        let policy = OpenClawStartRecovery::new();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            resolve(policy.recover(
                SupervisorFailure::LaunchFailed(LaunchFailure::PermissionDenied),
                cancellation.clone(),
            )),
            StartRecoveryResult::Cancelled,
        );
        assert_eq!(
            resolve(policy.recover(SupervisorFailure::ReadinessFailed, cancellation)),
            StartRecoveryResult::Cancelled,
        );
        for _ in 0..MAX_STARTUP_RETRIES {
            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
    }

    #[test]
    fn concurrent_failures_share_one_two_retry_budget() {
        const CALLS: usize = 12;

        let policy = Arc::new(OpenClawStartRecovery::new());
        let start = Arc::new(Barrier::new(CALLS));
        let workers = (0..CALLS)
            .map(|_| {
                let policy = Arc::clone(&policy);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    recover(&policy, SupervisorFailure::ReadinessFailed)
                })
            })
            .collect::<Vec<_>>();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(
            results
                .iter()
                .filter(|result| **result == StartRecoveryResult::RetryAfter(RETRY_DELAY))
                .count(),
            MAX_STARTUP_RETRIES as usize,
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == StartRecoveryResult::Fail)
                .count(),
            CALLS - MAX_STARTUP_RETRIES as usize,
        );
    }

    #[test]
    fn a_new_policy_instance_starts_a_new_first_episode() {
        let exhausted = OpenClawStartRecovery::new();
        for _ in 0..MAX_STARTUP_RETRIES {
            assert_eq!(
                recover(&exhausted, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
        assert_eq!(
            recover(&exhausted, SupervisorFailure::ReadinessFailed),
            StartRecoveryResult::Fail,
        );

        assert_eq!(
            recover(
                &OpenClawStartRecovery::new(),
                SupervisorFailure::ReadinessFailed,
            ),
            StartRecoveryResult::RetryAfter(RETRY_DELAY),
        );
    }
}
