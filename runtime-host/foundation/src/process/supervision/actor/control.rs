use tokio::{sync::oneshot, time::Instant};

use super::super::super::{ShutdownOutcome, TerminationFailure, TerminationOutcome};
use super::super::{
    CommandReceipt, ControlIntent, GracefulStop, ReadinessProbe, RestartPolicy, StartRecovery,
    StdioActivation, SupervisorFailure, SupervisorOperation, SupervisorPhase, SupervisorRejection,
    TerminationCompletion, dispatch::ControlCommand, worker,
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
    pub(super) fn control(&mut self, control: ControlCommand, batch_open: bool) {
        match control {
            ControlCommand::Stop(reply) => self.terminate(ControlIntent::Stop, reply, batch_open),
            ControlCommand::Kill(reply) => self.terminate(ControlIntent::Kill, reply, batch_open),
            ControlCommand::Shutdown(reply) => self.shutdown(reply),
        }
    }

    fn terminate(
        &mut self,
        intent: ControlIntent,
        reply: oneshot::Sender<CommandReceipt<TerminationCompletion>>,
        batch_open: bool,
    ) {
        if !batch_open || self.state.admission_closed {
            let _ = reply.send(CommandReceipt::ShuttingDown);
            return;
        }
        if self.state.is_attached() {
            let _ = reply.send(CommandReceipt::Rejected(
                SupervisorRejection::NoTerminationAuthority,
            ));
            return;
        }
        if matches!(
            self.state.failure,
            Some(SupervisorFailure::Termination(
                TerminationFailure::AuthorityLost
            ))
        ) && self.state.active_epoch.is_some()
        {
            let _ = reply.send(CommandReceipt::Rejected(SupervisorRejection::AuthorityLost));
            return;
        }
        if !self.state.has_process_or_begin() && !self.state.has_policy_work() {
            let _ = reply.send(CommandReceipt::AlreadySatisfied);
            return;
        }

        if intent == ControlIntent::Stop
            && self.state.graceful_deadline.is_none()
            && self.state.has_process_or_begin()
        {
            let Some(deadline) =
                Instant::now().checked_add(self.policies.graceful_stop.grace_period())
            else {
                let _ = reply.send(CommandReceipt::Rejected(
                    SupervisorRejection::RecoveryRequired,
                ));
                return;
            };
            self.state.graceful_deadline = Some(deadline);
        }
        let receipt = match intent {
            ControlIntent::Stop => self.state.controls.stop(),
            ControlIntent::Kill => self.state.controls.kill(),
            ControlIntent::Shutdown => unreachable!(),
        };
        self.state.restarting = false;
        self.state.intent = Some(
            self.state
                .intent
                .map_or(intent, |current| current.max(intent)),
        );
        let _ = reply.send(receipt);
    }

    fn shutdown(&mut self, reply: oneshot::Sender<CommandReceipt<ShutdownOutcome>>) {
        if self.state.phase == SupervisorPhase::ShutDown {
            let _ = reply.send(CommandReceipt::AlreadySatisfied);
            return;
        }
        if self.state.admission_closed {
            let retry = self.state.active_epoch.is_some()
                && self.state.intent.is_none()
                && !self.state.shutdown_issued
                && matches!(self.state.failure, Some(SupervisorFailure::Termination(_)));
            let receipt = self.state.controls.shutdown();
            if retry {
                self.state.intent = Some(ControlIntent::Shutdown);
            }
            let _ = reply.send(receipt);
            if retry {
                self.apply_control();
            }
            return;
        }

        let receipt = self.state.controls.shutdown();
        self.begin_shutdown();
        let _ = reply.send(receipt);
    }

    pub(super) fn owner_dropped(&mut self) {
        if self.state.phase == SupervisorPhase::ShutDown {
            return;
        }
        if !self.state.admission_closed {
            self.begin_shutdown();
            self.apply_control();
            return;
        }
        if self.state.active_epoch.is_some()
            && self.state.intent.is_none()
            && !self.state.shutdown_issued
        {
            self.schedule_shutdown_retry();
        }
    }

    fn begin_shutdown(&mut self) {
        self.state.admission_closed = true;
        self.state.close_lease_issuance();
        self.commands.close();
        self.state.restarting = false;
        self.state.intent = Some(ControlIntent::Shutdown);
        self.state.cancel_policy();
    }

    pub(super) fn apply_control(&mut self) {
        let intent = self.state.intent.expect("control intent set");
        self.state.cancel_lease();
        self.state.cancel_policy();

        let Some(epoch) = self.state.active_epoch else {
            if self.state.begin_in_flight.is_some() || self.state.pending_epoch.is_some() {
                self.state.publish(&self.snapshots);
                return;
            }
            if intent == ControlIntent::Shutdown {
                self.issue_shutdown(None);
            } else {
                self.settle_termination(intent, TerminationOutcome::NoProcess);
            }
            return;
        };

        let retry_cleanup = matches!(
            self.state.failure,
            Some(SupervisorFailure::Termination(
                TerminationFailure::CleanupUnconfirmed
            ))
        );
        self.state.phase = SupervisorPhase::Stopping;
        self.state.active = Some(if self.state.restarting && intent == ControlIntent::Stop {
            SupervisorOperation::Restart
        } else {
            super::super::action::operation(intent)
        });
        self.state.publish(&self.snapshots);

        match intent {
            ControlIntent::Stop if retry_cleanup => self.issue_kill(epoch),
            ControlIntent::Stop => self.issue_graceful(epoch),
            ControlIntent::Kill => self.issue_kill(epoch),
            ControlIntent::Shutdown => {
                if self.state.kill_issued != Some(epoch) {
                    self.issue_shutdown(Some(epoch));
                }
            }
        }
    }

    fn issue_graceful(&mut self, epoch: super::super::super::resource::ResourceEpoch) {
        if self.state.graceful_started {
            return;
        }
        let Some((observed_epoch, observation)) = self.state.observed else {
            return;
        };
        if observed_epoch != epoch {
            return;
        }
        let deadline = self.state.graceful_deadline.expect("graceful deadline set");
        self.state.graceful_started = true;
        let (generation, cancellation) = self.state.issue_policy();
        worker::graceful(
            worker::SpawnContext::new(
                &mut self.tasks,
                &mut self.task_identities,
                self.work_sender.clone(),
            ),
            self.policies.graceful_stop.clone(),
            generation,
            epoch,
            observation,
            deadline,
            cancellation,
        );
        let client = self.client().clone();
        worker::wait_drained(
            &mut self.tasks,
            &mut self.task_identities,
            client,
            generation,
            epoch,
            deadline,
            self.work_sender.clone(),
        );
    }

    pub(super) fn issue_kill(&mut self, epoch: super::super::super::resource::ResourceEpoch) {
        if self.state.kill_issued == Some(epoch) {
            return;
        }
        self.state.kill_issued = Some(epoch);
        let client = self.client().clone();
        worker::kill(
            &mut self.tasks,
            &mut self.task_identities,
            client,
            epoch,
            self.work_sender.clone(),
        );
    }

    pub(super) fn issue_shutdown(
        &mut self,
        epoch: Option<super::super::super::resource::ResourceEpoch>,
    ) {
        if self.state.shutdown_issued {
            return;
        }
        self.state.shutdown_issued = true;
        let client = self.client().clone();
        worker::shutdown(
            &mut self.tasks,
            &mut self.task_identities,
            client,
            epoch,
            self.work_sender.clone(),
        );
    }

    pub(super) fn schedule_shutdown_retry(&mut self) {
        if self.owner_dropped.is_some()
            || self.shutdown_retry_pending
            || self.state.active_epoch.is_none()
        {
            return;
        }
        let epoch = self.state.active_epoch.expect("active shutdown epoch");
        self.state.intent = Some(ControlIntent::Shutdown);
        self.state.shutdown_issued = true;
        self.shutdown_retry_pending = true;
        let client = self.client().clone();
        worker::shutdown_retry(
            &mut self.tasks,
            &mut self.task_identities,
            client,
            epoch,
            std::time::Duration::from_millis(10),
            self.work_sender.clone(),
        );
    }
}
