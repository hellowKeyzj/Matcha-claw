mod identity;
mod intent;
mod ledger;
mod state;

pub use identity::{
    CommandAttempt, CommandId, IdempotencyKey, InvalidCommandAttempt, InvalidCommandId,
    InvalidIdempotencyKey,
};
pub use intent::{CommandIntent, CommandKind, CommandTarget};
pub use ledger::{
    CommandLedger, CommandRecord, RestoreCommandError, RestoreLedgerError, StartOutcome,
    SubmitOutcome, TransitionOutcome,
};
pub use state::{CommandCancellation, CommandFailure, CommandState, CommandTransitionError};

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use platform::endpoint::EndpointId;

    use crate::topology::{NodeId, RuntimeId};

    use super::*;

    fn command_id(value: &str) -> CommandId {
        CommandId::try_new(value).unwrap()
    }

    fn key(value: &str) -> IdempotencyKey {
        IdempotencyKey::try_new(value).unwrap()
    }

    fn node_id(value: &str) -> NodeId {
        NodeId::try_new(value).unwrap()
    }

    fn intent(id: &str, idempotency_key: &str, queued_at: SystemTime) -> CommandIntent {
        CommandIntent::new(
            command_id(id),
            key(idempotency_key),
            CommandTarget::Node(node_id("node-1")),
            CommandKind::ProbeNode,
            queued_at,
        )
    }

    #[test]
    fn identities_reject_blank_values_without_echoing_them() {
        assert_eq!(
            CommandId::try_new(" \t").unwrap_err().to_string(),
            "command ID must not be empty"
        );
        assert_eq!(
            IdempotencyKey::try_new("\n").unwrap_err().to_string(),
            "idempotency key must not be empty"
        );
    }

    #[test]
    fn command_attempt_rejects_zero() {
        assert_eq!(
            CommandAttempt::try_new(0).unwrap_err().to_string(),
            "command attempt sequence must be positive"
        );
    }

    #[test]
    fn intent_exposes_a_typed_target_without_payload_or_secrets() {
        let target = CommandTarget::Endpoint {
            node_id: node_id("node-1"),
            runtime_id: RuntimeId::try_new("runtime-1").unwrap(),
            endpoint_id: EndpointId::try_new("endpoint-1").unwrap(),
        };
        let intent = CommandIntent::new(
            command_id("command-1"),
            key("key-1"),
            target,
            CommandKind::SyncCapabilities,
            SystemTime::UNIX_EPOCH,
        );

        assert_eq!(intent.target().node_id().as_str(), "node-1");
        assert_eq!(intent.target().runtime_id().unwrap().as_str(), "runtime-1");
        assert_eq!(
            intent.target().endpoint_id().unwrap().as_str(),
            "endpoint-1"
        );
        assert_eq!(intent.kind(), CommandKind::SyncCapabilities);
    }

    #[test]
    fn submission_permanently_reserves_the_idempotency_key() {
        let mut ledger = CommandLedger::default();
        let queued_at = SystemTime::UNIX_EPOCH;
        let id = command_id("command-1");
        let first = intent("command-1", "key-1", queued_at);
        let duplicate = intent("command-2", "key-1", queued_at + Duration::from_secs(1));

        assert!(matches!(ledger.submit(first), SubmitOutcome::Submitted(_)));
        let attempt = start(&mut ledger, &id, queued_at);
        assert!(matches!(
            ledger.succeed(&id, &attempt, queued_at),
            TransitionOutcome::Transitioned(_)
        ));

        let duplicate = ledger.submit(duplicate);
        let SubmitOutcome::Duplicate(record) = duplicate else {
            panic!("expected the original command for a duplicate idempotency key");
        };
        assert_eq!(record.intent().command_id().as_str(), "command-1");
        assert_eq!(
            record.state(),
            &CommandState::Succeeded {
                completed_at: queued_at
            }
        );
        assert_eq!(ledger.records().count(), 1);
    }

    #[test]
    fn submission_rejects_a_reused_command_identity_without_reserving_a_new_key() {
        let mut ledger = CommandLedger::default();
        let queued_at = SystemTime::UNIX_EPOCH;
        assert!(matches!(
            ledger.submit(intent("command-1", "key-1", queued_at)),
            SubmitOutcome::Submitted(_)
        ));

        assert_eq!(
            ledger.submit(intent("command-1", "key-2", queued_at)),
            SubmitOutcome::DuplicateCommandId(command_id("command-1"))
        );
        assert!(matches!(
            ledger.submit(intent("command-2", "key-2", queued_at)),
            SubmitOutcome::Submitted(_)
        ));
    }

    fn start(ledger: &mut CommandLedger, command_id: &CommandId, at: SystemTime) -> CommandAttempt {
        let StartOutcome::Started { attempt, .. } = ledger.start(command_id, at) else {
            panic!("expected the command to start");
        };
        attempt
    }

    #[test]
    fn command_moves_from_queued_to_running_to_a_terminal_outcome() {
        let mut ledger = CommandLedger::default();
        let queued_at = SystemTime::UNIX_EPOCH;
        let id = command_id("command-1");
        ledger.submit(intent("command-1", "key-1", queued_at));

        let started_at = queued_at + Duration::from_secs(2);
        let completed_at = queued_at + Duration::from_secs(3);
        let attempt = start(&mut ledger, &id, started_at);
        assert!(matches!(
            ledger.succeed(&id, &attempt, completed_at),
            TransitionOutcome::Transitioned(CommandRecord { .. })
        ));
        assert_eq!(
            ledger.record(&id).unwrap().state(),
            &CommandState::Succeeded { completed_at }
        );
    }

    #[test]
    fn duplicate_receipt_is_unchanged_and_conflicting_mutations_are_rejected() {
        let mut ledger = CommandLedger::default();
        let at = SystemTime::UNIX_EPOCH;
        let id = command_id("command-1");
        ledger.submit(intent("command-1", "key-1", at));
        let attempt = start(&mut ledger, &id, at);
        ledger.succeed(&id, &attempt, at);

        assert_eq!(
            ledger.cancel(&id, None, at),
            TransitionOutcome::Rejected(CommandTransitionError::InvalidTransition)
        );
        assert!(matches!(
            ledger.succeed(&id, &attempt, at),
            TransitionOutcome::Unchanged(CommandRecord { .. })
        ));
    }

    #[test]
    fn unknown_outcome_requires_explicit_replay_and_rejects_stale_attempt_receipts() {
        let mut ledger = CommandLedger::default();
        let at = SystemTime::UNIX_EPOCH;
        let id = command_id("command-1");
        ledger.submit(intent("command-1", "key-1", at));
        let first_attempt = start(&mut ledger, &id, at);

        let observed_at = at + Duration::from_secs(30);
        assert!(matches!(
            ledger.mark_outcome_unknown(&id, &first_attempt, observed_at),
            TransitionOutcome::Transitioned(_)
        ));
        assert_eq!(
            ledger.record(&id).unwrap().state(),
            &CommandState::OutcomeUnknown { observed_at }
        );
        assert!(matches!(
            ledger.start(&id, observed_at),
            StartOutcome::Rejected(CommandTransitionError::InvalidTransition)
        ));

        let replay_at = observed_at + Duration::from_secs(1);
        assert!(matches!(
            ledger.authorize_replay(&id, replay_at),
            TransitionOutcome::Transitioned(_)
        ));
        let second_attempt = start(&mut ledger, &id, replay_at);
        assert_eq!(second_attempt.sequence(), 2);
        assert!(matches!(
            ledger.succeed(&id, &first_attempt, replay_at),
            TransitionOutcome::StaleAttempt(_)
        ));
        assert!(matches!(
            ledger.succeed(&id, &second_attempt, replay_at),
            TransitionOutcome::Transitioned(_)
        ));
    }

    #[test]
    fn late_determinate_receipt_can_resolve_the_same_unknown_attempt() {
        let mut ledger = CommandLedger::default();
        let at = SystemTime::UNIX_EPOCH;
        let id = command_id("command-1");
        ledger.submit(intent("command-1", "key-1", at));
        let attempt = start(&mut ledger, &id, at);
        ledger.mark_outcome_unknown(&id, &attempt, at + Duration::from_secs(30));

        assert!(matches!(
            ledger.succeed(&id, &attempt, at + Duration::from_secs(31)),
            TransitionOutcome::Transitioned(_)
        ));
    }

    #[test]
    fn replayed_queued_attempts_allow_only_the_current_rejection_or_unknown_transition() {
        let at = SystemTime::UNIX_EPOCH;
        let id = command_id("command-1");
        let first_attempt = CommandAttempt::try_new(1).unwrap();
        let second_attempt = CommandAttempt::try_new(2).unwrap();

        let mut rejection = CommandLedger::default();
        rejection.submit(intent("command-1", "key-1", at));
        let started = start(&mut rejection, &id, at);
        assert!(matches!(
            rejection.mark_outcome_unknown(&id, &started, at),
            TransitionOutcome::Transitioned(_)
        ));
        assert!(matches!(
            rejection.authorize_replay(&id, at),
            TransitionOutcome::Transitioned(_)
        ));
        assert!(matches!(
            rejection.fail(&id, &first_attempt, CommandFailure::Rejected, at),
            TransitionOutcome::StaleAttempt(_)
        ));
        assert!(matches!(
            rejection.fail(&id, &second_attempt, CommandFailure::Rejected, at),
            TransitionOutcome::Transitioned(_)
        ));

        let mut unknown = CommandLedger::default();
        unknown.submit(intent("command-1", "key-1", at));
        let started = start(&mut unknown, &id, at);
        assert!(matches!(
            unknown.mark_outcome_unknown(&id, &started, at),
            TransitionOutcome::Transitioned(_)
        ));
        assert!(matches!(
            unknown.authorize_replay(&id, at),
            TransitionOutcome::Transitioned(_)
        ));
        assert!(matches!(
            unknown.mark_outcome_unknown(&id, &first_attempt, at),
            TransitionOutcome::StaleAttempt(_)
        ));
        assert!(matches!(
            unknown.mark_outcome_unknown(&id, &second_attempt, at),
            TransitionOutcome::Transitioned(_)
        ));
    }

    #[test]
    fn cancellation_and_timeout_apply_only_while_active() {
        let mut ledger = CommandLedger::default();
        let at = SystemTime::UNIX_EPOCH;
        let queued = command_id("queued");
        let running = command_id("running");
        ledger.submit(intent("queued", "key-1", at));
        ledger.submit(intent("running", "key-2", at));
        start(&mut ledger, &running, at);

        assert!(matches!(
            ledger.cancel(&queued, Some(CommandCancellation::Requested), at),
            TransitionOutcome::Transitioned(_)
        ));
        assert!(matches!(
            ledger.reap_timeouts(at + Duration::from_secs(30), Duration::from_secs(30)),
            timed_out if timed_out.len() == 1
        ));
        assert!(matches!(
            ledger.start(&queued, at),
            StartOutcome::Rejected(CommandTransitionError::InvalidTransition)
        ));
    }

    #[test]
    fn timeout_reaping_preserves_the_delivery_boundary() {
        let mut ledger = CommandLedger::default();
        let queued_at = SystemTime::UNIX_EPOCH;
        let queued = command_id("queued");
        let running = command_id("running");
        ledger.submit(intent("queued", "key-1", queued_at));
        ledger.submit(intent("running", "key-2", queued_at));
        start(&mut ledger, &running, queued_at + Duration::from_secs(10));

        assert!(
            ledger
                .reap_timeouts(queued_at + Duration::from_secs(29), Duration::from_secs(30))
                .is_empty()
        );
        let timed_out =
            ledger.reap_timeouts(queued_at + Duration::from_secs(40), Duration::from_secs(30));
        assert_eq!(timed_out.len(), 2);
        assert_eq!(
            ledger.record(&queued).unwrap().state(),
            &CommandState::TimedOut {
                completed_at: queued_at + Duration::from_secs(40),
                timeout: Duration::from_secs(30),
            }
        );
        assert_eq!(
            ledger.record(&running).unwrap().state(),
            &CommandState::OutcomeUnknown {
                observed_at: queued_at + Duration::from_secs(40),
            }
        );
    }

    #[test]
    fn restore_rejects_duplicate_durable_identities() {
        let at = SystemTime::UNIX_EPOCH;
        let first = CommandRecord::queued(intent("command-1", "key-1", at));
        let duplicate_key = CommandRecord::queued(intent("command-2", "key-1", at));

        assert_eq!(
            CommandLedger::restore([first, duplicate_key]),
            Err(RestoreLedgerError::DuplicateIdempotencyKey(key("key-1")))
        );
    }

    #[test]
    fn restore_rejects_state_that_predates_its_intent() {
        let queued_at = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
        assert_eq!(
            CommandRecord::restore(
                intent("command-1", "key-1", queued_at),
                CommandState::Succeeded {
                    completed_at: SystemTime::UNIX_EPOCH
                },
                None,
                None,
                SystemTime::UNIX_EPOCH,
            ),
            Err(RestoreCommandError::UpdatedBeforeQueued)
        );
    }

    #[test]
    fn restore_requires_attempts_for_started_or_executed_commands() {
        let queued_at = SystemTime::UNIX_EPOCH;
        let command = intent("command-1", "key-1", queued_at);
        let cases = [
            (
                CommandState::Running {
                    started_at: queued_at,
                },
                None,
            ),
            (
                CommandState::Succeeded {
                    completed_at: queued_at,
                },
                None,
            ),
            (
                CommandState::Failed {
                    completed_at: queued_at,
                    failure: CommandFailure::Rejected,
                },
                Some(CommandFailure::Rejected),
            ),
            (
                CommandState::OutcomeUnknown {
                    observed_at: queued_at,
                },
                None,
            ),
        ];

        for (state, last_failure) in cases {
            assert_eq!(
                CommandRecord::restore(command.clone(), state, None, last_failure, queued_at),
                Err(RestoreCommandError::MissingAttempt)
            );
        }

        assert!(
            CommandRecord::restore(
                command,
                CommandState::OutcomeUnknown {
                    observed_at: queued_at,
                },
                Some(CommandAttempt::try_new(1).unwrap()),
                None,
                queued_at,
            )
            .is_ok()
        );
    }

    #[test]
    fn restore_requires_the_persisted_state_and_failure_to_be_self_consistent() {
        let queued_at = SystemTime::UNIX_EPOCH;
        let completed_at = queued_at + Duration::from_secs(1);
        let command = intent("command-1", "key-1", queued_at);

        assert_eq!(
            CommandRecord::restore(
                command.clone(),
                CommandState::Succeeded { completed_at },
                None,
                None,
                queued_at,
            ),
            Err(RestoreCommandError::StateUpdatedMismatch)
        );
        assert_eq!(
            CommandRecord::restore(
                command.clone(),
                CommandState::Failed {
                    completed_at,
                    failure: CommandFailure::Rejected,
                },
                Some(CommandAttempt::try_new(1).unwrap()),
                Some(CommandFailure::Unavailable),
                completed_at,
            ),
            Err(RestoreCommandError::FailureMismatch)
        );
        assert_eq!(
            CommandRecord::restore(
                command,
                CommandState::Succeeded { completed_at },
                Some(CommandAttempt::try_new(1).unwrap()),
                Some(CommandFailure::ExecutionFailed),
                completed_at,
            ),
            Err(RestoreCommandError::UnexpectedFailure)
        );
    }

    #[test]
    fn restored_unknown_command_fences_late_receipts_after_replay() {
        let at = SystemTime::UNIX_EPOCH;
        let command = CommandRecord::restore(
            intent("command-1", "key-1", at),
            CommandState::OutcomeUnknown { observed_at: at },
            Some(CommandAttempt::try_new(1).unwrap()),
            None,
            at,
        )
        .unwrap();
        let mut ledger = CommandLedger::restore([command]).unwrap();
        let id = command_id("command-1");
        let first_attempt = CommandAttempt::try_new(1).unwrap();

        assert!(matches!(
            ledger.authorize_replay(&id, at),
            TransitionOutcome::Transitioned(_)
        ));
        let second_attempt = start(&mut ledger, &id, at);
        assert_eq!(second_attempt.sequence(), 2);
        assert!(matches!(
            ledger.fail(&id, &first_attempt, CommandFailure::ExecutionFailed, at),
            TransitionOutcome::StaleAttempt(_)
        ));
        assert!(matches!(
            ledger.fail(&id, &second_attempt, CommandFailure::ExecutionFailed, at,),
            TransitionOutcome::Transitioned(_)
        ));
    }

    #[test]
    fn replay_fails_closed_when_the_attempt_sequence_is_exhausted() {
        let at = SystemTime::UNIX_EPOCH;
        let command = CommandRecord::restore(
            intent("command-1", "key-1", at),
            CommandState::OutcomeUnknown { observed_at: at },
            Some(CommandAttempt::try_new(u64::MAX).unwrap()),
            None,
            at,
        )
        .unwrap();
        let mut ledger = CommandLedger::restore([command]).unwrap();
        let id = command_id("command-1");

        assert_eq!(
            ledger.authorize_replay(&id, at),
            TransitionOutcome::Rejected(CommandTransitionError::AttemptOverflow)
        );
    }

    #[test]
    fn transitions_reject_time_travel() {
        let mut ledger = CommandLedger::default();
        let queued_at = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
        let id = command_id("command-1");
        ledger.submit(intent("command-1", "key-1", queued_at));

        assert_eq!(
            ledger.start(&id, SystemTime::UNIX_EPOCH),
            StartOutcome::Rejected(CommandTransitionError::BackdatedTransition)
        );
    }
}
