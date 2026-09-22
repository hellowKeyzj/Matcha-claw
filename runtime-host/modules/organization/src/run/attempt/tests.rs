use std::num::NonZeroU32;

use crate::run::graph::{
    AttemptId, AttemptStatus, ExecutionFence, GraphDefinition, GraphEvent, GraphRunId, GraphState,
    NodeDefinition, NodeExecutionId, NodeId, reduce,
};

use super::{
    Attempt, AttemptIdentity, AttemptOutcome, AttemptPhase, AttemptReceipt, RecoveryAction,
    RecoveryFault, SettleOutcome, StartOutcome, WaitOutcome, recovery_oracle,
};

fn identity(run: &str, node: &str, number: u32) -> AttemptIdentity {
    let node_id = NodeId::new(node);
    let attempt_id = AttemptId::for_node(&node_id, NonZeroU32::new(number).unwrap());
    let node_execution_id = NodeExecutionId::for_attempt(&attempt_id);
    AttemptIdentity::new(
        GraphRunId::new(run),
        node_id,
        attempt_id.clone(),
        ExecutionFence::new(attempt_id, node_execution_id),
    )
    .unwrap()
}

fn graph(run: &str) -> GraphState {
    GraphState::initialize(
        GraphDefinition::new(
            "graph-01",
            "plan-01",
            GraphRunId::new(run),
            "Review graph",
            vec![NodeDefinition::start(
                NodeId::new("node-review"),
                "Review",
                NonZeroU32::new(2).unwrap(),
                None,
            )],
            Vec::new(),
        )
        .unwrap(),
        1_000,
    )
}

fn current_identity(graph: &GraphState) -> AttemptIdentity {
    let current = graph.current_attempt(&NodeId::new("node-review")).unwrap();
    AttemptIdentity::new(
        graph.definition().run_id().clone(),
        current.node_id().clone(),
        current.fence().attempt_id().clone(),
        current.fence().clone(),
    )
    .unwrap()
}

#[test]
fn preserves_the_graph_identity_for_an_attempt() {
    let identity = identity("run-01", "node-review", 2);

    assert_eq!(identity.run_id().as_str(), "run-01");
    assert_eq!(identity.node_id().as_str(), "node-review");
    assert_eq!(identity.attempt_id().as_str(), "node-review:attempt:2");
    assert_eq!(
        identity.fence().attempt_id().as_str(),
        identity.attempt_id().as_str()
    );
    assert_eq!(
        identity.fence().node_execution_id().as_str(),
        "node-review:attempt:2"
    );
}

#[test]
fn rejects_an_execution_fence_for_a_different_graph_attempt() {
    let node_id = NodeId::new("node-review");
    let first_attempt = AttemptId::for_node(&node_id, NonZeroU32::new(1).unwrap());
    let second_attempt = AttemptId::for_node(&node_id, NonZeroU32::new(2).unwrap());
    let second_execution = NodeExecutionId::for_attempt(&second_attempt);

    assert_eq!(
        AttemptIdentity::new(
            GraphRunId::new("run-01"),
            node_id,
            first_attempt,
            ExecutionFence::new(second_attempt, second_execution),
        )
        .unwrap_err()
        .to_string(),
        "attempt identity must match its execution fence"
    );
}

#[test]
fn begins_only_a_graph_ready_attempt() {
    let mut attempt = Attempt::ready(identity("run-01", "node-review", 1));

    assert_eq!(attempt.start(), StartOutcome::Started);
    assert_eq!(attempt.phase(), AttemptPhase::Graph(AttemptStatus::Running));
    assert_eq!(attempt.start(), StartOutcome::AlreadyRunning);

    assert_eq!(attempt.wait(), WaitOutcome::Waiting);
    assert_eq!(
        attempt.start(),
        StartOutcome::NotReady(AttemptStatus::Waiting)
    );
}

#[test]
fn allows_ready_running_and_waiting_attempts_to_wait() {
    for phase in [
        AttemptPhase::Graph(AttemptStatus::Ready),
        AttemptPhase::Graph(AttemptStatus::Running),
        AttemptPhase::Graph(AttemptStatus::Waiting),
    ] {
        let mut attempt = Attempt::restore(identity("run-01", "node-review", 1), phase);

        assert_eq!(attempt.wait(), WaitOutcome::Waiting);
        assert_eq!(attempt.phase(), AttemptPhase::Graph(AttemptStatus::Waiting));
    }
}

#[test]
fn refuses_to_start_pending_graph_work() {
    let mut attempt =
        Attempt::from_graph(identity("run-01", "node-review", 1), AttemptStatus::Pending);

    assert_eq!(
        attempt.start(),
        StartOutcome::NotReady(AttemptStatus::Pending)
    );
}

