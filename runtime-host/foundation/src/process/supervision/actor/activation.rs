use super::super::super::{
    ProcessStdio, StdioActivationResult,
    resource::{Activation, ActivationOutcome, ResourceEpoch, ResourceFailure},
};
use super::super::{
    GracefulStop, LaunchFailure, ReadinessProbe, RestartPolicy, StartRecovery, StdioActivation,
    SupervisorFailure, worker,
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
    pub(super) fn await_stdio_activation(
        &mut self,
        epoch: ResourceEpoch,
        observation: super::super::super::ProcessObservation,
        stdio: ProcessStdio,
        native_activation: Activation,
    ) {
        let (generation, cancellation) = self.state.issue_policy();
        self.state.pending_stdio_activation = Some((generation, epoch));
        self.native_activation = Some((epoch, native_activation));
        worker::stdio_activation(
            worker::SpawnContext::new(
                &mut self.tasks,
                &mut self.task_identities,
                self.work_sender.clone(),
            ),
            self.policies.stdio_activation.clone(),
            generation,
            epoch,
            observation,
            stdio,
            cancellation,
        );
    }

    pub(super) fn stdio_activation_completed(
        &mut self,
        generation: u64,
        epoch: ResourceEpoch,
        result: StdioActivationResult,
    ) {
        if self.state.pending_stdio_activation != Some((generation, epoch))
            || self.state.active_epoch != Some(epoch)
        {
            return;
        }
        self.state.pending_stdio_activation = None;
        match result {
            StdioActivationResult::Activated(drain) => {
                self.state.stdio_drain_epoch = Some(epoch);
                self.state.stdio_drain_result = None;
                self.state.stdio_drain_deadline = None;
                self.stdio_control
                    .send_replace(super::super::worker::StdioDrainControl::Pending);
                worker::stdio_drain(
                    &mut self.tasks,
                    &mut self.task_identities,
                    epoch,
                    drain,
                    self.stdio_control.subscribe(),
                    self.work_sender.clone(),
                );
                self.await_native_activation(epoch);
            }
            StdioActivationResult::Unavailable | StdioActivationResult::Cancelled => {
                self.stdio_activation_failed(epoch);
            }
        }
    }

    pub(super) fn stdio_activation_failed(&mut self, epoch: ResourceEpoch) {
        if self.state.active_epoch != Some(epoch) {
            return;
        }
        self.state.pending_stdio_activation = None;
        if !self.settle_startup_failure(Some(epoch), &SupervisorFailure::StdioFailed) {
            self.native_activation.take();
            return;
        }
        self.state.stdio_failure_cleanup_epoch = Some(epoch);
        self.native_activation.take();
        self.issue_kill(epoch);
    }

    fn await_native_activation(&mut self, epoch: ResourceEpoch) {
        let Some((activation_epoch, activation)) = self.native_activation.take() else {
            return;
        };
        if activation_epoch != epoch {
            return;
        }
        let request_id = self.next_activation_request_id;
        let Some(next_request_id) = self.next_activation_request_id.checked_add(1) else {
            self.fail(SupervisorFailure::LaunchFailed(
                LaunchFailure::PlatformRejected,
            ));
            return;
        };
        self.next_activation_request_id = next_request_id;
        self.state.pending_native_activation = Some((request_id, epoch));
        worker::native_activation(
            &mut self.tasks,
            &mut self.task_identities,
            activation,
            request_id,
            epoch,
            self.work_sender.clone(),
        );
    }

    pub(super) fn native_activation_completed(
        &mut self,
        request_id: u64,
        epoch: ResourceEpoch,
        result: Result<ActivationOutcome, ResourceFailure>,
    ) {
        if self.state.pending_native_activation != Some((request_id, epoch)) {
            return;
        }
        self.state.pending_native_activation = None;
        match result {
            Ok(ActivationOutcome::Terminal(evidence)) if evidence.epoch() == epoch => {
                if self.state.stdio_drain_result.is_some_and(|result| {
                    result
                        != super::super::worker::StdioDrainCompletion::Completed(
                            super::super::super::StdioDrainResult::Drained,
                        )
                }) {
                    self.pending_terminal = Some(evidence);
                    self.begin_stdio_failure_cleanup(epoch);
                    return;
                }
                if self.state.owner_closed
                    && self.state.intent == Some(super::super::ControlIntent::Shutdown)
                {
                    let outcome = super::super::action::terminal_outcome(&evidence);
                    self.state.shutdown_issued = true;
                    self.accept_terminal(evidence);
                    self.shutdown_terminal_ready = true;
                    self.shutdown_terminal_outcome = Some(outcome);
                    let drain_succeeded = self.state.stdio_drain_epoch != Some(epoch)
                        || self.state.stdio_drain_result
                            == Some(super::super::worker::StdioDrainCompletion::Completed(
                                super::super::super::StdioDrainResult::Drained,
                            ));
                    if drain_succeeded {
                        self.finalize_shutdown_terminal();
                    } else if self.state.stdio_drain_result.is_some() {
                        self.begin_stdio_failure_cleanup(epoch);
                    } else {
                        self.bound_stdio_drain();
                    }
                } else {
                    self.accept_terminal(evidence);
                }
            }
            Ok(ActivationOutcome::Terminal(_)) => {}
            Ok(ActivationOutcome::Unresolved {
                observation,
                failure,
            }) if self.state.active_epoch == Some(epoch) => {
                if self.state.owner_closed
                    && self.state.intent == Some(super::super::ControlIntent::Shutdown)
                {
                    self.state.observed = observation.map(|observation| (epoch, observation));
                    self.complete_unresolved_shutdown(failure);
                } else {
                    self.unresolved(epoch, observation, failure);
                }
            }
            Ok(ActivationOutcome::Unresolved { .. }) => {}
            Ok(ActivationOutcome::Active) if self.state.active_epoch == Some(epoch) => {
                if self.state.stdio_failure_cleanup_epoch == Some(epoch) {
                    return;
                }
                if self.state.owner_closed {
                    self.native_activation_failed(epoch);
                } else if self.state.intent.is_some() {
                    self.apply_control();
                } else {
                    self.start_readiness(epoch);
                }
            }
            Ok(ActivationOutcome::Active) => {}
            Err(_) if self.state.owner_closed => self.native_activation_failed(epoch),
            Err(failure) => self.resource_request_failed(failure),
        }
    }

    pub(super) fn native_activation_failed(&mut self, epoch: ResourceEpoch) {
        if self.state.active_epoch != Some(epoch) {
            return;
        }
        if self.state.owner_closed
            && self.state.intent == Some(super::super::ControlIntent::Shutdown)
        {
            self.complete_unresolved_shutdown(
                super::super::super::TerminationFailure::CleanupUnconfirmed,
            );
            return;
        }
        self.resource_request_failed(ResourceFailure::OwnerStopped);
    }

    fn start_readiness(&mut self, epoch: ResourceEpoch) {
        let Some((observed_epoch, observation)) = self.state.observed else {
            return;
        };
        if observed_epoch != epoch {
            return;
        }
        let (generation, cancellation) = self.state.issue_policy();
        worker::readiness(
            worker::SpawnContext::new(
                &mut self.tasks,
                &mut self.task_identities,
                self.work_sender.clone(),
            ),
            self.policies.readiness.clone(),
            generation,
            epoch,
            observation,
            cancellation,
        );
    }
}
