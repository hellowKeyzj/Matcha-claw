use std::time::Duration;

use tokio::sync::{mpsc, oneshot, watch};

use super::super::super::resource::{
    Activation, ActivationOutcome, BeginCompletion, ManagedObservation, NativeInstallResult,
    NativePollResult, NativeStdio, ResourceEpoch, ResourceEvent, ResourceRuntime, TerminalEvidence,
};
use super::super::{
    CommandReceipt, ReadinessResult, StartRecoveryResult, SupervisorSnapshot,
    dispatch::{Command, ControlCommand},
    tests::{
        DrainStdio, FakeAdapter, GatedStdio, Policy, Ready, Recovery, StdioActivationFailure, Stop,
        exit, owned, test_launch, wait_until,
    },
    worker::{GracefulCompletion, StdioDrainCompletion, Work},
};
use super::{Parts, runtime::Inbound};

#[tokio::test]
async fn closed_activation_channel_fails_start_instead_of_stalling() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let mut state = super::super::settle::State::new(resource.initial);
    state.phase = super::super::SupervisorPhase::Starting;
    let (start_sender, start_receipt) = super::super::receipt::new_start();
    state.mutation = Some(super::super::receipt::Mutation::start(start_sender));
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );
    let epoch = ResourceEpoch::test(7);
    actor.state.pending_epoch = Some(epoch);
    actor.resource_event(ResourceEvent::BeginCompleted {
        epoch,
        completion: BeginCompletion::Installed(ManagedObservation {
            epoch,
            observation: owned(),
            stdio: super::super::super::ProcessStdio::new(None, None, None),
            activation: Activation::closed(),
        }),
    });

    while actor.state.pending_stdio_activation.is_some()
        || actor.state.pending_native_activation.is_some()
    {
        match actor.receive().await {
            Inbound::Work(work) => actor.work(work),
            Inbound::TaskFinished(result) => actor.task_finished(result),
            _ => {}
        }
    }
    let CommandReceipt::Accepted(completion) = start_receipt else {
        panic!("expected accepted start");
    };
    assert!(matches!(
        completion.wait().await,
        Err(super::super::CompletionError::Failed(
            super::super::SupervisorFailure::Termination(_)
        ))
    ));
    assert_eq!(
        actor.state.phase,
        super::super::SupervisorPhase::OperationFailed
    );
}

