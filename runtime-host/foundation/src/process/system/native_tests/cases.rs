use std::ffi::OsString;
use std::fs;
use std::future::Future;
#[cfg(windows)]
use std::os::windows::io::IntoRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime};

use crate::process::{
    FixedLaunch, LaunchSpec, ShutdownOutcome, StdioMode, StdioSpec, TerminationOutcome,
    supervision::{
        CommandReceipt, Completion, StartOutcome, Supervisor, SupervisorFailure, SupervisorHandle,
        SupervisorPhase, TerminationCompletion,
    },
};

use super::policies::{DrainStdio, Policy, Ready, Recovery, Stop};

const STARTING_RELEASE: &str = "starting.release";
const STARTING_READY: &str = "starting.ready";
const EXIT_COUNT: &str = "exit.count";
const EXIT_READY: &str = "exit.ready";
const STOP_READY: &str = "stop.ready";
const ROOT_EXITED: &str = "root.exited";
const MEMBER_IDENTITY: &str = "member.identity";
const MEMBER_RELEASE: &str = "member.release";
const ROOT_IDENTITY: &str = "root.identity";
const SCOPE_ID: &str = "scope.id";
const SCOPE_READY: &str = "scope.ready";
const HOST_READY: &str = "host.ready";
const HOST_RELEASE: &str = "host.release";
const OUTSIDER_READY: &str = "outsider.ready";
const OUTSIDER_RELEASE: &str = "outsider.release";
const ENVIRONMENT_READY: &str = "environment.ready";
const TEST_TIMEOUT: Duration = Duration::from_secs(15);
const JOIN_TIMEOUT: Duration = Duration::from_secs(3);
const STOP_GRACE_PERIOD: Duration = Duration::from_millis(100);

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Copy)]
enum HelperCase {
    BlockedStart,
    ExitOnce,
    WaitForStop,
    RootExitsWithMember,
    ScopeRootWithMember,
    AuthorityHost,
    VerifyScopeCleared,
    WaitForOutsider,
    EmptyEnvironment,
}

impl HelperCase {
    const fn name(self) -> &'static str {
        match self {
            Self::BlockedStart => "blocked-start",
            Self::ExitOnce => "exit-once",
            Self::WaitForStop => "wait-for-stop",
            Self::RootExitsWithMember => "root-exits-with-member",
            Self::ScopeRootWithMember => "scope-root-with-member",
            Self::AuthorityHost => "authority-host",
            Self::VerifyScopeCleared => "verify-scope-cleared",
            Self::WaitForOutsider => "wait-for-outsider",
            Self::EmptyEnvironment => "empty-environment",
        }
    }
}

#[tokio::test]
#[cfg_attr(unix, ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE")]
async fn native_start_receipt_transitions_through_starting_to_running() {
    let directory = TestDirectory::new("starting");
    let supervisor = supervisor_with_readiness(
        spec(HelperCase::BlockedStart, directory.path()),
        Ready::after(directory.path().join(STARTING_RELEASE)),
        Policy::default(),
    );
    let handle = supervisor.handle();
    let receipt = accepted(handle.start().await);

    wait_for_path(&directory.path().join(STARTING_READY)).await;
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::Starting);
    fs::write(directory.path().join(STARTING_RELEASE), b"release").unwrap();
    assert_eq!(
        bounded(receipt.wait()).await.unwrap(),
        StartOutcome::Started
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::Running);
    let process = handle
        .snapshot()
        .process()
        .expect("running process is observed");
    assert_ne!(process.identity().pid(), 0);
    assert!(matches!(
        process.provenance(),
        crate::process::Provenance::Spawned { .. }
    ));

    shutdown(supervisor, handle).await;
}

