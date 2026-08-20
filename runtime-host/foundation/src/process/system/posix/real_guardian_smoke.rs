use std::ffi::OsString;
use std::fs;
use std::future::Future;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;

use super::super::super::{
    FixedLaunch, LaunchSpec, ProcessObservation, ProcessOutput, ProcessStdio, ShutdownOutcome,
    StdioActivationResult, StdioDrain, StdioDrainResult, StdioMode, StdioSpec,
    supervision::{
        CommandReceipt, Completion, GracefulStop, GracefulStopResult, PolicyFuture, ReadinessProbe,
        ReadinessResult, RestartDecision, RestartEpisode, RestartPolicy, StartOutcome,
        StartRecovery, StartRecoveryResult, StdioActivation, SupervisorFailure, SupervisorHandle,
    },
};
use super::{CustodyDrain, CustodyFailure, NativeCustody};

fn guardian_executable() -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os("MATCHA_GUARDIAN_EXE")
            .expect("MATCHA_GUARDIAN_EXE must name the built guardian artifact"),
    );
    assert!(path.is_absolute(), "MATCHA_GUARDIAN_EXE must be absolute");
    assert!(path.is_file(), "MATCHA_GUARDIAN_EXE must name a file");
    path
}

fn smoke_directory(name: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("matcha-{name}-{}-{unique}", std::process::id()));
    fs::create_dir(&path).unwrap();
    path
}

async fn wait_for_drained(custody: &mut NativeCustody) -> CustodyDrain {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let observation = custody.poll_drained().await.unwrap();
        if !matches!(observation, CustodyDrain::Pending) {
            return observation;
        }
        assert!(Instant::now() < deadline, "custody did not drain");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn wait_for_process_exit(pid: libc::pid_t) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if process_is_absent(pid) {
            return;
        }
        assert!(Instant::now() < deadline, "target process remained alive");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn process_is_absent(pid: libc::pid_t) -> bool {
    let result = unsafe { libc::kill(pid, 0) };
    result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

fn descriptor_is_closed(descriptor: RawFd) -> bool {
    (unsafe { libc::fcntl(descriptor, libc::F_GETFD) }) == -1
        && io::Error::last_os_error().raw_os_error() == Some(libc::EBADF)
}

fn launch_spec(executable: PathBuf, working_directory: PathBuf) -> LaunchSpec {
    LaunchSpec::try_new(
        executable,
        working_directory,
        [],
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .unwrap()
}

fn piped_shell_spec(script: &str) -> LaunchSpec {
    LaunchSpec::try_new(
        PathBuf::from("/bin/sh"),
        PathBuf::from("/"),
        [OsString::from("-c"), OsString::from(script)],
        [],
        StdioSpec::new(StdioMode::Piped, StdioMode::Piped, StdioMode::Piped),
    )
    .unwrap()
}

async fn launch_with_stdio(spec: &LaunchSpec) -> (NativeCustody, libc::pid_t, ProcessStdio) {
    let guardian = guardian_executable();
    let (mut custody, host_stdio) = NativeCustody::spawn(&guardian, spec, None, None, None)
        .await
        .unwrap();
    let launched = custody.launch(spec, host_stdio).await.unwrap();
    let pid = launched.root_identity().pid() as libc::pid_t;
    (custody, pid, launched.into_stdio())
}

async fn read_to_end(mut output: ProcessOutput) -> Vec<u8> {
    let mut bytes = Vec::new();
    output.read_to_end(&mut bytes).await.unwrap();
    bytes
}

async fn read_exact(mut output: ProcessOutput, expected: &[u8]) -> ProcessOutput {
    let mut bytes = vec![0; expected.len()];
    output.read_exact(&mut bytes).await.unwrap();
    assert_eq!(bytes, expected);
    output
}

fn run_with_closed_standard_descriptors(future: impl Future<Output = ()>) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let saved = [
        duplicate_descriptor(libc::STDIN_FILENO),
        duplicate_descriptor(libc::STDOUT_FILENO),
        duplicate_descriptor(libc::STDERR_FILENO),
    ];
    for descriptor in [libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO] {
        if unsafe { libc::close(descriptor) } == -1 {
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
        }
    }

    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runtime.block_on(future)));

    for (target, saved) in [libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO]
        .into_iter()
        .zip(saved)
    {
        match saved {
            Some(saved) => {
                assert_eq!(unsafe { libc::dup2(saved.as_raw_fd(), target) }, target);
            }
            None => assert!(descriptor_is_closed(target)),
        }
    }
    drop(runtime);
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

fn duplicate_descriptor(descriptor: RawFd) -> Option<OwnedFd> {
    let duplicated = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 8) };
    if duplicated == -1 {
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
        None
    } else {
        Some(unsafe { OwnedFd::from_raw_fd(duplicated) })
    }
}