#[tokio::test]
async fn stale_activation_identity_and_wrong_epoch_evidence_are_ignored() {
    let adapter = FakeAdapter::owned([]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let ready = Ready::immediate();
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: ready.clone(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );
    let epoch = ResourceEpoch::test(7);
    let wrong_epoch = ResourceEpoch::test(8);
    actor.state.phase = super::super::SupervisorPhase::Starting;
    actor.state.active_epoch = Some(epoch);
    actor.state.observed = Some((epoch, owned()));
    actor.state.pending_native_activation = Some((3, epoch));

    actor.native_activation_completed(2, epoch, Ok(ActivationOutcome::Active));
    actor.native_activation_completed(
        3,
        wrong_epoch,
        Ok(ActivationOutcome::Terminal(TerminalEvidence::test(
            wrong_epoch,
            exit(17),
        ))),
    );
    actor.native_activation_completed(
        3,
        wrong_epoch,
        Ok(ActivationOutcome::Unresolved {
            observation: Some(owned()),
            failure: super::super::super::TerminationFailure::CleanupUnconfirmed,
        }),
    );

    assert_eq!(actor.state.pending_native_activation, Some((3, epoch)));
    assert_eq!(actor.state.active_epoch, Some(epoch));
    assert_eq!(ready.calls(), 0);
}

#[tokio::test]
async fn control_intent_gates_active_but_consumes_terminal_and_unresolved() {
    for intent in [
        super::super::ControlIntent::Stop,
        super::super::ControlIntent::Kill,
        super::super::ControlIntent::Shutdown,
    ] {
        let adapter = FakeAdapter::owned([]);
        let resource = ResourceRuntime::spawn(adapter, test_launch());
        let state = super::super::settle::State::new(resource.initial);
        let (_commands, command_receiver) = mpsc::channel(1);
        let (_controls, control_receiver) = mpsc::channel(1);
        let (_owner_drop, owner_dropped) = oneshot::channel();
        let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
        let ready = Ready::immediate();
        let mut actor = super::runtime::Actor::new(
            Parts {
                stdio_activation: DrainStdio,
                readiness: ready.clone(),
                graceful_stop: Stop::requested(Duration::from_secs(1)),
                recovery: Recovery::fail(),
                restart_policy: Policy::halt(),
            },
            state,
            resource,
            command_receiver,
            control_receiver,
            owner_dropped,
            snapshots,
        );
        let epoch = ResourceEpoch::test(7);
        actor.state.phase = super::super::SupervisorPhase::Starting;
        actor.state.active_epoch = Some(epoch);
        actor.state.observed = Some((epoch, owned()));
        actor.state.intent = Some(intent);
        actor.state.pending_native_activation = Some((3, epoch));
        if intent == super::super::ControlIntent::Stop {
            actor.state.graceful_deadline =
                Some(tokio::time::Instant::now() + Duration::from_secs(1));
        }

        match intent {
            super::super::ControlIntent::Stop => {
                actor.native_activation_completed(3, epoch, Ok(ActivationOutcome::Active));
                assert!(actor.state.pending_native_activation.is_none());
                assert_eq!(ready.calls(), 0);
            }
            super::super::ControlIntent::Kill => {
                actor.native_activation_completed(
                    3,
                    epoch,
                    Ok(ActivationOutcome::Terminal(TerminalEvidence::test(
                        epoch,
                        exit(17),
                    ))),
                );
                assert_eq!(actor.state.settled_epoch, Some(epoch));
            }
            super::super::ControlIntent::Shutdown => {
                actor.state.owner_closed = true;
                actor.native_activation_completed(
                    3,
                    epoch,
                    Ok(ActivationOutcome::Unresolved {
                        observation: Some(owned()),
                        failure: super::super::super::TerminationFailure::CleanupUnconfirmed,
                    }),
                );
                assert!(actor.final_outcome.is_none());
                assert_eq!(
                    actor.state.phase,
                    super::super::SupervisorPhase::OperationFailed
                );
                assert_eq!(actor.state.active_epoch, Some(epoch));
            }
        }
    }
}

#[tokio::test]
async fn owner_closed_terminal_completes_pending_shutdown_without_resource_client() {
    let adapter = FakeAdapter::owned([]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );
    let epoch = ResourceEpoch::test(7);
    actor.state.phase = super::super::SupervisorPhase::Starting;
    actor.state.active_epoch = Some(epoch);
    actor.state.observed = Some((epoch, owned()));
    actor.state.intent = Some(super::super::ControlIntent::Shutdown);
    actor.state.pending_native_activation = Some((3, epoch));
    actor.resource_closed();

    actor.native_activation_completed(
        3,
        epoch,
        Ok(ActivationOutcome::Terminal(TerminalEvidence::test(
            epoch,
            exit(17),
        ))),
    );

    assert!(matches!(
        actor.final_outcome,
        Some(super::runtime::FinalShutdown::Terminated(
            super::super::super::TerminationOutcome::Graceful(_)
        ))
    ));
    assert_eq!(actor.state.settled_epoch, Some(epoch));
    assert!(actor.state.pending_native_activation.is_none());
}

#[tokio::test(start_paused = true)]
async fn cached_terminal_activation_never_starts_readiness_or_publishes_running() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter.clone(), test_launch());
    let client = resource.client.clone();
    let ready = Ready::immediate();
    let recovery = Recovery::fail();
    let mut state = super::super::settle::State::new(resource.initial);
    state.phase = super::super::SupervisorPhase::Starting;
    let (start_sender, start_receipt) = super::super::receipt::new_start();
    state.mutation = Some(super::super::receipt::Mutation::start(start_sender));
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, mut snapshot_receiver) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: ready.clone(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: recovery.clone(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    client.begin().await.unwrap();
    let Inbound::Resource(accepted) = actor.receive().await else {
        panic!("expected begin acceptance");
    };
    actor.resource_event(accepted);
    let Inbound::Resource(completed) = actor.receive().await else {
        panic!("expected installed completion");
    };
    let ResourceEvent::BeginCompleted { epoch, completion } = completed else {
        panic!("expected installed completion");
    };
    let super::super::super::resource::BeginCompletion::Installed(installed) = completion else {
        panic!("expected installed resource");
    };
    adapter.push_poll(NativePollResult::Drained(exit(17)));
    tokio::time::advance(Duration::from_millis(5)).await;
    wait_until(|| adapter.poll_calls() == 1).await;
    actor.resource_event(ResourceEvent::BeginCompleted {
        epoch,
        completion: super::super::super::resource::BeginCompletion::Installed(installed),
    });

    while actor.state.active_epoch.is_some() {
        match actor.receive().await {
            Inbound::Resource(event) => actor.resource_event(event),
            Inbound::Work(work) => actor.work(work),
            Inbound::TaskFinished(result) => actor.task_finished(result),
            _ => panic!("unexpected actor input"),
        }
    }
    assert_eq!(ready.calls(), 0);
    assert_eq!(actor.state.episode.settled_failures(), 1);
    for _ in 0..4 {
        if recovery.calls() == 1 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(recovery.calls(), 1);
    assert!(matches!(start_receipt, CommandReceipt::Accepted(_)));
    while snapshot_receiver.has_changed().unwrap() {
        snapshot_receiver.borrow_and_update();
        assert_ne!(
            snapshot_receiver.borrow().phase(),
            super::super::SupervisorPhase::Running
        );
        assert!(!matches!(
            snapshot_receiver.borrow().last_outcome(),
            Some(super::super::SupervisorOutcome::Started(
                super::super::StartOutcome::Started
            ))
        ));
    }
}

#[tokio::test]
async fn duplicate_terminal_evidence_is_idempotent_through_actor_delivery() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter.clone(), test_launch());
    let client = resource.client.clone();
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, mut snapshot_receiver) = watch::channel(SupervisorSnapshot::idle());
    let policy = Policy::halt();
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: policy.clone(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    client.begin().await.unwrap();
    let accepted = actor.receive().await;
    actor.resource_event(match accepted {
        Inbound::Resource(event) => event,
        _ => panic!("expected begin acceptance"),
    });
    let installed = actor.receive().await;
    actor.resource_event(match installed {
        Inbound::Resource(event) => event,
        _ => panic!("expected installed completion"),
    });
    adapter.push_poll(NativePollResult::Drained(exit(17)));
    let evidence = loop {
        match actor.receive().await {
            Inbound::Resource(ResourceEvent::NativeFact(evidence)) => break evidence,
            Inbound::TaskFinished(result) => actor.task_finished(result),
            Inbound::Work(work) => actor.work(work),
            _ => panic!("expected terminal evidence"),
        }
    };
    let duplicate = evidence.clone();
    let (kill_reply, kill_receipt) = oneshot::channel();
    let batch_open = !actor.state.admission_closed;
    actor.control(ControlCommand::Kill(kill_reply), batch_open);
    actor.apply_control();

    actor.resource_event(ResourceEvent::NativeFact(evidence));
    let first_snapshot = actor.snapshots.borrow().clone();
    let first_episode = actor.state.episode;
    snapshot_receiver.borrow_and_update();
    actor.resource_event(ResourceEvent::NativeFact(duplicate));

    let super::super::CommandReceipt::Accepted(completion) = kill_receipt.await.unwrap() else {
        panic!("expected accepted kill");
    };
    assert!(matches!(
        completion.wait().await.unwrap(),
        super::super::TerminationCompletion::Completed(
            super::super::super::TerminationOutcome::Graceful(_)
        )
    ));
    assert_eq!(*actor.snapshots.borrow(), first_snapshot);
    assert_eq!(actor.state.episode, first_episode);
    assert!(actor.state.controls.kill.is_none());
    assert!(!snapshot_receiver.has_changed().unwrap());
    assert_eq!(policy.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn terminal_activation_outcome_is_idempotent_after_native_fact() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, mut snapshot_receiver) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    actor.client().begin().await.unwrap();
    let Inbound::Resource(accepted) = actor.receive().await else {
        panic!("expected acceptance");
    };
    actor.resource_event(accepted);
    let Inbound::Resource(completed) = actor.receive().await else {
        panic!("expected completion");
    };
    actor.resource_event(completed);
    while actor.state.pending_native_activation.is_none() {
        drive_actor_once(&mut actor).await;
    }
    let (request_id, epoch) = actor.state.pending_native_activation.unwrap();
    actor.state.intent = Some(super::super::ControlIntent::Kill);
    actor.issue_kill(epoch);
    let evidence = loop {
        match actor.receive().await {
            Inbound::Resource(ResourceEvent::NativeFact(evidence)) => break evidence,
            Inbound::Work(Work::Kill {
                result: Ok(evidence),
                ..
            }) => break evidence,
            Inbound::Work(work) => actor.work(work),
            Inbound::TaskFinished(result) => actor.task_finished(result),
            _ => panic!("expected terminal evidence"),
        }
    };
    actor.accept_terminal(evidence.clone());
    let first_snapshot = actor.snapshots.borrow().clone();
    let first_episode = actor.state.episode;
    snapshot_receiver.borrow_and_update();

    actor.native_activation_completed(request_id, epoch, Ok(ActivationOutcome::Terminal(evidence)));

    assert_eq!(*actor.snapshots.borrow(), first_snapshot);
    assert_eq!(actor.state.episode, first_episode);
    assert!(!snapshot_receiver.has_changed().unwrap());
}

