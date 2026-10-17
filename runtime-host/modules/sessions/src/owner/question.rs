use super::actor::{SessionLane, SessionShared};
use crate::{
    command::session_identity_lane_key,
    ports::RuntimeOperationFailure,
    question::{
        PendingQuestionsCommand, PendingQuestionsOutcome, QuestionAvailability, QuestionDelivery,
        QuestionReceipt, SessionQuestionCommand, SessionQuestionOutcome, supports_identity,
    },
    state::SessionIdentity,
};

impl SessionLane {
    fn question_binding_matches(
        &self,
        shared: &SessionShared,
        identity: &SessionIdentity,
        native_id: &str,
    ) -> bool {
        let snapshot = shared.snapshot.load();
        let stored = snapshot.states.get(&session_identity_lane_key(identity));
        let states = self.state.iter().chain(stored);
        let mut bound = false;
        for state in states {
            if state.identity() != identity {
                return false;
            }
            if let Some(id) = state.native_session_id() {
                if id != native_id {
                    return false;
                }
                bound = true;
            }
        }
        bound
    }

    pub(super) async fn handle_pending_questions(
        &self,
        shared: &SessionShared,
        command: PendingQuestionsCommand,
    ) -> PendingQuestionsOutcome {
        if command.validate().is_err() {
            return PendingQuestionsOutcome::TargetRejected;
        }
        if !supports_identity(&command.identity) {
            return PendingQuestionsOutcome::Unsupported;
        }
        if !self.question_binding_matches(shared, &command.identity, &command.endpoint_session_id) {
            return PendingQuestionsOutcome::TargetRejected;
        }
        let driver = match shared.running_session_driver(
            platform::endpoint::runtime_address::RuntimeEndpoint::try_new(
                command.identity.provider().as_str(),
                &command.identity.endpoint.runtime_instance_id,
            )
            .ok(),
        ) {
            Ok(driver) => driver,
            Err(failure) => return pending_failure(failure),
        };
        let Some(ops) = driver.session_ops() else {
            return PendingQuestionsOutcome::Unsupported;
        };
        let native_id = command.endpoint_session_id.clone();
        let outcome = ops.pending_questions(command).await;
        match outcome {
            PendingQuestionsOutcome::Listed { questions } => {
                let mut targets = std::collections::BTreeSet::new();
                if questions.iter().any(|question| {
                    question.target.session_id != native_id
                        || question.validate().is_err()
                        || !targets.insert((
                            &question.target.instance_id,
                            &question.target.native_request_id,
                        ))
                }) {
                    return PendingQuestionsOutcome::Unknown;
                }
                PendingQuestionsOutcome::Listed { questions }
            }
            outcome => outcome,
        }
    }

    pub(super) async fn handle_question(
        &self,
        shared: &SessionShared,
        command: SessionQuestionCommand,
    ) -> SessionQuestionOutcome {
        if command.validate().is_err() {
            return SessionQuestionOutcome::rejected();
        }
        if !supports_identity(&command.identity) {
            return SessionQuestionOutcome::Unsupported;
        }
        // Read the actual pending request before submitting; native IDs alone do not bind a
        // question to this product session, and elicitation is not an AskUserQuestion answer.
        let questions = self
            .handle_pending_questions(
                shared,
                PendingQuestionsCommand {
                    identity: command.identity.clone(),
                    endpoint_session_id: command.target.session_id.clone(),
                },
            )
            .await;
        let questions = match questions {
            PendingQuestionsOutcome::Listed { questions } => questions,
            PendingQuestionsOutcome::TargetRejected => return SessionQuestionOutcome::rejected(),
            PendingQuestionsOutcome::Unsupported => return SessionQuestionOutcome::Unsupported,
            PendingQuestionsOutcome::Unknown => {
                return SessionQuestionOutcome::Unknown {
                    receipt: None,
                    response_attempt_delivery: Some(QuestionDelivery::NotSent),
                };
            }
            PendingQuestionsOutcome::Unavailable => {
                return SessionQuestionOutcome::Unavailable {
                    receipt: None,
                    response_attempt_delivery: Some(QuestionDelivery::NotSent),
                };
            }
        };
        let Some(question) = questions
            .into_iter()
            .find(|question| question.target == command.target)
        else {
            return SessionQuestionOutcome::rejected();
        };
        if question.availability != QuestionAvailability::Pending
            || question.delivery != QuestionDelivery::NotSent
            || !command.answer.matches_request(&question.request)
        {
            return SessionQuestionOutcome::TargetRejected {
                receipt: Some(QuestionReceipt {
                    target: question.target,
                    run_id: question.run_id,
                    availability: question.availability,
                    delivery: question.delivery,
                    native_application: question.native_application,
                    requested_at_ms: question.requested_at_ms,
                    updated_at_ms: question.updated_at_ms,
                    failure: None,
                }),
                response_attempt_delivery: Some(QuestionDelivery::NotSent),
            };
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
                return match pending_failure(failure) {
                    PendingQuestionsOutcome::Unsupported => SessionQuestionOutcome::Unsupported,
                    PendingQuestionsOutcome::TargetRejected => SessionQuestionOutcome::rejected(),
                    PendingQuestionsOutcome::Unknown => SessionQuestionOutcome::Unknown {
                        receipt: None,
                        response_attempt_delivery: Some(QuestionDelivery::NotSent),
                    },
                    _ => SessionQuestionOutcome::Unavailable {
                        receipt: None,
                        response_attempt_delivery: Some(QuestionDelivery::NotSent),
                    },
                };
            }
        };
        let Some(ops) = driver.session_ops() else {
            return SessionQuestionOutcome::Unsupported;
        };
        let target = command.target.clone();
        let outcome = ops.respond_to_question(command).await;
        if outcome
            .receipt()
            .is_some_and(|receipt| receipt.target != target || receipt.validate().is_err())
        {
            return SessionQuestionOutcome::unknown();
        }
        if matches!(&outcome, SessionQuestionOutcome::Responded { receipt } if receipt.delivery != QuestionDelivery::Sent)
        {
            return SessionQuestionOutcome::unknown();
        }
        outcome
    }
}

fn pending_failure(failure: RuntimeOperationFailure) -> PendingQuestionsOutcome {
    match failure {
        RuntimeOperationFailure::Unsupported => PendingQuestionsOutcome::Unsupported,
        RuntimeOperationFailure::TargetRejected => PendingQuestionsOutcome::TargetRejected,
        RuntimeOperationFailure::Unknown => PendingQuestionsOutcome::Unknown,
        RuntimeOperationFailure::Unavailable | RuntimeOperationFailure::HistoryRetryPending => {
            PendingQuestionsOutcome::Unavailable
        }
    }
}
