use foundation::execution::OwnedTask;
use tokio::sync::oneshot;

use super::actor::{SessionLane, SessionShared};
use crate::{
    call::SessionCall,
    command::SessionCommand,
    goal::{
        SessionGoalAction, SessionGoalCommand, SessionGoalMutation, SessionGoalOutcome,
        SessionGoalReceipt,
    },
    ports::RuntimeOperationFailure,
    send::{SessionSendOutcome, SessionSendStatus},
    state::{SessionEventBinding, SessionSourceBinding, SessionState},
};

impl SessionLane {
    pub(super) async fn start_goal(
        &mut self,
        shared: &SessionShared,
        command: SessionGoalCommand,
        reply: oneshot::Sender<SessionGoalOutcome>,
        call: Option<SessionCall>,
    ) {
        if command.validate().is_err() {
            crate::call::reply(call.as_ref(), reply, SessionGoalOutcome::TargetRejected).await;
            return;
        }
        let driver = match shared.running_session_driver(
            platform::endpoint::runtime_address::RuntimeEndpoint::try_new(
                command.identity.provider().as_str(),
                &command.identity.endpoint.runtime_instance_id,
            )
            .ok(),
        ) {
            Ok(driver) => driver,
            Err(failure) => {
                crate::call::reply(call.as_ref(), reply, goal_failure(failure)).await;
                return;
            }
        };
        if !driver.session_ops().is_some_and(|ops| ops.supports_goal()) {
            crate::call::reply(call.as_ref(), reply, SessionGoalOutcome::Unsupported).await;
            return;
        }
        if self.state.as_ref().is_some_and(|state| {
            state.identity() != &command.identity
                || state
                    .native_session_id()
                    .is_some_and(|id| id != command.endpoint_session_id)
        }) {
            crate::call::reply(call.as_ref(), reply, SessionGoalOutcome::TargetRejected).await;
            return;
        }
        let Some(sender) = shared.completion_handle.get().cloned() else {
            crate::call::reply(call.as_ref(), reply, SessionGoalOutcome::Unavailable).await;
            return;
        };
        if self.state.is_none() {
            self.state = SessionState::new(command.identity.clone(), shared.epoch)
                .and_then(|state| {
                    state.with_endpoint_session_id(Some(command.endpoint_session_id.clone()))
                })
                .ok();
        }
        let (demand_lease, _) = match self.prepare_goal_receive(
            shared,
            &command.identity,
            Some(&command.endpoint_session_id),
        ) {
            Ok(demand) => demand,
            Err(failure) => {
                crate::call::reply(call.as_ref(), reply, goal_failure(failure)).await;
                return;
            }
        };
        let shared_for_tasks = shared.clone();
        let (task, _) = OwnedTask::spawn(move |cancel| async move {
            let mutation = async {
                match driver.session_ops() {
                    Some(ops) => ops.mutate_session_goal(command.clone()).await,
                    None => SessionGoalOutcome::Unsupported,
                }
            };
            let outcome = tokio::select! {
                _ = cancel.cancelled() => { crate::call::reply(call.as_ref(), reply, SessionGoalOutcome::Unknown).await; return; },
                outcome = mutation => outcome,
            };
            let outcome = match outcome {
                SessionGoalOutcome::Succeeded { receipt } if !valid_receipt(&command, &receipt) => {
                    SessionGoalOutcome::Unknown
                }
                outcome => outcome,
            };
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = sender.send_command(SessionCommand::GoalCompleted { command, demand_lease, outcome, reply, call }) => {},
            }
        });
        let mut tasks = shared_for_tasks
            .read_tasks
            .lock()
            .expect("session read tasks lock");
        tasks.retain(|task| !task.is_finished());
        tasks.push(task);
    }

    pub(super) async fn complete_goal(
        &mut self,
        shared: &SessionShared,
        command: &SessionGoalCommand,
        demand_lease: &str,
        outcome: SessionGoalOutcome,
    ) -> SessionGoalOutcome {
        if !self.goal_completion_matches(
            &command.identity,
            Some(&command.endpoint_session_id),
            Some(&command.endpoint_session_id),
        ) {
            self.finish_goal_receive(shared, &command.identity, demand_lease, None);
            self.close_if_idle(shared, &command.identity);
            return SessionGoalOutcome::Unknown;
        }
        if matches!(command.mutation, SessionGoalMutation::Resume { .. }) {
            let send = match &outcome {
                SessionGoalOutcome::Succeeded { receipt } if receipt.replayed != Some(true) => {
                    SessionSendOutcome::Succeeded {
                        run_id: receipt.run_id.clone().expect("validated resume receipt"),
                        status: SessionSendStatus::Started,
                        goal: None,
                    }
                }
                SessionGoalOutcome::Unknown => SessionSendOutcome::Unknown,
                _ => SessionSendOutcome::Rejected,
            };
            self.finish_goal_receive(shared, &command.identity, demand_lease, Some(&send));
            if matches!(send, SessionSendOutcome::Succeeded { .. }) {
                self.apply_send_outcome(
                    shared,
                    command.identity.session_key(),
                    command.identity.provider(),
                    Some(command.identity.clone()),
                    &SessionSourceBinding::ordinary(),
                    SessionEventBinding::new(command.identity.clone(), None),
                    &send,
                    None,
                    None,
                )
                .await;
            }
        } else {
            self.finish_goal_receive(shared, &command.identity, demand_lease, None);
        }
        if matches!(
            outcome,
            SessionGoalOutcome::Succeeded { .. } | SessionGoalOutcome::Unknown
        ) {
            self.refresh_goal(shared, &command.identity);
        } else {
            self.close_if_idle(shared, &command.identity);
        }
        outcome
    }

    pub(super) fn goal_completion_matches(
        &self,
        identity: &crate::state::SessionIdentity,
        requested: Option<&str>,
        received: Option<&str>,
    ) -> bool {
        self.state.as_ref().is_some_and(|state| {
            state.identity() == identity
                && match requested {
                    Some(requested) => {
                        state.native_session_id() == Some(requested)
                            && received.is_none_or(|received| received == requested)
                    }
                    None => {
                        state.native_session_id().is_none() || state.native_session_id() == received
                    }
                }
        })
    }
}

