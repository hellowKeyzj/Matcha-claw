use tokio::sync::watch;

use super::super::{ShutdownOutcome, TerminationOutcome};
use super::{
    CommandReceipt, Completion, ControlIntent, RestartOutcome, StartOutcome, SupervisorFailure,
    TerminationCompletion,
};

type Reply<T> = watch::Sender<Option<Result<T, SupervisorFailure>>>;

pub(super) enum Mutation {
    Start(Reply<StartOutcome>),
    Restart(Reply<RestartOutcome>),
}

impl Mutation {
    pub(super) fn start(reply: Reply<StartOutcome>) -> Self {
        Self::Start(reply)
    }
    pub(super) fn restart(reply: Reply<RestartOutcome>) -> Self {
        Self::Restart(reply)
    }

    pub(super) fn share_start(&self) -> Option<CommandReceipt<StartOutcome>> {
        let Self::Start(reply) = self else {
            return None;
        };
        Some(CommandReceipt::Shared(Completion::new(reply.subscribe())))
    }

    pub(super) fn share_restart(&self) -> Option<CommandReceipt<RestartOutcome>> {
        let Self::Restart(reply) = self else {
            return None;
        };
        Some(CommandReceipt::Shared(Completion::new(reply.subscribe())))
    }

    pub(super) fn started(self) {
        if let Self::Start(reply) = self {
            send(reply, Ok(StartOutcome::Started));
        }
    }
    pub(super) fn restarted(self) {
        if let Self::Restart(reply) = self {
            send(reply, Ok(RestartOutcome::Restarted));
        }
    }

    pub(super) fn cancelled(self, by: ControlIntent, cleanup: TerminationOutcome) {
        match self {
            Self::Start(reply) => send(reply, Ok(StartOutcome::Cancelled { by, cleanup })),
            Self::Restart(reply) => send(reply, Ok(RestartOutcome::Cancelled { by, cleanup })),
        }
    }

    pub(super) fn failed(self, failure: SupervisorFailure) {
        match self {
            Self::Start(reply) => send(reply, Err(failure)),
            Self::Restart(reply) => send(reply, Err(failure)),
        }
    }
}

#[derive(Default)]
pub(super) struct Controls {
    pub(super) stop: Option<Reply<TerminationCompletion>>,
    pub(super) kill: Option<Reply<TerminationCompletion>>,
    pub(super) shutdown: Option<Reply<ShutdownOutcome>>,
}

impl Controls {
    pub(super) fn stop(&mut self) -> CommandReceipt<TerminationCompletion> {
        receipt(&mut self.stop)
    }
    pub(super) fn kill(&mut self) -> CommandReceipt<TerminationCompletion> {
        receipt(&mut self.kill)
    }
    pub(super) fn shutdown(&mut self) -> CommandReceipt<ShutdownOutcome> {
        receipt(&mut self.shutdown)
    }

    pub(super) fn terminate(&mut self, by: ControlIntent, outcome: TerminationOutcome) {
        settle(&mut self.stop, ControlIntent::Stop, by, outcome.clone());
        settle(&mut self.kill, ControlIntent::Kill, by, outcome);
    }

    pub(super) fn shutdown_complete(
        &mut self,
        outcome: ShutdownOutcome,
        final_outcome: TerminationOutcome,
    ) {
        self.complete_shutdown(outcome, final_outcome);
    }

    pub(super) fn complete_unresolved_shutdown(
        &mut self,
        outcome: ShutdownOutcome,
        final_outcome: TerminationOutcome,
    ) {
        self.complete_shutdown(outcome, final_outcome);
    }

    fn complete_shutdown(&mut self, outcome: ShutdownOutcome, final_outcome: TerminationOutcome) {
        settle(
            &mut self.stop,
            ControlIntent::Stop,
            ControlIntent::Shutdown,
            final_outcome.clone(),
        );
        settle(
            &mut self.kill,
            ControlIntent::Kill,
            ControlIntent::Shutdown,
            final_outcome,
        );
        if let Some(reply) = self.shutdown.take() {
            send(reply, Ok(outcome));
        }
    }

    pub(super) fn fail(&mut self, failure: SupervisorFailure) {
        for slot in [&mut self.stop, &mut self.kill] {
            if let Some(reply) = slot.take() {
                send(reply, Err(failure.clone()));
            }
        }
        if let Some(reply) = self.shutdown.take() {
            send(reply, Err(failure));
        }
    }
}