fn run_in_isolated_test(test_name: &str, marker: &str) -> bool {
    if std::env::var_os(marker).is_some() {
        return true;
    }
    let succeeded = Command::new(std::env::current_exe().unwrap())
        .arg(test_name)
        .arg("--exact")
        .arg("--ignored")
        .arg("--test-threads=1")
        .env(marker, "1")
        .env("MATCHA_GUARDIAN_EXE", guardian_executable())
        .status()
        .unwrap()
        .success();
    assert!(succeeded, "isolated real guardian regression failed");
    false
}

#[test]
#[ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE"]
fn real_guardian_relocates_stdio_when_host_zero_one_and_two_are_closed() {
    const TEST_NAME: &str = "process::system::posix::real_guardian_smoke::real_guardian_relocates_stdio_when_host_zero_one_and_two_are_closed";
    const MARKER: &str = "MATCHA_CLOSED_HOST_STDIO_TEST";
    if !run_in_isolated_test(TEST_NAME, MARKER) {
        return;
    }

    run_with_closed_standard_descriptors(async {
        let input = b"stdin-survived-closed-host-stdio".to_vec();
        let spec = piped_shell_spec("cat; printf stdout-after-eof; printf stderr-after-eof >&2");
        let (mut custody, _pid, stdio) = launch_with_stdio(&spec).await;
        let (stdin, stdout, stderr) = stdio.into_parts();
        let mut stdin = stdin.expect("piped stdin must survive host descriptor relocation");
        let stdout = stdout.expect("piped stdout must survive host descriptor relocation");
        let stderr = stderr.expect("piped stderr must survive host descriptor relocation");
        let expected_stdout = [input.as_slice(), b"stdout-after-eof"].concat();

        let write = async move {
            stdin.write_all(&input).await.unwrap();
            stdin.shutdown().await.unwrap();
        };
        let ((), stdout, stderr) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(write, read_to_end(stdout), read_to_end(stderr))
        })
        .await
        .expect("relocated stdio transfer did not finish");

        assert_eq!(stdout, expected_stdout);
        assert_eq!(stderr, b"stderr-after-eof");
        let CustodyDrain::Drained(observation) = wait_for_drained(&mut custody).await else {
            panic!("relocated target did not drain")
        };
        assert_eq!(observation.exit_code(), Some(0));
        assert_eq!(observation.signal(), None);
    });
}

#[tokio::test]
#[ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE"]
async fn real_guardian_does_not_leak_unrelated_non_cloexec_descriptor() {
    let source = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) };
    assert_ne!(source, -1);
    let source = unsafe { OwnedFd::from_raw_fd(source) };
    let unrelated = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD, 64) };
    assert_ne!(unrelated, -1);
    let unrelated = unsafe { OwnedFd::from_raw_fd(unrelated) };
    let flags = unsafe { libc::fcntl(unrelated.as_raw_fd(), libc::F_GETFD) };
    assert_ne!(flags, -1);
    assert_eq!(flags & libc::FD_CLOEXEC, 0);
    let leaked_descriptor = unrelated.as_raw_fd();
    let spec = piped_shell_spec(&format!(
        "if [ -e /proc/self/fd/{leaked_descriptor} ]; then printf leaked; else printf closed; fi"
    ));
    let (mut custody, host_stdio) =
        NativeCustody::spawn(&guardian_executable(), &spec, None, None, None)
            .await
            .unwrap();
    let stdio = custody
        .launch(&spec, host_stdio)
        .await
        .unwrap()
        .into_stdio();
    let (stdin, stdout, stderr) = stdio.into_parts();
    drop(stdin);
    let (stdout, stderr) = tokio::join!(
        read_to_end(stdout.expect("descriptor witness stdout must be piped")),
        read_to_end(stderr.expect("descriptor witness stderr must be piped"))
    );
    let CustodyDrain::Drained(observation) = wait_for_drained(&mut custody).await else {
        panic!("descriptor witness did not drain")
    };
    assert_eq!(observation.exit_code(), Some(0));
    assert_eq!(stdout, b"closed");
    assert!(stderr.is_empty());
    assert_eq!(
        unsafe { libc::fcntl(unrelated.as_raw_fd(), libc::F_GETFD) },
        flags
    );
}