#[tokio::test]
#[cfg_attr(unix, ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE")]
async fn native_natural_exit_restarts_once_and_returns_to_running() {
    let directory = TestDirectory::new("natural-recovery");
    let policy = Policy::default();
    let supervisor = supervisor(spec(HelperCase::ExitOnce, directory.path()), policy.clone());
    let handle = supervisor.handle();

    assert_eq!(
        bounded(accepted(handle.start().await).wait())
            .await
            .unwrap(),
        StartOutcome::Started
    );
    let initial = ProcessWitness::from_observation(
        handle
            .snapshot()
            .process()
            .expect("initial root process is observed"),
    );
    wait_for_path(&directory.path().join(EXIT_READY)).await;
    wait_for(|| policy.calls() == 1).await;
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::Running && policy.calls() == 1
    })
    .await;
    let restarted = ProcessWitness::from_observation(
        handle
            .snapshot()
            .process()
            .expect("recovered root process is observed"),
    );

    assert_ne!(
        initial, restarted,
        "recovery must launch a fresh root instance"
    );
    assert!(restarted.is_running());
    assert_eq!(read_count(&directory.path().join(EXIT_COUNT)), 2);
    assert!(matches!(
        policy.failures().as_slice(),
        [SupervisorFailure::Exited(exit)] if exit.exit_code() == Some(23)
    ));

    shutdown(supervisor, handle).await;
}

#[tokio::test]
#[cfg_attr(unix, ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE")]
async fn native_stop_deadline_forces_cleanup() {
    let directory = TestDirectory::new("stop-deadline");
    let supervisor = supervisor(
        spec(HelperCase::WaitForStop, directory.path()),
        Policy::default(),
    );
    let handle = supervisor.handle();
    bounded(accepted(handle.start().await).wait())
        .await
        .unwrap();
    wait_for_path(&directory.path().join(STOP_READY)).await;

    let started = Instant::now();
    let outcome = bounded(accepted(handle.stop().await).wait()).await.unwrap();
    assert!(started.elapsed() >= STOP_GRACE_PERIOD);
    assert!(matches!(
        outcome,
        TerminationCompletion::Completed(TerminationOutcome::Forced(_))
    ));
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::Idle);

    shutdown(supervisor, handle).await;
}

#[tokio::test]
#[cfg_attr(unix, ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE")]
async fn native_kill_publishes_terminal_snapshot_before_receipt_and_joins_bounded() {
    let directory = TestDirectory::new("kill");
    let supervisor = supervisor(
        spec(HelperCase::WaitForStop, directory.path()),
        Policy::default(),
    );
    let handle = supervisor.handle();
    bounded(accepted(handle.start().await).wait())
        .await
        .unwrap();
    wait_for_path(&directory.path().join(STOP_READY)).await;
    let snapshots = handle.subscribe();

    let outcome = bounded(accepted(handle.kill().await).wait()).await.unwrap();
    assert!(matches!(
        outcome,
        TerminationCompletion::Completed(TerminationOutcome::Forced(_))
    ));
    assert_eq!(snapshots.borrow().phase(), SupervisorPhase::Idle);

    bounded_join_after_shutdown(supervisor, handle).await;
}

#[tokio::test]
#[cfg_attr(unix, ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE")]
async fn native_shutdown_publishes_terminal_snapshot_before_receipt_and_joins_bounded() {
    let directory = TestDirectory::new("shutdown");
    let supervisor = supervisor(
        spec(HelperCase::WaitForStop, directory.path()),
        Policy::default(),
    );
    let handle = supervisor.handle();
    bounded(accepted(handle.start().await).wait())
        .await
        .unwrap();
    wait_for_path(&directory.path().join(STOP_READY)).await;
    let snapshots = handle.subscribe();

    let outcome = bounded(accepted(handle.shutdown().await).wait())
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        ShutdownOutcome::Terminated(TerminationOutcome::Forced(_))
    ));
    assert_eq!(snapshots.borrow().phase(), SupervisorPhase::ShutDown);
    bounded_join(supervisor).await;
}

