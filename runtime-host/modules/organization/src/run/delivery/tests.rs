use std::num::NonZeroU32;

use super::{
    AuthorizedGraphOutcome, AuthorizedGraphResolution, AuthorizedGraphResolutionError,
    AuthorizedGraphResolutionOutcome, AuthorizedGraphResolutionReceipt, Delivery, DeliveryClaim,
    DeliveryClaimSnapshot, DeliveryDispatch, DeliveryFailure, DeliveryId, DeliveryIdError,
    DeliveryLedger, DeliveryLedgerSnapshot, DeliveryPhase, DeliveryPhaseSnapshot, DeliveryReceipt,
    DeliveryReceiptError, DeliveryRecovery, DeliveryRequest, DeliveryRequestError,
    DeliveryResolution, DeliverySnapshot, DeliveryStart, NativeDeliveryCorrelation,
    NativeRunReceiptReference, NativeTerminalStatus, RegisterDeliveryError, RegisterOutcome,
    RestoreDeliveryError, RestoreLedgerError, TerminalObservationError, TerminalObservationOutcome,
    TerminalObservationResolution, TerminalObservationSnapshot, TerminalObservationSnapshotInput,
    begin_delivery, observe_native_terminal, recover_interrupted_delivery, register_delivery,
    resolve_authorized_graph_outcome, settle_delivery,
};
use crate::ports::{DeliveryReceiptReference, EndpointSessionId};
use crate::{
    AttemptStatus, EdgeAction, EdgeDefinition, GraphDefinition, GraphEvent, GraphRunId, GraphState,
    GraphStatus, NodeDefinition, NodeId, project, reduce,
};

fn request(delivery_id: &str, max_attempts: u32) -> DeliveryRequest {
    DeliveryRequest {
        delivery_id: DeliveryId::new(delivery_id).unwrap(),
        team_id: "team-01".to_owned(),
        run_id: "run-01".to_owned(),
        node_id: "node-review".to_owned(),
        node_execution_id: "node-review:attempt:1".to_owned(),
        task_id: "task-release".to_owned(),
        role_id: "role-lead".to_owned(),
        session_ref: crate::ROLE_SESSION_REF_INITIAL.to_owned(),
        idempotency_key: "team-run:run-01:node-review:attempt:1".to_owned(),
        message: "private prompt".to_owned(),
        requested_at: 1_000,
        max_attempts,
    }
}

fn claim(delivery: &mut Delivery, now: u64) -> DeliveryClaim {
    match begin_delivery(delivery, now) {
        DeliveryStart::Claimed(claim) => claim,
        other => panic!("expected a claim, got {other:?}"),
    }
}

fn running_graph() -> GraphState {
    let node_id = NodeId::new("node-review");
    let definition = GraphDefinition::new(
        "graph-01",
        "plan-01",
        GraphRunId::new("run-01"),
        "review graph",
        vec![NodeDefinition::work(
            node_id.clone(),
            "review",
            NonZeroU32::new(2).unwrap(),
            crate::WorkAssignment::new("task-release", "role-lead"),
        )],
        Vec::new(),
    )
    .unwrap();
    let graph = GraphState::initialize(definition, 1_000);
    let fence = graph.current_attempt(&node_id).unwrap().fence().clone();
    reduce(
        graph,
        GraphEvent::AttemptStarted {
            node_id,
            fence,
            started_at: 1_001,
        },
    )
    .unwrap()
}

fn graph_with_edge() -> GraphState {
    let source = NodeId::new("node-review");
    let target = NodeId::new("node-end");
    let definition = GraphDefinition::new(
        "graph-01",
        "plan-01",
        GraphRunId::new("run-01"),
        "review graph",
        vec![
            NodeDefinition::work(
                source.clone(),
                "review",
                NonZeroU32::new(2).unwrap(),
                crate::WorkAssignment::new("task-release", "role-lead"),
            ),
            NodeDefinition::control(
                target.clone(),
                crate::NodeKind::End,
                "end",
                NonZeroU32::new(1).unwrap(),
            ),
        ],
        vec![EdgeDefinition::new(
            crate::EdgeId::new("edge-review-end"),
            source.clone(),
            "completed",
            target,
            "done",
            EdgeAction::Finish,
        )],
    )
    .unwrap();
    let graph = GraphState::initialize(definition, 1_000);
    let fence = graph.current_attempt(&source).unwrap().fence().clone();
    reduce(
        graph,
        GraphEvent::AttemptStarted {
            node_id: source,
            fence,
            started_at: 1_001,
        },
    )
    .unwrap()
}

fn matcha_delivery_correlation() -> NativeDeliveryCorrelation {
    NativeDeliveryCorrelation::new(matcha_session(), matcha_native_run())
}

fn delivered_delivery() -> Delivery {
    let mut delivery = Delivery::request(request("delivery-01", 2)).unwrap();
    let active_claim = claim(&mut delivery, 1_000);
    settle_delivery(
        &mut delivery,
        &active_claim,
        DeliveryReceipt::Accepted {
            receipt: DeliveryReceiptReference::try_new("delivery-receipt-01").unwrap(),
            native_correlation: Some(matcha_delivery_correlation()),
            accepted_at: 1_002,
        },
        2_000,
    )
    .unwrap();
    delivery
}