#[tokio::test]
#[ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE"]
async fn real_guardian_pipes_exact_stdin_and_separates_large_outputs() {
    let stdout_bytes = 1024 * 1024 + 113;
    let stderr_bytes = 1024 * 1024 + 197;
    let input = b"exact stdin bytes\0with newline\n".repeat(4096);
    let spec = piped_shell_spec(&format!(
        "cat; printf stdin-eof; head -c {stdout_bytes} /dev/zero | tr '\\000' o; printf stderr-eof >&2; head -c {stderr_bytes} /dev/zero | tr '\\000' e >&2"
    ));
    let (mut custody, _pid, stdio) = launch_with_stdio(&spec).await;
    let (stdin, stdout, stderr) = stdio.into_parts();
    let mut stdin = stdin.expect("piped stdin must be available");
    let stdout = stdout.expect("piped stdout must be available");
    let stderr = stderr.expect("piped stderr must be available");

    let expected_input = input.clone();
    let write_input = async move {
        stdin.write_all(&input).await.unwrap();
        stdin.shutdown().await.unwrap();
    };
    let ((), stdout, stderr) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(write_input, read_to_end(stdout), read_to_end(stderr))
    })
    .await
    .expect("stdio transfer deadlocked beyond pipe capacity");

    let stdout_prefix = [expected_input.as_slice(), b"stdin-eof"].concat();
    assert!(stdout.starts_with(&stdout_prefix));
    assert_eq!(stdout.len(), stdout_prefix.len() + stdout_bytes);
    assert!(
        stdout[stdout_prefix.len()..]
            .iter()
            .all(|byte| *byte == b'o')
    );
    assert!(
        stderr.starts_with(b"stderr-eof"),
        "stderr length {} starts with {:?}",
        stderr.len(),
        &stderr[..stderr.len().min(128)]
    );
    assert_eq!(stderr.len(), b"stderr-eof".len() + stderr_bytes);
    assert!(
        stderr[b"stderr-eof".len()..]
            .iter()
            .all(|byte| *byte == b'e')
    );

    let CustodyDrain::Drained(observation) = wait_for_drained(&mut custody).await else {
        unreachable!()
    };
    assert_eq!(observation.exit_code(), Some(0));
    assert_eq!(observation.signal(), None);
}

