mod identity;
mod record;
mod state;

pub use identity::{DispatchId, InvalidDispatchId};
pub use record::{
    DispatchAttempt, DispatchIntent, DispatchPhase, DispatchReceipt, InvalidDispatchAttempt,
    InvalidOutboxRecordState, OutboxRecord,
};
pub use state::{
    AcknowledgeDeliveryOutcome, BeginDeliveryOutcome, InsertOutcome, Outbox, RecoveryOutcome,
    ReplayOutcome, RestoreError,
};

#[cfg(test)]
mod tests {
    use crate::command::CommandId;
    use platform::endpoint::NativeAgentId;

    use super::*;

    fn dispatch_id(value: &str) -> DispatchId {
        DispatchId::try_new(value).unwrap()
    }

    fn command_id(value: &str) -> CommandId {
        CommandId::try_new(value).unwrap()
    }

    fn intent(dispatch: &str, command: &str) -> DispatchIntent {
        DispatchIntent::new(
            dispatch_id(dispatch),
            command_id(command),
            NativeAgentId::try_new("agent-1").unwrap(),
        )
    }

    #[test]
    fn rejects_blank_command_and_dispatch_identities_without_echoing_them() {
        assert_eq!(
            DispatchId::try_new(" \t").unwrap_err().to_string(),
            "dispatch ID must not be empty"
        );
        assert_eq!(
            CommandId::try_new("\n").unwrap_err().to_string(),
            "command ID must not be empty"
        );
        assert_eq!(
            DispatchAttempt::try_new(0).unwrap_err().to_string(),
            "dispatch attempt sequence must be positive"
        );
    }

    #[test]
    fn records_one_delivery_intent_for_each_command_reference() {
        let mut outbox = Outbox::default();
        assert_eq!(
            outbox.insert(intent("dispatch-1", "command-1")),
            InsertOutcome::Inserted
        );

        assert_eq!(
            outbox.dispatch_id_for_command(&command_id("command-1")),
            Some(&dispatch_id("dispatch-1"))
        );
        assert_eq!(
            outbox.dispatch_id_for_command(&command_id("missing-command")),
            None
        );
        assert_eq!(
            outbox.insert(intent("dispatch-2", "command-1")),
            InsertOutcome::DuplicateCommandId(command_id("command-1"))
        );
        let record = outbox.record(&dispatch_id("dispatch-1")).unwrap();
        assert_eq!(record.intent().dispatch_id(), &dispatch_id("dispatch-1"));
        assert_eq!(record.intent().command_id(), &command_id("command-1"));
        assert_eq!(record.intent().agent_id().as_str(), "agent-1");
        assert!(outbox.record(&dispatch_id("dispatch-2")).is_none());
    }

    #[test]
    fn rejects_a_duplicate_dispatch_identity_with_a_different_command_reference() {
        let mut outbox = Outbox::default();
        assert_eq!(
            outbox.insert(intent("dispatch-1", "command-1")),
            InsertOutcome::Inserted
        );

        assert_eq!(
            outbox.insert(intent("dispatch-1", "command-2")),
            InsertOutcome::DuplicateDispatchId(dispatch_id("dispatch-1"))
        );
    }

    #[test]
    fn requires_a_matching_in_flight_attempt_before_recording_delivery() {
        let mut outbox = Outbox::default();
        outbox.insert(intent("dispatch-1", "command-1"));
        let first_attempt = expect_begun(outbox.begin_delivery(&dispatch_id("dispatch-1")));

        assert_eq!(
            outbox.acknowledge_delivery(
                &dispatch_id("dispatch-1"),
                &DispatchAttempt::try_new(2).unwrap(),
            ),
            AcknowledgeDeliveryOutcome::StaleAttempt
        );
        let receipt = match outbox.acknowledge_delivery(&dispatch_id("dispatch-1"), &first_attempt)
        {
            AcknowledgeDeliveryOutcome::Delivered(receipt) => receipt,
            other => panic!("expected a delivery receipt, received {other:?}"),
        };
        assert_eq!(receipt.dispatch_id(), &dispatch_id("dispatch-1"));
        assert_eq!(receipt.attempt(), &first_attempt);
        assert_eq!(
            outbox.acknowledge_delivery(&dispatch_id("dispatch-1"), &first_attempt),
            AcknowledgeDeliveryOutcome::AlreadyDelivered
        );
        assert_eq!(
            outbox.record(&dispatch_id("dispatch-1")).unwrap().phase(),
            DispatchPhase::Delivered
        );
    }