fn matcha_session() -> EndpointSessionId {
    EndpointSessionId::try_new("matcha-session-correlation-canary").unwrap()
}

fn matcha_native_run() -> NativeRunReceiptReference {
    NativeRunReceiptReference::try_new("matcha-native-run-correlation-canary").unwrap()
}

#[test]
fn delivery_identity_and_request_facts_reject_blank_values_without_echoing_them() {
    assert_eq!(DeliveryId::new(" \t "), Err(DeliveryIdError::Blank));

    let mut invalid = request("delivery-01", 1);
    invalid.role_id = "\n".to_owned();

    assert_eq!(
        Delivery::request(invalid),
        Err(DeliveryRequestError::BlankRoleId),
    );
}

#[test]
fn invalid_delivery_request_is_rejected_without_creating_a_record() {
    let mut invalid = request("delivery-01", 2);
    invalid.idempotency_key = " ".to_owned();
    let mut deliveries = Vec::new();

    assert_eq!(
        register_delivery(&mut deliveries, invalid),
        Err(RegisterDeliveryError::InvalidRequest(
            DeliveryRequestError::BlankIdempotencyKey,
        )),
    );
    assert!(deliveries.is_empty());
}

#[test]
fn duplicate_delivery_request_replays_without_creating_a_second_record() {
    let request = request("delivery-01", 2);
    let mut deliveries = Vec::new();

    assert_eq!(
        register_delivery(&mut deliveries, request.clone()),
        Ok(DeliveryDispatch::Recorded),
    );
    assert_eq!(
        register_delivery(&mut deliveries, request),
        Ok(DeliveryDispatch::Replayed),
    );
    assert_eq!(deliveries.len(), 1);
}

#[test]
fn conflicting_duplicate_delivery_id_is_rejected_without_rewriting_facts() {
    let mut deliveries = vec![Delivery::request(request("delivery-01", 2)).unwrap()];
    let mut conflicting = request("delivery-01", 2);
    conflicting.role_id = "role-reviewer".to_owned();
    conflicting.idempotency_key = "team-run:run-01:node-execution-02".to_owned();

    assert_eq!(
        register_delivery(&mut deliveries, conflicting),
        Err(RegisterDeliveryError::ConflictingDeliveryId {
            delivery_id: DeliveryId::new("delivery-01").unwrap(),
        }),
    );
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].facts().role_id, "role-lead");
}

#[test]
fn idempotency_key_replays_without_creating_a_second_delivery() {
    let mut deliveries = vec![Delivery::request(request("delivery-01", 2)).unwrap()];
    let conflicting = request("delivery-02", 2);

    assert_eq!(
        register_delivery(&mut deliveries, conflicting),
        Ok(DeliveryDispatch::Replayed),
    );
    assert_eq!(deliveries.len(), 1);
}

#[test]
fn ledger_replays_by_idempotency_key_and_rejects_reused_delivery_identity() {
    let first = request("delivery-01", 2);
    let mut ledger = DeliveryLedger::default();

    assert_eq!(
        ledger.register(first.clone()),
        Ok(RegisterOutcome::Recorded(
            Delivery::request(first.clone()).unwrap()
        )),
    );

    let mut replay = first.clone();
    replay.delivery_id = DeliveryId::new("delivery-02").unwrap();
    assert_eq!(
        ledger.register(replay),
        Ok(RegisterOutcome::ConflictingIdempotencyKey),
    );

    let mut conflicting = first;
    conflicting.role_id = "role-reviewer".to_owned();
    assert_eq!(
        ledger.register(conflicting),
        Ok(RegisterOutcome::ConflictingIdempotencyKey),
    );
    assert_eq!(ledger.deliveries().count(), 1);
}

#[test]
fn delivery_snapshot_round_trips_multiple_retries_and_fences_stale_receipts() {
    let mut delivery = Delivery::request(request("delivery-01", 3)).unwrap();
    let first = claim(&mut delivery, 1_000);
    settle_delivery(
        &mut delivery,
        &first,
        DeliveryReceipt::Rejected {
            failure: DeliveryFailure::Unavailable,
            observed_at: 1_001,
        },
        2_000,
    )
    .unwrap();
    let second = claim(&mut delivery, 31_001);
    settle_delivery(
        &mut delivery,
        &second,
        DeliveryReceipt::Rejected {
            failure: DeliveryFailure::TimedOut,
            observed_at: 2_001,
        },
        3_000,
    )
    .unwrap();

    let snapshot = delivery.snapshot();
    let mut restored = Delivery::restore(snapshot.clone()).unwrap();
    assert_eq!(restored.snapshot(), snapshot);

    let third = claim(&mut restored, 32_001);
    assert_eq!(third.attempt(), 3);
    assert_eq!(third.generation(), 3);
    assert_eq!(
        settle_delivery(
            &mut restored,
            &second,
            DeliveryReceipt::OutcomeUnknown { observed_at: 3_001 },
            4_000,
        ),
        Err(DeliveryReceiptError::StaleClaim {
            delivery_id: DeliveryId::new("delivery-01").unwrap(),
        }),
    );
}