#[test]
fn ignores_a_stale_graph_fence_without_mutating_the_current_attempt() {
    let mut attempt = Attempt::ready(identity("run-01", "node-review", 2));
    attempt.start();
    let stale_receipt = AttemptReceipt::new(
        identity("run-01", "node-review", 1),
        AttemptOutcome::Completed,
    );

    assert_eq!(attempt.settle(stale_receipt), SettleOutcome::StaleReceipt);
    assert_eq!(attempt.phase(), AttemptPhase::Graph(AttemptStatus::Running));
}

#[test]
fn settles_matching_receipts_from_every_phase_that_can_still_observe_an_outcome() {
    for (phase, outcome, expected_status) in [
        (
            AttemptPhase::Graph(AttemptStatus::Ready),
            AttemptOutcome::Completed,
            AttemptStatus::Completed,
        ),
        (
            AttemptPhase::Graph(AttemptStatus::Running),
            AttemptOutcome::Failed,
            AttemptStatus::Failed,
        ),
        (
            AttemptPhase::Graph(AttemptStatus::Waiting),
            AttemptOutcome::Cancelled,
            AttemptStatus::Cancelled,
        ),
        (
            AttemptPhase::OutcomeUnknown,
            AttemptOutcome::Completed,
            AttemptStatus::Completed,
        ),
    ] {
        let mut attempt = Attempt::restore(identity("run-01", "node-review", 1), phase);
        let receipt = AttemptReceipt::new(attempt.identity().clone(), outcome);

        assert_eq!(attempt.settle(receipt), SettleOutcome::Settled(outcome));
        assert_eq!(attempt.phase(), AttemptPhase::Graph(expected_status));
    }
}

#[test]
fn rejects_attempt_phases_that_cannot_await_an_outcome_without_mutating_them() {
    for phase in [
        AttemptPhase::Graph(AttemptStatus::Pending),
        AttemptPhase::Graph(AttemptStatus::Completed),
        AttemptPhase::Graph(AttemptStatus::Failed),
        AttemptPhase::Graph(AttemptStatus::Cancelled),
    ] {
        let mut attempt = Attempt::restore(identity("run-01", "node-review", 1), phase);
        let receipt = AttemptReceipt::new(attempt.identity().clone(), AttemptOutcome::Completed);

        assert_eq!(
            attempt.settle(receipt),
            SettleOutcome::NotAwaitingOutcome(phase)
        );
        assert_eq!(attempt.wait(), WaitOutcome::NotAwaitingOutcome(phase));
        assert_eq!(attempt.phase(), phase);
    }
}

#[test]
fn rejects_a_duplicate_receipt_after_the_matching_receipt_settles() {
    let mut attempt = Attempt::ready(identity("run-01", "node-review", 1));
    let receipt = AttemptReceipt::new(attempt.identity().clone(), AttemptOutcome::Completed);

    assert_eq!(
        attempt.settle(receipt.clone()),
        SettleOutcome::Settled(AttemptOutcome::Completed)
    );
    assert_eq!(
        attempt.settle(receipt),
        SettleOutcome::NotAwaitingOutcome(AttemptPhase::Graph(AttemptStatus::Completed))
    );
}

#[test]
fn recovery_marks_running_work_unknown_and_never_replays_it() {
    let mut graph = graph("run-01");
    let attempt_identity = current_identity(&graph);
    graph = reduce(
        graph,
        GraphEvent::AttemptStarted {
            node_id: attempt_identity.node_id().clone(),
            fence: attempt_identity.fence().clone(),
            started_at: 1_001,
        },
    )
    .unwrap();
    let mut attempt = Attempt::from_graph(attempt_identity, AttemptStatus::Running);

    assert_eq!(attempt.recover(&graph), Ok(RecoveryAction::ObserveOutcome));
    assert_eq!(attempt.phase(), AttemptPhase::OutcomeUnknown);
    assert_eq!(attempt.recover(&graph), Ok(RecoveryAction::ObserveOutcome));
    assert_eq!(attempt.start(), StartOutcome::OutcomeUnknown);
    assert_eq!(
        attempt.wait(),
        WaitOutcome::NotAwaitingOutcome(AttemptPhase::OutcomeUnknown)
    );
}