#[tokio::test]
#[ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE"]
async fn real_guardian_projects_launch_and_preserves_exact_drain_status() {
    let guardian = guardian_executable();
    let directory = smoke_directory("guardian-projection");
    let evidence = directory.join("evidence");
    let script = "printf '%s\\n%s\\n' \"$PWD\" \"$MATCHA_SMOKE_ENV\" > \"$1\"; for fd in 3 4 5 6 7; do [ ! -e \"/dev/fd/$fd\" ] || exit 91; done; sleep 2 & exit 23";
    let spec = LaunchSpec::try_new(
        PathBuf::from("/bin/sh"),
        directory.clone(),
        [
            OsString::from("-c"),
            OsString::from(script),
            OsString::from("matcha-smoke"),
            evidence.as_os_str().to_owned(),
        ],
        [(
            OsString::from("MATCHA_SMOKE_ENV"),
            OsString::from("projected"),
        )],
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .unwrap();
    let (mut custody, host_stdio) = NativeCustody::spawn(&guardian, &spec, None, None, None)
        .await
        .unwrap();
    custody.launch(&spec, host_stdio).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(custody.poll_drained().await.unwrap(), CustodyDrain::Pending);
    let CustodyDrain::Drained(observation) = wait_for_drained(&mut custody).await else {
        unreachable!()
    };
    assert_eq!(observation.exit_code(), Some(23));
    assert_eq!(observation.signal(), None);
    let evidence = fs::read_to_string(&evidence).unwrap();
    let mut lines = evidence.lines();
    assert!(
        lines
            .next()
            .is_some_and(|line| line == directory.as_os_str())
    );
    assert!(lines.next() == Some("projected"));
    assert!(lines.next().is_none());
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
#[ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE"]
async fn real_guardian_launch_failures_reap_all_helpers() {
    let guardian = guardian_executable();
    for spec in [
        launch_spec(
            PathBuf::from("/definitely/not/a/matcha-executable"),
            PathBuf::from("/"),
        ),
        launch_spec(
            PathBuf::from("/bin/true"),
            PathBuf::from("/definitely/not/a/matcha-working-directory"),
        ),
        launch_spec(PathBuf::from("/"), PathBuf::from("/")),
    ] {
        let piped_spec = LaunchSpec::try_new(
            spec.executable().to_path_buf(),
            spec.working_directory().to_path_buf(),
            spec.arguments().iter().cloned(),
            spec.public_environment().iter().cloned(),
            StdioSpec::new(StdioMode::Piped, StdioMode::Piped, StdioMode::Piped),
        )
        .unwrap();
        let (mut custody, host_stdio) =
            NativeCustody::spawn(&guardian, &piped_spec, None, None, None)
                .await
                .unwrap();
        let guardian_pid = custody.guardian_pid().unwrap();
        assert!(matches!(
            custody.launch(&piped_spec, host_stdio).await,
            Err(CustodyFailure::LaunchFailed)
        ));
        assert!(custody.guardian_pid().is_none());
        assert!(
            process_is_absent(guardian_pid),
            "helper process remained alive"
        );
    }
}

#[tokio::test]
#[ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE"]
async fn real_guardian_force_cleanup_is_unknown_and_scope_local() {
    let guardian = guardian_executable();
    let mut outsider = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let outsider_pid = outsider.id() as libc::pid_t;
    let exited_root = LaunchSpec::try_new(
        PathBuf::from("/bin/sh"),
        PathBuf::from("/"),
        [
            OsString::from("-c"),
            OsString::from("sleep 30 & sleep 1; exit 23"),
        ],
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .unwrap();
    let (mut custody, host_stdio) = NativeCustody::spawn(&guardian, &exited_root, None, None, None)
        .await
        .unwrap();
    custody.launch(&exited_root, host_stdio).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let poll_started = Instant::now();
    assert_eq!(custody.poll_drained().await.unwrap(), CustodyDrain::Pending);
    assert!(poll_started.elapsed() < Duration::from_secs(1));
    let observation = custody.terminate().await.unwrap();
    assert_eq!(observation.exit_code(), None);
    assert_eq!(observation.signal(), None);
    assert_eq!(unsafe { libc::kill(outsider_pid, 0) }, 0);
    outsider.kill().unwrap();
    outsider.wait().unwrap();
}

#[derive(Clone)]
struct JoinTrackedStdio {
    state: Arc<JoinTrackedStdioState>,
}

struct JoinTrackedStdioState {
    target_pid: Mutex<Option<libc::pid_t>>,
    drain_started: Notify,
    release_drain: Mutex<Option<oneshot::Receiver<()>>>,
}

impl JoinTrackedStdio {
    fn new() -> (Self, oneshot::Sender<()>) {
        let (release, release_drain) = oneshot::channel();
        (
            Self {
                state: Arc::new(JoinTrackedStdioState {
                    target_pid: Mutex::new(None),
                    drain_started: Notify::new(),
                    release_drain: Mutex::new(Some(release_drain)),
                }),
            },
            release,
        )
    }

    async fn wait_for_drain(&self) {
        self.state.drain_started.notified().await;
    }

    fn target_pid(&self) -> libc::pid_t {
        self.state
            .target_pid
            .lock()
            .unwrap()
            .expect("stdio activation did not observe the target")
    }
}

impl StdioActivation for JoinTrackedStdio {
    fn activate(
        &self,
        process: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        *self.state.target_pid.lock().unwrap() = Some(process.identity().pid() as libc::pid_t);
        let state = self.state.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StdioActivationResult::Cancelled;
            }
            let (None, Some(mut stdout), Some(mut stderr)) = stdio.into_parts() else {
                return StdioActivationResult::Unavailable;
            };
            let release = state
                .release_drain
                .lock()
                .unwrap()
                .take()
                .expect("stdio drain can only be activated once");
            StdioActivationResult::Activated(StdioDrain::new(async move {
                state.drain_started.notify_one();
                let (stdout, stderr, release) = tokio::join!(
                    async { tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await },
                    async { tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await },
                    release,
                );
                if stdout.is_ok() && stderr.is_ok() && release.is_ok() {
                    StdioDrainResult::Drained
                } else {
                    StdioDrainResult::Unavailable
                }
            }))
        })
    }
}

#[derive(Clone, Copy)]
struct ImmediateReady;

impl ReadinessProbe for ImmediateReady {
    fn wait_ready(
        &self,
        _: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                ReadinessResult::Cancelled
            } else {
                ReadinessResult::Ready
            }
        })
    }
}

#[derive(Clone, Copy)]
struct RejectGracefulStop;

impl GracefulStop for RejectGracefulStop {
    fn grace_period(&self) -> Duration {
        Duration::from_secs(10)
    }