#[test]
fn ledger_snapshot_restore_rejects_duplicate_idempotency_key() {
    let first = Delivery::request(request("delivery-01", 2)).unwrap();
    let mut duplicate = request("delivery-02", 2);
    duplicate.idempotency_key = first.facts().idempotency_key.clone();

    assert_eq!(
        DeliveryLedger::restore(DeliveryLedgerSnapshot::new(vec![
            first.snapshot(),
            Delivery::request(duplicate).unwrap().snapshot(),
        ])),
        Err(RestoreLedgerError::DuplicateIdempotencyKey(
            "team-run:run-01:node-review:attempt:1".to_owned(),
        )),
    );
}

#[test]
fn ledger_keeps_run_attempt_namespace_from_collapsing_into_delivery_id_replay() {
    let first = request("delivery-01", 2);
    let mut second = request("delivery-02", 2);
    second.run_id = "run-02".to_owned();
    second.node_execution_id = "node-review:attempt:1".to_owned();
    second.idempotency_key = "team-run:run-02:node-review:attempt:1".to_owned();
    let mut ledger = DeliveryLedger::default();

    assert!(matches!(
        ledger.register(first),
        Ok(RegisterOutcome::Recorded(_))
    ));
    assert!(matches!(
        ledger.register(second),
        Ok(RegisterOutcome::Recorded(_))
    ));
    assert_eq!(ledger.deliveries().count(), 2);
}

#[test]
fn ledger_snapshot_restore_rejects_duplicate_delivery_id() {
    let first = Delivery::request(request("delivery-01", 2)).unwrap();
    let duplicate = Delivery::request(request("delivery-01", 2)).unwrap();

    assert_eq!(
        DeliveryLedger::restore(DeliveryLedgerSnapshot::new(vec![
            first.snapshot(),
            duplicate.snapshot(),
        ])),
        Err(RestoreLedgerError::DuplicateDeliveryId(
            DeliveryId::new("delivery-01").unwrap(),
        )),
    );
}

#[test]
fn restore_rejects_exhausted_retry_and_invalid_generation() {
    let facts = request("delivery-01", 2);
    let exhausted_retry = DeliverySnapshot::new(
        facts.clone(),
        DeliveryPhaseSnapshot::RetryScheduled {
            retry_at: 31_001,
            failure: DeliveryFailure::Unavailable,
        },
        2,
        3,
    );

    assert_eq!(
        Delivery::restore(exhausted_retry),
        Err(RestoreDeliveryError::InvalidCompletedAttempts),
    );
    assert_eq!(
        Delivery::restore(DeliverySnapshot::new(
            facts,
            DeliveryPhaseSnapshot::Pending,
            0,
            u64::MAX,
        )),
        Err(RestoreDeliveryError::InvalidNextClaimGeneration),
    );
}

#[test]
fn restore_rejects_malformed_claim_facts() {
    let facts = request("delivery-01", 3);
    let mismatched_delivery = DeliverySnapshot::new(
        facts.clone(),
        DeliveryPhaseSnapshot::Delivering(DeliveryClaimSnapshot::new(
            DeliveryId::new("delivery-02").unwrap(),
            1,
            1,
            1_000,
        )),
        0,
        2,
    );
    let mismatched_attempt = DeliverySnapshot::new(
        facts,
        DeliveryPhaseSnapshot::Delivering(DeliveryClaimSnapshot::new(
            DeliveryId::new("delivery-01").unwrap(),
            2,
            1,
            1_000,
        )),
        0,
        2,
    );

    assert_eq!(
        Delivery::restore(mismatched_delivery),
        Err(RestoreDeliveryError::DeliveringClaimDeliveryMismatch),
    );
    assert_eq!(
        Delivery::restore(mismatched_attempt),
        Err(RestoreDeliveryError::DeliveringClaimAttemptMismatch),
    );
}

#[test]
fn restored_interrupted_claim_becomes_outcome_unknown_without_replaying() {
    let mut original = Delivery::request(request("delivery-01", 2)).unwrap();
    let active_claim = claim(&mut original, 1_000);
    let mut restored = Delivery::restore(original.snapshot()).unwrap();

    assert_eq!(
        recover_interrupted_delivery(&mut restored, 2_000),
        DeliveryRecovery::OutcomeUnknown
    );
    assert_eq!(
        begin_delivery(&mut restored, 2_001),
        DeliveryStart::Terminal(DeliveryPhase::OutcomeUnknown { observed_at: 2_000 }),
    );
    assert_eq!(
        settle_delivery(
            &mut restored,
            &active_claim,
            DeliveryReceipt::OutcomeUnknown { observed_at: 2_002 },
            3_000,
        ),
        Err(DeliveryReceiptError::NotDelivering {
            phase: DeliveryPhase::OutcomeUnknown { observed_at: 2_000 },
        }),
    );
}