#[test]
fn recovered_unknown_attempt_accepts_only_its_matching_outcome() {
    let mut graph = graph("run-01");
    let attempt_identity = current_identity(&graph);
    graph = reduce(
        graph,
        GraphEvent::AttemptStarted {
            node_id: attempt_identity.node_id().clone(),
            fence: attempt_identity.fence().clone(),
            started_at: 1_001,
        },
    )
    .unwrap();
    let mut attempt = Attempt::from_graph(attempt_identity, AttemptStatus::Running);

    assert_eq!(attempt.recover(&graph), Ok(RecoveryAction::ObserveOutcome));
    assert_eq!(
        attempt.settle(AttemptReceipt::new(
            identity("run-01", "node-review", 2),
            AttemptOutcome::Completed,
        )),
        SettleOutcome::StaleReceipt
    );
    assert_eq!(attempt.phase(), AttemptPhase::OutcomeUnknown);
    assert_eq!(
        attempt.settle(AttemptReceipt::new(
            attempt.identity().clone(),
            AttemptOutcome::Failed,
        )),
        SettleOutcome::Settled(AttemptOutcome::Failed)
    );
    assert_eq!(attempt.phase(), AttemptPhase::Graph(AttemptStatus::Failed));
}

#[test]
fn recovery_rejects_unknown_outcomes_when_the_graph_is_not_running() {
    let graph = graph("run-01");
    let attempt = Attempt::restore(current_identity(&graph), AttemptPhase::OutcomeUnknown);

    assert_eq!(
        recovery_oracle(&attempt, &graph),
        Err(RecoveryFault::GraphPhaseMismatch {
            expected: AttemptStatus::Ready,
            actual: AttemptPhase::OutcomeUnknown,
        })
    );
}

#[test]
fn recovery_preserves_graph_phases_that_do_not_need_outcome_observation() {
    let graph = graph("run-01");
    let identity = current_identity(&graph);
    let mut ready = Attempt::from_graph(identity, AttemptStatus::Ready);

    assert_eq!(ready.recover(&graph), Ok(RecoveryAction::Schedule));
    assert_eq!(ready.phase(), AttemptPhase::Graph(AttemptStatus::Ready));

    let waiting_identity = current_identity(&graph);
    let waiting_graph = reduce(
        graph,
        GraphEvent::NodeWaiting {
            node_id: waiting_identity.node_id().clone(),
            fence: waiting_identity.fence().clone(),
            waiting_at: 1_001,
        },
    )
    .unwrap();
    let mut waiting = Attempt::from_graph(waiting_identity, AttemptStatus::Waiting);

    assert_eq!(
        waiting.recover(&waiting_graph),
        Ok(RecoveryAction::PreserveWaiting)
    );
    assert_eq!(waiting.phase(), AttemptPhase::Graph(AttemptStatus::Waiting));
}

#[test]
fn recovery_oracle_rejects_a_different_run_without_mutating_the_attempt() {
    let graph = graph("run-02");
    let mut attempt = Attempt::ready(identity("run-01", "node-review", 1));

    assert_eq!(
        attempt.recover(&graph),
        Err(RecoveryFault::RunMismatch {
            attempt_run_id: GraphRunId::new("run-01"),
            graph_run_id: GraphRunId::new("run-02"),
        })
    );
    assert_eq!(attempt.phase(), AttemptPhase::Graph(AttemptStatus::Ready));
}

#[test]
fn recovery_oracle_rejects_a_stale_fence_without_mutating_the_attempt() {
    let graph = graph("run-01");
    let mut attempt = Attempt::ready(identity("run-01", "node-review", 2));

    assert_eq!(
        attempt.recover(&graph),
        Err(RecoveryFault::StaleFence {
            node_id: NodeId::new("node-review"),
            expected: current_identity(&graph).fence().clone(),
            actual: attempt.identity().fence().clone(),
        })
    );
    assert_eq!(attempt.phase(), AttemptPhase::Graph(AttemptStatus::Ready));
}

#[test]
fn recovery_oracle_rejects_a_missing_current_node_without_mutating_the_attempt() {
    let graph = graph("run-01");
    let mut attempt = Attempt::ready(identity("run-01", "node-missing", 1));

    assert_eq!(
        attempt.recover(&graph),
        Err(RecoveryFault::MissingNode(NodeId::new("node-missing")))
    );
    assert_eq!(attempt.phase(), AttemptPhase::Graph(AttemptStatus::Ready));
}

#[test]
fn recovery_oracle_rejects_a_phase_that_disagrees_with_the_graph() {
    let graph = graph("run-01");
    let attempt = Attempt::from_graph(current_identity(&graph), AttemptStatus::Waiting);

    assert_eq!(
        recovery_oracle(&attempt, &graph),
        Err(RecoveryFault::GraphPhaseMismatch {
            expected: AttemptStatus::Ready,
            actual: AttemptPhase::Graph(AttemptStatus::Waiting),
        })
    );
}
