use std::{
    ffi::OsStr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use connectors::ports::ConnectorOperationFailure;
use foundation::process::{
    LaunchAttempt, LaunchAttemptFuture, LaunchAttemptMaterializer, LaunchSpec, ProcessContainment,
    ProcessObservation, ProcessStdio, ShutdownOutcome, StdioActivationResult, StdioDrain,
    StdioDrainResult, StdioMode, StdioSpec, TerminationOutcome, supervise,
    supervision::{
        CommandReceipt, CompletionError, GracefulStop, GracefulStopResult, PolicyFuture,
        ReadinessProbe, ReadinessResult, RestartDecision, RestartEpisode, RestartPolicy,
        StartOutcome, StartRecovery, StartRecoveryResult, StdioActivation, SupervisorFailure,
    },
};
use platform::state_dir::CanonicalStateDir;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::watch,
    time::{Instant, timeout_at},
};
use tokio_util::sync::CancellationToken;

const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
const LOGIN_BUDGET: Duration = Duration::from_secs(330);
const COMMAND_BUDGET: Duration = Duration::from_secs(30);

pub(super) struct McpCli {
    executable: PathBuf,
    entry: PathBuf,
    working_directory: PathBuf,
    environment_root: PathBuf,
    state_dir: CanonicalStateDir,
    containment: ProcessContainment,
}

pub(super) enum Command {
    Login(String),
    Status,
    Logout(String),
}

#[derive(Clone)]
pub(super) enum Handoff {
    Pending,
    AuthorizationUrl(String),
    Finished,
}

pub(super) struct Output {
    pub exit: Result<bool, ConnectorOperationFailure>,
    pub stdout: Vec<u8>,
    pub reaped: bool,
}

impl McpCli {
    pub(super) fn new(
        executable: PathBuf,
        entry: PathBuf,
        working_directory: PathBuf,
        environment_root: PathBuf,
        state_dir: CanonicalStateDir,
        containment: ProcessContainment,
    ) -> Self {
        Self {
            executable,
            entry,
            working_directory,
            environment_root,
            state_dir,
            containment,
        }
    }

