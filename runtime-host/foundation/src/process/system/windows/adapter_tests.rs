use std::{
    ffi::OsString,
    fs,
    future::Future,
    process,
    task::Poll,
    time::{Duration, Instant},
};

use super::super::{
    custody::{CustodyCleanup, WindowsCustody, install as install_custody},
    test_support::{
        DIRECTORY_ENV, HelperProcess, ObservationHandle, ROLE_ENV, TestDirectory, helper_command,
        helper_directory, helper_launch_spec, wait_for_path, wait_for_pid, wait_for_release,
    },
};
use super::{Adapter, BlockingOperation};
use crate::process::{
    ExitObservation, FixedLaunch, LaunchRequest, LaunchSpec, ProcessObservation, StdioMode,
    StdioSpec, TerminationFailure,
    resource::{
        ActivationOutcome, BeginCompletion, BeginDrained, NativeAdapter, NativeCleanupResult,
        NativeDetachResult, NativeInstallResult, NativePollResult, ResourceEvent, ResourceRuntime,
        ResourceShutdown, TerminalOrigin,
    },
    supervision::LaunchFailure,
};

const INSTALL_ACTIVATION_TEST: &str =
    "process::system::windows::adapter::tests::resource_install_activates_real_adapter";
const NATURAL_DRAIN_TEST: &str =
    "process::system::windows::adapter::tests::natural_drain_is_terminal_and_idempotent";
const REINSTALL_TEST: &str =
    "process::system::windows::adapter::tests::drained_adapter_installs_a_distinct_second_spec";
const DESTRUCTIVE_CLEANUP_TEST: &str =
    "process::system::windows::adapter::tests::destructive_cleanup_is_classified_and_scope_local";
const CLEANUP_RETRY_TEST: &str =
    "process::system::windows::adapter::tests::unresolved_cleanup_retains_custody_for_retry";
const INSTALL_DROP_TEST: &str =
    "process::system::windows::adapter::tests::dropped_install_future_resumes_the_same_task";
const CLEANUP_DROP_TEST: &str =
    "process::system::windows::adapter::tests::dropped_cleanup_future_resumes_the_same_task";
const INSTALL_OWNER_DROP_TEST: &str =
    "process::system::windows::adapter::tests::adapter_drop_joins_in_flight_install_owner";
const CLEANUP_OWNER_DROP_TEST: &str =
    "process::system::windows::adapter::tests::adapter_drop_joins_in_flight_cleanup_owner";
const POLL_DROP_TEST: &str =
    "process::system::windows::adapter::tests::dropped_poll_future_preserves_custody_for_cleanup";
const DETACH_TEST: &str =
    "process::system::windows::adapter::tests::detach_is_unresolved_without_releasing_custody";