#[tokio::test]
async fn late_termination_workers_are_ignored_after_failure_settlement() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter.clone(), test_launch());
    let client = resource.client.clone();
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, mut snapshot_receiver) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    client.begin().await.unwrap();
    for _ in 0..2 {
        let Inbound::Resource(event) = actor.receive().await else {
            panic!("expected begin event");
        };
        actor.resource_event(event);
    }
    let epoch = actor.state.active_epoch.unwrap();
    let (reply, receipt) = oneshot::channel();
    actor.control(ControlCommand::Stop(reply), true);
    actor.apply_control();
    let generation = actor.state.generation;
    actor.work(Work::WaitDrained {
        generation,
        epoch,
        result: Err(super::super::super::resource::ResourceFailure::AuthorityLost),
    });
    let super::super::CommandReceipt::Accepted(completion) = receipt.await.unwrap() else {
        panic!("expected accepted stop");
    };
    assert_eq!(
        completion.wait().await.unwrap(),
        super::super::TerminationCompletion::Completed(
            super::super::super::TerminationOutcome::AuthorityLost,
        )
    );
    let settled_snapshot = actor.snapshots.borrow().clone();
    snapshot_receiver.borrow_and_update();

    actor.work(Work::Graceful {
        generation,
        epoch,
        result: GracefulCompletion::DeadlineElapsed,
    });
    actor.work(Work::WaitDrained {
        generation,
        epoch,
        result: Err(super::super::super::resource::ResourceFailure::TimedOut),
    });

    assert_eq!(*actor.snapshots.borrow(), settled_snapshot);
    assert!(!snapshot_receiver.has_changed().unwrap());
    assert!(actor.state.controls.stop.is_none());
    assert_eq!(adapter.cleanup_calls(), 0);
}

#[tokio::test]
async fn terminal_before_readiness_result_settles_startup_failure_once() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter.clone(), test_launch());
    let client = resource.client.clone();
    let (readiness, release) = Ready::blocked(ReadinessResult::Unavailable);
    let recovery = Recovery::fail();
    let mut state = super::super::settle::State::new(resource.initial);
    state.phase = super::super::SupervisorPhase::Starting;
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness,
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: recovery.clone(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    client.begin().await.unwrap();
    for _ in 0..2 {
        let Inbound::Resource(event) = actor.receive().await else {
            panic!("expected begin event");
        };
        actor.resource_event(event);
    }
    adapter.push_poll(NativePollResult::Drained(exit(17)));
    loop {
        match actor.receive().await {
            Inbound::Resource(event @ ResourceEvent::NativeFact(_)) => {
                actor.resource_event(event);
                break;
            }
            Inbound::TaskFinished(result) => actor.task_finished(result),
            Inbound::Work(work) => actor.work(work),
            _ => panic!("expected terminal evidence"),
        }
    }
    release.notify_one();
    wait_until(|| recovery.calls() == 1).await;

    assert_eq!(actor.state.episode.settled_failures(), 1);
    assert_eq!(recovery.calls(), 1);
}

#[tokio::test]
async fn readiness_failure_before_terminal_keeps_single_recovery() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter.clone(), test_launch());
    let client = resource.client.clone();
    let (recovery, _release) = Recovery::blocked(StartRecoveryResult::RetryAfter(Duration::ZERO));
    let mut state = super::super::settle::State::new(resource.initial);
    state.phase = super::super::SupervisorPhase::Starting;
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::sequence([ReadinessResult::Unavailable]),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: recovery.clone(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    client.begin().await.unwrap();
    for _ in 0..2 {
        let Inbound::Resource(event) = actor.receive().await else {
            panic!("expected begin event");
        };
        actor.resource_event(event);
    }
    loop {
        match actor.receive().await {
            Inbound::Work(work @ Work::Readiness { .. }) => {
                actor.work(work);
                break;
            }
            Inbound::Work(work) => actor.work(work),
            Inbound::TaskFinished(result) => actor.task_finished(result),
            _ => panic!("expected readiness result"),
        }
    }
    adapter.push_poll(NativePollResult::Drained(exit(17)));
    loop {
        match actor.receive().await {
            Inbound::Resource(event @ ResourceEvent::NativeFact(_)) => {
                actor.resource_event(event);
                break;
            }
            Inbound::TaskFinished(result) => actor.task_finished(result),
            _ => panic!("expected terminal evidence"),
        }
    }

    assert_eq!(actor.state.episode.settled_failures(), 1);
    assert_eq!(recovery.calls(), 1);
}

