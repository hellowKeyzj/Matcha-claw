use std::{
    ffi::OsString,
    fmt, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use foundation::process::{
    self, AuthorityClass, FixedLaunch, LaunchSpec, ProcessObservation, ProcessStdio, Provenance,
    StdioActivationResult, StdioDrain, StdioDrainResult, StdioMode, StdioSpec,
    supervision::{
        CommandReceipt, GracefulStop, GracefulStopResult, PolicyFuture, ReadinessProbe,
        ReadinessResult, RestartDecision, RestartEpisode, RestartPolicy, StartOutcome,
        StartRecovery, StartRecoveryResult, StdioActivation, SupervisorFailure,
    },
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{
    DIRECTORY_ENV, NONCE_ENV, ROLE_ENV, SCENARIO_ENV, platform,
    protocol::{
        FixtureDirectory, Nonce, Phase, ProcessIdentity, ProtocolError, Record, Role, Scenario,
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_GRACE_PERIOD: Duration = Duration::from_millis(100);
const MANAGED_TARGET_TEST: &str = "supervisor_host::managed_target";
const MANAGED_MEMBER_TEST: &str = "supervisor_host::managed_member";
const TARGET_ROOT_IDENTITY_FILE: &str = "target-root.identity";
const TARGET_MEMBER_IDENTITY_FILE: &str = "target-member.identity";
#[cfg(unix)]
const TARGET_GUARDIAN_IDENTITY_FILE: &str = "target-guardian.identity";
const TARGET_READY_FILE: &str = "target.ready";
const TARGET_RELEASE_FILE: &str = "target.release";
const TARGET_ROOT_IDENTITY_ENV: &str = "FOUNDATION_PROCESS_FIXTURE_TARGET_ROOT_IDENTITY";
const TARGET_MEMBER_IDENTITY_ENV: &str = "FOUNDATION_PROCESS_FIXTURE_TARGET_MEMBER_IDENTITY";
#[cfg(unix)]
const TARGET_GUARDIAN_IDENTITY_ENV: &str = "FOUNDATION_PROCESS_FIXTURE_TARGET_GUARDIAN_IDENTITY";
const TARGET_READY_ENV: &str = "FOUNDATION_PROCESS_FIXTURE_TARGET_READY";
const TARGET_RELEASE_ENV: &str = "FOUNDATION_PROCESS_FIXTURE_TARGET_RELEASE";

#[cfg(unix)]
type VerifierGuard = std::process::Child;
#[cfg(windows)]
type VerifierGuard = platform::OwnedHandle;

pub(crate) async fn run(
    scenario: Scenario,
    nonce: Nonce,
    directory: FixtureDirectory,
) -> Result<(), SupervisorHostError> {
    record(
        &nonce,
        scenario,
        Phase::Spawned,
        platform::current_identity().map_err(|_| SupervisorHostError::CurrentIdentity)?,
        &directory,
    )?;

    let _verifier = spawn_verifier(scenario, &nonce, &directory)?;
    let target_paths = TargetPaths::new(&directory);
    let launch = target_launch_spec(&directory, &target_paths)?;
    let deadline = Instant::now() + START_TIMEOUT;
    let readiness = TargetReadiness {
        marker: target_paths.ready.clone(),
        deadline,
    };

    #[cfg(windows)]
    let supervisor = process::supervise(
        process::ProcessContainment::job(),
        FixedLaunch::new(launch),
        DrainNullStdio,
        readiness,
        PendingStop,
        NoRecovery,
        HaltOnFailure,
    );
    #[cfg(unix)]
    let supervisor = process::supervise(
        process::ProcessContainment::guardian(PathBuf::from(env!(
            "CARGO_BIN_EXE_runtime-host-guardian"
        )))
        .expect("fixture process guardian executable is a compile-time binary path"),
        FixedLaunch::new(launch),
        DrainNullStdio,
        readiness,
        PendingStop,
        NoRecovery,
        HaltOnFailure,
    );

    let handle = supervisor.handle();
    await_started(&handle, deadline).await?;
    let observed = handle
        .snapshot()
        .process()
        .ok_or(SupervisorHostError::TargetObservationMissing)?;
    require_owned_scope(observed)?;

    let target_identity = read_identity(&target_paths.root_identity)
        .map_err(|_| SupervisorHostError::TargetIdentity)?;
    if target_identity.pid() != observed.identity().pid() {
        return Err(SupervisorHostError::TargetIdentity);
    }
    let member_identity = read_identity(&target_paths.member_identity)
        .map_err(|_| SupervisorHostError::TargetMemberIdentity)?;
    if member_identity == target_identity
        || !platform::is_exact_identity_alive(member_identity)
            .map_err(|_| SupervisorHostError::TargetMemberIdentity)?
    {
        return Err(SupervisorHostError::TargetMemberIdentity);
    }

    #[cfg(windows)]
    record(&nonce, scenario, Phase::Armed, member_identity, &directory)?;
    #[cfg(unix)]
    {
        let guardian_identity = read_identity(&target_paths.guardian_identity)
            .map_err(|_| SupervisorHostError::TargetGuardianIdentity)?;
        if guardian_identity == target_identity
            || guardian_identity == member_identity
            || !platform::is_exact_identity_alive(guardian_identity)
                .map_err(|_| SupervisorHostError::TargetGuardianIdentity)?
        {
            return Err(SupervisorHostError::TargetGuardianIdentity);
        }
        record(
            &nonce,
            scenario,
            Phase::Armed,
            guardian_identity,
            &directory,
        )?;
    }

    record(&nonce, scenario, Phase::Ready, target_identity, &directory)?;

    let _supervisor = supervisor;
    std::future::pending::<Result<(), SupervisorHostError>>().await
}

fn record(
    nonce: &Nonce,
    scenario: Scenario,
    phase: Phase,
    identity: ProcessIdentity,
    directory: &FixtureDirectory,
) -> Result<(), SupervisorHostError> {
    Record::new(
        nonce.clone(),
        scenario,
        Role::SupervisorHost,
        phase,
        identity,
    )
    .append_to(directory)
    .map_err(Into::into)
}

fn spawn_verifier(
    scenario: Scenario,
    nonce: &Nonce,
    directory: &FixtureDirectory,
) -> Result<VerifierGuard, SupervisorHostError> {
    let executable = std::env::current_exe().map_err(|_| SupervisorHostError::CurrentExecutable)?;
    let mut command = Command::new(executable);
    command
        .args(std::env::args_os().skip(1))
        .env_clear()
        .env(ROLE_ENV, Role::Verifier.as_str())
        .env(SCENARIO_ENV, scenario.as_str())
        .env(NONCE_ENV, nonce.as_str())
        .env(DIRECTORY_ENV, directory.path())
        .stdin(Stdio::null());

    #[cfg(unix)]
    return command
        .spawn()
        .map_err(|_| SupervisorHostError::VerifierSpawn);
    #[cfg(windows)]
    return platform::spawn_host_kill_verifier(&mut command)
        .map_err(|_| SupervisorHostError::VerifierSpawn);
}

async fn await_started(
    handle: &foundation::process::supervision::SupervisorHandle,
    deadline: Instant,
) -> Result<(), SupervisorHostError> {
    let receipt = tokio::time::timeout_at(deadline, handle.start())
        .await
        .map_err(|_| SupervisorHostError::StartDeadline)?;
    let completion = match receipt {
        CommandReceipt::Accepted(completion) => completion,
        CommandReceipt::Shared(_)
        | CommandReceipt::AlreadySatisfied
        | CommandReceipt::Busy
        | CommandReceipt::Rejected(_)
        | CommandReceipt::ShuttingDown => return Err(SupervisorHostError::StartRejected),
    };
    let outcome = tokio::time::timeout_at(deadline, completion.wait())
        .await
        .map_err(|_| SupervisorHostError::StartDeadline)?
        .map_err(|_| SupervisorHostError::StartFailed)?;
    match outcome {
        StartOutcome::Started => Ok(()),
        StartOutcome::Cancelled { .. } => Err(SupervisorHostError::StartFailed),
    }
}

fn require_owned_scope(observed: ProcessObservation) -> Result<(), SupervisorHostError> {
    let provenance = observed.provenance();
    match provenance {
        Provenance::Spawned { .. } if provenance.class() == AuthorityClass::Owned => Ok(()),
        Provenance::Spawned { .. } | Provenance::Attached { .. } => {
            Err(SupervisorHostError::TargetNotOwned)
        }
    }
}

struct TargetPaths {
    root_identity: PathBuf,
    member_identity: PathBuf,
    #[cfg(unix)]
    guardian_identity: PathBuf,
    ready: PathBuf,
    release: PathBuf,
}

impl TargetPaths {
    fn new(directory: &FixtureDirectory) -> Self {
        Self {
            root_identity: directory.path().join(TARGET_ROOT_IDENTITY_FILE),
            member_identity: directory.path().join(TARGET_MEMBER_IDENTITY_FILE),
            #[cfg(unix)]
            guardian_identity: directory.path().join(TARGET_GUARDIAN_IDENTITY_FILE),
            ready: directory.path().join(TARGET_READY_FILE),
            release: directory.path().join(TARGET_RELEASE_FILE),
        }
    }
}

fn target_launch_spec(
    directory: &FixtureDirectory,
    paths: &TargetPaths,
) -> Result<LaunchSpec, SupervisorHostError> {
    let public_environment = [
        (
            OsString::from(TARGET_ROOT_IDENTITY_ENV),
            paths.root_identity.as_os_str().to_owned(),
        ),
        (
            OsString::from(TARGET_MEMBER_IDENTITY_ENV),
            paths.member_identity.as_os_str().to_owned(),
        ),
        #[cfg(unix)]
        (
            OsString::from(TARGET_GUARDIAN_IDENTITY_ENV),
            paths.guardian_identity.as_os_str().to_owned(),
        ),
        (
            OsString::from(TARGET_READY_ENV),
            paths.ready.as_os_str().to_owned(),
        ),
        (
            OsString::from(TARGET_RELEASE_ENV),
            paths.release.as_os_str().to_owned(),
        ),
    ];

    LaunchSpec::try_new(
        std::env::current_exe().map_err(|_| SupervisorHostError::CurrentExecutable)?,
        directory.path().to_owned(),
        [
            OsString::from("--exact"),
            OsString::from(MANAGED_TARGET_TEST),
            OsString::from("--test-threads=1"),
        ],
        public_environment,
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .map_err(|_| SupervisorHostError::TargetLaunchSpec)
}

#[derive(Clone, Copy)]
struct DrainNullStdio;

impl StdioActivation for DrainNullStdio {
    fn activate(
        &self,
        _: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StdioActivationResult::Cancelled;
            }
            let (stdin, stdout, stderr) = stdio.into_parts();
            if stdin.is_some() || stdout.is_some() || stderr.is_some() {
                return StdioActivationResult::Unavailable;
            }
            StdioActivationResult::Activated(StdioDrain::new(async { StdioDrainResult::Drained }))
        })
    }
}

#[derive(Clone)]
struct TargetReadiness {
    marker: PathBuf,
    deadline: Instant,
}

impl ReadinessProbe for TargetReadiness {
    fn wait_ready(
        &self,
        _: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        let marker = self.marker.clone();
        let deadline = self.deadline;
        Box::pin(async move {
            loop {
                if Instant::now() >= deadline {
                    return ReadinessResult::Unavailable;
                }
                if marker.exists() {
                    return ReadinessResult::Ready;
                }
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return ReadinessResult::Cancelled,
                    _ = tokio::time::sleep_until(deadline) => return ReadinessResult::Unavailable,
                    _ = tokio::time::sleep(POLL_INTERVAL) => {}
                }
            }
        })
    }
}

#[derive(Clone, Copy)]
struct PendingStop;

impl GracefulStop for PendingStop {
    fn grace_period(&self) -> Duration {
        STOP_GRACE_PERIOD
    }

    fn request_stop(
        &self,
        _: ProcessObservation,
        _: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        Box::pin(std::future::pending())
    }
}

#[derive(Clone, Copy)]
struct NoRecovery;

impl StartRecovery for NoRecovery {
    fn recover(
        &self,
        _: SupervisorFailure,
        _: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        Box::pin(async { StartRecoveryResult::Fail })
    }
}

#[derive(Clone, Copy)]
struct HaltOnFailure;

impl RestartPolicy for HaltOnFailure {
    fn decide(&self, _: &SupervisorFailure, _: RestartEpisode) -> RestartDecision {
        RestartDecision::Halt
    }
}

#[test]
fn managed_target() {
    let Some(root_identity_path) = std::env::var_os(TARGET_ROOT_IDENTITY_ENV).map(PathBuf::from)
    else {
        return;
    };
    let member_identity_path = required_helper_path(TARGET_MEMBER_IDENTITY_ENV);
    #[cfg(unix)]
    let guardian_identity_path = required_helper_path(TARGET_GUARDIAN_IDENTITY_ENV);
    let ready_path = required_helper_path(TARGET_READY_ENV);
    let release_path = required_helper_path(TARGET_RELEASE_ENV);
    let executable = std::env::current_exe().expect("fixture target executable resolution failed");

    let mut member = Command::new(executable)
        .args([
            OsString::from("--exact"),
            OsString::from(MANAGED_MEMBER_TEST),
            OsString::from("--test-threads=1"),
        ])
        .env_clear()
        .env(TARGET_MEMBER_IDENTITY_ENV, &member_identity_path)
        .env(TARGET_RELEASE_ENV, &release_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("fixture target member spawn failed");

    wait_for_helper_marker(&member_identity_path, &mut member);
    let root_identity =
        platform::current_identity().expect("fixture target identity observation failed");
    write_identity(&root_identity_path, root_identity);
    #[cfg(unix)]
    {
        let sentinel_identity = platform::parent_identity(root_identity)
            .expect("fixture target direct parent identity observation failed");
        let guardian_identity = platform::parent_identity(sentinel_identity)
            .expect("fixture target guardian identity observation failed");
        write_identity(&guardian_identity_path, guardian_identity);
    }
    fs::write(ready_path, b"ready").expect("fixture target readiness write failed");
    member.wait().expect("fixture target member wait failed");
}

#[test]
fn managed_member() {
    let Some(identity_path) = std::env::var_os(TARGET_MEMBER_IDENTITY_ENV).map(PathBuf::from)
    else {
        return;
    };
    let release_path = required_helper_path(TARGET_RELEASE_ENV);
    write_current_identity(&identity_path);

    while !release_path.exists() {
        thread::sleep(POLL_INTERVAL);
    }
}

fn required_helper_path(name: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .expect("fixture target environment is incomplete")
}

fn wait_for_helper_marker(path: &Path, child: &mut std::process::Child) {
    let deadline = std::time::Instant::now() + START_TIMEOUT;
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "fixture target member readiness deadline elapsed"
        );
        assert!(
            child
                .try_wait()
                .expect("fixture target member observation failed")
                .is_none(),
            "fixture target member exited before readiness"
        );
        thread::sleep(POLL_INTERVAL);
    }
}

