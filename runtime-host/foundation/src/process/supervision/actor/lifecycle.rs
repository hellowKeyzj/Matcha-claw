use tokio::time::Instant;

use super::super::super::{
    ProcessObservation, TerminationFailure, TerminationOutcome,
    resource::{BeginCompletion, BeginDrained, ResourceEpoch, ResourceEvent, ResourceFailure},
};
use super::super::{
    ControlIntent, GracefulStop, ReadinessProbe, ReadinessResult, RestartDecision, RestartPolicy,
    StartRecovery, StartRecoveryResult, StdioActivation, SupervisorFailure, SupervisorOperation,
    SupervisorPhase,
    worker::{self, GracefulCompletion, Work},
};
use super::runtime::Actor;

impl<A, R, G, S, T> Actor<A, R, G, S, T>
where
    A: StdioActivation,
    R: ReadinessProbe,
    G: GracefulStop,
    S: StartRecovery,
    T: RestartPolicy,
{
    pub(super) fn resource_event(&mut self, event: ResourceEvent) {
        match event {
            ResourceEvent::BeginAccepted(epoch) => {
                self.state.begin_in_flight = None;
                self.state.pending_epoch = Some(epoch);
            }
            ResourceEvent::BeginCompleted { epoch, completion } => {
                self.begin_completed(epoch, completion)
            }
            ResourceEvent::NativeFact(evidence) => self.accept_terminal(evidence),
            ResourceEvent::MaterialCleanupFailed(evidence) => self.unresolved(
                evidence.epoch(),
                None,
                TerminationFailure::MaterialCleanupFailed,
            ),
            ResourceEvent::Unresolved {
                epoch,
                observation,
                failure,
            } => self.unresolved(epoch, observation, failure),
            ResourceEvent::OwnerStopped => self.resource_closed(),
        }
    }

    fn begin_completed(&mut self, epoch: ResourceEpoch, completion: BeginCompletion) {
        if self.state.pending_epoch != Some(epoch) {
            return;
        }
        match completion {
            BeginCompletion::Installed(installed) => {
                self.state.pending_epoch = None;
                self.state.active_epoch = Some(epoch);
                self.state.startup_failure_epoch = None;
                self.state.observed = Some((epoch, installed.observation));
                self.state.publish(&self.snapshots);
                self.await_stdio_activation(
                    epoch,
                    installed.observation,
                    installed.stdio,
                    installed.activation,
                );
                if self.state.intent.is_some() {
                    self.apply_control();
                }
            }
            BeginCompletion::Drained(drained) => {
                self.state.pending_epoch = None;
                if let Some(intent) = self.state.intent {
                    if intent == ControlIntent::Shutdown {
                        self.issue_shutdown(None);
                    } else {
                        self.settle_termination(intent, TerminationOutcome::NoProcess);
                    }
                } else {
                    let BeginDrained::LaunchFailed(failure) = drained;
                    self.start_launch_recovery(SupervisorFailure::LaunchFailed(failure));
                }
            }
            BeginCompletion::MaterialCleanupFailed { epoch } => {
                self.unresolved(epoch, None, TerminationFailure::MaterialCleanupFailed)
            }
            BeginCompletion::Unresolved {
                epoch,
                observation,
                failure,
            } => self.unresolved(epoch, observation, failure),
        }
    }

    pub(super) fn unresolved(
        &mut self,
        epoch: ResourceEpoch,
        observation: Option<ProcessObservation>,
        failure: TerminationFailure,
    ) {
        if self.state.active_epoch != Some(epoch) && self.state.pending_epoch != Some(epoch) {
            return;
        }
        self.state.pending_epoch = None;
        self.state.active_epoch = Some(epoch);
        self.state.observed = observation.map(|observation| (epoch, observation));
        if self.state.stdio_failure_cleanup_epoch == Some(epoch) {
            self.state.stdio_failure_cleanup_epoch = None;
            if self.state.intent == Some(ControlIntent::Shutdown) && !self.state.shutdown_issued {
                self.issue_shutdown(Some(epoch));
            }
            return;
        }
        if self.state.intent == Some(ControlIntent::Shutdown) {
            self.issue_shutdown(Some(epoch));
        } else if let Some(intent) = self.state.intent {
            self.settle_termination_failure(intent, failure);
        } else {
            self.fail(SupervisorFailure::Termination(failure));
        }
    }

    pub(super) fn work(&mut self, work: Work) {
        self.record_work(&work);
        match work {
            Work::BeginEnqueued(_) => {}
            Work::BeginOwnerClosed(request_id) => {
                if self.state.begin_in_flight == Some(request_id) {
                    self.state.begin_in_flight = None;
                    self.resource_closed();
                }
            }
            Work::StdioActivation {
                generation,
                epoch,
                result,
            } => self.stdio_activation_completed(generation, epoch, result),
            Work::NativeActivation {
                request_id,
                epoch,
                result,
            } => self.native_activation_completed(request_id, epoch, result),
            Work::StdioDrain { epoch, result } => self.stdio_drain_completed(epoch, result),
            Work::Readiness {
                generation,
                epoch,
                result,
            } => self.readiness(generation, epoch, result),
            Work::Recovery {
                generation,
                failure,
                result,
            } => self.recovery(generation, failure, result),
            Work::Graceful {
                generation,
                epoch,
                result,
            } => self.graceful(generation, epoch, result),
            Work::WaitDrained {
                generation,
                epoch,
                result,
            } if generation == self.state.generation => match result {
                Ok(evidence) => self.accept_terminal(evidence),
                Err(ResourceFailure::TimedOut) if self.state.active_epoch == Some(epoch) => {
                    self.issue_kill(epoch)
                }
                Err(_) if self.state.settled_epoch == Some(epoch) => {}
                Err(failure) if self.state.active_epoch == Some(epoch) => {
                    self.resource_request_failed(failure)
                }
                Err(_) => {}
            },
            Work::WaitDrained { .. } => {}
            Work::Kill { epoch, result } => match result {
                Ok(evidence) => self.accept_terminal(evidence),
                Err(_) if self.state.settled_epoch == Some(epoch) => {}
                Err(failure) if self.state.active_epoch == Some(epoch) => {
                    self.resource_request_failed(failure)
                }
                Err(_) => {}
            },
            Work::Shutdown(result) => self.shutdown_completed(result),
            Work::ShutdownRetry(result) => self.shutdown_retry_completed(result),
            Work::Timer(generation) if generation == self.state.generation => self.launch(),
            Work::Timer(_) => {}
        }
    }

    fn readiness(&mut self, generation: u64, epoch: ResourceEpoch, result: ReadinessResult) {
        if generation != self.state.generation
            || self.state.active_epoch != Some(epoch)
            || self.state.stdio_failure_cleanup_epoch == Some(epoch)
        {
            return;
        }
        if self.state.intent.is_some() {
            self.apply_control();
            return;
        }
        match result {
            ReadinessResult::Ready => self.settle_ready(),
            ReadinessResult::Unavailable | ReadinessResult::Cancelled => {
                self.start_readiness_recovery(epoch)
            }
        }
    }

    fn start_launch_recovery(&mut self, failure: SupervisorFailure) {
        if !self.settle_startup_failure(None, &failure) {
            return;
        }
        self.spawn_recovery(failure);
    }

    pub(super) fn start_readiness_recovery(&mut self, epoch: ResourceEpoch) {
        let failure = SupervisorFailure::ReadinessFailed;
        if !self.settle_startup_failure(Some(epoch), &failure) {
            return;
        }
        self.spawn_recovery(failure);
    }

    pub(super) fn settle_startup_failure(
        &mut self,
        epoch: Option<ResourceEpoch>,
        failure: &SupervisorFailure,
    ) -> bool {
        if self.state.intent.is_some() {
            self.apply_control();
            return false;
        }
        if epoch.is_some_and(|epoch| self.state.startup_failure_epoch == Some(epoch)) {
            return false;
        }
        self.state.begin_in_flight = None;
        if !self.state.settle_failure() {
            self.fail(failure.clone());
            return false;
        }
        self.state.startup_failure_epoch = epoch;
        true
    }

    pub(super) fn spawn_recovery(&mut self, failure: SupervisorFailure) {
        let (generation, cancellation) = self.state.issue_policy();
        worker::recovery(
            &mut self.tasks,
            &mut self.task_identities,
            self.policies.recovery.clone(),
            generation,
            failure,
            cancellation,
            self.work_sender.clone(),
        );
    }

    fn recovery(
        &mut self,
        generation: u64,
        failure: SupervisorFailure,
        result: StartRecoveryResult,
    ) {
        if generation != self.state.generation {
            return;
        }
        if self.state.intent.is_some() {
            self.apply_control();
            return;
        }
        match result {
            StartRecoveryResult::RetryAfter(delay) => {
                let Some(deadline) = Instant::now().checked_add(delay) else {
                    self.fail(failure);
                    return;
                };
                if let Some(epoch) = self.state.active_epoch {
                    self.state.recovery_after_cleanup = Some(deadline);
                    self.issue_kill(epoch);
                } else {
                    self.schedule_retry(deadline);
                }
            }
            StartRecoveryResult::Fail
            | StartRecoveryResult::Cancelled
            | StartRecoveryResult::Rejected => self.fail(failure),
        }
    }

    pub(super) fn schedule_retry(&mut self, deadline: Instant) {
        let (generation, cancellation) = self.state.issue_policy();
        self.state.phase = SupervisorPhase::WaitingToRestart;
        self.state.active = Some(SupervisorOperation::Restart);
        self.state.failure = None;
        self.state.publish(&self.snapshots);
        worker::timer(
            &mut self.tasks,
            &mut self.task_identities,
            generation,
            cancellation,
            deadline,
            self.work_sender.clone(),
        );
    }

    fn graceful(&mut self, generation: u64, epoch: ResourceEpoch, result: GracefulCompletion) {
        if generation != self.state.generation || self.state.active_epoch != Some(epoch) {
            return;
        }
        match result {
            GracefulCompletion::Completed(super::super::GracefulStopResult::Requested) => {}
            GracefulCompletion::Completed(
                super::super::GracefulStopResult::Cancelled
                | super::super::GracefulStopResult::Rejected,
            )
            | GracefulCompletion::DeadlineElapsed => self.issue_kill(epoch),
        }
    }

    pub(super) fn crashed(&mut self, failure: SupervisorFailure) {
        if !self.state.settle_failure() {
            self.fail(failure);
            return;
        }
        match self
            .policies
            .restart_policy
            .decide(&failure, self.state.episode)
        {
            RestartDecision::Halt => self.fail(failure),
            RestartDecision::RestartAfter(delay) => {
                let Some(deadline) = Instant::now().checked_add(delay) else {
                    self.fail(failure);
                    return;
                };
                self.schedule_retry(deadline);
            }
        }
    }
}