#[tokio::test]
async fn queued_observed_terminal_keeps_origin_when_kill_is_arbitrated_first() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter.clone(), test_launch());
    let client = resource.client.clone();
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    client.begin().await.unwrap();
    for _ in 0..2 {
        let Inbound::Resource(event) = actor.receive().await else {
            panic!("expected begin event");
        };
        actor.resource_event(event);
    }
    adapter.push_poll(NativePollResult::Drained(exit(0)));
    let evidence = loop {
        match actor.receive().await {
            Inbound::Resource(ResourceEvent::NativeFact(evidence)) => break evidence,
            Inbound::TaskFinished(result) => actor.task_finished(result),
            Inbound::Work(work) => actor.work(work),
            _ => panic!("expected terminal evidence"),
        }
    };
    let (reply, receipt) = oneshot::channel();
    controls.send(ControlCommand::Kill(reply)).await.unwrap();
    let Inbound::Control(control) = actor.receive().await else {
        panic!("expected kill control");
    };
    actor.control_batch(control);
    actor.resource_event(ResourceEvent::NativeFact(evidence));

    let super::super::CommandReceipt::Accepted(completion) = receipt.await.unwrap() else {
        panic!("expected accepted kill");
    };
    assert!(matches!(
        completion.wait().await.unwrap(),
        super::super::TerminationCompletion::Completed(
            super::super::super::TerminationOutcome::Graceful(_)
        )
    ));
}

#[tokio::test]
async fn closed_work_receiver_does_not_block_owned_task_join() {
    let mut tasks = tokio::task::JoinSet::new();
    let mut identities = Vec::new();
    let (work, receiver) = mpsc::channel(1);
    drop(receiver);

    super::super::worker::stdio_activation(
        super::super::worker::SpawnContext::new(&mut tasks, &mut identities, work),
        std::sync::Arc::new(DrainStdio),
        3,
        ResourceEpoch::test(7),
        owned(),
        super::super::super::ProcessStdio::new(None, None, None),
        tokio_util::sync::CancellationToken::new(),
    );

    let joined = tokio::time::timeout(Duration::from_secs(1), tasks.join_next_with_id())
        .await
        .expect("closed work receiver must not stall task join")
        .expect("owned task must be present")
        .expect("owned task must finish without panic");
    assert!(matches!(
        joined.1,
        super::super::worker::TaskIdentity::StdioActivation { .. }
    ));
}

#[tokio::test(start_paused = true)]
async fn never_finishing_drain_is_bounded_and_dropped_at_deadline() {
    let drain = GatedStdio::drain(None);
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: drain.clone(),
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    actor.client().begin().await.unwrap();
    while actor.state.stdio_drain_epoch.is_none() {
        drive_actor_once(&mut actor).await;
    }
    drain.wait_drain_started().await;
    let epoch = actor.state.active_epoch.expect("active epoch");
    actor.accept_terminal(TerminalEvidence::test(epoch, exit(0)));
    assert!(actor.pending_terminal.is_some());
    assert_eq!(actor.state.stdio_drain_result, None);

    tokio::time::advance(Duration::from_secs(1)).await;
    while actor.state.stdio_drain_result.is_none() {
        drive_actor_once(&mut actor).await;
    }
    drain.wait_drain_dropped().await;

    assert_eq!(
        actor.state.stdio_drain_result,
        Some(StdioDrainCompletion::DeadlineElapsed)
    );
    assert_eq!(
        actor.state.failure,
        Some(super::super::SupervisorFailure::StdioFailed)
    );
    assert!(actor.pending_terminal.is_none());
}