fn write_current_identity(path: &Path) {
    let identity =
        platform::current_identity().expect("fixture target identity observation failed");
    write_identity(path, identity);
}

fn write_identity(path: &Path, identity: ProcessIdentity) {
    fs::write(
        path,
        format!("{}\t{}", identity.pid(), identity.creation_marker()),
    )
    .expect("fixture target identity write failed");
}

fn read_identity(path: &Path) -> Result<ProcessIdentity, ()> {
    let contents = fs::read_to_string(path).map_err(|_| ())?;
    let mut fields = contents.split('\t');
    let pid = parse_decimal(fields.next().ok_or(())?)?;
    let creation_marker = parse_decimal(fields.next().ok_or(())?)?;
    if fields.next().is_some() {
        return Err(());
    }
    Ok(ProcessIdentity::new(pid, creation_marker))
}

fn parse_decimal<T: std::str::FromStr>(value: &str) -> Result<T, ()> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(());
    }
    value.parse().map_err(|_| ())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SupervisorHostError {
    CurrentIdentity,
    CurrentExecutable,
    VerifierSpawn,
    TargetLaunchSpec,
    StartDeadline,
    StartRejected,
    StartFailed,
    TargetObservationMissing,
    TargetNotOwned,
    TargetIdentity,
    TargetMemberIdentity,
    #[cfg(unix)]
    TargetGuardianIdentity,
    Protocol(ProtocolError),
}

impl From<ProtocolError> for SupervisorHostError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

impl fmt::Display for SupervisorHostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::CurrentIdentity => "fixture supervisor host identity observation failed",
            Self::CurrentExecutable => "fixture test executable resolution failed",
            Self::VerifierSpawn => "fixture verifier spawn failed",
            Self::TargetLaunchSpec => "fixture target launch specification is invalid",
            Self::StartDeadline => "fixture target start exceeded its monotonic deadline",
            Self::StartRejected => "fixture target start was not accepted",
            Self::StartFailed => "fixture target did not reach running state",
            Self::TargetObservationMissing => "fixture target observation is missing",
            Self::TargetNotOwned => "fixture target is not in an owned authority scope",
            Self::TargetIdentity => "fixture target exact identity observation failed",
            Self::TargetMemberIdentity => "fixture target member exact identity observation failed",
            #[cfg(unix)]
            Self::TargetGuardianIdentity => {
                "fixture target guardian exact identity observation failed"
            }
            Self::Protocol(error) => return error.fmt(formatter),
        })
    }
}

impl std::error::Error for SupervisorHostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            _ => None,
        }
    }
}