#[test]
fn rejected_delivery_retries_once_then_fails_when_its_attempt_budget_is_exhausted() {
    let mut delivery = Delivery::request(request("delivery-01", 2)).unwrap();
    let first = claim(&mut delivery, 1_000);

    assert_eq!(
        settle_delivery(
            &mut delivery,
            &first,
            DeliveryReceipt::Rejected {
                failure: DeliveryFailure::Unavailable,
                observed_at: 1_001,
            },
            2_000,
        ),
        Ok(DeliveryResolution::RetryScheduled { retry_at: 31_001 }),
    );
    assert_eq!(
        begin_delivery(&mut delivery, 31_000),
        DeliveryStart::AwaitingRetry { retry_at: 31_001 },
    );

    let second = claim(&mut delivery, 31_001);
    assert_eq!(second.attempt(), 2);
    assert_eq!(
        settle_delivery(
            &mut delivery,
            &second,
            DeliveryReceipt::Rejected {
                failure: DeliveryFailure::TimedOut,
                observed_at: 2_001,
            },
            3_000,
        ),
        Ok(DeliveryResolution::Failed),
    );
    assert_eq!(
        delivery.phase(),
        &DeliveryPhase::Failed {
            failed_at: 2_001,
            failure: DeliveryFailure::TimedOut,
        },
    );
}

#[test]
fn policy_rejection_is_terminal_without_spending_the_remaining_retry_budget() {
    let mut delivery = Delivery::request(request("delivery-01", 3)).unwrap();
    let active_claim = claim(&mut delivery, 1_000);

    assert_eq!(
        settle_delivery(
            &mut delivery,
            &active_claim,
            DeliveryReceipt::Rejected {
                failure: DeliveryFailure::PolicyRejected,
                observed_at: 1_001,
            },
            2_000,
        ),
        Ok(DeliveryResolution::Failed),
    );
    assert_eq!(
        delivery.phase(),
        &DeliveryPhase::Failed {
            failed_at: 1_001,
            failure: DeliveryFailure::PolicyRejected,
        },
    );
}

#[test]
fn explicit_outcome_unknown_is_terminal_and_never_becomes_an_automatic_retry() {
    let mut delivery = Delivery::request(request("delivery-01", 2)).unwrap();
    let active_claim = claim(&mut delivery, 1_000);

    assert_eq!(
        settle_delivery(
            &mut delivery,
            &active_claim,
            DeliveryReceipt::OutcomeUnknown { observed_at: 1_001 },
            2_000,
        ),
        Ok(DeliveryResolution::OutcomeUnknown),
    );
    assert_eq!(
        begin_delivery(&mut delivery, 2_000),
        DeliveryStart::Terminal(DeliveryPhase::OutcomeUnknown { observed_at: 1_001 }),
    );
    assert_eq!(
        recover_interrupted_delivery(&mut delivery, 3_000),
        DeliveryRecovery::Unchanged {
            phase: DeliveryPhase::OutcomeUnknown { observed_at: 1_001 },
        },
    );
}

#[test]
fn interrupted_claim_becomes_outcome_unknown_without_an_automatic_replay() {
    let mut delivery = Delivery::request(request("delivery-01", 2)).unwrap();
    let active_claim = claim(&mut delivery, 1_000);

    assert_eq!(
        recover_interrupted_delivery(&mut delivery, 2_000),
        DeliveryRecovery::OutcomeUnknown,
    );
    assert_eq!(
        delivery.phase(),
        &DeliveryPhase::OutcomeUnknown { observed_at: 2_000 },
    );
    assert_eq!(
        settle_delivery(
            &mut delivery,
            &active_claim,
            DeliveryReceipt::Accepted {
                receipt: DeliveryReceiptReference::try_new("receipt-01").unwrap(),
                native_correlation: None,
                accepted_at: 2_001
            },
            3_000,
        ),
        Err(DeliveryReceiptError::NotDelivering {
            phase: DeliveryPhase::OutcomeUnknown { observed_at: 2_000 },
        }),
    );
}

#[test]
fn stale_receipt_cannot_resolve_a_later_retry_claim() {
    let mut delivery = Delivery::request(request("delivery-01", 2)).unwrap();
    let first = claim(&mut delivery, 1_000);
    settle_delivery(
        &mut delivery,
        &first,
        DeliveryReceipt::Rejected {
            failure: DeliveryFailure::ReceiverRejected,
            observed_at: 1_001,
        },
        2_000,
    )
    .unwrap();

    let retry = claim(&mut delivery, 31_001);
    assert_eq!(retry.attempt(), 2);
    assert_ne!(retry.generation(), first.generation());
    assert_eq!(retry.claimed_at(), 31_001);
    assert_eq!(retry.delivery_id().as_str(), "delivery-01");
    assert_eq!(
        settle_delivery(
            &mut delivery,
            &first,
            DeliveryReceipt::Accepted {
                receipt: DeliveryReceiptReference::try_new("receipt-01").unwrap(),
                native_correlation: None,
                accepted_at: 2_001
            },
            3_000,
        ),
        Err(DeliveryReceiptError::StaleClaim {
            delivery_id: DeliveryId::new("delivery-01").unwrap(),
        }),
    );
}