#[tokio::test]
async fn only_drained_unlocks_pending_terminal() {
    for result in [
        super::super::super::StdioDrainResult::Drained,
        super::super::super::StdioDrainResult::Unavailable,
        super::super::super::StdioDrainResult::Cancelled,
    ] {
        let drain = GatedStdio::drain(Some(result));
        let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
        )]);
        let resource = ResourceRuntime::spawn(adapter, test_launch());
        let state = super::super::settle::State::new(resource.initial);
        let (_commands, command_receiver) = mpsc::channel(1);
        let (_controls, control_receiver) = mpsc::channel(1);
        let (_owner_drop, owner_dropped) = oneshot::channel();
        let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
        let mut actor = super::runtime::Actor::new(
            Parts {
                stdio_activation: drain.clone(),
                readiness: Ready::immediate(),
                graceful_stop: Stop::requested(Duration::from_secs(1)),
                recovery: Recovery::fail(),
                restart_policy: Policy::halt(),
            },
            state,
            resource,
            command_receiver,
            control_receiver,
            owner_dropped,
            snapshots,
        );

        actor.client().begin().await.unwrap();
        while actor.state.stdio_drain_epoch.is_none() {
            drive_actor_once(&mut actor).await;
        }
        drain.wait_drain_started().await;
        let epoch = actor.state.active_epoch.expect("active epoch");
        actor.accept_terminal(TerminalEvidence::test(epoch, exit(0)));
        assert!(actor.pending_terminal.is_some());
        assert_eq!(actor.state.active_epoch, Some(epoch));

        drain.release_drain();
        while actor.state.stdio_drain_result.is_none() {
            drive_actor_once(&mut actor).await;
        }

        match result {
            super::super::super::StdioDrainResult::Drained => {
                assert_eq!(actor.state.settled_epoch, Some(epoch));
                assert_eq!(actor.state.failure, None);
                assert!(actor.pending_terminal.is_none());
            }
            super::super::super::StdioDrainResult::Unavailable
            | super::super::super::StdioDrainResult::Cancelled => {
                assert_eq!(
                    actor.state.failure,
                    Some(super::super::SupervisorFailure::StdioFailed)
                );
                assert!(actor.pending_terminal.is_none());
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum EarlyDrainFailure {
    Unavailable,
    Cancelled,
    Panic,
    DeadlineElapsed,
}

#[tokio::test(start_paused = true)]
async fn early_drain_failure_prevents_start_and_completes_owned_cleanup() {
    for failure in [
        EarlyDrainFailure::Unavailable,
        EarlyDrainFailure::Cancelled,
        EarlyDrainFailure::Panic,
        EarlyDrainFailure::DeadlineElapsed,
    ] {
        let drain = match failure {
            EarlyDrainFailure::Unavailable => {
                GatedStdio::drain(Some(super::super::super::StdioDrainResult::Unavailable))
            }
            EarlyDrainFailure::Cancelled => {
                GatedStdio::drain(Some(super::super::super::StdioDrainResult::Cancelled))
            }
            EarlyDrainFailure::Panic => GatedStdio::panicking_drain(),
            EarlyDrainFailure::DeadlineElapsed => GatedStdio::drain(None),
        };
        let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
        )]);
        let resource = ResourceRuntime::spawn(adapter.clone(), test_launch());
        let ready = Ready::immediate();
        let mut state = super::super::settle::State::new(resource.initial);
        state.phase = super::super::SupervisorPhase::Starting;
        let (start_sender, start_receipt) = super::super::receipt::new_start();
        state.mutation = Some(super::super::receipt::Mutation::start(start_sender));
        let (_commands, command_receiver) = mpsc::channel(1);
        let (_controls, control_receiver) = mpsc::channel(1);
        let (_owner_drop, owner_dropped) = oneshot::channel();
        let (snapshots, mut snapshot_receiver) = watch::channel(SupervisorSnapshot::idle());
        let mut actor = super::runtime::Actor::new(
            Parts {
                stdio_activation: drain.clone(),
                readiness: ready.clone(),
                graceful_stop: Stop::requested(Duration::from_secs(1)),
                recovery: Recovery::fail(),
                restart_policy: Policy::halt(),
            },
            state,
            resource,
            command_receiver,
            control_receiver,
            owner_dropped,
            snapshots,
        );

        actor.client().begin().await.unwrap();
        while actor.state.stdio_drain_epoch.is_none() {
            drive_actor_once(&mut actor).await;
            assert_start_not_published(&actor.snapshots, &mut snapshot_receiver, failure);
        }
        drain.wait_drain_started().await;
        let epoch = actor.state.active_epoch.expect("active epoch");

        let native_activation = loop {
            match actor.receive().await {
                Inbound::OwnerDropped => actor.owner_dropped(),
                Inbound::Work(work)
                    if matches!(
                        &work,
                        Work::NativeActivation {
                            result: Ok(ActivationOutcome::Active),
                            ..
                        }
                    ) =>
                {
                    actor.record_work(&work);
                    break work;
                }
                Inbound::Resource(event) => actor.resource_event(event),
                Inbound::ResourceClosed => actor.resource_closed(),
                Inbound::Work(work) => actor.work(work),
                Inbound::TaskFinished(result) => actor.task_finished(result),
                Inbound::Command(command) => actor.command(command),
                Inbound::Control(control) => actor.control_batch(control),
            }
            assert_start_not_published(&actor.snapshots, &mut snapshot_receiver, failure);
        };
        assert!(matches!(
            &native_activation,
            Work::NativeActivation {
                epoch: activation_epoch,
                result: Ok(ActivationOutcome::Active),
                ..
            } if *activation_epoch == epoch
        ));

        match failure {
            EarlyDrainFailure::DeadlineElapsed => {
                actor.bound_stdio_drain();
                tokio::time::advance(Duration::from_secs(1)).await;
            }
            EarlyDrainFailure::Unavailable
            | EarlyDrainFailure::Cancelled
            | EarlyDrainFailure::Panic => drain.release_drain(),
        }
        while actor.state.stdio_drain_result.is_none() {
            drive_actor_once(&mut actor).await;
            assert_start_not_published(&actor.snapshots, &mut snapshot_receiver, failure);
        }

        let expected_completion = match failure {
            EarlyDrainFailure::Unavailable | EarlyDrainFailure::Panic => {
                StdioDrainCompletion::Completed(super::super::super::StdioDrainResult::Unavailable)
            }
            EarlyDrainFailure::Cancelled => {
                StdioDrainCompletion::Completed(super::super::super::StdioDrainResult::Cancelled)
            }
            EarlyDrainFailure::DeadlineElapsed => StdioDrainCompletion::DeadlineElapsed,
        };
        assert_eq!(
            actor.state.stdio_drain_result,
            Some(expected_completion),
            "{failure:?}"
        );
        assert_eq!(
            actor.state.failure,
            Some(super::super::SupervisorFailure::StdioFailed),
            "{failure:?}"
        );
        assert_eq!(actor.state.stdio_failure_cleanup_epoch, Some(epoch));
        assert_eq!(ready.calls(), 0, "{failure:?}");
        assert_start_not_published(&actor.snapshots, &mut snapshot_receiver, failure);

        actor.work(native_activation);
        assert_eq!(ready.calls(), 0, "{failure:?}");
        assert_start_not_published(&actor.snapshots, &mut snapshot_receiver, failure);

        while actor.state.active_epoch == Some(epoch)
            || actor.state.stdio_failure_cleanup_epoch == Some(epoch)
            || actor.task_identities.iter().any(|(_, identity, _)| {
                *identity == super::super::worker::TaskIdentity::Kill(epoch)
            })
        {
            drive_actor_once(&mut actor).await;
            assert_start_not_published(&actor.snapshots, &mut snapshot_receiver, failure);
        }

        let CommandReceipt::Accepted(completion) = start_receipt else {
            panic!("expected accepted start for {failure:?}");
        };
        assert!(matches!(
            completion.wait().await,
            Err(super::super::CompletionError::Failed(
                super::super::SupervisorFailure::StdioFailed
            ))
        ));
        assert_eq!(adapter.cleanup_calls(), 1, "{failure:?}");
        assert_eq!(actor.state.settled_epoch, Some(epoch), "{failure:?}");
        assert_eq!(actor.state.active_epoch, None, "{failure:?}");
        assert_eq!(actor.state.observed, None, "{failure:?}");
        assert_eq!(actor.state.stdio_failure_cleanup_epoch, None, "{failure:?}");
        assert!(actor.pending_terminal.is_none(), "{failure:?}");
        assert_start_not_published(&actor.snapshots, &mut snapshot_receiver, failure);
    }
}

