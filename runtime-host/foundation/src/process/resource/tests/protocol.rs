use std::{sync::Arc, time::Duration};

use tokio::{sync::oneshot, time::Instant};

use super::super::{
    ActivationOutcome, BeginCompletion, NativeInstallResult, NativePollResult, NativeStdio,
    ResourceEvent, ResourceFailure, ResourceRuntime, ResourceShutdown, TerminalOrigin,
};
use super::support::{FakeAdapter, exit, observation, test_launch, test_spec};
use crate::process::{
    LaunchAttempt, LaunchAttemptCleanupFailure, LaunchAttemptFuture, LaunchAttemptGuard,
    LaunchAttemptMaterializer, ProcessStdio,
};

struct DropSignaledGuard {
    _signal: oneshot::Sender<()>,
}

impl LaunchAttemptGuard for DropSignaledGuard {
    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        Ok(())
    }
}

struct DropSignaledLaunch(Option<DropSignaledGuard>);

impl LaunchAttemptMaterializer for DropSignaledLaunch {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let guard = self
            .0
            .take()
            .expect("drop-signaled launch materialized more than once");
        Box::pin(async move { Ok(LaunchAttempt::new(test_spec("fixed-attempt"), guard)) })
    }
}

fn drop_signaled_launch() -> (DropSignaledLaunch, oneshot::Receiver<()>) {
    let (signal, released) = oneshot::channel();
    (
        DropSignaledLaunch(Some(DropSignaledGuard { _signal: signal })),
        released,
    )
}

#[tokio::test]
async fn begin_is_accepted_before_install_completes_and_activation_gates_facts() {
    let (launch, terminal_committed) = drop_signaled_launch();
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), launch);
    runtime.client.begin().await.unwrap();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginAccepted(_))
    ));
    adapter.wait_install_called().await;
    assert!(runtime.events.try_recv().is_err());
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installed resource"),
    };
    adapter.push_poll(NativePollResult::Drained(exit(7)));
    assert!(
        terminal_committed.await.is_err(),
        "terminal commit must release launch custody"
    );
    assert!(runtime.events.try_recv().is_err());
    let ActivationOutcome::Terminal(evidence) = installed.activation.activate().await.unwrap()
    else {
        panic!("expected cached terminal outcome");
    };
    assert_eq!(evidence.origin(), TerminalOrigin::ObservedDrain);
    let ResourceEvent::NativeFact(published) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal fact");
    };
    assert!(Arc::ptr_eq(&evidence, &published));
    runtime.client.shutdown(None).await.unwrap();
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn unresolved_before_activation_returns_typed_outcome_and_event() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
    let mut runtime = ResourceRuntime::spawn(adapter.clone(), test_launch());
    runtime.client.begin().await.unwrap();
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::BeginAccepted(_))
    ));
    adapter.allow_install();
    let installed = match runtime.events.recv().await.unwrap() {
        ResourceEvent::BeginCompleted {
            completion: BeginCompletion::Installed(installed),
            ..
        } => installed,
        _ => panic!("expected installed resource"),
    };
    adapter.push_poll(NativePollResult::Unresolved(
        crate::process::TerminationFailure::CleanupUnconfirmed,
    ));
    let unresolved = runtime.events.recv().await.unwrap();

    let epoch = installed.epoch;
    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Unresolved {
            observation: Some(observation()),
            failure: crate::process::TerminationFailure::CleanupUnconfirmed,
        }
    );
    assert!(matches!(
        unresolved,
        ResourceEvent::Unresolved {
            observation: Some(observed),
            failure: crate::process::TerminationFailure::CleanupUnconfirmed,
            ..
        } if observed == observation()
    ));
    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Terminated(_)
    ));
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn terminal_fact_is_unconditional_and_shared_with_waiters() {
    let adapter = FakeAdapter::new(NativeInstallResult::Installed(
        observation(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    ));
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
    let waiter = tokio::spawn({
        let client = runtime.client.clone();
        async move {
            client
                .wait_drained(epoch, Instant::now() + Duration::from_secs(1))
                .await
                .unwrap()
        }
    });
    adapter.push_poll(NativePollResult::Drained(exit(4)));
    let ResourceEvent::NativeFact(fact) = runtime.events.recv().await.unwrap() else {
        panic!("expected fact");
    };
    let waited = waiter.await.unwrap();
    assert!(Arc::ptr_eq(&fact, &waited));
    runtime.client.shutdown(None).await.unwrap();
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn dropped_waiter_does_not_suppress_terminal_fact() {
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
            let _ = client
                .wait_drained(epoch, Instant::now() + Duration::from_secs(1))
                .await;
        }
    });
    waiter.abort();
    adapter.push_poll(NativePollResult::Drained(exit(5)));
    assert!(matches!(
        runtime.events.recv().await,
        Some(ResourceEvent::NativeFact(_))
    ));
    runtime.client.shutdown(None).await.unwrap();
    runtime.task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn waiter_deadline_starts_settling_only_after_activation() {
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
                .wait_drained(epoch, Instant::now() + Duration::from_millis(10))
                .await
        }
    });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(20)).await;
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());

    assert_eq!(
        installed.activation.activate().await.unwrap(),
        ActivationOutcome::Active
    );
    assert_eq!(waiter.await.unwrap(), Err(ResourceFailure::TimedOut));
    assert!(matches!(
        runtime.client.shutdown(Some(epoch)).await.unwrap(),
        ResourceShutdown::Terminated(_)
    ));
    runtime.task.await.unwrap();
}

#[tokio::test]
async fn cached_terminal_evidence_is_not_republished() {
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
    adapter.push_poll(NativePollResult::Drained(exit(5)));
    let ResourceEvent::NativeFact(fact) = runtime.events.recv().await.unwrap() else {
        panic!("expected terminal fact");
    };
    let cached = runtime.client.kill(epoch).await.unwrap();

    assert!(Arc::ptr_eq(&fact, &cached));
    assert!(runtime.events.try_recv().is_err());
    assert_eq!(adapter.cleanup_calls(), 0);
    runtime.client.shutdown(None).await.unwrap();
    runtime.task.await.unwrap();
}