#[test]
fn generic_delivered_receipt_cannot_record_a_matcha_terminal_observation() {
    let mut delivery = Delivery::request(request("delivery-01", 2)).unwrap();
    let active_claim = claim(&mut delivery, 1_000);
    settle_delivery(
        &mut delivery,
        &active_claim,
        DeliveryReceipt::Accepted {
            receipt: DeliveryReceiptReference::try_new("generic-delivery-receipt").unwrap(),
            native_correlation: None,
            accepted_at: 1_002,
        },
        2_000,
    )
    .unwrap();
    let original_delivery = delivery.clone();
    let mut graph = running_graph();
    let original_graph = graph.clone();

    assert_eq!(
        observe_native_terminal(
            &mut delivery,
            &mut graph,
            matcha_session(),
            matcha_native_run(),
            NativeTerminalStatus::Completed,
            1_010,
        ),
        Err(TerminalObservationError::DeliveryNotAccepted),
    );
    assert_eq!(delivery, original_delivery);
    assert_eq!(graph, original_graph);
}

#[test]
fn terminal_observation_uses_correlation_even_when_delivery_and_native_receipts_differ() {
    let mut delivery = delivered_delivery();
    let mut graph = running_graph();

    assert_eq!(
        observe_native_terminal(
            &mut delivery,
            &mut graph,
            matcha_session(),
            matcha_native_run(),
            NativeTerminalStatus::Completed,
            1_010,
        ),
        Ok(TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution),
    );
    let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
        panic!("terminal observation should be recorded");
    };
    assert_ne!(
        observation.delivered_receipt().as_str(),
        observation.native_run_receipt().as_str(),
    );
}

#[test]
fn terminal_observation_rejects_session_mismatch_without_mutating_delivery_or_graph() {
    let mut delivery = delivered_delivery();
    let original_delivery = delivery.clone();
    let mut graph = running_graph();
    let original_graph = graph.clone();

    assert_eq!(
        observe_native_terminal(
            &mut delivery,
            &mut graph,
            EndpointSessionId::try_new("other-native-session").unwrap(),
            matcha_native_run(),
            NativeTerminalStatus::Completed,
            1_010,
        ),
        Err(TerminalObservationError::SessionMismatch),
    );
    assert_eq!(delivery, original_delivery);
    assert_eq!(graph, original_graph);
}

#[test]
fn terminal_observation_rejects_stale_fence_without_mutating_delivery_or_graph() {
    let mut delivery = delivered_delivery();
    delivery.facts.node_execution_id = "stale-node-execution".to_owned();
    let original_delivery = delivery.clone();
    let mut graph = running_graph();
    let original_graph = graph.clone();

    assert_eq!(
        observe_native_terminal(
            &mut delivery,
            &mut graph,
            matcha_session(),
            matcha_native_run(),
            NativeTerminalStatus::Completed,
            1_010,
        ),
        Err(TerminalObservationError::StaleFence),
    );
    assert_eq!(delivery, original_delivery);
    assert_eq!(graph, original_graph);
}

#[test]
fn terminal_observation_rejects_a_native_receipt_other_than_its_native_correlation_without_mutation()
 {
    let mut delivery = delivered_delivery();
    let original_delivery = delivery.clone();
    let mut graph = running_graph();
    let original_graph = graph.clone();

    assert_eq!(
        observe_native_terminal(
            &mut delivery,
            &mut graph,
            matcha_session(),
            NativeRunReceiptReference::try_new("other-native-receipt").unwrap(),
            NativeTerminalStatus::Completed,
            1_010,
        ),
        Err(TerminalObservationError::NativeReceiptMismatch),
    );
    assert_eq!(delivery, original_delivery);
    assert_eq!(graph, original_graph);
}

#[test]
fn terminal_observation_replays_identical_record_and_rejects_conflict_without_mutation() {
    let mut delivery = delivered_delivery();
    let mut graph = running_graph();

    assert_eq!(
        observe_native_terminal(
            &mut delivery,
            &mut graph,
            matcha_session(),
            matcha_native_run(),
            NativeTerminalStatus::Completed,
            1_010,
        ),
        Ok(TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution),
    );
    let observed_delivery = delivery.clone();

    assert_eq!(
        observe_native_terminal(
            &mut delivery,
            &mut graph,
            matcha_session(),
            matcha_native_run(),
            NativeTerminalStatus::Completed,
            1_010,
        ),
        Ok(TerminalObservationOutcome::Replayed),
    );
    assert_eq!(delivery, observed_delivery);

    assert_eq!(
        observe_native_terminal(
            &mut delivery,
            &mut graph,
            matcha_session(),
            matcha_native_run(),
            NativeTerminalStatus::Failed,
            1_010,
        ),
        Err(TerminalObservationError::ConflictingObservation),
    );
    assert_eq!(delivery, observed_delivery);
}