fn assert_start_not_published(
    snapshots: &watch::Sender<SupervisorSnapshot>,
    snapshot_receiver: &mut watch::Receiver<SupervisorSnapshot>,
    failure: EarlyDrainFailure,
) {
    while snapshot_receiver.has_changed().unwrap() {
        let snapshot = snapshot_receiver.borrow_and_update();
        assert_snapshot_not_started(&snapshot, failure);
    }
    assert_snapshot_not_started(&snapshots.borrow(), failure);
}

fn assert_snapshot_not_started(snapshot: &SupervisorSnapshot, failure: EarlyDrainFailure) {
    assert_ne!(
        snapshot.phase(),
        super::super::SupervisorPhase::Running,
        "{failure:?}"
    );
    assert!(
        !matches!(
            snapshot.last_outcome(),
            Some(super::super::SupervisorOutcome::Started(
                super::super::StartOutcome::Started
            ))
        ),
        "{failure:?}"
    );
}

#[tokio::test]
async fn panicking_drain_settles_as_stdio_failed() {
    let drain = GatedStdio::panicking_drain();
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: drain.clone(),
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    actor.client().begin().await.unwrap();
    while actor.state.stdio_drain_epoch.is_none() {
        drive_actor_once(&mut actor).await;
    }
    drain.wait_drain_started().await;
    let epoch = actor.state.active_epoch.expect("active epoch");
    actor.accept_terminal(TerminalEvidence::test(epoch, exit(0)));
    drain.release_drain();
    while actor.state.failure.is_none() {
        drive_actor_once(&mut actor).await;
    }

    assert_eq!(
        actor.state.failure,
        Some(super::super::SupervisorFailure::StdioFailed)
    );
    assert!(actor.pending_terminal.is_none());
}

#[tokio::test]
async fn stdio_activation_failures_settle_as_stdio_failed() {
    for failure in [
        StdioActivationFailure::Unavailable,
        StdioActivationFailure::Cancelled,
        StdioActivationFailure::Panic,
    ] {
        let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
        )]);
        let resource = ResourceRuntime::spawn(adapter, test_launch());
        let mut state = super::super::settle::State::new(resource.initial);
        state.phase = super::super::SupervisorPhase::Starting;
        let (start_sender, start_receipt) = super::super::receipt::new_start();
        state.mutation = Some(super::super::receipt::Mutation::start(start_sender));
        let (_commands, command_receiver) = mpsc::channel(1);
        let (_controls, control_receiver) = mpsc::channel(1);
        let (_owner_drop, owner_dropped) = oneshot::channel();
        let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
        let mut actor = super::runtime::Actor::new(
            Parts {
                stdio_activation: GatedStdio::activation(failure),
                readiness: Ready::immediate(),
                graceful_stop: Stop::requested(Duration::from_secs(1)),
                recovery: Recovery::fail(),
                restart_policy: Policy::halt(),
            },
            state,
            resource,
            command_receiver,
            control_receiver,
            owner_dropped,
            snapshots,
        );

        actor.client().begin().await.unwrap();
        while actor.state.failure.is_none() {
            drive_actor_once(&mut actor).await;
        }

        let CommandReceipt::Accepted(completion) = start_receipt else {
            panic!("expected accepted start");
        };
        assert!(matches!(
            completion.wait().await,
            Err(super::super::CompletionError::Failed(
                super::super::SupervisorFailure::StdioFailed
            ))
        ));
        assert_eq!(
            actor.state.failure,
            Some(super::super::SupervisorFailure::StdioFailed)
        );
        assert_eq!(
            actor.state.phase,
            super::super::SupervisorPhase::OperationFailed
        );
    }
}

#[tokio::test]
async fn confirmed_shutdown_terminal_cancels_pending_stdio_drain() {
    let drain = GatedStdio::drain(None);
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: drain.clone(),
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    actor.client().begin().await.unwrap();
    while actor.state.stdio_drain_epoch.is_none() {
        drive_actor_once(&mut actor).await;
    }
    drain.wait_drain_started().await;
    let epoch = actor.state.active_epoch.expect("active epoch");

    actor.shutdown_completed(Ok(
        super::super::super::resource::ResourceShutdown::Terminated(TerminalEvidence::test(
            epoch,
            exit(0),
        )),
    ));
    tokio::time::timeout(Duration::from_secs(1), drain.wait_drain_dropped())
        .await
        .expect("confirmed shutdown must cancel the stdio drain");

    assert!(matches!(
        actor.final_outcome,
        Some(super::runtime::FinalShutdown::Terminated(
            super::super::super::TerminationOutcome::Graceful(ref observation)
        )) if observation.exit_code() == Some(0)
    ));
    assert_eq!(actor.state.failure, None);
}

#[tokio::test]
async fn owner_closed_terminal_activation_waits_for_pending_drain() {
    let drain = GatedStdio::drain(Some(super::super::super::StdioDrainResult::Drained));
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: drain.clone(),
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    actor.client().begin().await.unwrap();
    while actor.state.pending_native_activation.is_none() {
        drive_actor_once(&mut actor).await;
    }
    drain.wait_drain_started().await;
    let (request_id, epoch) = actor
        .state
        .pending_native_activation
        .expect("native activation");
    actor.state.intent = Some(super::super::ControlIntent::Shutdown);
    actor.state.owner_closed = true;

    actor.native_activation_completed(
        request_id,
        epoch,
        Ok(ActivationOutcome::Terminal(TerminalEvidence::test(
            epoch,
            exit(0),
        ))),
    );
    assert!(actor.final_outcome.is_none());
    assert!(actor.pending_terminal.is_some());
    assert!(actor.shutdown_terminal_ready);

    drain.release_drain();
    while actor.final_outcome.is_none() {
        drive_actor_once(&mut actor).await;
    }
    assert!(matches!(
        actor.final_outcome,
        Some(super::runtime::FinalShutdown::Terminated(
            super::super::super::TerminationOutcome::Graceful(_)
        ))
    ));
}

