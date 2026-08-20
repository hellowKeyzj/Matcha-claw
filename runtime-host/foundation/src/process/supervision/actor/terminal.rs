use super::super::super::{
    TerminationFailure, TerminationOutcome,
    resource::{ResourceFailure, ResourceShutdown, SharedTerminalEvidence},
};
use super::super::{
    ControlIntent, GracefulStop, ReadinessProbe, RestartPolicy, StartRecovery, StdioActivation,
    SupervisorFailure, SupervisorPhase, worker::StdioDrainControl,
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
    pub(super) fn accept_terminal(&mut self, evidence: SharedTerminalEvidence) {
        let epoch = evidence.epoch();
        if self.state.active_epoch != Some(epoch) && self.state.pending_epoch != Some(epoch) {
            return;
        }
        self.state.cancel_lease();
        if self.state.stdio_drain_epoch == Some(epoch) && self.state.stdio_drain_result.is_none() {
            self.pending_terminal = Some(evidence);
            self.bound_stdio_drain();
            return;
        }
        if self.state.settled_epoch == Some(epoch) {
            if self
                .state
                .pending_native_activation
                .is_some_and(|(_, pending_epoch)| pending_epoch == epoch)
            {
                self.state.pending_native_activation = None;
            }
            self.state.pending_epoch = None;
            self.state.active_epoch = None;
            if self
                .state
                .observed
                .is_some_and(|(observed_epoch, _)| observed_epoch == epoch)
            {
                self.state.observed = None;
            }
            self.state.kill_issued = None;
            if self.state.stdio_failure_cleanup_epoch == Some(epoch) {
                self.settle_stdio_failure(epoch);
            } else if self.state.intent.is_some() {
                self.apply_control();
            } else if let Some(delay) = self.state.recovery_after_cleanup.take() {
                self.schedule_retry(delay);
            } else {
                self.state.publish(&self.snapshots);
            }
            return;
        }

        let phase = self.state.phase;
        let startup_failure_settled = self.state.startup_failure_epoch == Some(epoch);
        let outcome = super::super::action::terminal_outcome(&evidence);
        self.state.settled_epoch = Some(epoch);
        if self
            .state
            .pending_native_activation
            .is_some_and(|(_, pending_epoch)| pending_epoch == epoch)
        {
            self.state.pending_native_activation = None;
        }
        self.state.pending_epoch = None;
        self.state.active_epoch = None;
        self.state.observed = None;
        self.state.kill_issued = None;

        if self.state.stdio_failure_cleanup_epoch == Some(epoch) {
            self.settle_stdio_failure(epoch);
            return;
        }

        if let Some(intent) = self.state.intent {
            if intent == ControlIntent::Shutdown {
                if !self.state.shutdown_issued {
                    self.issue_shutdown(Some(epoch));
                }
                return;
            }
            if self.state.restarting && intent == ControlIntent::Stop {
                self.state.cancel_policy();
                self.state.reset_control_episode();
                self.launch();
                return;
            }
            self.settle_termination(intent, outcome);
            return;
        }

        if let Some(delay) = self.state.recovery_after_cleanup.take() {
            self.schedule_retry(delay);
            return;
        }
        if startup_failure_settled {
            self.state.publish(&self.snapshots);
            return;
        }

        let failure = SupervisorFailure::Exited(evidence.exit().clone());
        match phase {
            SupervisorPhase::Running => {
                self.state.cancel_policy();
                self.crashed(failure);
            }
            SupervisorPhase::Starting => {
                if self.settle_startup_failure(Some(epoch), &failure) {
                    self.spawn_recovery(failure);
                }
            }
            SupervisorPhase::Stopping => {
                self.state.cancel_policy();
                self.fail(failure);
            }
            SupervisorPhase::OperationFailed | SupervisorPhase::WaitingToRestart => {
                self.state.publish(&self.snapshots)
            }
            _ => {}
        }
    }

    pub(super) fn stdio_drain_completed(
        &mut self,
        epoch: super::super::super::resource::ResourceEpoch,
        result: super::super::worker::StdioDrainCompletion,
    ) {
        if self.state.stdio_drain_epoch != Some(epoch) || self.state.stdio_drain_result.is_some() {
            return;
        }
        self.state.stdio_drain_result = Some(result);
        self.state.stdio_drain_deadline = None;
        let pending_terminal = self
            .pending_terminal
            .as_ref()
            .is_some_and(|evidence| evidence.epoch() == epoch);
        let shutdown_terminal =
            self.state.intent == Some(ControlIntent::Shutdown) && self.shutdown_terminal_ready;
        let owner_closed_shutdown = self.state.owner_closed
            && self.state.intent == Some(ControlIntent::Shutdown)
            && self.state.active_epoch == Some(epoch);
        if result
            != super::super::worker::StdioDrainCompletion::Completed(
                super::super::super::StdioDrainResult::Drained,
            )
        {
            self.begin_stdio_failure_cleanup(epoch);
            return;
        }
        if !pending_terminal && !shutdown_terminal && !owner_closed_shutdown {
            return;
        }
        if owner_closed_shutdown && !shutdown_terminal && !pending_terminal {
            self.complete_unresolved_shutdown(TerminationFailure::CleanupUnconfirmed);
            return;
        }
        if shutdown_terminal {
            self.pending_terminal = None;
            self.finalize_shutdown_terminal();
            return;
        }
        let evidence = self
            .pending_terminal
            .take()
            .expect("terminal evidence present");
        self.accept_terminal(evidence);
    }

    pub(super) fn bound_stdio_drain(&mut self) {
        if self.state.stdio_drain_result.is_some() || self.state.stdio_drain_deadline.is_some() {
            return;
        }
        let Some(deadline) = self.state.graceful_deadline.or_else(|| {
            tokio::time::Instant::now().checked_add(self.policies.graceful_stop.grace_period())
        }) else {
            self.stdio_control.send_replace(StdioDrainControl::Cancel);
            return;
        };
        self.state.stdio_drain_deadline = Some(deadline);
        self.stdio_control
            .send_replace(StdioDrainControl::Deadline(deadline));
    }

    pub(super) fn begin_stdio_failure_cleanup(
        &mut self,
        epoch: super::super::super::resource::ResourceEpoch,
    ) {
        if self.state.active_epoch != Some(epoch)
            || self.state.stdio_failure_cleanup_epoch == Some(epoch)
        {
            return;
        }
        self.pending_terminal = None;
        self.shutdown_terminal_ready = false;
        self.shutdown_terminal_outcome = None;
        self.state.cancel_lease();
        self.native_activation.take();
        self.state.pending_native_activation = None;
        self.state.stdio_failure_cleanup_epoch = Some(epoch);
        let shutdown = self.state.intent == Some(ControlIntent::Shutdown);
        if !shutdown && !self.settle_startup_failure(Some(epoch), &SupervisorFailure::StdioFailed) {
            self.state.stdio_failure_cleanup_epoch = None;
            return;
        }
        self.state.cancel_policy();
        self.state.phase = SupervisorPhase::OperationFailed;
        self.state.active = None;
        self.state.failure = Some(SupervisorFailure::StdioFailed);
        self.state.publish(&self.snapshots);
        if let Some(mutation) = self.state.mutation.take() {
            mutation.failed(SupervisorFailure::StdioFailed);
        }
        if shutdown && self.state.owner_closed {
            self.complete_unresolved_shutdown(TerminationFailure::CleanupUnconfirmed);
        } else if shutdown {
            self.issue_shutdown(Some(epoch));
        } else {
            self.issue_kill(epoch);
        }
    }

    fn settle_stdio_failure(&mut self, epoch: super::super::super::resource::ResourceEpoch) {
        if self.state.stdio_failure_cleanup_epoch != Some(epoch) {
            return;
        }
        self.state.stdio_failure_cleanup_epoch = None;
        self.state.stdio_drain_epoch = None;
        self.state.stdio_drain_result = None;
        self.state.stdio_drain_deadline = None;
        if self.state.intent != Some(ControlIntent::Shutdown) {
            self.spawn_recovery(SupervisorFailure::StdioFailed);
        }
    }

    pub(super) fn resource_request_failed(&mut self, failure: ResourceFailure) {
        if self.state.phase == SupervisorPhase::OperationFailed && self.state.intent.is_none() {
            return;
        }
        let supervisor_failure = super::super::action::resource_failure(failure);
        let termination_failure = match supervisor_failure {
            SupervisorFailure::Termination(failure) => failure,
            SupervisorFailure::LaunchFailed(_)
            | SupervisorFailure::StdioFailed
            | SupervisorFailure::ReadinessFailed
            | SupervisorFailure::Exited(_) => TerminationFailure::CleanupUnconfirmed,
        };
        if self.state.intent == Some(ControlIntent::Shutdown) {
            self.complete_unresolved_shutdown(termination_failure);
            return;
        }
        if let Some(intent) = self.state.intent {
            self.settle_termination_failure(intent, termination_failure);
            return;
        }
        if self.state.recovery_after_cleanup.take().is_some() {
            self.fail(SupervisorFailure::Termination(termination_failure));
            return;
        }
        self.settle_termination_failure(ControlIntent::Kill, termination_failure);
    }

    pub(super) fn finalize_shutdown_terminal(&mut self) {
        let outcome = self
            .shutdown_terminal_outcome
            .take()
            .expect("shutdown terminal outcome available");
        self.shutdown_terminal_ready = false;
        self.final_outcome = Some(super::runtime::FinalShutdown::Terminated(outcome));
    }

    pub(super) fn complete_unresolved_shutdown(&mut self, failure: TerminationFailure) {
        self.settle_unresolved_shutdown(failure);
        if self.owner_dropped.is_none() {
            self.schedule_shutdown_retry();
        }
    }

    pub(super) fn shutdown_completed(&mut self, result: Result<ResourceShutdown, ResourceFailure>) {
        if let Some(epoch) = self.state.stdio_failure_cleanup_epoch {
            match result {
                Ok(ResourceShutdown::Terminated(evidence)) => {
                    let outcome = super::super::action::terminal_outcome(&evidence);
                    self.accept_terminal(evidence);
                    self.final_outcome = Some(super::runtime::FinalShutdown::Terminated(outcome));
                }
                Ok(ResourceShutdown::Detached) => {
                    self.final_outcome = Some(super::runtime::FinalShutdown::Detached);
                }
                Ok(ResourceShutdown::Unresolved(failure)) => {
                    self.complete_unresolved_shutdown(failure);
                }
                Ok(ResourceShutdown::NoResource) => {
                    self.state.settled_epoch = Some(epoch);
                    self.state.pending_epoch = None;
                    self.state.active_epoch = None;
                    self.state.observed = None;
                    self.settle_stdio_failure(epoch);
                    self.final_outcome = Some(super::runtime::FinalShutdown::Terminated(
                        TerminationOutcome::NoProcess,
                    ));
                }
                Err(failure) => {
                    let failure = match failure {
                        ResourceFailure::AuthorityLost => TerminationFailure::AuthorityLost,
                        ResourceFailure::MaterialCleanupFailed => {
                            TerminationFailure::MaterialCleanupFailed
                        }
                        _ => TerminationFailure::CleanupUnconfirmed,
                    };
                    self.complete_unresolved_shutdown(failure);
                }
            }
            return;
        }
        self.finish_shutdown_result(result);
    }

    pub(super) fn shutdown_retry_completed(
        &mut self,
        result: Result<ResourceShutdown, ResourceFailure>,
    ) {
        if !self.shutdown_retry_pending {
            return;
        }
        self.shutdown_retry_pending = false;
        self.shutdown_completed(result);
    }

    fn finish_shutdown_result(&mut self, result: Result<ResourceShutdown, ResourceFailure>) {
        match result {
            Ok(ResourceShutdown::Terminated(evidence)) => {
                let outcome = super::super::action::terminal_outcome(&evidence);
                self.accept_terminal(evidence);
                self.pending_terminal = None;
                self.stdio_control.send_replace(StdioDrainControl::Cancel);
                self.shutdown_terminal_ready = true;
                self.shutdown_terminal_outcome = Some(outcome);
                self.finalize_shutdown_terminal();
            }
            Ok(ResourceShutdown::Detached) => {
                self.final_outcome = Some(super::runtime::FinalShutdown::Detached);
            }
            Ok(ResourceShutdown::NoResource) => {
                self.final_outcome = Some(super::runtime::FinalShutdown::Terminated(
                    TerminationOutcome::NoProcess,
                ));
            }
            Ok(ResourceShutdown::Unresolved(failure)) => {
                self.complete_unresolved_shutdown(failure);
            }
            Err(failure) => {
                let failure = match failure {
                    ResourceFailure::AuthorityLost => TerminationFailure::AuthorityLost,
                    ResourceFailure::MaterialCleanupFailed => {
                        TerminationFailure::MaterialCleanupFailed
                    }
                    _ => TerminationFailure::CleanupUnconfirmed,
                };
                self.complete_unresolved_shutdown(failure);
            }
        }
    }
}