#[test]
fn completed_failed_and_interrupted_observations_wait_for_authorized_graph_resolution() {
    for native_terminal in [
        NativeTerminalStatus::Completed,
        NativeTerminalStatus::Failed,
        NativeTerminalStatus::Interrupted,
    ] {
        let mut delivery = delivered_delivery();
        let mut graph = running_graph();

        assert_eq!(
            observe_native_terminal(
                &mut delivery,
                &mut graph,
                matcha_session(),
                matcha_native_run(),
                native_terminal,
                1_010,
            ),
            Ok(TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution),
        );

        let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
            panic!("terminal observation should be recorded");
        };
        assert_eq!(observation.native_terminal(), native_terminal);
        assert_eq!(
            observation.resolution(),
            &TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
        );
        let projection = project(&graph);
        assert_eq!(projection.status, GraphStatus::Waiting);
        assert_eq!(projection.nodes[0].current.status, AttemptStatus::Waiting);
        assert_eq!(projection.nodes[0].current.output_port, None);
    }
}

#[test]
fn authorized_graph_resolution_routes_only_an_explicit_fenced_output_receipt() {
    let mut delivery = delivered_delivery();
    let mut graph = graph_with_edge();
    observe_native_terminal(
        &mut delivery,
        &mut graph,
        matcha_session(),
        matcha_native_run(),
        NativeTerminalStatus::Completed,
        1_010,
    )
    .unwrap();
    let fence = graph
        .current_attempt(&NodeId::new("node-review"))
        .unwrap()
        .fence()
        .clone();
    let resolution = AuthorizedGraphResolution::new(
        AuthorizedGraphResolutionReceipt::try_new("executor-output:one").unwrap(),
        delivery.facts().delivery_id.clone(),
        "run-01",
        fence,
        AuthorizedGraphOutcome::Completed,
        "completed",
        1_011,
    )
    .unwrap();

    assert_eq!(
        resolve_authorized_graph_outcome(&mut delivery, &mut graph, resolution.clone()),
        Ok(AuthorizedGraphResolutionOutcome::Recorded),
    );
    assert_eq!(
        resolve_authorized_graph_outcome(&mut delivery, &mut graph, resolution),
        Ok(AuthorizedGraphResolutionOutcome::Replayed),
    );
    let projection = project(&graph);
    assert_eq!(projection.nodes[0].current.status, AttemptStatus::Completed);
    assert_eq!(
        projection.nodes[0].current.output_port.as_deref(),
        Some("completed")
    );
    assert_eq!(projection.nodes[1].current.status, AttemptStatus::Ready);
}

