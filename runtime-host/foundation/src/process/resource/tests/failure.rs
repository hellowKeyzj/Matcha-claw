use std::{
    collections::VecDeque,
    num::NonZeroU64,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use tokio::time::Instant;

use super::super::{
    BeginCompletion, BeginDrained, NativeCleanupResult, NativeDetachResult, NativeInstallResult,
    NativeStdio, ResourceEpoch, ResourceEvent, ResourceFailure, ResourceRuntime, ResourceShutdown,
    TerminalOrigin,
};
use super::support::{FakeAdapter, observation, test_launch, test_spec};
use crate::process::{
    LaunchAttempt, LaunchAttemptCleanupFailure, LaunchAttemptFuture, LaunchAttemptGuard,
    LaunchAttemptMaterializer, LaunchMaterializationFailure, ProcessIdentity, ProcessObservation,
    ProcessStdio, Provenance, TerminationFailure, supervision::LaunchFailure,
};

struct AttemptMaterializer {
    results: Arc<Mutex<VecDeque<Result<&'static str, LaunchFailure>>>>,
    calls: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
}

impl AttemptMaterializer {
    fn sequence(
        results: impl IntoIterator<Item = Result<&'static str, LaunchFailure>>,
    ) -> (Self, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let drops = Arc::new(AtomicUsize::new(0));
        (
            Self {
                results: Arc::new(Mutex::new(results.into_iter().collect())),
                calls: calls.clone(),
                drops: drops.clone(),
            },
            calls,
            drops,
        )
    }
}

impl LaunchAttemptMaterializer for AttemptMaterializer {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = self.results.lock().unwrap().pop_front().unwrap();
        let drops = self.drops.clone();
        Box::pin(async move {
            result
                .map(|marker| LaunchAttempt::new(test_spec(marker), AttemptGuard(drops)))
                .map_err(LaunchMaterializationFailure::new)
        })
    }
}

struct AttemptGuard(Arc<AtomicUsize>);

impl LaunchAttemptGuard for AttemptGuard {
    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        Ok(())
    }
}

impl Drop for AttemptGuard {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

struct RetryingCleanupMaterializer {
    cleanup_calls: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
}

impl LaunchAttemptMaterializer for RetryingCleanupMaterializer {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let cleanup_calls = self.cleanup_calls.clone();
        let drops = self.drops.clone();
        Box::pin(async move {
            Ok(LaunchAttempt::new(
                test_spec("retrying-cleanup-attempt"),
                RetryingCleanupGuard {
                    cleanup_calls,
                    drops,
                },
            ))
        })
    }
}

struct RetryingCleanupGuard {
    cleanup_calls: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
}

impl LaunchAttemptGuard for RetryingCleanupGuard {
    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        if self.cleanup_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(LaunchAttemptCleanupFailure)
        } else {
            Ok(())
        }
    }
}

impl Drop for RetryingCleanupGuard {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

struct PartialFailureMaterializer {
    cleanup_calls: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
}

impl LaunchAttemptMaterializer for PartialFailureMaterializer {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let cleanup_calls = self.cleanup_calls.clone();
        let drops = self.drops.clone();
        Box::pin(async move {
            Err(LaunchMaterializationFailure::with_guard(
                LaunchFailure::ResourceUnavailable,
                RetryingCleanupGuard {
                    cleanup_calls,
                    drops,
                },
            ))
        })
    }
}

struct CountingMaterializer(Arc<AtomicUsize>);

impl LaunchAttemptMaterializer for CountingMaterializer {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { panic!("attached resource must not materialize") })
    }
}

