use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll, Wake, Waker},
    time::Duration,
};

use tokio::time::Instant;

use super::super::owner::POLL_INTERVAL;
use super::super::{
    Activation, ActivationOutcome, BeginCompletion, NativeAdapter, NativeCleanupResult,
    NativeDetachResult, NativeFuture, NativeInstallResult, NativePollResult, NativeStdio,
    ResourceEvent, ResourceFailure, ResourceRuntime, ResourceShutdown, TerminalOrigin,
};
use super::support::{FakeAdapter, observation, test_launch, test_spec};
use crate::process::{
    LaunchAttempt, LaunchAttemptCleanupFailure, LaunchAttemptFuture, LaunchAttemptGuard,
    LaunchAttemptMaterializer, ProcessStdio, TerminationFailure,
};

struct GuardedMaterializer {
    markers: Arc<Mutex<VecDeque<&'static str>>>,
    calls: Arc<AtomicUsize>,
    cleanup_calls: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
}

impl GuardedMaterializer {
    fn new(
        markers: impl IntoIterator<Item = &'static str>,
    ) -> (Self, Arc<AtomicUsize>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let cleanup_calls = Arc::new(AtomicUsize::new(0));
        let drops = Arc::new(AtomicUsize::new(0));
        (
            Self {
                markers: Arc::new(Mutex::new(markers.into_iter().collect())),
                calls: calls.clone(),
                cleanup_calls: cleanup_calls.clone(),
                drops: drops.clone(),
            },
            calls,
            cleanup_calls,
            drops,
        )
    }
}

impl LaunchAttemptMaterializer for GuardedMaterializer {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let marker = self.markers.lock().unwrap().pop_front().unwrap();
        let cleanup_calls = self.cleanup_calls.clone();
        let drops = self.drops.clone();
        Box::pin(async move {
            Ok(LaunchAttempt::new(
                test_spec(marker),
                Guard {
                    cleanup_calls,
                    drops,
                },
            ))
        })
    }
}

struct Guard {
    cleanup_calls: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
}

impl LaunchAttemptGuard for Guard {
    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

struct PanicsOnceOnCleanup {
    adapter: FakeAdapter,
    cleanup_calls: usize,
}

impl NativeAdapter for PanicsOnceOnCleanup {
    fn install(
        &mut self,
        request: crate::process::launch::LaunchRequest,
    ) -> NativeFuture<'_, NativeInstallResult> {
        self.adapter.install(request)
    }

    fn poll(&mut self) -> NativeFuture<'_, NativePollResult> {
        self.adapter.poll()
    }

    fn cleanup(&mut self) -> NativeFuture<'_, NativeCleanupResult> {
        self.cleanup_calls += 1;
        if self.cleanup_calls == 1 {
            Box::pin(async { panic!("expected adapter cleanup unwind") })
        } else {
            self.adapter.cleanup()
        }
    }

    fn detach(&mut self) -> NativeFuture<'_, NativeDetachResult> {
        self.adapter.detach()
    }
}

struct PanickingWake;

impl Wake for PanickingWake {
    fn wake(self: Arc<Self>) {
        panic!("expected activation reply wake unwind");
    }
}