    fn launch(&self, command: &Command) -> Result<LaunchSpec, ConnectorOperationFailure> {
        if !self.entry.is_absolute() || !self.environment_root.is_absolute() {
            return Err(ConnectorOperationFailure::Unavailable);
        }
        let mut environment =
            crate::lifecycle::launch::base_launch_environment(&self.environment_root)
                .map_err(|_| ConnectorOperationFailure::Unavailable)?;
        let overrides = [
            (
                "OPENCLAW_STATE_DIR",
                self.state_dir.as_path().as_os_str().to_owned(),
            ),
            (
                "OPENCLAW_CONFIG_DIR",
                self.state_dir.as_path().as_os_str().to_owned(),
            ),
            ("OPENCLAW_NO_RESPAWN", "1".into()),
            ("NODE_DISABLE_COMPILE_CACHE", "1".into()),
            ("OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED", "1".into()),
            ("OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED", "1".into()),
            ("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0".into()),
            ("FORCE_COLOR", "0".into()),
            ("NO_COLOR", "1".into()),
        ];
        environment.retain(|(key, _)| {
            !key.eq_ignore_ascii_case(OsStr::new("NODE_COMPILE_CACHE"))
                && !overrides
                    .iter()
                    .any(|(name, _)| key.eq_ignore_ascii_case(OsStr::new(name)))
        });
        environment.extend(
            overrides
                .into_iter()
                .map(|(key, value)| (key.into(), value)),
        );
        let mut arguments = vec![self.entry.clone().into_os_string(), "mcp".into()];
        match command {
            Command::Login(name) => arguments.extend(["login".into(), name.as_str().into()]),
            Command::Status => arguments.extend(["status".into(), "--json".into()]),
            Command::Logout(name) => arguments.extend(["logout".into(), name.as_str().into()]),
        }
        LaunchSpec::try_new(
            self.executable.clone(),
            self.working_directory.clone(),
            arguments,
            environment,
            StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped),
        )
        .map_err(|_| ConnectorOperationFailure::Unavailable)
    }

    pub(super) async fn run(
        &self,
        command: Command,
        cancellation: CancellationToken,
        shutdown: CancellationToken,
        handoff: Option<watch::Sender<Handoff>>,
    ) -> Output {
        let deadline = Instant::now()
            + if matches!(&command, Command::Login(_)) {
                LOGIN_BUDGET
            } else {
                COMMAND_BUDGET
            };
        let launch = match self.launch(&command) {
            Ok(launch) => launch,
            Err(error) => {
                return Output {
                    exit: Err(error),
                    stdout: Vec::new(),
                    reaped: true,
                };
            }
        };
        if cancellation.is_cancelled() || shutdown.is_cancelled() {
            return Output {
                exit: Err(ConnectorOperationFailure::Unavailable),
                stdout: Vec::new(),
                reaped: true,
            };
        }
        let capture = Capture {
            stdout: Arc::new(Mutex::new(Vec::new())),
            login_name: match &command {
                Command::Login(name) => Some(name.clone()),
                _ => None,
            },
            capture_json: matches!(&command, Command::Status),
            handoff,
        };
        let mut supervisor = supervise(
            self.containment.clone(),
            CliLaunch {
                launch: Some(launch),
                deadline,
            },
            capture.clone(),
            CliPolicy,
            CliPolicy,
            CliPolicy,
            CliPolicy,
        );
        let handle = supervisor.handle();
        let execution = async {
            match handle.start().await {
                CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                    match completion.wait().await {
                        Ok(StartOutcome::Started) => {}
                        Err(CompletionError::Failed(failure)) => return classify_failure(&failure),
                        _ => return Err(ConnectorOperationFailure::Unknown),
                    }
                }
                CommandReceipt::Busy | CommandReceipt::Rejected(_) => {
                    return Err(ConnectorOperationFailure::Unavailable);
                }
                _ => return Err(ConnectorOperationFailure::Unknown),
            }
            let mut snapshots = handle.subscribe();
            loop {
                if let Some(failure) = snapshots.borrow().failure() {
                    return classify_failure(failure);
                }
                snapshots
                    .changed()
                    .await
                    .map_err(|_| ConnectorOperationFailure::Unknown)?;
            }
        };
        let exit = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(ConnectorOperationFailure::Unknown),
            _ = shutdown.cancelled() => Err(ConnectorOperationFailure::Unknown),
            result = timeout_at(deadline, execution) => result.unwrap_or(Err(ConnectorOperationFailure::Unknown)),
        };
        // Foundation owns the proven process tree; never infer ownership from a callback port.
        let reaped = match handle.shutdown().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => matches!(
                completion.wait().await,
                Ok(ShutdownOutcome::Terminated(
                    TerminationOutcome::Forced(_)
                        | TerminationOutcome::Graceful(_)
                        | TerminationOutcome::NoProcess
                ))
            ),
            CommandReceipt::AlreadySatisfied => matches!(
                handle.snapshot().last_outcome(),
                Some(
                    foundation::process::supervision::SupervisorOutcome::ShutDown(
                        ShutdownOutcome::Terminated(
                            TerminationOutcome::Forced(_)
                                | TerminationOutcome::Graceful(_)
                                | TerminationOutcome::NoProcess
                        )
                    )
                )
            ),
            _ => false,
        };
        // Like the existing contained one-shot pattern, cleanup outlives the execution budget.
        let reaped = supervisor.join().await.is_ok() && reaped;
        let stdout = std::mem::take(&mut *capture.stdout.lock().expect("OAuth output lock"));
        Output {
            exit,
            stdout,
            reaped,
        }
    }
}

struct CliLaunch {
    launch: Option<LaunchSpec>,
    deadline: Instant,
}

impl LaunchAttemptMaterializer for CliLaunch {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let launch = self.launch.take();
        let deadline = self.deadline;
        Box::pin(async move {
            if Instant::now() >= deadline {
                return Err(
                    foundation::process::supervision::LaunchFailure::PlatformRejected.into(),
                );
            }
            let launch =
                launch.ok_or(foundation::process::supervision::LaunchFailure::PlatformRejected)?;
            Ok(LaunchAttempt::new(launch, ()))
        })
    }
}