#[test]
fn authorized_graph_resolution_rejects_cancelled_and_conflicting_or_stale_receipts() {
    let mut cancelled_delivery = delivered_delivery();
    let mut cancelled_graph = running_graph();
    observe_native_terminal(
        &mut cancelled_delivery,
        &mut cancelled_graph,
        matcha_session(),
        matcha_native_run(),
        NativeTerminalStatus::Cancelled,
        1_010,
    )
    .unwrap();
    let fence = cancelled_graph
        .current_attempt(&NodeId::new("node-review"))
        .unwrap()
        .fence()
        .clone();
    let rejected = AuthorizedGraphResolution::new(
        AuthorizedGraphResolutionReceipt::try_new("executor-output:cancelled").unwrap(),
        cancelled_delivery.facts().delivery_id.clone(),
        "run-01",
        fence,
        AuthorizedGraphOutcome::Completed,
        "completed",
        1_011,
    )
    .unwrap();
    let cancelled_before = cancelled_delivery.clone();
    let cancelled_graph_before = cancelled_graph.clone();
    assert_eq!(
        resolve_authorized_graph_outcome(&mut cancelled_delivery, &mut cancelled_graph, rejected),
        Err(AuthorizedGraphResolutionError::DeliveryNotAwaitingAuthorizedResolution),
    );
    assert_eq!(cancelled_delivery, cancelled_before);
    assert_eq!(cancelled_graph, cancelled_graph_before);

    let mut mismatched_delivery = delivered_delivery();
    let mut mismatched_graph = running_graph();
    observe_native_terminal(
        &mut mismatched_delivery,
        &mut mismatched_graph,
        matcha_session(),
        matcha_native_run(),
        NativeTerminalStatus::Completed,
        1_010,
    )
    .unwrap();
    let mismatched_fence = mismatched_graph
        .current_attempt(&NodeId::new("node-review"))
        .unwrap()
        .fence()
        .clone();
    let mismatched = AuthorizedGraphResolution::new(
        AuthorizedGraphResolutionReceipt::try_new("executor-output:mismatch").unwrap(),
        DeliveryId::new("delivery-other").unwrap(),
        "run-01",
        mismatched_fence,
        AuthorizedGraphOutcome::Completed,
        "completed",
        1_011,
    )
    .unwrap();
    let mismatched_delivery_before = mismatched_delivery.clone();
    let mismatched_graph_before = mismatched_graph.clone();
    assert_eq!(
        resolve_authorized_graph_outcome(
            &mut mismatched_delivery,
            &mut mismatched_graph,
            mismatched
        ),
        Err(AuthorizedGraphResolutionError::DeliveryMismatch),
    );
    assert_eq!(mismatched_delivery, mismatched_delivery_before);
    assert_eq!(mismatched_graph, mismatched_graph_before);

    let mut unmatched_delivery = delivered_delivery();
    let mut unmatched_graph = graph_with_edge();
    observe_native_terminal(
        &mut unmatched_delivery,
        &mut unmatched_graph,
        matcha_session(),
        matcha_native_run(),
        NativeTerminalStatus::Completed,
        1_010,
    )
    .unwrap();
    let unmatched_fence = unmatched_graph
        .current_attempt(&NodeId::new("node-review"))
        .unwrap()
        .fence()
        .clone();
    let unmatched = AuthorizedGraphResolution::new(
        AuthorizedGraphResolutionReceipt::try_new("executor-output:unmatched").unwrap(),
        unmatched_delivery.facts().delivery_id.clone(),
        "run-01",
        unmatched_fence,
        AuthorizedGraphOutcome::Completed,
        "unmatched",
        1_011,
    )
    .unwrap();
    let unmatched_delivery_before = unmatched_delivery.clone();
    let unmatched_graph_before = unmatched_graph.clone();
    assert_eq!(
        resolve_authorized_graph_outcome(&mut unmatched_delivery, &mut unmatched_graph, unmatched),
        Err(AuthorizedGraphResolutionError::OutputPortDoesNotMatchEdge),
    );
    assert_eq!(unmatched_delivery, unmatched_delivery_before);
    assert_eq!(unmatched_graph, unmatched_graph_before);

    let mut delivery = delivered_delivery();
    let mut graph = running_graph();
    observe_native_terminal(
        &mut delivery,
        &mut graph,
        matcha_session(),
        matcha_native_run(),
        NativeTerminalStatus::Completed,
        1_010,
    )
    .unwrap();
    let fence = graph
        .current_attempt(&NodeId::new("node-review"))
        .unwrap()
        .fence()
        .clone();
    let stale = AuthorizedGraphResolution::new(
        AuthorizedGraphResolutionReceipt::try_new("executor-output:stale").unwrap(),
        delivery.facts().delivery_id.clone(),
        "other-run",
        fence,
        AuthorizedGraphOutcome::Completed,
        "completed",
        1_009,
    )
    .unwrap();
    let original_delivery = delivery.clone();
    let original_graph = graph.clone();
    assert_eq!(
        resolve_authorized_graph_outcome(&mut delivery, &mut graph, stale),
        Err(AuthorizedGraphResolutionError::RunMismatch),
    );
    assert_eq!(delivery, original_delivery);
    assert_eq!(graph, original_graph);
}

#[test]
fn cancelled_observation_records_atomically_without_output_or_edge_routing() {
    let mut delivery = delivered_delivery();
    let mut graph = graph_with_edge();

    assert_eq!(
        observe_native_terminal(
            &mut delivery,
            &mut graph,
            matcha_session(),
            matcha_native_run(),
            NativeTerminalStatus::Cancelled,
            1_010,
        ),
        Ok(TerminalObservationOutcome::RecordedNodeCancelled),
    );

    let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
        panic!("terminal observation should be recorded");
    };
    assert_eq!(
        observation.native_terminal(),
        NativeTerminalStatus::Cancelled
    );
    assert_eq!(
        observation.resolution(),
        &TerminalObservationResolution::NodeCancelled
    );
    let projection = project(&graph);
    assert_eq!(projection.status, GraphStatus::Cancelled);
    assert_eq!(projection.ready_node_ids, Vec::<NodeId>::new());
    assert_eq!(projection.nodes[0].current.status, AttemptStatus::Cancelled);
    assert_eq!(projection.nodes[0].current.output_port, None);
    assert_eq!(projection.nodes[1].current.status, AttemptStatus::Pending);
    assert_eq!(projection.edges[0].status, crate::EdgeStatus::Waiting);
}

#[test]
fn terminal_observation_is_not_rewritten_by_interrupted_delivery_recovery() {
    let mut delivery = delivered_delivery();
    let mut graph = running_graph();
    observe_native_terminal(
        &mut delivery,
        &mut graph,
        matcha_session(),
        matcha_native_run(),
        NativeTerminalStatus::Completed,
        1_010,
    )
    .unwrap();
    let observation = delivery.phase().clone();

    assert_eq!(
        recover_interrupted_delivery(&mut delivery, 1_011),
        DeliveryRecovery::Unchanged {
            phase: observation.clone(),
        },
    );
    assert_eq!(delivery.phase(), &observation);
}

#[test]
fn terminal_observation_snapshot_round_trips_distinct_delivery_and_native_receipts() {
    let mut delivery = delivered_delivery();
    let mut graph = running_graph();
    observe_native_terminal(
        &mut delivery,
        &mut graph,
        matcha_session(),
        matcha_native_run(),
        NativeTerminalStatus::Completed,
        1_010,
    )
    .unwrap();
    let snapshot = delivery.snapshot();
    assert_eq!(Delivery::restore(snapshot.clone()), Ok(delivery.clone()));

    let DeliveryPhaseSnapshot::TerminalObserved { observation } = snapshot.phase() else {
        panic!("terminal observation snapshot should be recorded");
    };
    assert_ne!(
        observation.delivered_receipt().as_str(),
        observation.native_run_receipt().as_str(),
    );
}