#[tokio::test]
#[cfg_attr(unix, ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE")]
async fn native_root_exit_with_live_member_is_not_terminal() {
    let directory = TestDirectory::new("live-member");
    let policy = Policy::halt();
    let supervisor = supervisor(
        spec(HelperCase::RootExitsWithMember, directory.path()),
        policy.clone(),
    );
    let handle = supervisor.handle();
    bounded(accepted(handle.start().await).wait())
        .await
        .unwrap();
    let root = ProcessWitness::from_observation(
        handle
            .snapshot()
            .process()
            .expect("running root process is observed"),
    );

    wait_for_path(&directory.path().join(ROOT_EXITED)).await;
    wait_for(|| !root.is_running()).await;
    let member = ProcessWitness::read(&directory.path().join(MEMBER_IDENTITY));
    assert!(member.is_running());
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::Running);
    assert_eq!(policy.calls(), 0);

    fs::write(directory.path().join(MEMBER_RELEASE), b"release").unwrap();
    wait_for(|| !member.is_running()).await;
    wait_for(|| policy.calls() == 1).await;
    assert!(matches!(
        policy.failures().as_slice(),
        [SupervisorFailure::Exited(exit)] if exit.exit_code() == Some(0)
    ));

    shutdown(supervisor, handle).await;
}

#[test]
#[cfg_attr(unix, ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE")]
fn native_host_crash_cleans_only_its_proven_scope() {
    let directory = TestDirectory::new("host-crash");
    let mut outsider = ReapedChild::new(
        helper_command(HelperCase::WaitForOutsider, directory.path())
            .spawn()
            .unwrap(),
    );
    wait_for_path_blocking(&directory.path().join(OUTSIDER_READY));

    let mut host = ReapedChild::new(
        helper_command(HelperCase::AuthorityHost, directory.path())
            .spawn()
            .unwrap(),
    );
    wait_for_path_from_child(&directory.path().join(HOST_READY), &mut host);
    let scope = fs::read_to_string(directory.path().join(SCOPE_ID)).unwrap();
    assert!(scope.trim().len() == 32);
    let root = ProcessWitness::read(&directory.path().join(ROOT_IDENTITY));
    let member = ProcessWitness::read(&directory.path().join(MEMBER_IDENTITY));
    let outsider_identity = ProcessWitness::from_child(&outsider);
    assert!(root.is_running());
    assert!(member.is_running());
    assert!(outsider_identity.is_running());

    host.hard_kill_and_reap();
    assert!(
        helper_command(HelperCase::VerifyScopeCleared, directory.path())
            .status()
            .unwrap()
            .success(),
        "independent verifier rejected crash containment evidence"
    );
    assert!(!root.is_running());
    assert!(!member.is_running());
    assert!(outsider_identity.is_running());

    fs::write(directory.path().join(OUTSIDER_RELEASE), b"release").unwrap();
    outsider.wait_for_exit();
    assert!(!outsider_identity.is_running());
}

#[tokio::test]
#[cfg_attr(unix, ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE")]
async fn native_empty_exact_environment_does_not_inherit_host() {
    let directory = TestDirectory::new("empty-environment");
    let supervisor = supervisor(
        spec(HelperCase::EmptyEnvironment, directory.path()),
        Policy::default(),
    );
    let handle = supervisor.handle();

    assert_eq!(
        bounded(accepted(handle.start().await).wait())
            .await
            .unwrap(),
        StartOutcome::Started
    );
    wait_for_path(&directory.path().join(ENVIRONMENT_READY)).await;
    shutdown(supervisor, handle).await;
}