const DROP_CONTAINMENT_TEST: &str = "process::system::windows::adapter::tests::adapter_drop_is_nonblocking_and_job_close_contains_scope";
const RUNTIME_DROP_TEST: &str = "process::system::windows::adapter::tests::resource_runtime_drop_is_nonblocking_and_contains_scope_without_success_claim";
const ROOT_EXIT_CODE: i32 = 23;
const PROBE_DEADLINE: Duration = Duration::from_secs(10);
const PROBE_POLL: Duration = Duration::from_millis(10);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resource_install_activates_real_adapter() {
    match helper_role().as_deref() {
        Some("activation-root") => {
            run_waiting_root();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-adapter-activation");
    let launch = helper_launch_spec(INSTALL_ACTIVATION_TEST, "activation-root", directory.path());
    let mut runtime = super::super::resource(FixedLaunch::new(launch));
    runtime.task.start();

    runtime.client.begin().await.unwrap();
    let epoch = match recv_event(&mut runtime).await {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected begin acceptance"),
    };
    let installed = match recv_event(&mut runtime).await {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installed resource"),
    };
    assert_eq!(installed.epoch, epoch);
    let root = ObservationHandle::open(installed.observation.identity().pid()).unwrap();
    wait_for_path(&directory.root_ready());

    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );
    fs::write(directory.scope_release(), b"release").unwrap();
    root.wait_signaled().unwrap();

    let evidence = match recv_event(&mut runtime).await {
        ResourceEvent::NativeFact(evidence) => evidence,
        _ => panic!("expected natural terminal evidence"),
    };
    assert_eq!(evidence.epoch(), epoch);
    assert_eq!(evidence.origin(), TerminalOrigin::ObservedDrain);
    assert_exit(evidence.exit(), 0);
    assert!(matches!(
        runtime.client.shutdown(None).await.unwrap(),
        ResourceShutdown::NoResource
    ));
    runtime.task.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn natural_drain_is_terminal_and_idempotent() {
    match helper_role().as_deref() {
        Some("natural-root") => run_scope_root(
            NATURAL_DRAIN_TEST,
            "natural-member",
            RootBehavior::Exit(ROOT_EXIT_CODE),
        ),
        Some("natural-member") => {
            run_scope_member();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-adapter-natural-drain");
    let launch = helper_launch_spec(NATURAL_DRAIN_TEST, "natural-root", directory.path());
    let (mut adapter, observation) = install_adapter(launch).await;
    let root = ObservationHandle::open(observation.identity().pid()).unwrap();
    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());
    root.wait_signaled().unwrap();
    assert!(!member.is_signaled().unwrap());
    assert!(matches!(
        NativeAdapter::poll(&mut adapter).await,
        NativePollResult::Pending
    ));

    fs::write(directory.scope_release(), b"release").unwrap();
    member.wait_signaled().unwrap();
    let drained = poll_until_drained(&mut adapter).await;
    assert_exit(&drained, ROOT_EXIT_CODE);

    let repeated_poll = match NativeAdapter::poll(&mut adapter).await {
        NativePollResult::Drained(exit) => exit,
        _ => panic!("expected cached natural drain"),
    };
    assert_eq!(repeated_poll, drained);
    for _ in 0..2 {
        let repeated_cleanup = match NativeAdapter::cleanup(&mut adapter).await {
            NativeCleanupResult::AlreadyDrained(exit) => exit,
            _ => panic!("expected already-drained cleanup"),
        };
        assert_eq!(repeated_cleanup, drained);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drained_adapter_installs_a_distinct_second_spec() {
    match helper_role().as_deref() {
        Some("first-root") => {
            run_waiting_root();
            return;
        }
        Some("second-root") => {
            run_waiting_root();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let first_directory = TestDirectory::new("windows-adapter-first-attempt");
    let second_directory = TestDirectory::new("windows-adapter-second-attempt");
    let mut adapter = Adapter::new();

    let first = install_observation(
        &mut adapter,
        helper_launch_spec(REINSTALL_TEST, "first-root", first_directory.path()),
    )
    .await;
    wait_for_path(&first_directory.root_ready());
    fs::write(first_directory.scope_release(), b"release").unwrap();
    ObservationHandle::open(first.identity().pid())
        .unwrap()
        .wait_signaled()
        .unwrap();
    assert_exit(&poll_until_drained(&mut adapter).await, 0);

    let second = install_observation(
        &mut adapter,
        helper_launch_spec(REINSTALL_TEST, "second-root", second_directory.path()),
    )
    .await;
    wait_for_path(&second_directory.root_ready());
    assert!(!first_directory.entry_marker().exists());
    assert!(!second_directory.scope_release().exists());
    assert_ne!(first.identity(), second.identity());

    fs::write(second_directory.scope_release(), b"release").unwrap();
    ObservationHandle::open(second.identity().pid())
        .unwrap()
        .wait_signaled()
        .unwrap();
    assert_exit(&poll_until_drained(&mut adapter).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn destructive_cleanup_is_classified_and_scope_local() {
    match helper_role().as_deref() {
        Some("cleanup-root") => run_scope_root(
            DESTRUCTIVE_CLEANUP_TEST,
            "cleanup-member",
            RootBehavior::WaitForRelease,
        ),
        Some("cleanup-member") => {
            run_scope_member();
            return;
        }
        Some("cleanup-control") => {
            run_control();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-adapter-destructive-cleanup");
    let control = HelperProcess::spawn(
        DESTRUCTIVE_CLEANUP_TEST,
        "cleanup-control",
        directory.path(),
    )
    .unwrap();
    let control_observation = ObservationHandle::open(control.id()).unwrap();
    let launch = helper_launch_spec(DESTRUCTIVE_CLEANUP_TEST, "cleanup-root", directory.path());
    let (mut adapter, observation) = install_adapter(launch).await;
    let root = ObservationHandle::open(observation.identity().pid()).unwrap();
    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());
    wait_for_path(&directory.control_ready());

    let terminated = match NativeAdapter::cleanup(&mut adapter).await {
        NativeCleanupResult::Terminated(exit) => exit,
        _ => panic!("expected destructive cleanup"),
    };
    assert_exit(&terminated, 1);
    root.wait_signaled().unwrap();
    member.wait_signaled().unwrap();
    assert!(!control_observation.is_signaled().unwrap());

    let repeated = match NativeAdapter::cleanup(&mut adapter).await {
        NativeCleanupResult::Terminated(exit) => exit,
        _ => panic!("expected cached destructive cleanup"),
    };
    assert_eq!(repeated, terminated);
    assert!(!control_observation.is_signaled().unwrap());

    fs::write(directory.control_release(), b"release").unwrap();
    control.wait_success().unwrap();
    control_observation.wait_signaled().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_executable_is_typed_as_drained_launch_failure() {
    assert_parent_role();
    let directory = TestDirectory::new("windows-adapter-missing-executable");
    let launch = LaunchSpec::try_new(
        directory.path().join("not-present.exe"),
        directory.path().to_path_buf(),
        std::iter::empty::<OsString>(),
        std::iter::empty::<(OsString, OsString)>(),
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .unwrap();
    let mut adapter = Adapter::new();

    assert!(matches!(
        NativeAdapter::install(&mut adapter, LaunchRequest::fixed(launch)).await,
        NativeInstallResult::Drained(BeginDrained::LaunchFailed(
            LaunchFailure::ArtifactUnavailable
        ))
    ));
    assert!(!directory.entry_marker().exists());
}

#[test]
fn dropped_install_future_resumes_the_same_task() {
    match helper_role().as_deref() {
        Some("install-drop-root") => {
            run_waiting_root();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let runtime = cancellation_runtime();
    runtime.block_on(async {
        let directory = TestDirectory::new("windows-adapter-install-drop");
        let launch = helper_launch_spec(INSTALL_DROP_TEST, "install-drop-root", directory.path());
        let mut adapter = Adapter::new();
        let (release, blocked) = operation_barrier();
        adapter.install = Some(
            BlockingOperation::spawn(
                "foundation-windows-test-install",
                launch.clone(),
                move |spec| {
                    blocked.recv().unwrap();
                    install_custody((spec, None, None))
                },
            )
            .unwrap_or_else(|_| panic!("test install operation must spawn")),
        );

        let mut install =
            NativeAdapter::install(&mut adapter, LaunchRequest::fixed(launch.clone()));
        assert!(matches!(poll_once(install.as_mut()), Poll::Pending));
        drop(install);
        assert!(adapter.install.is_some());

        release.send(()).unwrap();
        let observation =
            match NativeAdapter::install(&mut adapter, LaunchRequest::fixed(launch)).await {
                NativeInstallResult::Installed(observation, _) => observation,
                _ => panic!("expected resumed adapter installation"),
            };
        assert!(adapter.install.is_none());
        wait_for_path(&directory.root_ready());
        assert!(!directory.entry_marker().exists());
        let root = ObservationHandle::open(observation.identity().pid()).unwrap();

        assert!(matches!(
            NativeAdapter::cleanup(&mut adapter).await,
            NativeCleanupResult::Terminated(_)
        ));
        root.wait_signaled().unwrap();
    });
}

#[test]
fn dropped_cleanup_future_resumes_the_same_task() {
    match helper_role().as_deref() {
        Some("cleanup-drop-root") => {
            run_waiting_root();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let runtime = cancellation_runtime();
    runtime.block_on(async {
        let directory = TestDirectory::new("windows-adapter-cleanup-drop");
        let launch = helper_launch_spec(CLEANUP_DROP_TEST, "cleanup-drop-root", directory.path());
        let (mut adapter, observation) = install_adapter(launch).await;
        let root = ObservationHandle::open(observation.identity().pid()).unwrap();
        wait_for_path(&directory.root_ready());
        let custody = adapter
            .custody
            .take()
            .expect("installed adapter must retain custody");
        let (release, blocked) = operation_barrier();
        adapter.cleanup = Some(
            BlockingOperation::spawn(
                "foundation-windows-test-cleanup",
                custody,
                move |mut custody| {
                    blocked.recv().unwrap();
                    let result = custody.cleanup();
                    (custody, result)
                },
            )
            .unwrap_or_else(|_| panic!("test cleanup operation must spawn")),
        );

        let mut cleanup = NativeAdapter::cleanup(&mut adapter);
        assert!(matches!(poll_once(cleanup.as_mut()), Poll::Pending));
        drop(cleanup);
        assert!(adapter.cleanup.is_some());
        assert!(adapter.custody.is_none());

        release.send(()).unwrap();
        assert!(matches!(
            NativeAdapter::cleanup(&mut adapter).await,
            NativeCleanupResult::Terminated(_)
        ));
        assert!(adapter.cleanup.is_none());
        root.wait_signaled().unwrap();
    });
}

#[test]
fn adapter_drop_joins_in_flight_install_owner() {
    match helper_role().as_deref() {
        Some("install-owner-drop-root") => {
            run_waiting_root();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let runtime = cancellation_runtime();
    runtime.block_on(async {
        let directory = TestDirectory::new("windows-adapter-install-owner-drop");
        let launch = helper_launch_spec(
            INSTALL_OWNER_DROP_TEST,
            "install-owner-drop-root",
            directory.path(),
        );
        let (release, blocked) = operation_barrier();
        let (installed, observation) = std::sync::mpsc::channel();
        let (return_output, output_release) = operation_barrier();
        let mut adapter = Adapter::new();
        adapter.install = Some(
            BlockingOperation::spawn(
                "foundation-windows-test-install-drop",
                launch,
                move |spec| {
                    blocked.recv().unwrap();
                    let outcome = install_custody((spec, None, None));
                    let observation = match &outcome {
                        super::super::custody::LaunchOutcome::Installed(custody, _) => {
                            custody.observation()
                        }
                        _ => panic!("test install operation must retain installed custody"),
                    };
                    installed.send(observation).unwrap();
                    output_release.recv().unwrap();
                    outcome
                },
            )
            .unwrap_or_else(|_| panic!("test install operation must spawn")),
        );

        let (drop_started, dropping) = std::sync::mpsc::channel();
        let (drop_finished, dropped) = std::sync::mpsc::channel();
        let dropper = std::thread::spawn(move || {
            drop_started.send(()).unwrap();
            drop(adapter);
            drop_finished.send(()).unwrap();
        });
        dropping.recv_timeout(PROBE_DEADLINE).unwrap();
        assert!(matches!(
            dropped.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        release.send(()).unwrap();
        let observation = observation.recv_timeout(PROBE_DEADLINE).unwrap();
        let root = ObservationHandle::open(observation.identity().pid()).unwrap();
        return_output.send(()).unwrap();
        dropped.recv_timeout(PROBE_DEADLINE).unwrap();
        dropper.join().unwrap();
        root.wait_signaled().unwrap();
    });
}

#[test]
fn adapter_drop_joins_in_flight_cleanup_owner() {
    match helper_role().as_deref() {
        Some("cleanup-owner-drop-root") => {
            run_waiting_root();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let runtime = cancellation_runtime();
    runtime.block_on(async {
        let directory = TestDirectory::new("windows-adapter-cleanup-owner-drop");
        let launch = helper_launch_spec(
            CLEANUP_OWNER_DROP_TEST,
            "cleanup-owner-drop-root",
            directory.path(),
        );
        let (mut adapter, observation) = install_adapter(launch).await;
        let root = ObservationHandle::open(observation.identity().pid()).unwrap();
        wait_for_path(&directory.root_ready());
        let custody = adapter
            .custody
            .take()
            .expect("installed adapter must retain custody");
        let (release, blocked) = operation_barrier();
        let (finished, completion) = std::sync::mpsc::channel();
        adapter.cleanup = Some(
            BlockingOperation::spawn(
                "foundation-windows-test-cleanup-drop",
                custody,
                move |custody| {
                    blocked.recv().unwrap();
                    finished.send(()).unwrap();
                    (
                        custody,
                        Err::<CustodyCleanup, TerminationFailure>(
                            TerminationFailure::CleanupUnconfirmed,
                        ),
                    )
                },
            )
            .unwrap_or_else(|_| panic!("test cleanup operation must spawn")),
        );

        let (drop_started, dropping) = std::sync::mpsc::channel();
        let (drop_finished, dropped) = std::sync::mpsc::channel();
        let dropper = std::thread::spawn(move || {
            drop_started.send(()).unwrap();
            drop(adapter);
            drop_finished.send(()).unwrap();
        });
        dropping.recv_timeout(PROBE_DEADLINE).unwrap();
        assert!(matches!(
            dropped.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(!root.is_signaled().unwrap());
        release.send(()).unwrap();
        completion.recv_timeout(PROBE_DEADLINE).unwrap();
        dropped.recv_timeout(PROBE_DEADLINE).unwrap();
        dropper.join().unwrap();
        root.wait_signaled().unwrap();
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unresolved_cleanup_retains_custody_for_retry() {
    match helper_role().as_deref() {
        Some("retry-root") => run_scope_root(
            CLEANUP_RETRY_TEST,
            "retry-member",
            RootBehavior::WaitForRelease,
        ),
        Some("retry-member") => {
            run_scope_member();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-adapter-cleanup-retry");
    let launch = helper_launch_spec(CLEANUP_RETRY_TEST, "retry-root", directory.path());
    let (mut adapter, observation) = install_adapter(launch).await;
    let root = ObservationHandle::open(observation.identity().pid()).unwrap();
    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());

    // Seed the exact completed-operation state produced by unconfirmed custody cleanup.
    let custody = adapter
        .custody
        .take()
        .expect("installed adapter must retain custody");
    adapter.cleanup = Some(
        BlockingOperation::spawn("foundation-windows-test-retry", custody, |custody| {
            (
                custody,
                std::result::Result::<CustodyCleanup, TerminationFailure>::Err(
                    TerminationFailure::CleanupUnconfirmed,
                ),
            )
        })
        .unwrap_or_else(|_| panic!("test retry operation must spawn")),
    );

    assert!(matches!(
        NativeAdapter::cleanup(&mut adapter).await,
        NativeCleanupResult::Unresolved(TerminationFailure::CleanupUnconfirmed)
    ));
    assert!(matches!(
        adapter.custody.as_ref(),
        Some(WindowsCustody::Owned(_))
    ));
    assert_eq!(adapter.observation, Some(observation));
    assert!(matches!(
        NativeAdapter::install(
            &mut adapter,
            LaunchRequest::fixed(helper_launch_spec(CLEANUP_RETRY_TEST, "retry-root", directory.path())),
        )
        .await,
        NativeInstallResult::Unresolved {
            observation: Some(current),
            failure: TerminationFailure::CleanupUnconfirmed,
        } if current == observation
    ));

    assert!(matches!(
        NativeAdapter::cleanup(&mut adapter).await,
        NativeCleanupResult::Terminated(_)
    ));
    root.wait_signaled().unwrap();
    member.wait_signaled().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_poll_future_preserves_custody_for_cleanup() {
    match helper_role().as_deref() {
        Some("poll-drop-root") => run_scope_root(
            POLL_DROP_TEST,
            "poll-drop-member",
            RootBehavior::WaitForRelease,
        ),
        Some("poll-drop-member") => {
            run_scope_member();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-adapter-poll-drop");
    let launch = helper_launch_spec(POLL_DROP_TEST, "poll-drop-root", directory.path());
    let (mut adapter, observation) = install_adapter(launch).await;
    let root = ObservationHandle::open(observation.identity().pid()).unwrap();
    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());

    let poll = NativeAdapter::poll(&mut adapter);
    drop(poll);
    assert!(adapter.custody.is_some());
    assert!(matches!(
        NativeAdapter::cleanup(&mut adapter).await,
        NativeCleanupResult::Terminated(_)
    ));
    root.wait_signaled().unwrap();
    member.wait_signaled().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detach_is_unresolved_without_releasing_custody() {
    match helper_role().as_deref() {
        Some("detach-root") => {
            run_scope_root(DETACH_TEST, "detach-member", RootBehavior::WaitForRelease)
        }
        Some("detach-member") => {
            run_scope_member();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-adapter-detach");
    let launch = helper_launch_spec(DETACH_TEST, "detach-root", directory.path());
    let (mut adapter, observation) = install_adapter(launch).await;
    let root = ObservationHandle::open(observation.identity().pid()).unwrap();
    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());

    assert!(matches!(
        NativeAdapter::detach(&mut adapter).await,
        NativeDetachResult::Unresolved(TerminationFailure::CleanupUnconfirmed)
    ));
    assert!(!root.is_signaled().unwrap());
    assert!(!member.is_signaled().unwrap());
    assert!(adapter.custody.is_some());

    assert!(matches!(
        NativeAdapter::cleanup(&mut adapter).await,
        NativeCleanupResult::Terminated(_)
    ));
    root.wait_signaled().unwrap();
    member.wait_signaled().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resource_runtime_drop_is_nonblocking_and_contains_scope_without_success_claim() {
    match helper_role().as_deref() {
        Some("runtime-drop-root") => run_scope_root(
            RUNTIME_DROP_TEST,
            "runtime-drop-member",
            RootBehavior::WaitForRelease,
        ),
        Some("runtime-drop-member") => {
            run_scope_member();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-resource-runtime-drop-containment");
    let launch = helper_launch_spec(RUNTIME_DROP_TEST, "runtime-drop-root", directory.path());
    let mut runtime = super::super::resource(FixedLaunch::new(launch));
    runtime.task.start();
    runtime.client.begin().await.unwrap();
    assert!(matches!(
        recv_event(&mut runtime).await,
        ResourceEvent::BeginAccepted(_)
    ));
    let installed = match recv_event(&mut runtime).await {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installed resource"),
    };
    let root = ObservationHandle::open(installed.observation.identity().pid()).unwrap();
    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );

    let started = Instant::now();
    drop(runtime);
    assert!(started.elapsed() < Duration::from_secs(1));

    // ResourceRuntime Drop returns no cleanup result. Eventual exit only proves adapter Job-close
    // containment after asynchronous owner teardown, never verified cleanup success.
    root.wait_signaled().unwrap();
    member.wait_signaled().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adapter_drop_is_nonblocking_and_job_close_contains_scope() {
    match helper_role().as_deref() {
        Some("drop-root") => run_scope_root(
            DROP_CONTAINMENT_TEST,
            "drop-member",
            RootBehavior::WaitForRelease,
        ),
        Some("drop-member") => {
            run_scope_member();
            return;
        }
        Some(_) => panic!("unexpected helper role"),
        None => {}
    }

    let directory = TestDirectory::new("windows-adapter-drop-containment");
    let launch = helper_launch_spec(DROP_CONTAINMENT_TEST, "drop-root", directory.path());
    let (adapter, observation) = install_adapter(launch).await;
    let root = ObservationHandle::open(observation.identity().pid()).unwrap();
    wait_for_path(&directory.member_ready());
    let member = ObservationHandle::open(wait_for_pid(&directory.member_pid())).unwrap();
    wait_for_path(&directory.root_ready());

    let started = Instant::now();
    drop(adapter);
    assert!(started.elapsed() < Duration::from_secs(1));

    // No cleanup result exists on Drop; process termination only demonstrates Job-close
    // containment and must not be interpreted as verified cleanup success.
    root.wait_signaled().unwrap();
    member.wait_signaled().unwrap();
}

fn cancellation_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap()
}

fn operation_barrier() -> (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>) {
    std::sync::mpsc::channel()
}

fn poll_once<T>(future: std::pin::Pin<&mut dyn Future<Output = T>>) -> Poll<T> {
    let waker = std::task::Waker::noop();
    let mut context = std::task::Context::from_waker(waker);
    future.poll(&mut context)
}

async fn install_adapter(launch: LaunchSpec) -> (Adapter, ProcessObservation) {
    let mut adapter = Adapter::new();
    let observation = install_observation(&mut adapter, launch).await;
    (adapter, observation)
}

async fn install_observation(adapter: &mut Adapter, launch: LaunchSpec) -> ProcessObservation {
    match NativeAdapter::install(adapter, LaunchRequest::fixed(launch)).await {
        NativeInstallResult::Installed(observation, _) => observation,
        _ => panic!("expected adapter installation"),
    }
}

async fn poll_until_drained(adapter: &mut Adapter) -> ExitObservation {
    let deadline = Instant::now() + PROBE_DEADLINE;
    loop {
        match NativeAdapter::poll(adapter).await {
            NativePollResult::Pending => {
                assert!(
                    Instant::now() < deadline,
                    "adapter did not drain before the smoke deadline"
                );
                tokio::time::sleep(PROBE_POLL).await;
            }
            NativePollResult::Drained(exit) => return exit,
            NativePollResult::Unresolved(_) => panic!("adapter lost custody while polling"),
        }
    }
}

async fn recv_event(runtime: &mut ResourceRuntime) -> ResourceEvent {
    tokio::time::timeout(PROBE_DEADLINE, runtime.events.recv())
        .await
        .expect("resource event exceeded the smoke deadline")
        .expect("resource owner stopped before the expected event")
}

fn assert_exit(exit: &ExitObservation, code: i32) {
    assert_eq!(exit.exit_code(), Some(code));
    assert_eq!(exit.signal(), None);
}

#[derive(Clone, Copy)]
enum RootBehavior {
    Exit(i32),
    WaitForRelease,
}

fn run_waiting_root() {
    let directory = helper_directory();
    fs::write(directory.join("root.ready"), b"ready").unwrap();
    wait_for_release(&directory.join("scope.release"));
}

fn run_scope_root(test_name: &str, member_role: &str, behavior: RootBehavior) -> ! {
    let directory = helper_directory();
    let member = helper_command(test_name, member_role, &directory)
        .spawn()
        .unwrap();
    fs::write(directory.join("member.pid"), member.id().to_string()).unwrap();
    drop(member);
    wait_for_path(&directory.join("member.ready"));
    fs::write(directory.join("root.ready"), b"ready").unwrap();
    match behavior {
        RootBehavior::Exit(code) => process::exit(code),
        RootBehavior::WaitForRelease => {
            wait_for_release(&directory.join("scope.release"));
            process::exit(0)
        }
    }
}

fn run_scope_member() {
    let directory = helper_directory();
    fs::write(directory.join("member.ready"), b"ready").unwrap();
    wait_for_release(&directory.join("scope.release"));
}

fn run_control() {
    let directory = helper_directory();
    fs::write(directory.join("control.ready"), b"ready").unwrap();
    wait_for_release(&directory.join("control.release"));
}

fn helper_role() -> Option<String> {
    std::env::var_os(ROLE_ENV).map(|role| role.to_string_lossy().into_owned())
}

fn assert_parent_role() {
    assert!(std::env::var_os(ROLE_ENV).is_none());
    assert!(std::env::var_os(DIRECTORY_ENV).is_none());
}