#[test]
fn restore_rejects_a_terminal_observation_that_contradicts_its_delivery_facts() {
    let mut delivery = delivered_delivery();
    let mut graph = running_graph();
    observe_native_terminal(
        &mut delivery,
        &mut graph,
        matcha_session(),
        matcha_native_run(),
        NativeTerminalStatus::Completed,
        1_010,
    )
    .unwrap();
    let snapshot = delivery.snapshot();
    let DeliveryPhaseSnapshot::TerminalObserved { observation } = snapshot.phase() else {
        panic!("terminal observation snapshot should be recorded");
    };
    let rewrite = |role_id: &str, native_terminal: NativeTerminalStatus| {
        DeliverySnapshot::new(
            snapshot.facts().clone(),
            DeliveryPhaseSnapshot::TerminalObserved {
                observation: TerminalObservationSnapshot::new(TerminalObservationSnapshotInput {
                    delivery_id: observation.delivery_id().clone(),
                    graph_run_id: observation.graph_run_id().to_owned(),
                    node_id: observation.node_id().to_owned(),
                    fence: observation.fence().clone(),
                    role_id: role_id.to_owned(),
                    correlation: observation.correlation().clone(),
                    delivered_receipt: observation.delivered_receipt().clone(),
                    native_terminal,
                    observed_at: observation.observed_at(),
                    output: observation.output().cloned(),
                    resolution: observation.resolution().clone(),
                }),
            },
            snapshot.completed_attempts(),
            snapshot.next_claim_generation(),
        )
    };

    assert_eq!(
        Delivery::restore(rewrite("role-imposter", NativeTerminalStatus::Completed)),
        Err(RestoreDeliveryError::TerminalObservationCorrelationMismatch),
    );
    assert_eq!(
        Delivery::restore(rewrite("role-lead", NativeTerminalStatus::Cancelled)),
        Err(RestoreDeliveryError::TerminalObservationInvalidResolution),
    );
}

#[test]
fn terminal_observation_debug_redacts_sensitive_correlation_fields() {
    let mut delivery = delivered_delivery();
    let mut graph = running_graph();
    observe_native_terminal(
        &mut delivery,
        &mut graph,
        matcha_session(),
        matcha_native_run(),
        NativeTerminalStatus::Interrupted,
        1_010,
    )
    .unwrap();

    let debug = format!("{:?}", delivery.phase());
    for secret in [
        "delivery-01",
        "run-01",
        "node-review",
        "node-review:attempt:1",
        "role-lead",
        "matcha-session-correlation-canary",
        "delivery-receipt-01",
        "matcha-native-run-correlation-canary",
    ] {
        assert!(!debug.contains(secret));
    }
    assert!(debug.contains("Interrupted"));
    assert!(debug.contains("AwaitingAuthorizedGraphResolution"));
}

#[test]
fn cancellation_is_terminal_and_preserves_the_cancellation_fact() {
    let mut delivery = Delivery::request(request("delivery-01", 1)).unwrap();
    delivery.cancel(1_000);

    assert_eq!(
        begin_delivery(&mut delivery, 1_001),
        DeliveryStart::Terminal(DeliveryPhase::Cancelled {
            cancelled_at: 1_000
        }),
    );
    delivery.cancel(1_002);
    assert_eq!(
        delivery.phase(),
        &DeliveryPhase::Cancelled {
            cancelled_at: 1_000
        },
    );
}

#[test]
fn terminal_delivery_rejects_later_receipts_without_rewriting_its_receipt_fact() {
    let mut delivery = Delivery::request(request("delivery-01", 1)).unwrap();
    let active_claim = claim(&mut delivery, 1_000);
    settle_delivery(
        &mut delivery,
        &active_claim,
        DeliveryReceipt::Accepted {
            receipt: DeliveryReceiptReference::try_new("receipt-01").unwrap(),
            native_correlation: None,
            accepted_at: 1_001,
        },
        2_000,
    )
    .unwrap();

    assert_eq!(
        settle_delivery(
            &mut delivery,
            &active_claim,
            DeliveryReceipt::OutcomeUnknown { observed_at: 1_002 },
            2_000,
        ),
        Err(DeliveryReceiptError::NotDelivering {
            phase: DeliveryPhase::Delivered {
                receipt: DeliveryReceiptReference::try_new("receipt-01").unwrap(),
                native_correlation: None,
                accepted_at: 1_001,
            },
        }),
    );
    assert_eq!(
        delivery.phase(),
        &DeliveryPhase::Delivered {
            receipt: DeliveryReceiptReference::try_new("receipt-01").unwrap(),
            native_correlation: None,
            accepted_at: 1_001,
        },
    );
}