pub(super) fn run_helper() {
    let arguments = std::env::args_os().collect::<Vec<_>>();
    let Some(separator) = arguments.iter().position(|argument| argument == "--") else {
        return;
    };
    let Some(case) = arguments.get(separator + 1) else {
        return;
    };
    let Some(directory) = arguments.get(separator + 2) else {
        return;
    };
    let Some(action) = case.to_str().and_then(parse_case) else {
        return;
    };
    let directory = PathBuf::from(directory);

    match action {
        HelperCase::BlockedStart => {
            fs::write(directory.join(STARTING_READY), b"ready").unwrap();
            wait_for_path_blocking(&directory.join(STARTING_RELEASE));
            wait_for_path_blocking(&directory.join(MEMBER_RELEASE));
        }
        HelperCase::ExitOnce => {
            let count_path = directory.join(EXIT_COUNT);
            let count = read_count_or_zero(&count_path) + 1;
            fs::write(&count_path, count.to_string()).unwrap();
            if count == 1 {
                std::process::exit(23);
            }
            fs::write(directory.join(EXIT_READY), b"ready").unwrap();
            wait_for_path_blocking(&directory.join(MEMBER_RELEASE));
        }
        HelperCase::WaitForStop => {
            fs::write(directory.join(STOP_READY), b"ready").unwrap();
            wait_for_path_blocking(&directory.join(MEMBER_RELEASE));
        }
        HelperCase::RootExitsWithMember => {
            let mut member = helper_command(HelperCase::WaitForStop, &directory);
            project_helper_environment(&mut member, &directory);
            let member = ReapedChild::new(member.spawn().unwrap());
            write_process_witness(&directory.join(MEMBER_IDENTITY), member.id());
            wait_for_path_blocking(&directory.join(STOP_READY));
            member.release_local_ownership();
            fs::write(directory.join(ROOT_EXITED), b"exited").unwrap();
        }
        HelperCase::ScopeRootWithMember => {
            let mut member = helper_command(HelperCase::WaitForStop, &directory);
            project_helper_environment(&mut member, &directory);
            let member = ReapedChild::new(member.spawn().unwrap());
            write_process_witness(&directory.join(MEMBER_IDENTITY), member.id());
            wait_for_path_blocking(&directory.join(STOP_READY));
            member.release_local_ownership();
            fs::write(directory.join(SCOPE_READY), b"ready").unwrap();
            wait_for_path_blocking(&directory.join(MEMBER_RELEASE));
        }
        HelperCase::AuthorityHost => run_authority_host(&directory),
        HelperCase::VerifyScopeCleared => verify_scope_cleared(&directory),
        HelperCase::WaitForOutsider => {
            fs::write(directory.join(OUTSIDER_READY), b"ready").unwrap();
            wait_for_path_blocking(&directory.join(OUTSIDER_RELEASE));
        }
        HelperCase::EmptyEnvironment => {
            let environment = std::env::vars_os().collect::<Vec<_>>();
            assert!(
                environment.is_empty(),
                "empty exact environment inherited unexpected host entries: {environment:?}"
            );
            fs::write(directory.join(ENVIRONMENT_READY), b"ready").unwrap();
            wait_for_path_blocking(&directory.join(MEMBER_RELEASE));
        }
    }
}

fn run_authority_host(directory: &Path) {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (supervisor, handle) = runtime.block_on(async {
        let supervisor = supervisor(authority_host_spec(directory), Policy::default());
        let handle = supervisor.handle();
        assert_eq!(
            bounded(accepted(handle.start().await).wait())
                .await
                .unwrap(),
            StartOutcome::Started
        );
        wait_for_path(&directory.join(SCOPE_READY)).await;
        let process = handle
            .snapshot()
            .process()
            .expect("authority host must publish its spawned root");
        let crate::process::Provenance::Spawned { scope } = process.provenance() else {
            panic!("authority host must own its scope");
        };
        write_process_witness(&directory.join(ROOT_IDENTITY), process.identity().pid());
        fs::write(directory.join(SCOPE_ID), scope.id().to_string()).unwrap();
        fs::write(directory.join(HOST_READY), b"ready").unwrap();
        (supervisor, handle)
    });
    wait_for_path_blocking(&directory.join(HOST_RELEASE));
    runtime.block_on(shutdown(supervisor, handle));
}

fn verify_scope_cleared(directory: &Path) {
    let scope = fs::read_to_string(directory.join(SCOPE_ID)).unwrap();
    assert_eq!(scope.trim().len(), 32);
    for marker in [ROOT_IDENTITY, MEMBER_IDENTITY] {
        wait_for_process_exit_blocking(ProcessWitness::read(&directory.join(marker)));
    }
}

