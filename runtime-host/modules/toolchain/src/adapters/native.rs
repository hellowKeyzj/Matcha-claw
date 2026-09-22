use std::{
    ffi::OsString,
    fmt, fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

pub use foundation::toolchain::{
    FoundationToolchainCommandPort, PrivateEnvVar, ToolchainCommandFuture, ToolchainCommandOutcome,
    ToolchainCommandPort, ToolchainCommandRequest, ToolchainEnvProjection,
    ToolchainEnvProjectionStatus, ToolchainPythonResolution, UnsupportedToolchainCommandPort,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolchainPlatform {
    Windows,
    Unix,
}

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
            Self::Unix if cfg!(target_os = "macos") => "darwin",
            Self::Unix if cfg!(target_os = "linux") => "linux",
            Self::Unix => "unix",
        }
    }
}

const PYTHON_INSTALL_ARGUMENTS: [&str; 3] = ["python", "install", "3.12"];
const PYTHON_READINESS_ARGUMENTS: [&str; 3] = ["python", "find", "3.12"];
const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(30);
const UV_TOOL_ID: &str = "uv";

use crate::domain::model::{
    PrepareOutcome, PythonReadiness, ToolAvailability, ToolchainError, ToolchainStatus,
};

/// Local third-party uv/Python owner shared by peer runtimes.
pub struct NativeToolchain {
    platform: ToolchainPlatform,
    arch: String,
    working_directory: PathBuf,
    uv_override: Option<PathBuf>,
    commands: Arc<dyn ToolchainCommandPort>,
    prepare: tokio::sync::Mutex<()>,
}