async fn drive_actor_once<A, R, G, S, T>(actor: &mut super::runtime::Actor<A, R, G, S, T>)
where
    A: super::super::StdioActivation,
    R: super::super::ReadinessProbe,
    G: super::super::GracefulStop,
    S: super::super::StartRecovery,
    T: super::super::RestartPolicy,
{
    match actor.receive().await {
        Inbound::OwnerDropped => actor.owner_dropped(),
        Inbound::Resource(event) => actor.resource_event(event),
        Inbound::ResourceClosed => actor.resource_closed(),
        Inbound::Work(work) => actor.work(work),
        Inbound::TaskFinished(result) => actor.task_finished(result),
        Inbound::Command(command) => actor.command(command),
        Inbound::Control(control) => actor.control_batch(control),
    }
}

#[tokio::test]
async fn activation_task_panic_fails_pending_start_closed() {
    let adapter = FakeAdapter::owned([]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let mut state = super::super::settle::State::new(resource.initial);
    state.phase = super::super::SupervisorPhase::Starting;
    let (start_sender, start_receipt) = super::super::receipt::new_start();
    state.mutation = Some(super::super::receipt::Mutation::start(start_sender));
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );
    let epoch = ResourceEpoch::test(7);
    actor.state.active_epoch = Some(epoch);
    actor.state.observed = Some((epoch, owned()));
    actor.state.pending_native_activation = Some((3, epoch));
    let identity = super::super::worker::TaskIdentity::NativeActivation {
        request_id: 3,
        epoch,
    };
    let handle = actor
        .tasks
        .spawn(async move { panic!("activation task panic") });
    actor.task_identities.push((handle.id(), identity, false));

    let result = actor.tasks.join_next_with_id().await.unwrap();
    actor.task_finished(result);

    let CommandReceipt::Accepted(completion) = start_receipt else {
        panic!("expected accepted start");
    };
    assert!(matches!(
        completion.wait().await,
        Err(super::super::CompletionError::Failed(
            super::super::SupervisorFailure::Termination(_)
        ))
    ));
    assert!(actor.state.pending_native_activation.is_none());
    assert_eq!(
        actor.state.phase,
        super::super::SupervisorPhase::OperationFailed
    );
}