fn classify_failure(failure: &SupervisorFailure) -> Result<bool, ConnectorOperationFailure> {
    match failure {
        SupervisorFailure::Exited(exit) => Ok(exit.exit_code() == Some(0)),
        SupervisorFailure::LaunchFailed(_) => Err(ConnectorOperationFailure::Unavailable),
        _ => Err(ConnectorOperationFailure::Unknown),
    }
}

#[derive(Clone)]
struct Capture {
    stdout: Arc<Mutex<Vec<u8>>>,
    login_name: Option<String>,
    capture_json: bool,
    handoff: Option<watch::Sender<Handoff>>,
}

impl StdioActivation for Capture {
    fn activate(
        &self,
        _: ProcessObservation,
        stdio: ProcessStdio,
        _: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        let capture = self.clone();
        Box::pin(async move {
            let (stdin, Some(stdout), Some(stderr)) = stdio.into_parts() else {
                return StdioActivationResult::Unavailable;
            };
            if stdin.is_some() {
                return StdioActivationResult::Unavailable;
            }
            StdioActivationResult::Activated(StdioDrain::new(async move {
                match tokio::try_join!(capture.drain(stdout, true), capture.drain(stderr, false)) {
                    Ok(_) => StdioDrainResult::Drained,
                    Err(_) => StdioDrainResult::Unavailable,
                }
            }))
        })
    }
}

impl Capture {
    async fn drain(&self, mut output: impl AsyncRead + Unpin, is_stdout: bool) -> Result<(), ()> {
        let mut chunk = [0; 8192];
        let mut bytes = 0;
        let mut line = Vec::new();
        let mut expects_url = false;
        loop {
            let read = output.read(&mut chunk).await.map_err(|_| ())?;
            if read == 0 {
                return Ok(());
            }
            bytes += read;
            if bytes > MAX_OUTPUT_BYTES {
                return Err(());
            }
            if !is_stdout {
                continue;
            }
            if self.capture_json {
                self.stdout
                    .lock()
                    .expect("OAuth output lock")
                    .extend_from_slice(&chunk[..read]);
            }
            if let Some(name) = &self.login_name {
                for byte in &chunk[..read] {
                    if *byte != b'\n' {
                        if line.len() == MAX_LINE_BYTES {
                            return Err(());
                        }
                        line.push(*byte);
                        continue;
                    }
                    let text = std::str::from_utf8(&line)
                        .map_err(|_| ())?
                        .trim_end_matches('\r');
                    // Private, version-bound decoder for the current public CLI's two log lines.
                    if expects_url {
                        let url = reqwest::Url::parse(text).map_err(|_| ())?;
                        if !matches!(url.scheme(), "http" | "https")
                            || url.host_str().is_none()
                            || !url.username().is_empty()
                            || url.password().is_some()
                            || url.fragment().is_some()
                            || url.query_pairs().any(|(key, _)| {
                                let key = key.to_ascii_lowercase().replace(['-', '_'], "");
                                key.contains("token")
                                    || key.contains("secret")
                                    || key.contains("password")
                                    || key.contains("apikey")
                                    || key == "code"
                                    || key == "authorization"
                            })
                            || text.chars().any(|character| {
                                character.is_control() || character.is_whitespace()
                            })
                        {
                            return Err(());
                        }
                        if let Some(handoff) = &self.handoff {
                            handoff.send_replace(Handoff::AuthorizationUrl(text.to_owned()));
                        }
                    }
                    expects_url = text == format!("Open this URL to authorize \"{name}\":");
                    line.clear();
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
struct CliPolicy;
impl ReadinessProbe for CliPolicy {
    fn wait_ready(
        &self,
        _: ProcessObservation,
        _: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        Box::pin(async { ReadinessResult::Ready })
    }
}
impl GracefulStop for CliPolicy {
    fn grace_period(&self) -> Duration {
        Duration::from_secs(1)
    }
    fn request_stop(
        &self,
        _: ProcessObservation,
        _: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        Box::pin(async { GracefulStopResult::Rejected })
    }
}
impl StartRecovery for CliPolicy {
    fn recover(
        &self,
        _: SupervisorFailure,
        _: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        Box::pin(async { StartRecoveryResult::Fail })
    }
}
impl RestartPolicy for CliPolicy {
    fn decide(&self, _: &SupervisorFailure, _: RestartEpisode) -> RestartDecision {
        RestartDecision::Halt
    }
}