#[tokio::test]
async fn materialization_failure_skips_install_and_returns_typed_launch_failure() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let (materializer, calls, drops) =
        AttemptMaterializer::sequence([Err(LaunchFailure::PermissionDenied)]);
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);

    runtime.client.begin().await.unwrap();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginAccepted(_))
    ));
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Drained(BeginDrained::LaunchFailed(
                LaunchFailure::PermissionDenied
            )),
            ..
        })
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(adapter.installed_markers().is_empty());
    assert_eq!(drops.load(Ordering::SeqCst), 0);

    runtime.client.shutdown(None).await.unwrap();
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn partial_materialization_cleanup_failure_retries_same_epoch() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let cleanup_calls = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let materializer = PartialFailureMaterializer {
        cleanup_calls: cleanup_calls.clone(),
        drops: drops.clone(),
    };
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);

    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginCompleted {
            completion: BeginCompletion::MaterialCleanupFailed { .. },
            ..
        })
    ));
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(adapter.installed_markers().is_empty());
    assert!(!runtime.task.is_finished());

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::NoResource
    ));
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 2);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn launch_guard_survives_install_activation_and_running_until_verified_terminal() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let (materializer, calls, drops) = AttemptMaterializer::sequence([Ok("guarded-attempt")]);
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);

    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    adapter.wait_install_called().await;
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installation"),
    };
    assert_eq!(adapter.installed_markers(), ["guarded-attempt"]);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        super::super::ActivationOutcome::Active
    );
    assert_eq!(drops.load(Ordering::SeqCst), 0);

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Terminated(_)
    ));
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn drained_install_material_cleanup_failure_retries_same_epoch() {
    let adapter = FakeAdapter::new(NativeInstallResult::Drained(BeginDrained::LaunchFailed(
        LaunchFailure::PlatformRejected,
    )));
    let cleanup_calls = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let materializer = RetryingCleanupMaterializer {
        cleanup_calls: cleanup_calls.clone(),
        drops: drops.clone(),
    };
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);

    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    adapter.allow_install();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginCompleted {
            completion: BeginCompletion::MaterialCleanupFailed { .. },
            ..
        })
    ));
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(!runtime.task.is_finished());

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::NoResource
    ));
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 2);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn drained_install_material_cleanup_failure_expires_waiters_without_polling() {
    let adapter = FakeAdapter::new(NativeInstallResult::Drained(BeginDrained::LaunchFailed(
        LaunchFailure::PlatformRejected,
    )));
    let cleanup_calls = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let materializer = RetryingCleanupMaterializer {
        cleanup_calls: cleanup_calls.clone(),
        drops: drops.clone(),
    };
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);

    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    adapter.allow_install();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginCompleted {
            completion: BeginCompletion::MaterialCleanupFailed { .. },
            ..
        })
    ));

    let waiter = tokio::spawn({
        let client = runtime.client.clone();
        async move {
            client
                .wait_drained(epoch, Instant::now() + Duration::from_millis(10))
                .await
        }
    });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(10)).await;

    assert_eq!(waiter.await.unwrap(), Err(ResourceFailure::TimedOut));
    assert_eq!(adapter.poll_calls(), 0);
    assert_eq!(adapter.cleanup_calls(), 0);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::NoResource
    ));
    runtime.task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn terminal_material_cleanup_failure_retries_same_epoch_before_shutdown() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let cleanup_calls = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let materializer = RetryingCleanupMaterializer {
        cleanup_calls: cleanup_calls.clone(),
        drops: drops.clone(),
    };
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);

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
        super::super::ActivationOutcome::Active
    );

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Unresolved(TerminationFailure::MaterialCleanupFailed)
    ));
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::MaterialCleanupFailed(_))
    ));
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(!runtime.task.is_finished());

    let waiter = tokio::spawn({
        let client = runtime.client.clone();
        async move {
            client
                .wait_drained(epoch, Instant::now() + Duration::from_millis(10))
                .await
        }
    });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(10)).await;
    assert_eq!(waiter.await.unwrap(), Err(ResourceFailure::TimedOut));
    assert_eq!(adapter.poll_calls(), 0);
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Terminated(_)
    ));
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::NativeFact(_))
    ));
    assert_eq!(cleanup_calls.load(Ordering::SeqCst), 2);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn unresolved_cleanup_retains_guard_until_later_verified_terminal() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    let (materializer, _, drops) = AttemptMaterializer::sequence([Ok("unresolved-attempt")]);
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);

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
    drop(installed);
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::Unresolved {
            failure: TerminationFailure::CleanupUnconfirmed,
            ..
        })
    ));
    assert_eq!(drops.load(Ordering::SeqCst), 0);

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Terminated(_)
    ));
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unresolved_shutdown_retains_guard_until_same_epoch_retry_terminal() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    let (materializer, _, drops) = AttemptMaterializer::sequence([Ok("retried-attempt")]);
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);

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
        super::super::ActivationOutcome::Active
    );
    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Unresolved(TerminationFailure::CleanupUnconfirmed)
    ));
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.cleanup_calls(), 1);
    assert!(!runtime.task.is_finished());

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Terminated(_)
    ));
    assert_eq!(adapter.cleanup_calls(), 2);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dropped_activation_keeps_unconfirmed_cleanup_controllable() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
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
    drop(installed);

    let ResourceEvent::Unresolved { failure, .. } = runtime.events.recv().await.unwrap() else {
        panic!("expected unresolved cleanup");
    };
    assert_eq!(failure, TerminationFailure::CleanupUnconfirmed);
    assert_eq!(adapter.cleanup_calls(), 1);
    assert!(!adapter.is_dropped());

    let shutdown = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.shutdown(Some(epoch)).await.unwrap() }
    });
    let ResourceEvent::NativeFact(fact) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal evidence after retry");
    };
    let ResourceShutdown::Terminated(shutdown_fact) = shutdown.await.unwrap() else {
        panic!("expected terminated shutdown");
    };
    assert!(Arc::ptr_eq(&fact, &shutdown_fact));
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn cleanup_unconfirmed_resource_can_be_verified_and_settled() {
    let adapter = FakeAdapter::new(NativeInstallResult::Unresolved {
        observation: Some(observation()),
        failure: TerminationFailure::CleanupUnconfirmed,
    });
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    adapter.allow_install();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Unresolved { .. },
            ..
        })
    ));
    let cleanup = tokio::spawn({
        let client = runtime.client.clone();
        async move { client.kill(epoch).await.unwrap() }
    });
    let ResourceEvent::NativeFact(fact) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal fact");
    };
    let cleaned = cleanup.await.unwrap();

    assert!(Arc::ptr_eq(&fact, &cleaned));
    assert_eq!(fact.origin(), TerminalOrigin::DestructiveCleanup);
    runtime.client.shutdown(None).await.unwrap();
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn authority_lost_shutdown_retries_same_epoch_until_terminal() {
    let adapter = FakeAdapter::new(NativeInstallResult::Unresolved {
        observation: Some(observation()),
        failure: TerminationFailure::AuthorityLost,
    });
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::AuthorityLost,
    ));
    let (materializer, _, drops) = AttemptMaterializer::sequence([Ok("authority-lost-attempt")]);
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), materializer);
    runtime.client.begin().await.unwrap();
    let epoch = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginAccepted(epoch) => epoch,
        _ => panic!("expected acceptance"),
    };
    adapter.allow_install();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Unresolved { .. },
            ..
        })
    ));

    assert_eq!(
        runtime.client.kill(epoch).await,
        Err(ResourceFailure::AuthorityLost)
    );
    assert_eq!(adapter.cleanup_calls(), 0);
    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Unresolved(TerminationFailure::AuthorityLost)
    ));
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(!runtime.task.is_finished());

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Terminated(_)
    ));
    assert_eq!(adapter.cleanup_calls(), 2);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn attached_resource_never_materializes_a_launch_attempt() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let calls = Arc::new(AtomicUsize::new(0));
    let epoch = ResourceEpoch::test(1);
    let identity = ProcessIdentity::new(9, 2);
    let attached = ProcessObservation::new(identity, Provenance::Attached { subject: identity });
    let runtime = ResourceRuntime::spawn_with(
        adapter.clone(),
        Some(Box::new(CountingMaterializer(calls.clone()))),
        Some((epoch, attached)),
        None,
    );

    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Detached
    ));
    assert_eq!(adapter.detach_calls(), 1);
    runtime.task.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn attached_unresolved_detach_retries_same_epoch_until_detached() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    adapter.push_detach(NativeDetachResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    let epoch = ResourceEpoch::test(1);
    let identity = ProcessIdentity::new(9, 2);
    let attached = ProcessObservation::new(identity, Provenance::Attached { subject: identity });
    let runtime = ResourceRuntime::spawn_attached(adapter.clone(), attached);

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Unresolved(TerminationFailure::CleanupUnconfirmed)
    ));
    assert_eq!(adapter.detach_calls(), 1);
    assert!(!runtime.task.is_finished());

    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Detached
    ));
    assert_eq!(adapter.detach_calls(), 2);
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn stale_destructive_request_has_no_side_effect() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    let stale = ResourceEpoch::new(NonZeroU64::new(99).unwrap());
    assert_eq!(
        runtime.client.kill(stale).await,
        Err(ResourceFailure::EpochMismatch)
    );
    assert_eq!(adapter.cleanup_calls(), 0);
    runtime.client.shutdown(None).await.unwrap();
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn exhausted_epoch_stops_owner_without_wrapping() {
    let adapter = FakeAdapter::new(NativeInstallResult::Drained(BeginDrained::LaunchFailed(
        LaunchFailure::PlatformRejected,
    )));
    let max = ResourceEpoch::new(NonZeroU64::new(u64::MAX).unwrap());
    let mut runtime = ResourceRuntime::spawn_at(adapter.clone(), test_launch(), max);
    runtime.client.begin().await.unwrap();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginAccepted(epoch)) if epoch == max
    ));
    adapter.allow_install();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginCompleted { .. })
    ));
    runtime.client.begin().await.unwrap();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::OwnerStopped)
    ));
    runtime.task.await.unwrap();
}