#[tokio::test]
async fn restart_episode_overflow_fails_closed() {
    let adapter = FakeAdapter::blocked_install([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let mut state = super::super::settle::State::new(resource.initial);
    state.set_episode(super::super::RestartEpisode::from_settled_failures(
        u32::MAX,
    ));
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let policy = Policy::new(super::super::RestartDecision::RestartAfter(Duration::ZERO));
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: policy.clone(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    actor.crashed(super::super::SupervisorFailure::Exited(
        super::super::super::ExitObservation::new(Some(1), None, std::time::SystemTime::UNIX_EPOCH),
    ));

    assert_eq!(
        actor.state.phase,
        super::super::SupervisorPhase::OperationFailed
    );
    assert_eq!(actor.state.episode.settled_failures(), u32::MAX);
    assert_eq!(policy.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn shutdown_completion_waits_for_owned_tasks_and_snapshot() {
    let adapter = FakeAdapter::blocked_install([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let mut state = super::super::settle::State::new(resource.initial);
    state.admission_closed = true;
    state.intent = Some(super::super::ControlIntent::Shutdown);
    let shutdown = match state.controls.shutdown() {
        super::super::CommandReceipt::Accepted(completion) => completion,
        _ => panic!("expected shutdown receipt"),
    };
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, snapshot_receiver) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let task_release = release.clone();
    actor.tasks.spawn(async move {
        task_release.notified().await;
        super::super::worker::TaskIdentity::Probe
    });
    actor.resource_closed();
    let finalize = tokio::spawn(actor.finalize());
    tokio::task::yield_now().await;

    assert!(!finalize.is_finished());
    assert_eq!(
        snapshot_receiver.borrow().phase(),
        super::super::SupervisorPhase::Idle
    );
    release.notify_one();
    assert_eq!(
        shutdown.wait().await.unwrap(),
        super::super::super::ShutdownOutcome::Terminated(
            super::super::super::TerminationOutcome::NoProcess,
        )
    );
    assert_eq!(
        snapshot_receiver.borrow().phase(),
        super::super::SupervisorPhase::ShutDown
    );
    finalize.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn ready_sources_make_bounded_progress_in_priority_order() {
    let adapter = FakeAdapter::blocked_install([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter.clone(), test_launch());
    let client = resource.client.clone();
    let state = super::super::settle::State::new(resource.initial);
    let (commands, command_receiver) = mpsc::channel(16);
    let (controls, control_receiver) = mpsc::channel(32);
    let (owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    client.begin().await.unwrap();
    wait_until(|| adapter.install_calls() == 1).await;
    let generation = actor.state.generation;
    actor
        .work_sender
        .send(Work::Timer(generation))
        .await
        .unwrap();
    actor
        .tasks
        .spawn(async { super::super::worker::TaskIdentity::Probe });
    let (command_reply, _) = oneshot::channel();
    commands.send(Command::Start(command_reply)).await.unwrap();
    for _ in 0..32 {
        let (reply, _) = oneshot::channel();
        controls.send(ControlCommand::Stop(reply)).await.unwrap();
    }
    owner_drop.send(()).unwrap();
    tokio::task::yield_now().await;

    assert!(matches!(actor.receive().await, Inbound::OwnerDropped));
    assert!(matches!(actor.receive().await, Inbound::Control(_)));
    assert!(matches!(
        actor.receive().await,
        Inbound::Resource(ResourceEvent::BeginAccepted(_))
    ));
    assert!(
        matches!(actor.receive().await, Inbound::Work(Work::Timer(value)) if value == generation)
    );
    assert!(matches!(
        actor.receive().await,
        Inbound::Command(Command::Start(_))
    ));
    assert!(matches!(actor.receive().await, Inbound::Control(_)));
    assert!(matches!(actor.receive().await, Inbound::TaskFinished(_)));
}

#[tokio::test]
async fn stdio_failure_shutdown_unresolved_keeps_epoch_retriable() {
    let adapter = FakeAdapter::owned([]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let mut state = super::super::settle::State::new(resource.initial);
    let epoch = ResourceEpoch::test(7);
    state.phase = super::super::SupervisorPhase::OperationFailed;
    state.active_epoch = Some(epoch);
    state.observed = Some((epoch, owned()));
    state.stdio_failure_cleanup_epoch = Some(epoch);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (_controls, control_receiver) = mpsc::channel(1);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    let (first_reply, first_receipt) = oneshot::channel();
    actor.control(ControlCommand::Shutdown(first_reply), true);
    actor.apply_control();
    let CommandReceipt::Accepted(first_completion) = first_receipt.await.unwrap() else {
        panic!("expected accepted shutdown");
    };
    actor.shutdown_completed(Ok(
        super::super::super::resource::ResourceShutdown::Unresolved(
            super::super::super::TerminationFailure::AuthorityLost,
        ),
    ));

    assert_eq!(
        first_completion.wait().await.unwrap(),
        super::super::super::ShutdownOutcome::Unresolved {
            failure: super::super::super::TerminationFailure::AuthorityLost,
        }
    );
    assert_eq!(
        actor.state.phase,
        super::super::SupervisorPhase::OperationFailed
    );
    assert_eq!(actor.state.active_epoch, Some(epoch));
    assert_eq!(actor.state.observed, Some((epoch, owned())));
    assert_eq!(actor.state.stdio_failure_cleanup_epoch, Some(epoch));
    assert_eq!(actor.state.intent, None);
    assert!(!actor.state.shutdown_issued);
    assert_eq!(actor.state.active, None);
    assert!(actor.final_outcome.is_none());

    let (second_reply, second_receipt) = oneshot::channel();
    actor.control(ControlCommand::Shutdown(second_reply), false);
    let CommandReceipt::Accepted(second_completion) = second_receipt.await.unwrap() else {
        panic!("expected fresh shutdown receipt");
    };
    assert_eq!(
        actor.state.intent,
        Some(super::super::ControlIntent::Shutdown)
    );
    assert!(actor.state.shutdown_issued);
    actor.shutdown_completed(Ok(
        super::super::super::resource::ResourceShutdown::Terminated(TerminalEvidence::test(
            epoch,
            exit(9),
        )),
    ));
    actor.finalize().await;

    assert!(matches!(
        second_completion.wait().await.unwrap(),
        super::super::super::ShutdownOutcome::Terminated(
            super::super::super::TerminationOutcome::Graceful(ref observation)
        ) if observation.exit_code() == Some(9)
    ));
}

#[tokio::test]
async fn controls_queued_after_shutdown_are_rejected_within_the_same_batch() {
    let adapter = FakeAdapter::owned([]);
    let resource = ResourceRuntime::spawn(adapter, test_launch());
    let state = super::super::settle::State::new(resource.initial);
    let (_commands, command_receiver) = mpsc::channel(1);
    let (controls, control_receiver) = mpsc::channel(4);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );
    let (stop_before_shutdown, stop_before_shutdown_receipt) = oneshot::channel();
    let (shutdown, shutdown_receipt) = oneshot::channel();
    let (stop_after_shutdown, stop_after_shutdown_receipt) = oneshot::channel();
    controls
        .send(ControlCommand::Stop(stop_before_shutdown))
        .await
        .unwrap();
    controls
        .send(ControlCommand::Shutdown(shutdown))
        .await
        .unwrap();
    controls
        .send(ControlCommand::Stop(stop_after_shutdown))
        .await
        .unwrap();

    let Inbound::Control(control) = actor.receive().await else {
        panic!("expected first control");
    };
    actor.control_batch(control);

    assert!(matches!(
        stop_before_shutdown_receipt.await.unwrap(),
        CommandReceipt::AlreadySatisfied
    ));
    assert!(matches!(
        shutdown_receipt.await.unwrap(),
        CommandReceipt::Accepted(_)
    ));
    assert!(matches!(
        stop_after_shutdown_receipt.await.unwrap(),
        CommandReceipt::ShuttingDown
    ));
}

#[tokio::test(start_paused = true)]
async fn control_batch_advances_past_resource_to_work_and_command() {
    let adapter = FakeAdapter::blocked_install([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(super::super::super::ProcessStdio::new(None, None, None)),
    )]);
    let resource = ResourceRuntime::spawn(adapter.clone(), test_launch());
    let client = resource.client.clone();
    let state = super::super::settle::State::new(resource.initial);
    let (commands, command_receiver) = mpsc::channel(16);
    let (controls, control_receiver) = mpsc::channel(32);
    let (_owner_drop, owner_dropped) = oneshot::channel();
    let (snapshots, _) = watch::channel(SupervisorSnapshot::idle());
    let mut actor = super::runtime::Actor::new(
        Parts {
            stdio_activation: DrainStdio,
            readiness: Ready::immediate(),
            graceful_stop: Stop::requested(Duration::from_secs(1)),
            recovery: Recovery::fail(),
            restart_policy: Policy::halt(),
        },
        state,
        resource,
        command_receiver,
        control_receiver,
        owner_dropped,
        snapshots,
    );

    client.begin().await.unwrap();
    wait_until(|| adapter.install_calls() == 1).await;
    actor
        .work_sender
        .send(Work::Shutdown(Ok(
            super::super::super::resource::ResourceShutdown::NoResource,
        )))
        .await
        .unwrap();
    let (command_reply, _) = oneshot::channel();
    commands.send(Command::Start(command_reply)).await.unwrap();
    for _ in 0..32 {
        let (reply, _) = oneshot::channel();
        controls.send(ControlCommand::Stop(reply)).await.unwrap();
    }

    let Inbound::Control(control) = actor.receive().await else {
        panic!("expected control");
    };
    actor.control_batch(control);
    assert!(matches!(
        actor.receive().await,
        Inbound::Resource(ResourceEvent::BeginAccepted(_))
    ));
    assert!(matches!(
        actor.receive().await,
        Inbound::Work(Work::Shutdown(_))
    ));
    assert!(matches!(
        actor.receive().await,
        Inbound::Command(Command::Start(_))
    ));
}