fn helper_command(case: HelperCase, directory: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            OsString::from("--exact"),
            OsString::from("process::system::native_tests::native_process_helper"),
            OsString::from("--test-threads=1"),
            OsString::from("--"),
            OsString::from(case.name()),
            directory.as_os_str().to_owned(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn supervisor(spec: LaunchSpec, policy: Policy) -> Supervisor {
    supervisor_with_readiness(spec, Ready::immediate(), policy)
}

fn supervisor_with_readiness(spec: LaunchSpec, readiness: Ready, policy: Policy) -> Supervisor {
    #[cfg(windows)]
    let supervisor = crate::process::supervise(
        crate::process::ProcessContainment::job(),
        FixedLaunch::new(spec),
        DrainStdio,
        readiness,
        Stop::after(STOP_GRACE_PERIOD),
        Recovery::after(Duration::ZERO),
        policy,
    );
    #[cfg(unix)]
    let supervisor = crate::process::supervise(
        crate::process::ProcessContainment::guardian(guardian_executable())
            .expect("guardian executable must be valid"),
        FixedLaunch::new(spec),
        DrainStdio,
        readiness,
        Stop::after(STOP_GRACE_PERIOD),
        Recovery::after(Duration::ZERO),
        policy,
    );
    supervisor
}

#[cfg(unix)]
fn guardian_executable() -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os("MATCHA_GUARDIAN_EXE")
            .expect("MATCHA_GUARDIAN_EXE must name the built guardian artifact"),
    );
    assert!(path.is_absolute(), "MATCHA_GUARDIAN_EXE must be absolute");
    assert!(path.is_file(), "MATCHA_GUARDIAN_EXE must name a file");
    path
}

fn authority_host_spec(directory: &Path) -> LaunchSpec {
    #[cfg(unix)]
    let environment = vec![(
        OsString::from("MATCHA_GUARDIAN_EXE"),
        std::env::var_os("MATCHA_GUARDIAN_EXE").expect("guardian path must be projected to host"),
    )];
    #[cfg(windows)]
    let environment = projected_windows_environment();
    LaunchSpec::try_new(
        std::env::current_exe().unwrap(),
        directory.to_path_buf(),
        [
            OsString::from("--exact"),
            OsString::from("process::system::native_tests::native_process_helper"),
            OsString::from("--test-threads=1"),
            OsString::from("--"),
            OsString::from(HelperCase::ScopeRootWithMember.name()),
            directory.as_os_str().to_owned(),
        ],
        environment,
        StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped),
    )
    .unwrap()
}

fn spec(case: HelperCase, directory: &Path) -> LaunchSpec {
    LaunchSpec::try_new(
        std::env::current_exe().unwrap(),
        directory.to_path_buf(),
        [
            OsString::from("--exact"),
            OsString::from("process::system::native_tests::native_process_helper"),
            OsString::from("--test-threads=1"),
            OsString::from("--"),
            OsString::from(case.name()),
            directory.as_os_str().to_owned(),
        ],
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped),
    )
    .unwrap()
}

fn project_helper_environment(command: &mut Command, directory: &Path) {
    command
        .env_clear()
        .envs(projected_windows_environment())
        .current_dir(directory);
}

#[cfg(windows)]
fn projected_windows_environment() -> Vec<(OsString, OsString)> {
    ["SystemRoot", "WINDIR", "PATH"]
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

#[cfg(not(windows))]
fn projected_windows_environment() -> Vec<(OsString, OsString)> {
    Vec::new()
}

fn parse_case(value: &str) -> Option<HelperCase> {
    Some(match value {
        "blocked-start" => HelperCase::BlockedStart,
        "exit-once" => HelperCase::ExitOnce,
        "wait-for-stop" => HelperCase::WaitForStop,
        "root-exits-with-member" => HelperCase::RootExitsWithMember,
        "scope-root-with-member" => HelperCase::ScopeRootWithMember,
        "authority-host" => HelperCase::AuthorityHost,
        "verify-scope-cleared" => HelperCase::VerifyScopeCleared,
        "wait-for-outsider" => HelperCase::WaitForOutsider,
        "empty-environment" => HelperCase::EmptyEnvironment,
        _ => return None,
    })
}

fn accepted<T>(receipt: CommandReceipt<T>) -> Completion<T> {
    match receipt {
        CommandReceipt::Accepted(completion) => completion,
        _ => panic!("expected accepted command receipt"),
    }
}

async fn shutdown(supervisor: Supervisor, handle: SupervisorHandle) {
    let receipt = handle.shutdown().await;
    if let CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) = receipt {
        bounded(completion.wait()).await.unwrap();
    }
    bounded_join(supervisor).await;
}

