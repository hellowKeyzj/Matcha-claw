use std::{
    ffi::{OsStr, OsString},
    fmt,
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
};
use tokio_util::sync::CancellationToken;

use super::{
    launch::{OpenClawLaunchInput, base_launch_environment},
    logs::{LifecycleLogBuffer, LifecycleLogClassifier, LogStream},
};

// Native Doctor allows 30 seconds per database; full repair can visit multiple stores.
const DOCTOR_REPAIR_TIMEOUT: Duration = Duration::from_secs(300);
const DOCTOR_ARGS: [&str; 3] = ["doctor", "--fix", "--non-interactive"];

#[derive(Clone)]
pub struct OpenClawDoctorRepair {
    spec: Arc<DoctorRepairSpec>,
}

impl OpenClawDoctorRepair {
    pub fn new(input: OpenClawLaunchInput) -> Result<Self, DoctorRepairError> {
        Ok(Self {
            spec: Arc::new(DoctorRepairSpec::new(input)?),
        })
    }

    pub async fn run(
        &self,
        cancellation: CancellationToken,
        logs: LifecycleLogBuffer,
    ) -> DoctorRepairOutcome {
        logs.append(LogStream::Stdout, b"[doctor] repair started");
        let outcome = self.run_process(cancellation, &logs).await;
        logs.append(
            LogStream::Stdout,
            format!("[doctor] repair {outcome:?}").as_bytes(),
        );
        outcome
    }

    async fn run_process(
        &self,
        cancellation: CancellationToken,
        logs: &LifecycleLogBuffer,
    ) -> DoctorRepairOutcome {
        if cancellation.is_cancelled() {
            return DoctorRepairOutcome::Cancelled;
        }
        let spec = &self.spec;
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.arguments)
            .current_dir(&spec.working_directory)
            .env_clear()
            .envs(spec.environment.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => return DoctorRepairOutcome::SpawnFailed,
        };
        let stdout = child.stdout.take().expect("doctor stdout is piped");
        let stderr = child.stderr.take().expect("doctor stderr is piped");
        let outcome = tokio::select! {
            biased;
            _ = cancellation.cancelled() => DoctorRepairOutcome::Cancelled,
            _ = tokio::time::sleep(DOCTOR_REPAIR_TIMEOUT) => DoctorRepairOutcome::TimedOut,
            result = async {
                tokio::try_join!(
                    child.wait(),
                    drain_output(stdout, LogStream::Stdout, logs.clone()),
                    drain_output(stderr, LogStream::Stderr, logs.clone()),
                )
            } => match result {
                Ok((status, (), ())) if status.success() => return DoctorRepairOutcome::Succeeded,
                Ok(_) => return DoctorRepairOutcome::Failed,
                Err(_) => DoctorRepairOutcome::Failed,
            },
        };
        if !terminate_child(&mut child).await {
            logs.append(
                LogStream::Stderr,
                b"[doctor] child cleanup unconfirmed; repair failed",
            );
            return DoctorRepairOutcome::Failed;
        }
        outcome
    }
}

struct DoctorRepairSpec {
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
}

impl DoctorRepairSpec {
    fn new(input: OpenClawLaunchInput) -> Result<Self, DoctorRepairError> {
        if !input.electron_image.is_absolute()
            || !input.working_directory.is_absolute()
            || !input.openclaw_dir.is_absolute()
            || !input.entry.is_absolute()
        {
            return Err(DoctorRepairError::InvalidInput);
        }
        let mut environment = base_launch_environment(&input.working_directory)
            .map_err(|_| DoctorRepairError::InvalidInput)?;
        environment.retain(|(key, _)| {
            !key.eq_ignore_ascii_case(OsStr::new("OPENCLAW_SERVICE_REPAIR_POLICY"))
        });
        environment.extend([
            (
                "OPENCLAW_STATE_DIR".into(),
                input.state_dir.as_path().into(),
            ),
            (
                "OPENCLAW_CONFIG_DIR".into(),
                input.state_dir.as_path().into(),
            ),
            ("OPENCLAW_NO_RESPAWN".into(), "1".into()),
            ("OPENCLAW_SERVICE_REPAIR_POLICY".into(), "external".into()),
        ]);
        Ok(Self {
            executable: input.electron_image,
            working_directory: input.openclaw_dir,
            arguments: std::iter::once(input.entry.into_os_string())
                .chain(DOCTOR_ARGS.into_iter().map(OsString::from))
                .collect(),
            environment,
        })
    }
}

impl fmt::Debug for DoctorRepairSpec {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("DoctorRepairSpec(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DoctorRepairOutcome {
    Succeeded,
    Failed,
    TimedOut,
    Cancelled,
    SpawnFailed,
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

async fn drain_output(
    mut output: impl AsyncRead + Unpin,
    stream: LogStream,
    logs: LifecycleLogBuffer,
) -> std::io::Result<()> {
    let mut classifier = LifecycleLogClassifier::with_buffer(stream, logs);
    let mut chunk = [0; 8 * 1024];
    loop {
        let read = output.read(&mut chunk).await?;
        if read == 0 {
            classifier.finish();
            return Ok(());
        }
        // Doctor output is a private tail, never a Gateway startup diagnostic.
        classifier.push(&chunk[..read]);
    }
}

async fn terminate_child(child: &mut Child) -> bool {
    let _ = child.start_kill();
    // Keep the caller's lifecycle permit until the owned process has been reaped.
    child.wait().await.is_ok()
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path,
        sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::gateway::auth::GatewaySecret;
    use platform::state_dir::CanonicalStateDir;

    use super::*;

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

    #[test]
    fn doctor_repair_spec_matches_native_doctor_fix_command() {
        let root = TestRoot::new();
        let repair = OpenClawDoctorRepair::new(root.launch_input()).unwrap();
        let spec = repair.spec.as_ref();

        assert_eq!(spec.executable.as_path(), root.electron_image.as_path());
        assert_eq!(
            spec.working_directory.as_path(),
            root.openclaw_dir.as_path()
        );
        assert_eq!(
            spec.arguments,
            [
                root.entry.clone().into_os_string(),
                "doctor".into(),
                "--fix".into(),
                "--non-interactive".into(),
            ]
        );
        assert!(
            spec.environment
                .contains(&("ELECTRON_RUN_AS_NODE".into(), "1".into()))
        );
        assert!(
            spec.environment
                .contains(&("OPENCLAW_NO_RESPAWN".into(), "1".into()))
        );
        assert!(
            spec.environment
                .contains(&("OPENCLAW_STATE_DIR".into(), root.state_dir.as_path().into()))
        );
        assert!(
            spec.environment
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case(OsStr::new("PATH")))
        );
        assert!(!spec.environment.iter().any(|(key, value)| {
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
        let repair = OpenClawDoctorRepair::new(root.launch_input()).unwrap();
        let (_, path) = repair
            .spec
            .environment
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(OsStr::new("PATH")))
            .unwrap();
        assert_eq!(
            std::env::split_paths(path).next().as_deref(),
            Some(bundled.as_path())
        );
    }

    #[test]
    fn doctor_repair_spec_debug_redacts_paths_and_secret_material() {
        let root = TestRoot::new();
        let repair = OpenClawDoctorRepair::new(root.launch_input()).unwrap();

        let rendered = format!("{:?}", repair.spec);

        assert!(!rendered.contains(root.cleanup_root.to_string_lossy().as_ref()));
        assert!(!rendered.contains(SECRET_CANARY));
    }
}