pub(super) fn new_start() -> (Reply<StartOutcome>, CommandReceipt<StartOutcome>) {
    let (reply, receiver) = watch::channel(None);
    (reply, CommandReceipt::Accepted(Completion::new(receiver)))
}

pub(super) fn new_restart() -> (Reply<RestartOutcome>, CommandReceipt<RestartOutcome>) {
    let (reply, receiver) = watch::channel(None);
    (reply, CommandReceipt::Accepted(Completion::new(receiver)))
}

fn receipt<T: Clone>(slot: &mut Option<Reply<T>>) -> CommandReceipt<T> {
    if let Some(reply) = slot {
        return CommandReceipt::Shared(Completion::new(reply.subscribe()));
    }
    let (reply, receiver) = watch::channel(None);
    *slot = Some(reply);
    CommandReceipt::Accepted(Completion::new(receiver))
}

fn settle(
    slot: &mut Option<Reply<TerminationCompletion>>,
    requested: ControlIntent,
    by: ControlIntent,
    outcome: TerminationOutcome,
) {
    let Some(reply) = slot.take() else { return };
    let completion = if requested < by {
        TerminationCompletion::Superseded {
            by,
            final_outcome: outcome,
        }
    } else {
        TerminationCompletion::Completed(outcome)
    };
    send(reply, Ok(completion));
}

fn send<T>(reply: Reply<T>, result: Result<T, SupervisorFailure>) {
    let _ = reply.send(Some(result));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn controls_share_same_intent_and_settle_superseded_receipts() {
        let mut controls = Controls::default();
        let accepted = accepted(controls.stop());
        let shared = shared(controls.stop());
        let outcome = TerminationOutcome::NoProcess;

        controls.terminate(ControlIntent::Kill, outcome.clone());

        let expected = TerminationCompletion::Superseded {
            by: ControlIntent::Kill,
            final_outcome: outcome,
        };
        assert_eq!(accepted.wait().await.unwrap(), expected);
        assert_eq!(shared.wait().await.unwrap(), expected);
    }

    #[tokio::test]
    async fn controls_complete_shutdown_cohort_with_final_outcome() {
        let mut controls = Controls::default();
        let stop = accepted(controls.stop());
        let kill = accepted(controls.kill());
        let shutdown = accepted(controls.shutdown());
        let outcome = TerminationOutcome::NoProcess;
        let shutdown_outcome = ShutdownOutcome::Terminated(outcome.clone());

        controls.shutdown_complete(shutdown_outcome.clone(), outcome.clone());

        assert_eq!(
            stop.wait().await.unwrap(),
            TerminationCompletion::Superseded {
                by: ControlIntent::Shutdown,
                final_outcome: outcome.clone(),
            }
        );
        assert_eq!(
            kill.wait().await.unwrap(),
            TerminationCompletion::Superseded {
                by: ControlIntent::Shutdown,
                final_outcome: outcome,
            }
        );
        assert_eq!(shutdown.wait().await.unwrap(), shutdown_outcome);
    }

    #[tokio::test]
    async fn mutation_receipts_share_matching_operation_only() {
        let (start_reply, accepted_start) = new_start();
        let start = Mutation::start(start_reply);
        let shared_start = shared(start.share_start().expect("start receipt"));
        assert!(start.share_restart().is_none());

        start.started();

        assert_eq!(
            accepted(accepted_start).wait().await.unwrap(),
            StartOutcome::Started
        );
        assert_eq!(shared_start.wait().await.unwrap(), StartOutcome::Started);

        let (restart_reply, accepted_restart) = new_restart();
        let restart = Mutation::restart(restart_reply);
        assert!(restart.share_start().is_none());
        let shared_restart = shared(restart.share_restart().expect("restart receipt"));

        restart.restarted();

        assert_eq!(
            accepted(accepted_restart).wait().await.unwrap(),
            RestartOutcome::Restarted
        );
        assert_eq!(
            shared_restart.wait().await.unwrap(),
            RestartOutcome::Restarted
        );
    }

    fn accepted<T>(receipt: CommandReceipt<T>) -> Completion<T> {
        let CommandReceipt::Accepted(completion) = receipt else {
            panic!("expected accepted receipt");
        };
        completion
    }

    fn shared<T>(receipt: CommandReceipt<T>) -> Completion<T> {
        let CommandReceipt::Shared(completion) = receipt else {
            panic!("expected shared receipt");
        };
        completion
    }
}
