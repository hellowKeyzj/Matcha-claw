use super::super::super::{ShutdownOutcome, TerminationFailure, TerminationOutcome};
use super::super::{
    ControlIntent, GracefulStop, LaunchFailure, ReadinessProbe, RestartOutcome, RestartPolicy,
    StartOutcome, StartRecovery, StdioActivation, SupervisorFailure, SupervisorOutcome,
    SupervisorPhase, TerminationCompletion, receipt::Mutation,
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
    pub(super) fn settle_ready(&mut self) {
        self.state.pending_native_activation = None;
        self.state.stdio_failure_cleanup_epoch = None;
        self.state.phase = SupervisorPhase::Running;
        self.state.active = None;
        self.state.failure = None;
        self.state.episode = super::super::RestartEpisode::initial();
        self.state.startup_failure_epoch = None;
        self.state.reset_control_episode();
        let mutation = self.state.mutation.take();
        self.state.outcome = match mutation.as_ref() {
            Some(Mutation::Start(_)) => Some(SupervisorOutcome::Started(StartOutcome::Started)),
            Some(Mutation::Restart(_)) => {
                Some(SupervisorOutcome::Restarted(RestartOutcome::Restarted))
            }
            None => None,
        };
        self.state.issue_lease();
        self.state.publish(&self.snapshots);
        match mutation {
            Some(mutation @ Mutation::Start(_)) => mutation.started(),
            Some(mutation @ Mutation::Restart(_)) => mutation.restarted(),
            None => {}
        }
        self.state.restarting = false;
    }

    pub(super) fn resource_closed(&mut self) {
        self.resource_events_open = false;
        self.state.owner_closed = true;
        if let Some(epoch) = self.state.active_epoch
            && self.state.stdio_drain_epoch == Some(epoch)
            && self.state.stdio_drain_result.is_none()
        {
            self.bound_stdio_drain();
            return;
        }
        if self.state.pending_native_activation.is_some() {
            self.state.cancel_policy();
            if let Some(ControlIntent::Stop | ControlIntent::Kill) = self.state.intent {
                self.settle_termination_failure(
                    self.state.intent.expect("control intent set"),
                    TerminationFailure::CleanupUnconfirmed,
                );
            }
            return;
        }
        if self.state.shutdown_issued {
            return;
        }
        let unresolved = self.state.active_epoch.is_some() || self.state.pending_epoch.is_some();
        match (self.state.intent, unresolved) {
            (Some(ControlIntent::Shutdown), true) => {
                self.complete_unresolved_shutdown(TerminationFailure::CleanupUnconfirmed);
            }
            (Some(ControlIntent::Shutdown), false) => {
                self.final_outcome = Some(super::runtime::FinalShutdown::Terminated(
                    TerminationOutcome::NoProcess,
                ));
            }
            (Some(intent), true) => {
                self.settle_termination_failure(intent, TerminationFailure::CleanupUnconfirmed)
            }
            (Some(intent), false) => self.settle_missing_owner(intent),
            (None, true) => self.fail(SupervisorFailure::Termination(
                TerminationFailure::CleanupUnconfirmed,
            )),
            (None, false) => self.fail(SupervisorFailure::LaunchFailed(
                LaunchFailure::PlatformRejected,
            )),
        }
    }

    fn settle_missing_owner(&mut self, intent: ControlIntent) {
        self.state.cancel_policy();
        let outcome = TerminationOutcome::NoProcess;
        self.state.phase = SupervisorPhase::OperationFailed;
        self.state.active = None;
        self.state.failure = Some(SupervisorFailure::LaunchFailed(
            LaunchFailure::PlatformRejected,
        ));
        self.state.outcome = Some(SupervisorOutcome::Terminated(
            TerminationCompletion::Completed(outcome.clone()),
        ));
        self.state.reset_control_episode();
        self.state.publish(&self.snapshots);
        self.state.controls.terminate(intent, outcome);
        if let Some(mutation) = self.state.mutation.take() {
            mutation.failed(SupervisorFailure::LaunchFailed(
                LaunchFailure::PlatformRejected,
            ));
        }
    }

    pub(super) fn settle_termination_failure(
        &mut self,
        intent: ControlIntent,
        failure: TerminationFailure,
    ) {
        self.state.cancel_lease();
        self.state.cancel_policy();
        self.state.pending_native_activation = None;
        let outcome = super::super::action::termination_failure_outcome(failure);
        self.state.phase = SupervisorPhase::OperationFailed;
        self.state.active = None;
        self.state.failure = Some(SupervisorFailure::Termination(failure));
        self.state.outcome = Some(SupervisorOutcome::Terminated(
            TerminationCompletion::Completed(outcome.clone()),
        ));
        self.state.reset_control_episode();
        self.state.publish(&self.snapshots);
        self.state.controls.terminate(intent, outcome);
        if let Some(mutation) = self.state.mutation.take() {
            mutation.failed(SupervisorFailure::Termination(failure));
        }
    }

    pub(super) fn settle_unresolved_shutdown(&mut self, failure: TerminationFailure) {
        self.state.cancel_lease();
        self.state.cancel_policy();
        self.state.pending_native_activation = None;
        self.state.phase = SupervisorPhase::OperationFailed;
        self.state.active = None;
        self.state.failure = Some(SupervisorFailure::Termination(failure));
        let outcome = ShutdownOutcome::Unresolved { failure };
        self.state.intent = None;
        self.state.graceful_deadline = None;
        self.state.graceful_started = false;
        self.state.kill_issued = None;
        self.state.shutdown_issued = false;
        self.state.recovery_after_cleanup = None;
        self.state.publish(&self.snapshots);
        let final_outcome = super::super::action::termination_failure_outcome(failure);
        self.state
            .controls
            .complete_unresolved_shutdown(outcome, final_outcome);
        if let Some(mutation) = self.state.mutation.take() {
            mutation.failed(SupervisorFailure::Termination(failure));
        }
    }

    pub(super) fn settle_termination(
        &mut self,
        intent: ControlIntent,
        outcome: TerminationOutcome,
    ) {
        self.state.cancel_lease();
        self.state.cancel_policy();
        self.state.pending_native_activation = None;
        self.state.stdio_failure_cleanup_epoch = None;
        self.state.pending_epoch = None;
        self.state.active_epoch = None;
        self.state.observed = None;
        self.state.startup_failure_epoch = None;
        self.state.phase = SupervisorPhase::Idle;
        self.state.active = None;
        self.state.failure = None;
        self.state.outcome = Some(SupervisorOutcome::Terminated(
            TerminationCompletion::Completed(outcome.clone()),
        ));
        self.state.reset_control_episode();
        self.state.publish(&self.snapshots);
        self.state.controls.terminate(intent, outcome.clone());
        if let Some(mutation) = self.state.mutation.take() {
            mutation.cancelled(intent, outcome);
        }
    }

    pub(super) fn fail(&mut self, failure: SupervisorFailure) {
        self.state.cancel_lease();
        self.state.cancel_policy();
        self.state.pending_native_activation = None;
        self.state.phase = SupervisorPhase::OperationFailed;
        self.state.active = None;
        self.state.failure = Some(failure.clone());
        self.state.publish(&self.snapshots);
        self.state.controls.fail(failure.clone());
        if let Some(mutation) = self.state.mutation.take() {
            mutation.failed(failure);
        }
    }

    pub(super) async fn drain_custody(&mut self) -> Result<(), tokio::task::JoinError> {
        self.state.admission_closed = true;
        self.state.close_lease_issuance();
        self.state.cancel_policy();
        self.stdio_control
            .send_replace(super::super::worker::StdioDrainControl::Cancel);
        self.commands.close();
        self.controls.close();
        self.work.close();
        self.resource_events_open = false;

        while self.tasks.join_next().await.is_some() {}
        let resource = self.resource.take().expect("resource runtime available");
        drop(resource.client);
        drop(resource.events);
        resource.task.await
    }

    pub(super) async fn finalize(mut self) {
        self.drain_custody()
            .await
            .expect("resource owner task failed");

        let (outcome, final_outcome) =
            match self.final_outcome.take().expect("shutdown outcome set") {
                super::runtime::FinalShutdown::Terminated(outcome) => {
                    (ShutdownOutcome::Terminated(outcome.clone()), outcome)
                }
                super::runtime::FinalShutdown::Detached => {
                    (ShutdownOutcome::Detached, TerminationOutcome::NoProcess)
                }
            };
        self.state.pending_native_activation = None;
        self.state.stdio_failure_cleanup_epoch = None;
        self.state.pending_epoch = None;
        self.state.active_epoch = None;
        self.state.observed = None;
        self.state.startup_failure_epoch = None;
        self.state.phase = SupervisorPhase::ShutDown;
        self.state.active = None;
        self.state.intent = None;
        self.state.failure = None;
        self.state.outcome = Some(SupervisorOutcome::ShutDown(outcome.clone()));
        self.state.publish(&self.snapshots);

        self.state
            .controls
            .shutdown_complete(outcome, final_outcome.clone());
        if let Some(mutation) = self.state.mutation.take() {
            mutation.cancelled(ControlIntent::Shutdown, final_outcome);
        }
    }
}