    #[test]
    fn prevents_a_second_delivery_attempt_while_one_is_in_flight() {
        let mut outbox = Outbox::default();
        outbox.insert(intent("dispatch-1", "command-1"));
        let first_attempt = expect_begun(outbox.begin_delivery(&dispatch_id("dispatch-1")));

        assert_eq!(
            outbox.begin_delivery(&dispatch_id("dispatch-1")),
            BeginDeliveryOutcome::AlreadyInFlight(first_attempt)
        );
    }

    #[test]
    fn retains_unknown_outcome_until_replay_is_explicitly_authorized() {
        let mut outbox = Outbox::default();
        outbox.insert(intent("dispatch-1", "command-1"));
        let first_attempt = expect_begun(outbox.begin_delivery(&dispatch_id("dispatch-1")));

        assert_eq!(
            outbox.recover_interrupted_delivery(&dispatch_id("dispatch-1")),
            RecoveryOutcome::OutcomeUnknown
        );
        assert_eq!(
            outbox.record(&dispatch_id("dispatch-1")).unwrap().phase(),
            DispatchPhase::OutcomeUnknown
        );
        assert_eq!(
            outbox.begin_delivery(&dispatch_id("dispatch-1")),
            BeginDeliveryOutcome::OutcomeUnknown
        );
        assert_eq!(
            outbox.authorize_replay(&dispatch_id("dispatch-1")),
            ReplayOutcome::Authorized
        );

        let replay_attempt = expect_begun(outbox.begin_delivery(&dispatch_id("dispatch-1")));
        assert_eq!(first_attempt.sequence(), 1);
        assert_eq!(replay_attempt.sequence(), 2);
        assert_eq!(
            outbox.acknowledge_delivery(&dispatch_id("dispatch-1"), &first_attempt),
            AcknowledgeDeliveryOutcome::StaleAttempt
        );
        let record = outbox.record(&dispatch_id("dispatch-1")).unwrap();
        assert_eq!(record.intent().command_id(), &command_id("command-1"));
        assert_eq!(record.phase(), DispatchPhase::InFlight);
    }

    #[test]
    fn resolves_an_unknown_outcome_when_the_matching_receipt_arrives_late() {
        let mut outbox = Outbox::default();
        outbox.insert(intent("dispatch-1", "command-1"));
        let attempt = expect_begun(outbox.begin_delivery(&dispatch_id("dispatch-1")));
        assert_eq!(
            outbox.recover_interrupted_delivery(&dispatch_id("dispatch-1")),
            RecoveryOutcome::OutcomeUnknown
        );

        let receipt = match outbox.acknowledge_delivery(&dispatch_id("dispatch-1"), &attempt) {
            AcknowledgeDeliveryOutcome::Delivered(receipt) => receipt,
            other => panic!("expected delayed delivery receipt, received {other:?}"),
        };

        assert_eq!(receipt.attempt(), &attempt);
        assert_eq!(
            outbox.record(&dispatch_id("dispatch-1")).unwrap().phase(),
            DispatchPhase::Delivered
        );
    }

    #[test]
    fn restores_an_unknown_delivery_for_the_matching_late_receipt() {
        let attempt = DispatchAttempt::try_new(4).unwrap();
        let record = OutboxRecord::restore(
            intent("dispatch-1", "command-1"),
            DispatchPhase::InFlight,
            Some(attempt.clone()),
        )
        .unwrap();
        let mut outbox = Outbox::restore([record]).unwrap();

        let receipt = match outbox.acknowledge_delivery(&dispatch_id("dispatch-1"), &attempt) {
            AcknowledgeDeliveryOutcome::Delivered(receipt) => receipt,
            other => panic!("expected a delivery receipt, received {other:?}"),
        };

        assert_eq!(receipt.attempt(), &attempt);
        assert_eq!(
            outbox.record(&dispatch_id("dispatch-1")).unwrap().phase(),
            DispatchPhase::Delivered
        );
    }

    #[test]
    fn restores_an_interrupted_delivery_as_an_unknown_outcome() {
        let record = OutboxRecord::restore(
            intent("dispatch-1", "command-1"),
            DispatchPhase::InFlight,
            Some(DispatchAttempt::try_new(4).unwrap()),
        )
        .unwrap();
        let mut outbox = Outbox::restore([record]).unwrap();

        assert_eq!(
            outbox.record(&dispatch_id("dispatch-1")).unwrap().phase(),
            DispatchPhase::OutcomeUnknown
        );
        assert_eq!(
            outbox.begin_delivery(&dispatch_id("dispatch-1")),
            BeginDeliveryOutcome::OutcomeUnknown
        );
        assert_eq!(
            outbox.authorize_replay(&dispatch_id("dispatch-1")),
            ReplayOutcome::Authorized
        );
        let replay_attempt = expect_begun(outbox.begin_delivery(&dispatch_id("dispatch-1")));

        assert_eq!(replay_attempt.sequence(), 5);
        assert_eq!(
            outbox
                .records()
                .map(|record| record.intent().dispatch_id().as_str())
                .collect::<Vec<_>>(),
            vec!["dispatch-1"]
        );
    }