impl NativeToolchain {
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
            prepare: tokio::sync::Mutex::new(()),
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
    pub fn from_process(commands: Arc<dyn ToolchainCommandPort>) -> Result<Self, ToolchainError> {
        let working_directory =
            std::env::current_dir().map_err(|_| ToolchainError::WorkingDirectoryUnavailable)?;
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
        let target = format!(
            "{}-{}",
            self.platform.target_name(),
            resource_arch_key(&self.arch)
        );
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

    pub async fn status(&self) -> ToolchainStatus {
        match self.uv_path().await {
            Ok(executable) => ToolchainStatus::new(
                ToolAvailability::Available,
                self.observe_python(&executable).await,
            ),
            Err(UvResolution::Unavailable) => {
                ToolchainStatus::new(ToolAvailability::Unavailable, PythonReadiness::Unavailable)
            }
            Err(UvResolution::Unknown) => {
                ToolchainStatus::new(ToolAvailability::Unknown, PythonReadiness::Unknown)
            }
            Err(UvResolution::Unsupported) => {
                ToolchainStatus::new(ToolAvailability::Unsupported, PythonReadiness::Unsupported)
            }
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

    pub async fn prepare(&self) -> PrepareOutcome {
        let _single_flight = self.prepare.lock().await;
        let executable = match self.uv_path().await {
            Ok(path) => path,
            Err(UvResolution::Unavailable) => return PrepareOutcome::Unavailable,
            Err(UvResolution::Unknown) => return PrepareOutcome::Unknown,
            Err(UvResolution::Unsupported) => return PrepareOutcome::Unsupported,
        };
        match self.observe_python(&executable).await {
            PythonReadiness::Ready => return PrepareOutcome::Ready,
            PythonReadiness::NotReady => {}
            PythonReadiness::Unavailable => return PrepareOutcome::Unavailable,
            PythonReadiness::Unknown => return PrepareOutcome::Unknown,
            PythonReadiness::Unsupported => return PrepareOutcome::Unsupported,
        }
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
                    ToolchainCommandOutcome::Succeeded => PrepareOutcome::Installed,
                    ToolchainCommandOutcome::Failed => PrepareOutcome::Rejected,
                    ToolchainCommandOutcome::Unavailable => PrepareOutcome::Unavailable,
                    ToolchainCommandOutcome::TimedOut | ToolchainCommandOutcome::Unknown => {
                        PrepareOutcome::Unknown
                    }
                    ToolchainCommandOutcome::Unsupported => PrepareOutcome::Unsupported,
                }
            }
            ToolchainCommandOutcome::Failed => PrepareOutcome::Rejected,
            ToolchainCommandOutcome::Unavailable => PrepareOutcome::Unavailable,
            ToolchainCommandOutcome::TimedOut | ToolchainCommandOutcome::Unknown => {
                PrepareOutcome::Unknown
            }
            ToolchainCommandOutcome::Unsupported => PrepareOutcome::Unsupported,
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

impl fmt::Debug for NativeToolchain {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeToolchain([REDACTED])")
    }
}

fn resource_arch_key(arch: &str) -> &str {
    match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => arch,
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

fn is_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UvResolution {
    Unavailable,
    Unknown,
    Unsupported,
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap, VecDeque},
        ffi::OsStr,
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
            let path = std::env::temp_dir().join(format!("toolchain-{nanos}-{sequence}"));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn runtime(
            &self,
            platform: ToolchainPlatform,
            commands: Arc<FakeCommands>,
        ) -> NativeToolchain {
            self.runtime_with_arch(platform, "x64", commands)
        }

        fn runtime_with_arch(
            &self,
            platform: ToolchainPlatform,
            arch: impl Into<String>,
            commands: Arc<FakeCommands>,
        ) -> NativeToolchain {
            NativeToolchain::new(platform, arch, self.path.clone(), None, commands)
        }

        fn bundled_uv(&self, platform: ToolchainPlatform) -> PathBuf {
            self.bundled_uv_for_arch(platform, "x64")
        }

        fn bundled_uv_for_arch(&self, platform: ToolchainPlatform, arch: &str) -> PathBuf {
            let executable = match platform {
                ToolchainPlatform::Windows => "uv.exe",
                ToolchainPlatform::Unix => "uv",
            };
            self.path
                .join("resources/bin")
                .join(format!(
                    "{}-{}",
                    platform.target_name(),
                    resource_arch_key(arch)
                ))
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

        fn resolve_python(
            &self,
            request: ToolchainCommandRequest,
        ) -> foundation::toolchain::ToolchainResolveFuture<'_> {
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

        let status = runtime.status().await;
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

        let status = runtime.status().await;
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
        let runtime = NativeToolchain::new(
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
        assert_eq!(format!("{runtime:?}"), "NativeToolchain([REDACTED])");
    }

    #[test]
    fn native_candidates_use_electron_resource_arch_keys() {
        let root = TestRoot::new();
        for (platform, arch, expected_arch) in [
            (ToolchainPlatform::Windows, "x86_64", "x64"),
            (ToolchainPlatform::Windows, "aarch64", "arm64"),
            (ToolchainPlatform::Windows, "x64", "x64"),
            (ToolchainPlatform::Windows, "arm64", "arm64"),
            (ToolchainPlatform::Unix, "x86_64", "x64"),
            (ToolchainPlatform::Unix, "aarch64", "arm64"),
            (ToolchainPlatform::Unix, "riscv64", "riscv64"),
        ] {
            let runtime = NativeToolchain::new(
                platform,
                arch,
                root.path.clone(),
                None,
                Arc::new(UnsupportedToolchainCommandPort),
            );
            let candidates = runtime.bundled_uv_path_candidates();
            let executable = platform.bundled_uv_name();
            let expected_target = format!("{}-{}", platform.target_name(), expected_arch);

            assert!(
                candidates.contains(
                    &root
                        .path
                        .join("resources/bin")
                        .join(expected_target)
                        .join(executable)
                )
            );
        }
    }

    #[tokio::test]
    async fn prepare_uses_bundled_uv_and_the_fixed_python_install_arguments() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([
            ToolchainCommandOutcome::Failed,
            ToolchainCommandOutcome::Succeeded,
            ToolchainCommandOutcome::Succeeded,
        ]);
        let bundled = root.bundled_uv(ToolchainPlatform::Unix);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"uv").unwrap();
        let runtime = root.runtime(ToolchainPlatform::Unix, commands.clone());

        assert_eq!(runtime.prepare().await, PrepareOutcome::Installed);
        let requests = commands.requests();
        assert_eq!(requests.len(), 3);
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
        assert_eq!(requests[1].program(), bundled);
        assert_eq!(
            requests[1].arguments(),
            &[
                OsString::from("python"),
                OsString::from("install"),
                OsString::from("3.12")
            ]
        );
        assert_eq!(requests[1].timeout(), Some(INSTALL_TIMEOUT));
        assert_eq!(requests[2].program(), bundled);
        assert_eq!(
            requests[2].arguments(),
            &[
                OsString::from("python"),
                OsString::from("find"),
                OsString::from("3.12")
            ]
        );
        assert_eq!(requests[2].timeout(), Some(PATH_PROBE_TIMEOUT));
    }

    #[tokio::test]
    async fn path_probe_and_prepare_use_uv_when_no_bundled_binary_exists() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([
            ToolchainCommandOutcome::Succeeded,
            ToolchainCommandOutcome::Failed,
            ToolchainCommandOutcome::Succeeded,
            ToolchainCommandOutcome::Succeeded,
        ]);
        let runtime = root.runtime(ToolchainPlatform::Unix, commands.clone());

        assert_eq!(runtime.prepare().await, PrepareOutcome::Installed);
        let requests = commands.requests();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].program(), Path::new("which"));
        assert_eq!(requests[1].program(), Path::new("uv"));
        assert_eq!(requests[2].program(), Path::new("uv"));
        assert_eq!(requests[3].program(), Path::new("uv"));
        assert_eq!(
            requests[3].arguments(),
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
            (
                ToolchainCommandOutcome::Unavailable,
                PrepareOutcome::Unavailable,
            ),
            (ToolchainCommandOutcome::TimedOut, PrepareOutcome::Unknown),
            (ToolchainCommandOutcome::Unknown, PrepareOutcome::Unknown),
            (
                ToolchainCommandOutcome::Unsupported,
                PrepareOutcome::Unsupported,
            ),
        ] {
            let commands = FakeCommands::new([command_outcome]);
            let bundled = root.bundled_uv(ToolchainPlatform::Unix);
            fs::create_dir_all(bundled.parent().unwrap()).unwrap();
            fs::write(&bundled, b"uv").unwrap();
            let runtime = root.runtime(ToolchainPlatform::Unix, commands);
            assert_eq!(runtime.prepare().await, expected);
            fs::remove_file(&bundled).unwrap();
        }

        let commands = FakeCommands::new([
            ToolchainCommandOutcome::Failed,
            ToolchainCommandOutcome::Failed,
        ]);
        let bundled = root.bundled_uv(ToolchainPlatform::Unix);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"uv").unwrap();
        let runtime = root.runtime(ToolchainPlatform::Unix, commands);
        assert_eq!(runtime.prepare().await, PrepareOutcome::Rejected);
    }

    #[tokio::test]
    async fn status_exposes_only_safe_facts_and_preserves_unknown_readiness() {
        let root = TestRoot::new();
        let commands = FakeCommands::new([ToolchainCommandOutcome::TimedOut]);
        let runtime = root.runtime(ToolchainPlatform::Unix, commands);

        let status = runtime.status().await;
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
