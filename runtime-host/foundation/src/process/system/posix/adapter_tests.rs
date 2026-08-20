use std::ffi::OsString;
use std::fs;
use std::future::{Future, poll_fn};
use std::io::{self, Write};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::task::Poll;
use std::time::{Duration, Instant, SystemTime};

use crate::process::resource::{
    ActivationOutcome, BeginCompletion, BeginDrained, NativeCleanupResult, NativeDetachResult,
    NativeInstallResult, NativePollResult, ResourceEvent, ResourceShutdown,
};
use crate::process::supervision::LaunchFailure;
use crate::process::{FixedLaunch, LaunchSpec, StdioMode, StdioSpec, TerminationFailure};

use super::super::custody::NativeCustody;
use super::super::guardian_process;
use super::super::protocol::{Frame, Message};
use super::super::resource;
use super::Adapter;

const PROCESS_DEADLINE: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(target_os = "linux")]
const LAUNCH_FAILED_TEST: &str =
    "process::system::posix::adapter::tests::launch_failed_maps_to_drained_after_full_reap";
#[cfg(target_os = "linux")]
const ISOLATED_TEST_ENV: &str = "MATCHA_POSIX_ADAPTER_ISOLATED_TEST";

#[test]
fn resource_rejects_a_relative_guardian_executable() {
    let result = resource(
        PathBuf::from("process-guardian"),
        FixedLaunch::new(shell_spec("exit 0", Path::new("/"), &[])),
    );

    assert!(result.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn missing_absolute_guardian_maps_install_to_artifact_unavailable() {
    let directory = TestDirectory::new("adapter-missing-guardian");
    let mut adapter = Adapter::new(directory.path().join("missing-guardian"))
        .expect("an absolute guardian path must pass structural validation");

    assert!(matches!(
        adapter
            .install(crate::process::launch::LaunchRequest::fixed(shell_spec(
                "exit 0",
                Path::new("/"),
                &[],
            )))
            .await,
        NativeInstallResult::Drained(BeginDrained::LaunchFailed(
            LaunchFailure::ArtifactUnavailable
        ))
    ));
    assert!(adapter.custody.is_none());
    assert!(adapter.drain.is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn real_guardian_installs_activates_short_polls_and_naturally_drains() {
    let directory = TestDirectory::new("adapter-lifecycle");
    let launch = shell_spec("/bin/sleep 1; exit 23", directory.path(), &[]);
    let runtime = crate::process::resource::ResourceRuntime::spawn(
        Adapter::new(guardian_executable())
            .expect("the absolute guardian artifact must create an adapter"),
        FixedLaunch::new(launch),
    );
    let crate::process::resource::ResourceRuntime {
        client,
        mut events,
        task,
        ..
    } = runtime;

    client
        .begin()
        .await
        .expect("begin must reach the resource owner");
    let epoch = match receive_event(&mut events).await {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("begin acceptance was not the first resource event"),
    };
    let managed = match receive_event(&mut events).await {
        ResourceEvent::BeginCompleted {
            epoch: completed_epoch,
            completion: BeginCompletion::Installed(managed),
        } => {
            assert_eq!(completed_epoch, epoch);
            managed
        }
        _ => panic!("the real guardian did not install a managed process"),
    };
    assert_eq!(managed.epoch, epoch);
    let target_pid = managed.observation.identity().pid() as libc::pid_t;
    assert!(matches!(
        managed.activation.activate().await,
        Ok(ActivationOutcome::Active)
    ));

    assert!(
        tokio::time::timeout(Duration::from_millis(150), events.recv())
            .await
            .is_err(),
        "short native polls must remain pending while the target is live"
    );

    let evidence = client
        .wait_drained(epoch, tokio::time::Instant::now() + PROCESS_DEADLINE)
        .await
        .expect("natural drain must publish terminal evidence");
    assert_eq!(evidence.exit().exit_code(), Some(23));
    assert_eq!(evidence.exit().signal(), None);
    assert!(matches!(
        client.shutdown(Some(epoch)).await,
        Ok(ResourceShutdown::Terminated(_))
    ));
    tokio::time::timeout(PROCESS_DEADLINE, task)
        .await
        .expect("resource owner shutdown must be bounded")
        .expect("resource owner shutdown must join cleanly");
    wait_for_process_absence(target_pid).await;
}

#[tokio::test(flavor = "current_thread")]
async fn sequential_installs_use_distinct_specs_and_new_custody_after_verified_drain() {
    let directory = TestDirectory::new("adapter-sequential-attempts");
    let first_output = directory.path().join("first.txt");
    let second_output = directory.path().join("second.txt");
    let mut adapter = Adapter::new(guardian_executable())
        .expect("the absolute guardian artifact must create an adapter");

    let first = installed_observation(
        &mut adapter,
        shell_spec(
            "printf first > \"$1\"",
            directory.path(),
            &[first_output.as_os_str().to_owned()],
        ),
    )
    .await;
    let first_guardian = adapter
        .custody
        .as_ref()
        .and_then(|custody| custody.guardian_pid())
        .expect("the first attempt must retain its guardian");
    let first_scope = first.provenance();
    let _ = wait_for_adapter_drain(&mut adapter).await;
    assert!(adapter.custody.is_none());
    wait_for_process_absence(first_guardian).await;

    let second = installed_observation(
        &mut adapter,
        shell_spec(
            "printf second > \"$1\"",
            directory.path(),
            &[second_output.as_os_str().to_owned()],
        ),
    )
    .await;
    let second_guardian = adapter
        .custody
        .as_ref()
        .and_then(|custody| custody.guardian_pid())
        .expect("the second attempt must retain its guardian");
    assert_ne!(second_guardian, first_guardian);
    assert_ne!(second.provenance(), first_scope);
    let _ = wait_for_adapter_drain(&mut adapter).await;
    wait_for_process_absence(second_guardian).await;

    assert_eq!(fs::read_to_string(first_output).unwrap(), "first");
    assert_eq!(fs::read_to_string(second_output).unwrap(), "second");
}

#[tokio::test(flavor = "current_thread")]
async fn root_exit_with_a_live_scope_member_stays_pending_until_natural_drain() {
    let directory = TestDirectory::new("adapter-member-drain");
    let member_pid_file = directory.path().join("member.pid");
    let launch = shell_spec(
        "/bin/sleep 2 & printf '%s' \"$!\" > \"$1\"; exit 23",
        directory.path(),
        &[member_pid_file.as_os_str().to_owned()],
    );
    let mut adapter = Adapter::new(guardian_executable())
        .expect("the absolute guardian artifact must create an adapter");

    let observation = installed_observation(&mut adapter, launch).await;
    let root_pid = observation.identity().pid() as libc::pid_t;
    let guardian_pid = adapter
        .custody
        .as_ref()
        .and_then(|custody| custody.guardian_pid())
        .expect("installed custody must retain its guardian");
    let member_pid = wait_for_pid(&member_pid_file).await;
    #[cfg(target_os = "linux")]
    wait_for_zombie(root_pid).await;
    #[cfg(target_os = "macos")]
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(process_is_alive(member_pid));

    let poll_started = Instant::now();
    assert!(matches!(adapter.poll().await, NativePollResult::Pending));
    assert!(
        poll_started.elapsed() < Duration::from_secs(1),
        "a live scope member must produce a bounded pending poll"
    );

    let exit = wait_for_adapter_drain(&mut adapter).await;
    assert_eq!(exit.exit_code(), Some(23));
    assert_eq!(exit.signal(), None);
    assert!(matches!(
        adapter.poll().await,
        NativePollResult::Drained(ref repeated) if repeated == &exit
    ));
    assert!(matches!(
        adapter.cleanup().await,
        NativeCleanupResult::AlreadyDrained(ref repeated) if repeated == &exit
    ));
    wait_for_process_absence(root_pid).await;
    wait_for_process_absence(member_pid).await;
    wait_for_process_absence(guardian_pid).await;
}

#[cfg(target_os = "linux")]
#[test]
fn launch_failed_maps_to_drained_after_full_reap() {
    if !run_in_isolated_process(LAUNCH_FAILED_TEST) {
        return;
    }
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
        0
    );

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the isolated runtime must start");
    runtime.block_on(async {
        let launch = LaunchSpec::try_new(
            PathBuf::from("/definitely/not/a/matcha-adapter-target"),
            PathBuf::from("/"),
            [],
            [],
            StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
        )
        .expect("the invalid artifact case must still be a valid launch spec");
        let mut adapter = Adapter::new(guardian_executable())
            .expect("the absolute guardian artifact must create an adapter");

        assert!(matches!(
            adapter
                .install(crate::process::launch::LaunchRequest::fixed(launch))
                .await,
            NativeInstallResult::Drained(BeginDrained::LaunchFailed(
                LaunchFailure::PlatformRejected
            ))
        ));
        assert!(adapter.custody.is_none());
        assert!(adapter.drain.is_none());
    });
    drop(runtime);
    assert_no_child_processes();
}

#[tokio::test(flavor = "current_thread")]
async fn guardian_authority_loss_maps_to_unresolved_and_closes_the_target() {
    let directory = TestDirectory::new("adapter-authority-loss");
    let launch = shell_spec("exec /bin/sleep 30", directory.path(), &[]);
    let mut adapter = Adapter::new(guardian_executable())
        .expect("the absolute guardian artifact must create an adapter");

    let observation = installed_observation(&mut adapter, launch).await;
    let target_pid = observation.identity().pid() as libc::pid_t;
    let guardian_pid = adapter
        .custody
        .as_ref()
        .and_then(|custody| custody.guardian_pid())
        .expect("installed custody must retain its guardian");
    assert_eq!(unsafe { libc::kill(guardian_pid, libc::SIGKILL) }, 0);

    assert!(matches!(
        adapter.poll().await,
        NativePollResult::Unresolved(TerminationFailure::AuthorityLost)
    ));
    assert!(matches!(
        adapter.cleanup().await,
        NativeCleanupResult::Unresolved(TerminationFailure::AuthorityLost)
    ));
    wait_for_process_absence(guardian_pid).await;
    wait_for_process_absence(target_pid).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cleanup_recovers_the_same_custody_after_its_poll_future_is_dropped() {
    let directory = TestDirectory::new("adapter-poll-preemption");
    let launch = shell_spec("exec /bin/sleep 30", directory.path(), &[]);
    let mut adapter = Adapter::new(guardian_executable())
        .expect("the absolute guardian artifact must create an adapter");

    let observation = installed_observation(&mut adapter, launch).await;
    let target_pid = observation.identity().pid() as libc::pid_t;
    let guardian_pid = adapter
        .custody
        .as_ref()
        .and_then(|custody| custody.guardian_pid())
        .expect("installed custody must retain its guardian");

    {
        let mut poll = Box::pin(adapter.poll());
        poll_fn(|context| {
            assert!(
                poll.as_mut().poll(context).is_pending(),
                "the first poll must yield with custody stored in its drain task"
            );
            Poll::Ready(())
        })
        .await;
    }
    assert!(adapter.custody.is_none());
    assert!(adapter.drain.is_some());
    assert!(process_is_alive(guardian_pid));

    let cleanup = tokio::time::timeout(PROCESS_DEADLINE, adapter.cleanup())
        .await
        .expect("cleanup must not hang behind an abandoned poll future");
    assert!(matches!(
        cleanup,
        NativeCleanupResult::Terminated(_) | NativeCleanupResult::AlreadyDrained(_)
    ));
    assert!(adapter.custody.is_none());
    assert!(adapter.drain.is_none());
    wait_for_process_absence(target_pid).await;
    wait_for_process_absence(guardian_pid).await;
}

#[tokio::test(flavor = "current_thread")]
async fn terminal_state_still_joins_an_existing_drain_before_returning() {
    let (custody, guardian_pid, mut control) = controlled_custody(38);
    let mut adapter = Adapter::new(PathBuf::from("/unused/absolute/guardian"))
        .expect("the test guardian path must be structurally valid");
    adapter.custody = Some(custody);

    {
        let mut poll = Box::pin(adapter.poll());
        poll_fn(|context| {
            assert!(poll.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
    }
    assert_eq!(read_control_marker(control.try_clone().unwrap()).await, [1]);
    assert!(adapter.drain.is_some());
    assert!(adapter.custody.is_none());
    adapter.terminal = Some(super::Terminal::Unresolved(
        TerminationFailure::AuthorityLost,
    ));

    let mut cleanup = Box::pin(adapter.cleanup());
    poll_fn(|context| {
        assert!(
            cleanup.as_mut().poll(context).is_pending(),
            "terminal state must not bypass an existing drain task"
        );
        Poll::Ready(())
    })
    .await;
    control
        .write_all(
            &Frame::new(Message::Drained, [7; 16], 1, 0_i32.to_be_bytes().to_vec())
                .unwrap()
                .encode(),
        )
        .expect("the drain response must be observed");
    let settle_guardian = async move {
        assert_eq!(read_control_marker(control.try_clone().unwrap()).await, [2]);
        control
            .write_all(
                &Frame::new(Message::Disarm, [7; 16], 2, Vec::new())
                    .unwrap()
                    .encode(),
            )
            .expect("the disarm response must be observed");
    };
    let (cleanup_result, ()) = tokio::time::timeout(PROCESS_DEADLINE, async {
        tokio::join!(cleanup.as_mut(), settle_guardian)
    })
    .await
    .expect("cleanup must settle the existing drain before its deadline");
    assert!(matches!(
        cleanup_result,
        NativeCleanupResult::AlreadyDrained(_)
    ));
    drop(cleanup);
    assert!(adapter.custody.is_none());
    assert!(adapter.drain.is_none());
    wait_for_process_absence(guardian_pid).await;
}

#[tokio::test(flavor = "current_thread")]
async fn abandoned_polls_reuse_one_drain_task_before_cleanup_recovers_it() {
    let (custody, guardian_pid, mut control) = controlled_pending_custody();
    let mut adapter = Adapter::new(PathBuf::from("/unused/absolute/guardian"))
        .expect("the test guardian path must be structurally valid");
    adapter.custody = Some(custody);

    {
        let mut poll = Box::pin(adapter.poll());
        poll_fn(|context| {
            assert!(poll.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
    }
    assert_eq!(read_control_marker(control.try_clone().unwrap()).await, [1]);
    assert!(adapter.drain.is_some());
    assert!(adapter.custody.is_none());

    {
        let mut poll = Box::pin(adapter.poll());
        poll_fn(|context| {
            assert!(poll.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    let mut cleanup = Box::pin(adapter.cleanup());
    poll_fn(|context| {
        assert!(
            cleanup.as_mut().poll(context).is_pending(),
            "cleanup must await the original drain before taking custody"
        );
        Poll::Ready(())
    })
    .await;
    control
        .write_all(
            &Frame::new(Message::Pending, [7; 16], 1, Vec::new())
                .unwrap()
                .encode(),
        )
        .expect("the drain response must be observed");
    let settle_guardian = async move {
        assert_eq!(read_control_marker(control.try_clone().unwrap()).await, [2]);
        control
            .write_all(
                &Frame::new(Message::Terminate, [7; 16], 2, Vec::new())
                    .unwrap()
                    .encode(),
            )
            .expect("the termination response must be observed");
    };
    let (cleanup_result, ()) = tokio::time::timeout(PROCESS_DEADLINE, async {
        tokio::join!(cleanup.as_mut(), settle_guardian)
    })
    .await
    .expect("cleanup must settle the recovered custody before its deadline");
    assert!(matches!(cleanup_result, NativeCleanupResult::Terminated(_)));
    drop(cleanup);
    assert!(adapter.custody.is_none());
    assert!(adapter.drain.is_none());
    wait_for_process_absence(guardian_pid).await;
}

#[tokio::test(flavor = "current_thread")]
async fn unresolved_install_blocks_a_new_attempt() {
    let mut adapter = Adapter::new(PathBuf::from("/unused/absolute/guardian"))
        .expect("the test guardian path must be structurally valid");
    adapter.terminal = Some(super::Terminal::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));

    assert!(matches!(
        adapter
            .install(crate::process::launch::LaunchRequest::fixed(shell_spec(
                "exit 0",
                Path::new("/"),
                &[],
            )))
            .await,
        NativeInstallResult::Unresolved {
            observation: None,
            failure: TerminationFailure::CleanupUnconfirmed,
        }
    ));
    assert!(matches!(
        adapter.terminal,
        Some(super::Terminal::Unresolved(
            TerminationFailure::CleanupUnconfirmed
        ))
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn cleanup_unresolved_retains_live_custody_for_same_epoch_retry() {
    let (custody, guardian_pid) = test_custody();
    let mut adapter = Adapter::new(PathBuf::from("/unused/absolute/guardian"))
        .expect("the test guardian path must be structurally valid");
    adapter.custody = Some(custody);

    assert!(matches!(
        adapter.cleanup_unresolved(),
        NativeCleanupResult::Unresolved(TerminationFailure::CleanupUnconfirmed)
    ));
    let retained_guardian = adapter
        .custody
        .as_ref()
        .and_then(|custody| custody.guardian_pid())
        .expect("unresolved cleanup must retain live custody");
    assert_eq!(retained_guardian, guardian_pid);
    assert!(adapter.terminal.is_none());

    assert!(matches!(
        adapter.cleanup_unresolved(),
        NativeCleanupResult::Unresolved(TerminationFailure::CleanupUnconfirmed)
    ));
    assert_eq!(
        adapter
            .custody
            .as_ref()
            .and_then(|custody| custody.guardian_pid()),
        Some(retained_guardian)
    );
    assert!(adapter.terminal.is_none());
    drop(adapter);
    wait_for_process_absence(guardian_pid).await;
}

#[tokio::test(flavor = "current_thread")]
async fn terminate_is_scope_local_and_joins_the_guardian() {
    let directory = TestDirectory::new("adapter-scope-local");
    let member_pid_file = directory.path().join("member.pid");
    let mut outsider = ChildGuard::spawn_sleep();
    let outsider_pid = outsider.pid();
    let launch = shell_spec(
        "/bin/sleep 30 & printf '%s' \"$!\" > \"$1\"; wait",
        directory.path(),
        &[member_pid_file.as_os_str().to_owned()],
    );
    let mut adapter = Adapter::new(guardian_executable())
        .expect("the absolute guardian artifact must create an adapter");

    let observation = installed_observation(&mut adapter, launch).await;
    let root_pid = observation.identity().pid() as libc::pid_t;
    let guardian_pid = adapter
        .custody
        .as_ref()
        .and_then(|custody| custody.guardian_pid())
        .expect("installed custody must retain its guardian");
    let member_pid = wait_for_pid(&member_pid_file).await;

    assert!(matches!(
        tokio::time::timeout(PROCESS_DEADLINE, adapter.cleanup()).await,
        Ok(NativeCleanupResult::Terminated(_))
    ));
    wait_for_process_absence(root_pid).await;
    wait_for_process_absence(member_pid).await;
    wait_for_process_absence(guardian_pid).await;
    assert!(process_is_alive(outsider_pid));
    outsider.stop();
}

#[tokio::test(flavor = "current_thread")]
async fn detach_is_unresolved_without_abandoning_live_custody() {
    let directory = TestDirectory::new("adapter-detach");
    let launch = shell_spec("exec /bin/sleep 30", directory.path(), &[]);
    let mut adapter = Adapter::new(guardian_executable())
        .expect("the absolute guardian artifact must create an adapter");

    let observation = installed_observation(&mut adapter, launch).await;
    let target_pid = observation.identity().pid() as libc::pid_t;
    let guardian_pid = adapter
        .custody
        .as_ref()
        .and_then(|custody| custody.guardian_pid())
        .expect("installed custody must retain its guardian");

    assert!(matches!(
        adapter.detach().await,
        NativeDetachResult::Unresolved(TerminationFailure::CleanupUnconfirmed)
    ));
    assert!(process_is_alive(target_pid));
    assert!(process_is_alive(guardian_pid));
    assert!(matches!(
        adapter.cleanup().await,
        NativeCleanupResult::Terminated(_)
    ));
    wait_for_process_absence(target_pid).await;
    wait_for_process_absence(guardian_pid).await;
}

#[tokio::test(flavor = "current_thread")]
async fn drop_is_nonblocking_best_effort_cleanup() {
    let directory = TestDirectory::new("adapter-drop");
    let launch = shell_spec("exec /bin/sleep 30", directory.path(), &[]);
    let mut adapter = Adapter::new(guardian_executable())
        .expect("the absolute guardian artifact must create an adapter");

    let observation = installed_observation(&mut adapter, launch).await;
    let target_pid = observation.identity().pid() as libc::pid_t;
    let guardian_pid = adapter
        .custody
        .as_ref()
        .and_then(|custody| custody.guardian_pid())
        .expect("installed custody must retain its guardian");
    let started = Instant::now();
    drop(adapter);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "drop must not masquerade as synchronous confirmed cleanup"
    );

    wait_for_process_absence(guardian_pid).await;
    wait_for_process_absence(target_pid).await;
}

fn test_custody() -> (NativeCustody, libc::pid_t) {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "read _ || true"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the test guardian must start");
    let guardian_pid = child.id() as libc::pid_t;
    let guardian = guardian_process::GuardianProcess {
        stdin: child.stdin.take().expect("test guardian stdin must exist"),
        stdout: child
            .stdout
            .take()
            .expect("test guardian stdout must exist"),
        child,
    };
    (native_custody(guardian), guardian_pid)
}

fn controlled_pending_custody() -> (NativeCustody, libc::pid_t, UnixStream) {
    controlled_custody(34)
}

fn controlled_custody(first_response_bytes: usize) -> (NativeCustody, libc::pid_t, UnixStream) {
    let (control, guardian_control) = UnixStream::pair().unwrap();
    let script = format!(
        "dd bs=1 count=34 of=/dev/null 2>/dev/null; printf '\\001' >&2; dd bs=1 count={first_response_bytes} <&2 2>/dev/null; dd bs=1 count=34 of=/dev/null 2>/dev/null; printf '\\002' >&2; dd bs=1 count=34 <&2 2>/dev/null"
    );
    let mut child = Command::new("/bin/sh")
        .args(["-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(OwnedFd::from(guardian_control))
        .spawn()
        .expect("the test guardian must start");
    let guardian_pid = child.id() as libc::pid_t;
    let guardian = guardian_process::GuardianProcess {
        stdin: child.stdin.take().expect("test guardian stdin must exist"),
        stdout: child
            .stdout
            .take()
            .expect("test guardian stdout must exist"),
        child,
    };
    (native_custody(guardian), guardian_pid, control)
}

async fn read_control_marker(mut control: UnixStream) -> [u8; 1] {
    control
        .set_read_timeout(Some(PROCESS_DEADLINE))
        .expect("the guardian marker read must be bounded");
    tokio::task::spawn_blocking(move || {
        let mut marker = [0_u8];
        std::io::Read::read_exact(&mut control, &mut marker)
            .expect("the guardian marker must arrive");
        marker
    })
    .await
    .expect("the guardian marker task must join")
}

fn native_custody(guardian: guardian_process::GuardianProcess) -> NativeCustody {
    NativeCustody {
        guardian: Some(guardian),
        nonce: [7; 16],
        next_request_id: 1,
        in_flight: None,
    }
}

async fn installed_observation(
    adapter: &mut Adapter,
    launch: LaunchSpec,
) -> crate::process::ProcessObservation {
    match adapter
        .install(crate::process::launch::LaunchRequest::fixed(launch))
        .await
    {
        NativeInstallResult::Installed(observation, _) => observation,
        _ => panic!("the real guardian did not install the target"),
    }
}

async fn wait_for_adapter_drain(adapter: &mut Adapter) -> crate::process::ExitObservation {
    let deadline = Instant::now() + PROCESS_DEADLINE;
    loop {
        match adapter.poll().await {
            NativePollResult::Pending => {
                assert!(
                    Instant::now() < deadline,
                    "the adapter did not naturally drain before the test deadline"
                );
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            NativePollResult::Drained(exit) => return exit,
            NativePollResult::Unresolved(_) => {
                panic!("the adapter lost authority during natural drain")
            }
        }
    }
}

async fn receive_event(events: &mut tokio::sync::mpsc::Receiver<ResourceEvent>) -> ResourceEvent {
    tokio::time::timeout(PROCESS_DEADLINE, events.recv())
        .await
        .expect("the resource event deadline elapsed")
        .expect("the resource event channel closed")
}

fn guardian_executable() -> PathBuf {
    let executable = std::env::var_os("MATCHA_GUARDIAN_EXE")
        .map(PathBuf::from)
        .expect("the guardian test artifact is unavailable");
    assert!(
        executable.is_absolute(),
        "the guardian test artifact must be absolute"
    );
    assert!(
        executable.is_file(),
        "the guardian test artifact must be a file"
    );
    executable
}

fn shell_spec(script: &str, working_directory: &Path, arguments: &[OsString]) -> LaunchSpec {
    let mut launch_arguments = vec![
        OsString::from("-c"),
        OsString::from(script),
        OsString::from("matcha-adapter-test"),
    ];
    launch_arguments.extend_from_slice(arguments);
    LaunchSpec::try_new(
        PathBuf::from("/bin/sh"),
        working_directory.to_path_buf(),
        launch_arguments,
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .expect("the test launch specification must be valid")
}

async fn wait_for_pid(file: &Path) -> libc::pid_t {
    let deadline = Instant::now() + PROCESS_DEADLINE;
    loop {
        if let Ok(contents) = fs::read_to_string(file)
            && let Ok(pid) = contents.parse::<libc::pid_t>()
        {
            return pid;
        }
        assert!(
            Instant::now() < deadline,
            "the target member did not publish its identity"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn process_is_alive(pid: libc::pid_t) -> bool {
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

async fn wait_for_process_absence(pid: libc::pid_t) {
    let deadline = Instant::now() + PROCESS_DEADLINE;
    while process_is_alive(pid) {
        assert!(
            Instant::now() < deadline,
            "a managed test process remained alive"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(target_os = "linux")]
async fn wait_for_zombie(pid: libc::pid_t) {
    let deadline = Instant::now() + PROCESS_DEADLINE;
    loop {
        if linux_process_state(pid) == Some('Z') {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the target root did not reach its exited state"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(target_os = "linux")]
fn linux_process_state(pid: libc::pid_t) -> Option<char> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let closing_parenthesis = stat.rfind(')')?;
    stat[closing_parenthesis + 2..].chars().next()
}

#[cfg(target_os = "linux")]
fn run_in_isolated_process(test_name: &str) -> bool {
    if std::env::var_os(ISOLATED_TEST_ENV).is_some() {
        return true;
    }
    let succeeded =
        Command::new(std::env::current_exe().expect("the test executable is unavailable"))
            .arg(test_name)
            .arg("--exact")
            .arg("--test-threads=1")
            .env(ISOLATED_TEST_ENV, "1")
            .stdin(Stdio::null())
            .status()
            .expect("the isolated adapter test did not start")
            .success();
    assert!(succeeded, "the isolated adapter test failed");
    false
}

#[cfg(target_os = "linux")]
fn assert_no_child_processes() {
    let deadline = Instant::now() + PROCESS_DEADLINE;
    let mut reaped_residue = false;
    loop {
        let mut status = 0;
        let waited = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if waited > 0 {
            reaped_residue = true;
            continue;
        }
        if waited == -1 {
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
            assert!(
                !reaped_residue,
                "launch failure left an unreaped helper or target"
            );
            return;
        }
        assert!(
            Instant::now() < deadline,
            "launch failure left a live helper or target"
        );
        std::thread::sleep(POLL_INTERVAL);
    }
}

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the system clock must follow the Unix epoch")
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("matcha-{name}-{}-{unique}", std::process::id()));
        fs::create_dir(&directory).expect("the test directory could not be created");
        Self(directory)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct ChildGuard {
    child: Option<Child>,
}

impl ChildGuard {
    fn spawn_sleep() -> Self {
        let child = Command::new("/bin/sleep")
            .arg("30")
            .current_dir("/")
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the outsider test process did not start");
        Self { child: Some(child) }
    }

    fn pid(&self) -> libc::pid_t {
        self.child
            .as_ref()
            .expect("the outsider test process is unavailable")
            .id() as libc::pid_t
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.stop();
    }
}