async fn bounded_join_after_shutdown(supervisor: Supervisor, handle: SupervisorHandle) {
    let receipt = handle.shutdown().await;
    if let CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) = receipt {
        bounded(completion.wait()).await.unwrap();
    }
    bounded_join(supervisor).await;
}

async fn bounded_join(mut supervisor: Supervisor) {
    tokio::time::timeout(JOIN_TIMEOUT, supervisor.join())
        .await
        .expect("supervisor join exceeded its bound")
        .unwrap();
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(TEST_TIMEOUT, future)
        .await
        .expect("native integration operation exceeded its bound")
}

async fn wait_for_snapshot(
    handle: &SupervisorHandle,
    matches: impl Fn(&crate::process::supervision::SupervisorSnapshot) -> bool,
) {
    let mut snapshots = handle.subscribe();
    bounded(async {
        loop {
            if matches(&snapshots.borrow()) {
                return;
            }
            snapshots.changed().await.unwrap();
        }
    })
    .await;
}

async fn wait_for_path(path: &Path) {
    wait_for(|| path.exists()).await;
}

async fn wait_for(matches: impl Fn() -> bool) {
    bounded(async {
        while !matches() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
}

fn wait_for_path_blocking(path: &Path) {
    let deadline = Instant::now() + TEST_TIMEOUT;
    while !path.exists() {
        assert!(Instant::now() < deadline, "helper marker was not released");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_path_from_child(path: &Path, child: &mut ReapedChild) {
    let deadline = Instant::now() + TEST_TIMEOUT;
    while !path.exists() {
        if let Some(status) = child.try_wait() {
            panic!("authority host exited before ready marker: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "authority host did not arm a scope"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn read_count(path: &Path) -> u32 {
    fs::read_to_string(path).unwrap().parse().unwrap()
}

fn read_count_or_zero(path: &Path) -> u32 {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProcessWitness {
    pid: u32,
    #[cfg(windows)]
    creation_marker: u128,
}

impl ProcessWitness {
    fn from_observation(process: crate::process::ProcessObservation) -> Self {
        let identity = process.identity();
        Self {
            pid: identity.pid(),
            #[cfg(windows)]
            creation_marker: identity.creation_marker(),
        }
    }

    fn from_child(child: &ReapedChild) -> Self {
        Self::from_pid(child.id())
    }

    fn from_pid(pid: u32) -> Self {
        Self {
            pid,
            #[cfg(windows)]
            creation_marker: process_creation_marker(pid)
                .expect("fixture child must remain identifiable while captured"),
        }
    }

    fn read(path: &Path) -> Self {
        let value = fs::read_to_string(path).expect("fixture process identity must be recorded");
        let mut fields = value.trim().split(':');
        let pid = fields
            .next()
            .expect("fixture process identity must include pid")
            .parse()
            .expect("fixture process pid must be numeric");
        #[cfg(windows)]
        let creation_marker = fields
            .next()
            .expect("fixture process identity must include creation marker")
            .parse()
            .expect("fixture creation marker must be numeric");
        assert!(
            fields.next().is_none(),
            "fixture process identity must contain only pid and creation marker"
        );
        Self {
            pid,
            #[cfg(windows)]
            creation_marker,
        }
    }

    fn is_running(self) -> bool {
        #[cfg(windows)]
        {
            process_has_identity(self.pid, self.creation_marker)
        }
        #[cfg(not(windows))]
        {
            process_is_running(self.pid)
        }
    }
}

fn write_process_witness(path: &Path, pid: u32) {
    let witness = ProcessWitness::from_pid(pid);
    #[cfg(windows)]
    let value = format!("{}:{}", witness.pid, witness.creation_marker);
    #[cfg(not(windows))]
    let value = witness.pid.to_string();
    fs::write(path, value).unwrap();
}

fn wait_for_process_exit_blocking(process: ProcessWitness) {
    let deadline = Instant::now() + TEST_TIMEOUT;
    while process.is_running() {
        assert!(
            Instant::now() < deadline,
            "proven scope process remained alive"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct ReapedChild(Option<Child>);

impl ReapedChild {
    fn new(child: Child) -> Self {
        Self(Some(child))
    }

    fn id(&self) -> u32 {
        self.0.as_ref().unwrap().id()
    }

    fn try_wait(&mut self) -> Option<std::process::ExitStatus> {
        self.0.as_mut().unwrap().try_wait().unwrap()
    }

    #[cfg(windows)]
    fn release_local_ownership(mut self) {
        let child = self.0.take().unwrap();
        let _ = unsafe { windows_sys::Win32::Foundation::CloseHandle(child.into_raw_handle()) };
    }

    #[cfg(unix)]
    fn release_local_ownership(mut self) {
        let child = self.0.take().unwrap();
        drop(child);
    }

    fn hard_kill_and_reap(&mut self) {
        let child = self.0.as_mut().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        self.0 = None;
    }

    fn wait_for_exit(&mut self) {
        let child = self.0.as_mut().unwrap();
        child.wait().unwrap();
        self.0 = None;
    }
}

impl Drop for ReapedChild {
    fn drop(&mut self) {
        let Some(mut child) = self.0.take() else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(windows)]
fn process_creation_marker(pid: u32) -> Option<u128> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut creation = windows_sys::Win32::Foundation::FILETIME::default();
    let mut exit = windows_sys::Win32::Foundation::FILETIME::default();
    let mut kernel = windows_sys::Win32::Foundation::FILETIME::default();
    let mut user = windows_sys::Win32::Foundation::FILETIME::default();
    let identified =
        unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) != 0 };
    unsafe { CloseHandle(process) };
    identified
        .then(|| u128::from(creation.dwLowDateTime) | (u128::from(creation.dwHighDateTime) << 32))
}

#[cfg(windows)]
fn process_has_identity(pid: u32, creation_marker: u128) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        WaitForSingleObject,
    };

    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if process.is_null() {
        return false;
    }
    let mut creation = windows_sys::Win32::Foundation::FILETIME::default();
    let mut exit = windows_sys::Win32::Foundation::FILETIME::default();
    let mut kernel = windows_sys::Win32::Foundation::FILETIME::default();
    let mut user = windows_sys::Win32::Foundation::FILETIME::default();
    let matched = unsafe {
        GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) != 0
            && WaitForSingleObject(process, 0) == WAIT_TIMEOUT
            && u128::from(creation.dwLowDateTime) | (u128::from(creation.dwHighDateTime) << 32)
                == creation_marker
    };
    unsafe { CloseHandle(process) };
    matched
}

#[cfg(target_os = "linux")]
fn process_is_running(pid: u32) -> bool {
    let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some(closing_parenthesis) = stat.rfind(')') else {
        return false;
    };
    !stat[closing_parenthesis + 2..].starts_with("Z ")
}

#[cfg(target_os = "macos")]
fn process_is_running(pid: u32) -> bool {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::pid_t,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as _,
        )
    };
    written == std::mem::size_of::<libc::proc_bsdinfo>() as i32
        && unsafe { info.assume_init() }.pbi_status != libc::SZOMB
}

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(name: &str) -> Self {
        let unique = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "matcha-native-{name}-{}-{timestamp}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::write(self.0.join(STARTING_RELEASE), b"release");
        let _ = fs::write(self.0.join(MEMBER_RELEASE), b"release");
        let _ = fs::write(self.0.join(HOST_RELEASE), b"release");
        let _ = fs::write(self.0.join(OUTSIDER_RELEASE), b"release");
        let _ = fs::remove_dir_all(&self.0);
    }
}