#[tokio::test(start_paused = true)]
async fn pending_poll_does_not_block_wait_deadline_or_kill() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.block_poll();
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected begin acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );
    tokio::time::advance(POLL_INTERVAL).await;
    adapter.wait_poll_called().await;

    let deadline = Instant::now() + Duration::from_millis(10);
    let waiter = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.wait_drained(epoch, deadline).await }
    });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(10)).await;
    assert_eq!(waiter.await.unwrap(), Err(ResourceFailure::TimedOut));

    let kill = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.kill(epoch).await.unwrap() }
    });
    let ResourceEvent::NativeFact(fact) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal fact");
    };
    assert!(Arc::ptr_eq(&fact, &kill.await.unwrap()));
    runtime.client.shutdown(None).await.unwrap();
    runtime.task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn pending_poll_does_not_block_shutdown() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.block_poll();
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected begin acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );
    tokio::time::advance(POLL_INTERVAL).await;
    adapter.wait_poll_called().await;

    let shutdown = runtime.client.shutdown(Some(epoch)).await.unwrap();
    let ResourceShutdown::Terminated(evidence) = shutdown else {
        panic!("expected terminated shutdown");
    };
    assert_eq!(evidence.origin(), TerminalOrigin::DestructiveCleanup);
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn cancelled_shutdown_wait_preserves_adapter_custody_until_terminal_and_owner_join() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.block_cleanup();
    let (materializer, calls, cleanup_calls, drops) =
        GuardedMaterializer::new(["cancelled-cleanup"]);
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected begin acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );

    let cancelled = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.shutdown(Some(epoch)).await }
    });
    adapter.wait_cleanup_called().await;
    cancelled.abort();
    assert!(matches!(cancelled.await, Err(error) if error.is_cancelled()));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(!runtime.task.is_finished());

    adapter.allow_cleanup();
    let ResourceEvent::NativeFact(_) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal evidence");
    };
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelled_kill_preserves_custody_for_following_shutdown_terminal_evidence() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.block_cleanup();
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected begin acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );

    let cancelled = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.kill(epoch).await }
    });
    adapter.wait_cleanup_called().await;
    cancelled.abort();
    assert!(matches!(cancelled.await, Err(error) if error.is_cancelled()));

    let shutdown = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.shutdown(Some(epoch)).await.unwrap() }
    });
    tokio::task::yield_now().await;
    assert_eq!(adapter.cleanup_calls(), 1);

    adapter.allow_cleanup();
    let ResourceEvent::NativeFact(fact) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal evidence");
    };
    let ResourceShutdown::Terminated(shutdown_fact) = shutdown.await.unwrap() else {
        panic!("expected following shutdown to reuse terminal evidence");
    };
    assert!(Arc::ptr_eq(&fact, &shutdown_fact));
    assert_eq!(adapter.cleanup_calls(), 1);
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn activation_reply_unwind_in_closing_holds_guard_until_terminal_and_owner_join() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.block_cleanup();
    let (materializer, calls, cleanup_calls, drops) = GuardedMaterializer::new(["closing-unwind"]);
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);
    runtime.client.begin().await.unwrap();
    let ResourceEvent::BeginAccepted(_) = runtime.events.recv().await.unwrap() else {
        panic!("expected begin acceptance");
    };
    adapter.allow_install();
    let ResourceEvent::BeginCompleted {
        completion: BeginCompletion::Installed(installed),
        ..
    } = runtime.events.recv().await.unwrap()
    else {
        panic!("expected installation");
    };

    let Activation {
        sender,
        mut outcome,
    } = installed.activation;
    let waker = Waker::from(Arc::new(PanickingWake));
    let mut context = Context::from_waker(&waker);
    assert!(matches!(
        Future::poll(Pin::new(&mut outcome), &mut context),
        Poll::Pending
    ));
    drop(sender);

    tokio::time::timeout(Duration::from_secs(1), adapter.wait_cleanup_called())
        .await
        .expect("closing unwind cleanup starts");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(!runtime.task.is_finished());

    adapter.allow_cleanup();
    let mut owner = runtime.task;
    let joined = tokio::time::timeout(Duration::from_secs(1), &mut owner)
        .await
        .expect("resource owner joins after closing unwind cleanup");
    assert!(matches!(joined, Err(error) if error.is_panic()));
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unpublished_install_materializes_once_and_drops_guard_after_verified_cleanup() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let (materializer, calls, cleanup_calls, drops) = GuardedMaterializer::new(["orphan-attempt"]);
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);
    runtime.client.begin().await.unwrap();
    adapter.wait_install_called().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    runtime.events.close();
    adapter.allow_install();

    adapter.wait_cleanup_returned().await;
    assert_eq!(adapter.installed_markers(), ["orphan-attempt"]);
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn orphan_unconfirmed_cleanup_holds_custody_until_verified_cleanup() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    let (materializer, calls, cleanup_calls, drops) =
        GuardedMaterializer::new(["unresolved-orphan"]);
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);
    runtime.client.begin().await.unwrap();
    let ResourceEvent::BeginAccepted(_) = runtime.events.recv().await.unwrap() else {
        panic!("expected acceptance");
    };
    adapter.wait_install_called().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    runtime.events.close();
    adapter.allow_install();

    adapter.wait_cleanup_returned().await;
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(!adapter.is_dropped());
    runtime.task.await.unwrap();
    adapter.wait_dropped().await;
    assert_eq!(adapter.cleanup_calls(), 2);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn adapter_cleanup_panic_preserves_guard_for_same_epoch_terminal_retry_and_join() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let (materializer, calls, cleanup_calls, drops) =
        GuardedMaterializer::new(["panicked-cleanup"]);
    let mut runtime = ResourceRuntime::spawn(
        PanicsOnceOnCleanup {
            adapter: adapter.clone(),
            cleanup_calls: 0,
        },
        materializer,
    );
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected begin acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Unresolved(TerminationFailure::AuthorityLost)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(!runtime.task.is_finished());

    let retried =
        tokio::time::timeout(Duration::from_secs(1), runtime.client.shutdown(Some(epoch))).await;
    if !matches!(retried, Ok(Ok(ResourceShutdown::Terminated(_)))) {
        runtime.task.abort();
        let _ = runtime.task.await;
        panic!("cleanup unwind lost same-epoch adapter custody");
    }
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn outer_task_panic_holds_guard_until_orphan_cleanup_and_owner_join() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    let (materializer, calls, cleanup_calls, drops) = GuardedMaterializer::new(["panicked-owner"]);
    let runtime = ResourceRuntime::spawn(adapter.clone(), materializer);
    let client = runtime.client;
    let mut events = runtime.events;
    let owner = runtime.task;
    adapter.allow_install();

    let panicked = tokio::spawn(async move {
        client.begin().await.unwrap();
        let ResourceEvent::BeginAccepted(_) = events.recv().await.unwrap() else {
            panic!("expected acceptance");
        };
        let ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } = events.recv().await.unwrap()
        else {
            panic!("expected installation");
        };
        assert_eq!(
            installed.activation.activate().await.unwrap(),
            ActivationOutcome::Active
        );
        panic!("expected outer task unwind");
    });
    assert!(panicked.await.unwrap_err().is_panic());

    adapter.wait_cleanup_returned().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(!owner.is_finished());

    tokio::time::advance(POLL_INTERVAL).await;
    owner.await.unwrap();
    assert_eq!(adapter.cleanup_calls(), 2);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn abandoned_poll_cannot_overwrite_cleanup_unconfirmed() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.block_poll();
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );
    tokio::time::advance(POLL_INTERVAL).await;
    adapter.wait_poll_called().await;

    let kill = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.kill(epoch).await }
    });
    let ResourceEvent::Unresolved { failure, .. } = runtime.events.recv().await.unwrap() else {
        panic!("expected unresolved fact");
    };
    assert_eq!(
        kill.await.unwrap(),
        Err(ResourceFailure::CleanupUnconfirmed)
    );
    assert_eq!(failure, TerminationFailure::CleanupUnconfirmed);
    tokio::task::yield_now().await;
    assert!(runtime.events.try_recv().is_err());

    let shutdown = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.shutdown(Some(epoch)).await.unwrap() }
    });
    let ResourceEvent::NativeFact(_) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal fact after retry cleanup");
    };
    let ResourceShutdown::Terminated(_) = shutdown.await.unwrap() else {
        panic!("expected retry cleanup to terminate resource");
    };
    runtime.task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn cached_terminal_ignores_stale_unresolved_poll_before_activation() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.block_poll();
    adapter.push_poll(NativePollResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    tokio::time::advance(POLL_INTERVAL).await;
    adapter.wait_poll_called().await;

    let shutdown = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.shutdown(Some(epoch)).await.unwrap() }
    });
    adapter.allow_poll();
    let activation = tokio::spawn(installed.activation.activate());
    let ResourceEvent::NativeFact(fact) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal evidence");
    };
    assert!(runtime.events.try_recv().is_err());
    let ResourceShutdown::Terminated(shutdown_fact) = shutdown.await.unwrap() else {
        panic!("expected terminated shutdown");
    };
    let Ok(ActivationOutcome::Terminal(activated)) = activation.await.unwrap() else {
        panic!("expected terminal activation outcome");
    };
    assert!(Arc::ptr_eq(&fact, &shutdown_fact));
    assert!(Arc::ptr_eq(&fact, &activated));
    runtime.task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn sustained_requests_do_not_starve_waiter_deadline_or_poll_progress() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );

    let waiter = tokio::spawn({
        let client = runtime.client.clone();
        async move {
            client
                .wait_drained(epoch, Instant::now() + Duration::from_millis(10))
                .await
        }
    });
    let mut hot_requests = Vec::new();
    for offset in 1..=4 {
        hot_requests.push(tokio::spawn({
            let client = runtime.client.clone();
            async move {
                client
                    .wait_drained(epoch, Instant::now() + Duration::from_secs(offset))
                    .await
            }
        }));
    }
    tokio::time::advance(Duration::from_millis(10)).await;
    assert_eq!(waiter.await.unwrap(), Err(ResourceFailure::TimedOut));
    adapter.wait_poll_called().await;
    for request in hot_requests {
        request.abort();
    }

    let shutdown = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.shutdown(Some(epoch)).await.unwrap() }
    });
    let ResourceEvent::NativeFact(_) = runtime.events.recv().await.unwrap() else {
        panic!("expected shutdown terminal fact");
    };
    assert!(matches!(
        shutdown.await.unwrap(),
        ResourceShutdown::Terminated(_)
    ));
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn shutdown_while_activation_is_pending_completes() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };

    let shutdown = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.shutdown(Some(epoch)).await.unwrap() }
    });
    let activation = tokio::spawn(installed.activation.activate());
    let ResourceShutdown::Terminated(evidence) = shutdown.await.unwrap() else {
        panic!("expected terminated shutdown");
    };
    assert_eq!(evidence.origin(), TerminalOrigin::DestructiveCleanup);
    let Ok(ActivationOutcome::Terminal(activated)) = activation.await.unwrap() else {
        panic!("expected terminal activation outcome");
    };
    assert!(Arc::ptr_eq(&evidence, &activated));
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn dropped_activation_commits_cleanup_terminal_evidence() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    let waiter = tokio::spawn({
        let client = runtime.client.clone();
        async move {
            client
                .wait_drained(epoch, Instant::now() + Duration::from_secs(1))
                .await
                .unwrap()
        }
    });
    drop(installed);

    let ResourceEvent::NativeFact(fact) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal fact");
    };
    assert!(Arc::ptr_eq(&fact, &waiter.await.unwrap()));
    assert_eq!(fact.origin(), TerminalOrigin::DestructiveCleanup);
    assert_eq!(adapter.cleanup_calls(), 1);
    runtime.client.shutdown(None).await.unwrap();
    runtime.task.await.unwrap();
}