fn valid_receipt(command: &SessionGoalCommand, receipt: &SessionGoalReceipt) -> bool {
    let action = match command.mutation {
        SessionGoalMutation::Edit { .. } => SessionGoalAction::Edit,
        SessionGoalMutation::Pause { .. } => SessionGoalAction::Pause,
        SessionGoalMutation::Resume { .. } => SessionGoalAction::Resume,
        SessionGoalMutation::Complete { .. } => SessionGoalAction::Complete,
        SessionGoalMutation::Block { .. } => SessionGoalAction::Block,
        SessionGoalMutation::Clear => SessionGoalAction::Clear,
    };
    receipt.validate().is_ok()
        && receipt.operation_id == command.operation_id
        && receipt.goal_id == command.goal_id
        && receipt.session_id == command.endpoint_session_id
        && receipt.action == action
}

pub(super) fn validate_start_outcome(
    command: &crate::send::SessionSendCommand,
    outcome: SessionSendOutcome,
) -> SessionSendOutcome {
    if command.intent.is_none() {
        return outcome;
    }
    match &outcome {
        SessionSendOutcome::Succeeded {
            run_id,
            goal: Some(receipt),
            ..
        } if receipt.validate().is_ok()
            && receipt.action == SessionGoalAction::Start
            && Some(receipt.operation_id.as_str()) == command.idempotency_key.as_deref()
            && command
                .endpoint_session_id
                .as_deref()
                .is_none_or(|id| id == receipt.session_id)
            && receipt.run_id.as_deref() == Some(run_id.as_str()) =>
        {
            outcome
        }
        SessionSendOutcome::Succeeded { .. } | SessionSendOutcome::Queued { .. } => {
            SessionSendOutcome::Unknown
        }
        _ => outcome,
    }
}

fn goal_failure(failure: RuntimeOperationFailure) -> SessionGoalOutcome {
    match failure {
        RuntimeOperationFailure::Unsupported => SessionGoalOutcome::Unsupported,
        RuntimeOperationFailure::Unavailable | RuntimeOperationFailure::HistoryRetryPending => SessionGoalOutcome::Unavailable,
        RuntimeOperationFailure::TargetRejected => SessionGoalOutcome::TargetRejected,
        RuntimeOperationFailure::Unknown => SessionGoalOutcome::Unknown,
    }
}