    #[test]
    fn rejects_invalid_restored_records_and_duplicate_durable_identities() {
        assert_eq!(
            OutboxRecord::restore(
                intent("dispatch-1", "command-1"),
                DispatchPhase::Delivered,
                None
            ),
            Err(InvalidOutboxRecordState)
        );

        let first = OutboxRecord::restore(
            intent("dispatch-1", "command-1"),
            DispatchPhase::Pending,
            None,
        )
        .unwrap();
        let duplicate = OutboxRecord::restore(
            intent("dispatch-2", "command-1"),
            DispatchPhase::Pending,
            None,
        )
        .unwrap();
        assert_eq!(
            Outbox::restore([first, duplicate]),
            Err(RestoreError::DuplicateCommandId(command_id("command-1")))
        );

        let first = OutboxRecord::restore(
            intent("dispatch-1", "command-1"),
            DispatchPhase::Pending,
            None,
        )
        .unwrap();
        let duplicate = OutboxRecord::restore(
            intent("dispatch-1", "command-2"),
            DispatchPhase::Pending,
            None,
        )
        .unwrap();
        assert_eq!(
            Outbox::restore([first, duplicate]),
            Err(RestoreError::DuplicateDispatchId(dispatch_id("dispatch-1")))
        );
    }

    #[test]
    fn exposes_only_pending_records_for_replay_in_stable_order() {
        let mut outbox = Outbox::default();
        outbox.insert(intent("dispatch-2", "command-2"));
        outbox.insert(intent("dispatch-1", "command-1"));
        let first_attempt = expect_begun(outbox.begin_delivery(&dispatch_id("dispatch-1")));
        outbox.acknowledge_delivery(&dispatch_id("dispatch-1"), &first_attempt);

        let pending: Vec<_> = outbox
            .pending()
            .map(|record| record.intent().dispatch_id().as_str())
            .collect();

        assert_eq!(pending, vec!["dispatch-2"]);
    }

    #[test]
    fn keeps_delivered_records_terminal_across_recovery_and_replay() {
        let mut outbox = Outbox::default();
        outbox.insert(intent("dispatch-1", "command-1"));
        let attempt = expect_begun(outbox.begin_delivery(&dispatch_id("dispatch-1")));
        outbox.acknowledge_delivery(&dispatch_id("dispatch-1"), &attempt);

        assert_eq!(
            outbox.recover_interrupted_delivery(&dispatch_id("dispatch-1")),
            RecoveryOutcome::Unchanged
        );
        assert_eq!(
            outbox.authorize_replay(&dispatch_id("dispatch-1")),
            ReplayOutcome::Unchanged
        );
        assert_eq!(
            outbox.begin_delivery(&dispatch_id("dispatch-1")),
            BeginDeliveryOutcome::AlreadyDelivered
        );
    }

    #[test]
    fn distinguishes_a_matching_duplicate_receipt_from_a_stale_receipt_after_delivery() {
        let mut outbox = Outbox::default();
        outbox.insert(intent("dispatch-1", "command-1"));
        let attempt = expect_begun(outbox.begin_delivery(&dispatch_id("dispatch-1")));
        outbox.acknowledge_delivery(&dispatch_id("dispatch-1"), &attempt);

        assert_eq!(
            outbox.acknowledge_delivery(
                &dispatch_id("dispatch-1"),
                &DispatchAttempt::try_new(2).unwrap(),
            ),
            AcknowledgeDeliveryOutcome::StaleAttempt
        );
        assert_eq!(
            outbox.acknowledge_delivery(&dispatch_id("dispatch-1"), &attempt),
            AcknowledgeDeliveryOutcome::AlreadyDelivered
        );
    }

    fn expect_begun(outcome: BeginDeliveryOutcome) -> DispatchAttempt {
        match outcome {
            BeginDeliveryOutcome::Begun(attempt) => attempt,
            other => panic!("expected a begun delivery, received {other:?}"),
        }
    }
}
