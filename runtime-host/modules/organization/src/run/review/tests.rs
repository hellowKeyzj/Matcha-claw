use super::*;
use crate::run::graph::{AttemptId, ExecutionFence, NodeExecutionId};

fn request() -> ReviewerRequest {
    ReviewerRequest {
        review_id: "review:run-1:node-review:1".into(),
        run_id: "run-1".into(),
        node_id: "node-review".into(),
        fence: ExecutionFence::new(
            AttemptId::for_node(
                &crate::NodeId::new("node-review"),
                std::num::NonZeroU32::MIN,
            ),
            NodeExecutionId::for_attempt(&AttemptId::for_node(
                &crate::NodeId::new("node-review"),
                std::num::NonZeroU32::MIN,
            )),
        ),
        role_id: "reviewer".into(),
        session_id: "session-1".into(),
        prompt: "Review the upstream result.".into(),
        idempotency_key: "review-request-1".into(),
        requested_at: 10,
    }
}

#[test]
fn register_is_durable_and_replays_exact_request() {
    let mut ledger = ReviewLedger::default();
    let request = request();
    let recorded = ledger.register(request.clone(), 11).unwrap();
    assert!(matches!(recorded, RegisterReviewOutcome::Recorded(_)));
    let replay = ledger.register(request, 12).unwrap();
    assert!(matches!(replay, RegisterReviewOutcome::Replayed(_)));
    let restored = ReviewLedger::restore(ledger.snapshot()).unwrap();
    assert!(restored.review("review:run-1:node-review:1").is_some());
}

#[test]
fn verdict_requires_binding_and_is_terminally_idempotent() {
    let mut ledger = ReviewLedger::default();
    let request = request();
    ledger.register(request.clone(), 11).unwrap();
    let verdict = ledger
        .resolve(
            "review:run-1:node-review:1",
            "run-1",
            "node-review",
            request.fence.clone(),
            "reviewer",
            "session-1",
            ReviewVerdict::Rework,
            "needs another pass".into(),
            "verdict-1".into(),
            12,
        )
        .unwrap();
    assert!(matches!(verdict, ResolveReviewOutcome::Recorded(_)));
    let replay = ledger
        .resolve(
            "review:run-1:node-review:1",
            "run-1",
            "node-review",
            request.fence,
            "reviewer",
            "session-1",
            ReviewVerdict::Rework,
            "needs another pass".into(),
            "verdict-1".into(),
            12,
        )
        .unwrap();
    assert!(matches!(replay, ResolveReviewOutcome::Replayed(_)));
}

#[test]
fn verdict_rejects_scope_escape_and_conflict() {
    let mut ledger = ReviewLedger::default();
    let request = request();
    ledger.register(request.clone(), 11).unwrap();
    let error = ledger
        .resolve(
            "review:run-1:node-review:1",
            "other-run",
            "node-review",
            request.fence.clone(),
            "reviewer",
            "session-1",
            ReviewVerdict::Pass,
            "passed".into(),
            "verdict-a".into(),
            12,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        ReviewLedgerError::InvalidVerdict(ReviewVerdictError::BindingMismatch)
    ));
    ledger
        .resolve(
            "review:run-1:node-review:1",
            "run-1",
            "node-review",
            request.fence.clone(),
            "reviewer",
            "session-1",
            ReviewVerdict::Pass,
            "passed".into(),
            "verdict-a".into(),
            12,
        )
        .unwrap();
    let conflict = ledger
        .resolve(
            "review:run-1:node-review:1",
            "run-1",
            "node-review",
            request.fence,
            "reviewer",
            "session-1",
            ReviewVerdict::Fail,
            "failed".into(),
            "verdict-b".into(),
            13,
        )
        .unwrap_err();
    assert!(matches!(conflict, ReviewLedgerError::TerminalConflict));
}
