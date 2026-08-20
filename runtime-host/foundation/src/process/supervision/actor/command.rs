use tokio::{sync::oneshot, time::Instant};

use super::super::super::TerminationFailure;
use super::super::{
    CommandReceipt, ControlIntent, GracefulStop, LaunchFailure, ReadinessProbe, RestartOutcome,
    RestartPolicy, StartOutcome, StartRecovery, StdioActivation, SupervisorFailure,
    SupervisorOperation, SupervisorPhase, SupervisorRejection,
    dispatch::Command,
    receipt::{Mutation, new_restart, new_start},
    worker,
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
    pub(super) fn command(&mut self, command: Command) {
        match command {
            Command::Start(reply) => self.start(reply),
            Command::Restart(reply) => self.restart(reply),
        }
    }

    fn start(&mut self, reply: oneshot::Sender<CommandReceipt<StartOutcome>>) {
        if self.state.admission_closed {
            let _ = reply.send(CommandReceipt::ShuttingDown);
            return;
        }
        if let Some(receipt) = self.state.mutation.as_ref().and_then(Mutation::share_start) {
            let _ = reply.send(receipt);
            return;
        }
        if self.state.mutation.is_some() {
            let _ = reply.send(CommandReceipt::Busy);
            return;
        }
        if self.state.active_epoch.is_some() {
            let receipt = if self.state.phase == SupervisorPhase::Running {
                CommandReceipt::AlreadySatisfied
            } else {
                CommandReceipt::Rejected(SupervisorRejection::RecoveryRequired)
            };
            let _ = reply.send(receipt);
            return;
        }
        if self.state.pending_epoch.is_some()
            || !matches!(
                self.state.phase,
                SupervisorPhase::Idle | SupervisorPhase::OperationFailed
            )
        {
            let _ = reply.send(CommandReceipt::Busy);
            return;
        }

        let (sender, receipt) = new_start();
        self.state.mutation = Some(Mutation::start(sender));
        self.state.restarting = false;
        self.state.failure = None;
        self.launch();
        let _ = reply.send(receipt);
    }

    fn restart(&mut self, reply: oneshot::Sender<CommandReceipt<RestartOutcome>>) {
        if self.state.admission_closed {
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
        if let Some(receipt) = self
            .state
            .mutation
            .as_ref()
            .and_then(Mutation::share_restart)
        {
            let _ = reply.send(receipt);
            return;
        }
        if self.state.mutation.is_some() || self.state.pending_epoch.is_some() {
            let _ = reply.send(CommandReceipt::Busy);
            return;
        }

        let can_launch = self.state.active_epoch.is_none()
            && matches!(
                self.state.phase,
                SupervisorPhase::Idle | SupervisorPhase::OperationFailed
            );
        let can_restart = self.state.active_epoch.is_some()
            && matches!(
                self.state.phase,
                SupervisorPhase::Running | SupervisorPhase::OperationFailed
            );
        if !can_launch && !can_restart {
            let _ = reply.send(CommandReceipt::Busy);
            return;
        }

        let deadline = if can_restart {
            let Some(deadline) =
                Instant::now().checked_add(self.policies.graceful_stop.grace_period())
            else {
                let _ = reply.send(CommandReceipt::Rejected(
                    SupervisorRejection::RecoveryRequired,
                ));
                return;
            };
            Some(deadline)
        } else {
            None
        };
        let (sender, receipt) = new_restart();
        self.state.mutation = Some(Mutation::restart(sender));
        if can_launch {
            self.state.failure = None;
        }
        if can_restart {
            self.state.restarting = true;
            self.state.intent = Some(ControlIntent::Stop);
            self.state.graceful_deadline = deadline;
        }
        let _ = reply.send(receipt);
        if can_launch {
            self.launch();
        } else {
            self.apply_control();
        }
    }

    pub(super) fn launch(&mut self) {
        self.state.cancel_policy();
        self.state.reset_control_episode();
        self.state.pending_native_activation = None;
        self.state.stdio_failure_cleanup_epoch = None;
        self.state.stdio_drain_epoch = None;
        self.state.stdio_drain_result = None;
        self.state.stdio_drain_deadline = None;
        self.pending_terminal = None;
        self.shutdown_terminal_ready = false;
        self.shutdown_terminal_outcome = None;
        self.stdio_control
            .send_replace(super::super::worker::StdioDrainControl::Pending);
        self.state.owner_closed = false;
        self.state.startup_failure_epoch = None;
        self.state.phase = SupervisorPhase::Starting;
        self.state.active = Some(match self.state.mutation.as_ref() {
            Some(Mutation::Restart(_)) => SupervisorOperation::Restart,
            _ => SupervisorOperation::Start,
        });
        self.state.failure = None;
        self.state.publish(&self.snapshots);
        let request_id = self.next_request_id;
        let Some(next_request_id) = self.next_request_id.checked_add(1) else {
            self.fail(SupervisorFailure::LaunchFailed(
                LaunchFailure::PlatformRejected,
            ));
            return;
        };
        self.next_request_id = next_request_id;
        self.state.begin_in_flight = Some(request_id);
        let client = self.client().clone();
        worker::begin(
            &mut self.tasks,
            &mut self.task_identities,
            request_id,
            client,
            self.work_sender.clone(),
        );
    }
}