    fn request_stop(
        &self,
        _: ProcessObservation,
        _: CancellationToken,
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
        _: CancellationToken,
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

fn accepted<T>(receipt: CommandReceipt<T>) -> Completion<T> {
    match receipt {
        CommandReceipt::Accepted(completion) => completion,
        _ => panic!("expected accepted command receipt"),
    }
}

async fn shutdown_completion(handle: &SupervisorHandle) -> ShutdownOutcome {
    match handle.shutdown().await {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
            completion.wait().await.unwrap()
        }
        CommandReceipt::AlreadySatisfied => {
            ShutdownOutcome::Terminated(super::super::super::TerminationOutcome::NoProcess)
        }
        _ => panic!("expected accepted shutdown receipt"),
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE"]
async fn supervisor_join_waits_for_stdio_drain_and_confirmed_process_cleanup() {
    let spec = LaunchSpec::try_new(
        PathBuf::from("/bin/sh"),
        PathBuf::from("/"),
        [
            OsString::from("-c"),
            OsString::from("printf started; exec /bin/sleep 30"),
        ],
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped),
    )
    .unwrap();
    let (stdio, release_drain) = JoinTrackedStdio::new();
    let mut supervisor = super::super::super::supervise(
        super::super::super::ProcessContainment::guardian(guardian_executable())
            .expect("guardian executable must be valid"),
        FixedLaunch::new(spec),
        stdio.clone(),
        ImmediateReady,
        RejectGracefulStop,
        FailRecovery,
        HaltRestart,
    );
    let handle = supervisor.handle();
    assert_eq!(
        accepted(handle.start().await).wait().await.unwrap(),
        StartOutcome::Started
    );
    stdio.wait_for_drain().await;
    let target_pid = stdio.target_pid();

    let shutdown = tokio::spawn({
        let handle = handle.clone();
        async move { shutdown_completion(&handle).await }
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        while !process_is_absent(target_pid) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("target cleanup did not complete");
    let mut join = Box::pin(supervisor.join());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut join)
            .await
            .is_err(),
        "tracked owner join returned before stdio drain completion"
    );

    release_drain.send(()).unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(10), shutdown)
            .await
            .expect("shutdown receipt did not settle")
            .unwrap(),
        ShutdownOutcome::Terminated(_)
    ));
    tokio::time::timeout(Duration::from_secs(10), &mut join)
        .await
        .expect("tracked owner did not join")
        .unwrap();
    assert!(process_is_absent(target_pid));
}

#[tokio::test]
#[ignore = "requires explicit absolute MATCHA_GUARDIAN_EXE"]
async fn real_guardian_closes_scope_and_outputs_after_host_and_guardian_loss() {
    let host_loss_spec = LaunchSpec::try_new(
        PathBuf::from("/bin/sh"),
        PathBuf::from("/"),
        [
            OsString::from("-c"),
            OsString::from("printf host-start; printf host-error >&2; sleep 30"),
        ],
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped),
    )
    .unwrap();
    let (host_loss, host_loss_pid, stdio) = launch_with_stdio(&host_loss_spec).await;
    let (_, stdout, stderr) = stdio.into_parts();
    let (stdout, stderr) = tokio::join!(
        read_exact(stdout.unwrap(), b"host-start"),
        read_exact(stderr.unwrap(), b"host-error")
    );
    drop(host_loss);
    let (stdout, stderr) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(read_to_end(stdout), read_to_end(stderr))
    })
    .await
    .expect("host loss did not close target output pipes");
    assert!(stdout.is_empty());
    assert!(stderr.is_empty());
    wait_for_process_exit(host_loss_pid);

    let guardian_loss_spec = LaunchSpec::try_new(
        PathBuf::from("/bin/sh"),
        PathBuf::from("/"),
        [
            OsString::from("-c"),
            OsString::from("printf guardian-start; printf guardian-error >&2; sleep 30"),
        ],
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped),
    )
    .unwrap();
    let (mut guardian_loss, target_pid, stdio) = launch_with_stdio(&guardian_loss_spec).await;
    let (_, stdout, stderr) = stdio.into_parts();
    let (stdout, stderr) = tokio::join!(
        read_exact(stdout.unwrap(), b"guardian-start"),
        read_exact(stderr.unwrap(), b"guardian-error")
    );
    let guardian_pid = guardian_loss.guardian_pid().unwrap();
    assert_eq!(unsafe { libc::kill(guardian_pid, libc::SIGKILL) }, 0);
    assert_eq!(
        guardian_loss.poll_drained().await,
        Err(CustodyFailure::AuthorityLost)
    );
    let (stdout, stderr) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(read_to_end(stdout), read_to_end(stderr))
    })
    .await
    .expect("guardian loss did not close target output pipes");
    assert!(stdout.is_empty());
    assert!(stderr.is_empty());
    wait_for_process_exit(target_pid);
    drop(guardian_loss);
}
