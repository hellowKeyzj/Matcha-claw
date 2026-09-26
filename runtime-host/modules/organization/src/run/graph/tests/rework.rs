use super::*;
use crate::run::graph::{AttemptReason, ReduceError, settle_superseded_attempt};

fn work(id: &str, limit: u32) -> NodeDefinition {
    NodeDefinition::work(
        node(id),
        id,
        NonZeroU32::new(limit).unwrap(),
        WorkAssignment::new(format!("task-{id}"), format!("role-{id}")),
    )
}

fn review(id: &str, limit: u32) -> NodeDefinition {
    NodeDefinition::review(
        node(id),
        id,
        NonZeroU32::new(limit).unwrap(),
        ReviewAssignment::new(format!("role-{id}"), "Review the result"),
    )
}

fn graph(nodes: Vec<NodeDefinition>, edges: Vec<EdgeDefinition>) -> GraphState {
    GraphState::initialize(
        GraphDefinition::new(
            "rework",
            "plan",
            GraphRunId::new("run"),
            "Rework",
            nodes,
            edges,
        )
        .unwrap(),
        10,
    )
}

fn cycle(work_limit: u32, review_limit: u32) -> GraphState {
    graph(
        vec![
            work("work", work_limit),
            review("review", review_limit),
            NodeDefinition::control(node("end"), NodeKind::End, "End", attempts()),
        ],
        vec![
            edge(
                "work-review",
                "work",
                "completed",
                "review",
                EdgeAction::Activate,
            ),
            edge(
                "review-work",
                "review",
                "rework",
                "work",
                EdgeAction::Rework,
            ),
            edge(
                "review-end",
                "review",
                "completed",
                "end",
                EdgeAction::Finish,
            ),
        ],
    )
}

fn assert_attempt(state: &GraphState, id: &str, number: u32, status: AttemptStatus) {
    let attempt = state.current_attempt(&node(id)).unwrap();
    assert_eq!(attempt.number().get(), number, "{id}");
    assert_eq!(attempt.status(), status, "{id}");
}

fn roundtrip(state: GraphState) -> GraphState {
    let restored = GraphState::restore_durable(state.durable_snapshot()).unwrap();
    assert_eq!(restored, state);
    restored
}

#[test]
fn work_review_rework_runs_again_then_finishes() {
    let state = complete(cycle(3, 3), "work", "completed", 11);
    let old_review = state
        .current_attempt(&node("review"))
        .unwrap()
        .fence()
        .clone();
    let state = roundtrip(complete(state, "review", "rework", 12));
    assert_attempt(&state, "work", 2, AttemptStatus::Ready);
    assert_attempt(&state, "review", 2, AttemptStatus::Pending);
    assert_attempt(&state, "end", 1, AttemptStatus::Pending);
    let target = state.current_attempt(&node("work")).unwrap();
    assert_eq!(target.reason(), &AttemptReason::Rework);
    assert_eq!(target.inputs()[0].source_fence(), &old_review);
    let review = state.current_attempt(&node("review")).unwrap();
    assert_eq!(review.reason(), &AttemptReason::Rework);
    assert!(review.inputs().is_empty());
    assert_eq!(state.ready_queue().len(), 1);
    assert_eq!(state.ready_queue()[0].node_id(), &node("work"));
    let state = complete(state, "work", "completed", 13);
    assert_attempt(&state, "review", 2, AttemptStatus::Ready);
    assert_eq!(
        state.current_attempt(&node("review")).unwrap().inputs()[0].source_fence(),
        state.current_attempt(&node("work")).unwrap().fence()
    );
    let state = complete(state, "review", "completed", 14);
    let state = roundtrip(complete(state, "end", "completed", 15));
    assert_eq!(project(&state).status, GraphStatus::Completed);
}

#[test]
fn repeated_rework_retains_receipts_and_old_fences_stay_stale() {
    let mut state = cycle(4, 4);
    for at in [11, 13, 15] {
        state = complete(state, "work", "completed", at);
        let fence = state
            .current_attempt(&node("review"))
            .unwrap()
            .fence()
            .clone();
        state = roundtrip(complete(state, "review", "rework", at + 1));
        assert_eq!(
            reduce(
                state.clone(),
                GraphEvent::NodeCompleted {
                    node_id: node("review"),
                    fence,
                    output_port: "completed".into(),
                    completed_at: at + 2
                }
            ),
            Err(ReduceError::StaleFence {
                node_id: node("review")
            })
        );
        assert_eq!(state.ready_queue().len(), 1);
    }
    assert_attempt(&state, "work", 4, AttemptStatus::Ready);
    assert_attempt(&state, "review", 4, AttemptStatus::Pending);
    state = complete(state, "work", "completed", 17);
    state = complete(state, "review", "completed", 18);
    assert_eq!(
        project(&complete(state, "end", "completed", 19)).status,
        GraphStatus::Completed
    );
}

#[test]
fn diamond_and_external_join_rebuild_only_affected_inputs() {
    let state = graph(
        vec![
            work("work", 3),
            work("left", 3),
            work("right", 3),
            work("external", 1),
            NodeDefinition::control(node("join"), NodeKind::Join, "Join", attempts()),
            review("review", 3),
            work("unrelated", 1),
        ],
        vec![
            edge(
                "work-left",
                "work",
                "completed",
                "left",
                EdgeAction::Activate,
            ),
            edge(
                "work-right",
                "work",
                "completed",
                "right",
                EdgeAction::Activate,
            ),
            edge("left-join", "left", "completed", "join", EdgeAction::Gate),
            edge("right-join", "right", "completed", "join", EdgeAction::Gate),
            edge(
                "external-join",
                "external",
                "completed",
                "join",
                EdgeAction::Gate,
            ),
            edge(
                "join-review",
                "join",
                "completed",
                "review",
                EdgeAction::Activate,
            ),
            edge(
                "review-work",
                "review",
                "rework",
                "work",
                EdgeAction::Rework,
            ),
        ],
    );
    let unrelated = state.executions()[&node("unrelated")].clone();
    let mut state = complete(state, "external", "completed", 11);
    let external = state.executions()[&node("external")].clone();
    for (id, at) in [("work", 12), ("left", 13), ("right", 14), ("join", 15)] {
        state = complete(state, id, "completed", at);
    }
    let state = roundtrip(complete(state, "review", "rework", 16));
    assert_attempt(&state, "work", 2, AttemptStatus::Ready);
    for id in ["left", "right", "join", "review"] {
        assert_attempt(&state, id, 2, AttemptStatus::Pending);
        assert!(
            state
                .current_attempt(&node(id))
                .unwrap()
                .inputs()
                .is_empty()
        );
    }
    assert_eq!(state.executions()[&node("external")], external);
    assert_eq!(state.executions()[&node("unrelated")], unrelated);
    let state = complete(state, "work", "completed", 17);
    let state = complete(state, "left", "completed", 18);
    assert_attempt(&state, "join", 2, AttemptStatus::Pending);
    let state = roundtrip(complete(state, "right", "completed", 19));
    assert_attempt(&state, "join", 2, AttemptStatus::Ready);
    let receipt = state
        .current_attempt(&node("join"))
        .unwrap()
        .inputs()
        .iter()
        .find(|receipt| receipt.source_node_id() == &node("external"))
        .unwrap();
    assert_eq!(receipt.source_fence(), external.current().fence());
    assert_eq!(receipt.arrived_at(), 19);
    let state = complete(state, "join", "completed", 20);
    assert_attempt(&state, "review", 2, AttemptStatus::Ready);
}

#[test]
fn multiple_edges_deduplicate_targets_and_shared_paths() {
    let state = graph(
        vec![
            work("left", 3),
            work("right", 3),
            NodeDefinition::control(node("join"), NodeKind::Join, "Join", attempts()),
            review("review", 3),
        ],
        vec![
            edge("left-join", "left", "completed", "join", EdgeAction::Gate),
            edge("right-join", "right", "completed", "join", EdgeAction::Gate),
            edge(
                "join-review",
                "join",
                "completed",
                "review",
                EdgeAction::Activate,
            ),
            edge(
                "review-left",
                "review",
                "rework",
                "left",
                EdgeAction::Rework,
            ),
            edge(
                "review-left-extra",
                "review",
                "rework",
                "left",
                EdgeAction::Rework,
            ),
            edge(
                "review-right",
                "review",
                "rework",
                "right",
                EdgeAction::Rework,
            ),
        ],
    );
    let state = complete(state, "left", "completed", 11);
    let state = complete(state, "right", "completed", 12);
    let state = complete(state, "join", "completed", 13);
    let state = roundtrip(complete(state, "review", "rework", 14));
    for id in ["left", "right"] {
        assert_attempt(&state, id, 2, AttemptStatus::Ready);
    }
    for id in ["join", "review"] {
        assert_attempt(&state, id, 2, AttemptStatus::Pending);
    }
    assert_eq!(state.ready_queue().len(), 2);
    let inputs = state.current_attempt(&node("left")).unwrap().inputs();
    assert_eq!(
        inputs
            .iter()
            .map(|receipt| receipt.edge_id().as_str())
            .collect::<Vec<_>>(),
        ["review-left", "review-left-extra"]
    );
    let mut snapshot = state.durable_snapshot();
    let attempt = snapshot
        .executions
        .iter_mut()
        .find(|execution| execution.node_id == "left")
        .unwrap()
        .attempts
        .last_mut()
        .unwrap();
    attempt.inputs.push(attempt.inputs[0].clone());
    assert!(matches!(
        GraphState::restore_durable(snapshot),
        Err(DurableRestoreError::InvalidAttemptInputs { .. })
    ));
    let state = complete(state, "left", "completed", 15);
    let state = complete(state, "right", "completed", 16);
    assert_attempt(&state, "join", 2, AttemptStatus::Ready);
}

#[test]
fn forward_rework_does_not_reset_source_without_an_activation_return_path() {
    let state = graph(
        vec![review("review", 1), work("work", 2)],
        vec![
            edge(
                "review-work",
                "review",
                "completed",
                "work",
                EdgeAction::Activate,
            ),
            edge(
                "review-rework",
                "review",
                "rework",
                "work",
                EdgeAction::Rework,
            ),
        ],
    );
    let state = roundtrip(complete(state, "review", "rework", 11));
    assert_attempt(&state, "review", 1, AttemptStatus::Completed);
    assert_attempt(&state, "work", 2, AttemptStatus::Ready);
    assert_eq!(
        project(&complete(state, "work", "completed", 12)).status,
        GraphStatus::Completed
    );
}

#[test]
fn rework_edges_do_not_expand_activation_scope() {
    let state = graph(
        vec![work("work", 3), review("review", 3), review("other", 1)],
        vec![
            edge(
                "work-review",
                "work",
                "completed",
                "review",
                EdgeAction::Activate,
            ),
            edge(
                "review-work",
                "review",
                "rework",
                "work",
                EdgeAction::Rework,
            ),
            edge(
                "review-other",
                "review",
                "rework",
                "other",
                EdgeAction::Rework,
            ),
            edge(
                "other-review",
                "other",
                "rework",
                "review",
                EdgeAction::Rework,
            ),
        ],
    );
    // Only the selected source's rework edges participate in this outcome.
    let state = complete(state, "work", "completed", 11);
    let state = complete(state, "other", "rework", 12);
    assert_attempt(&state, "work", 1, AttemptStatus::Completed);
    assert_attempt(&state, "other", 1, AttemptStatus::Completed);
    assert_attempt(&state, "review", 2, AttemptStatus::Ready);
    roundtrip(state);
}

#[test]
fn target_or_source_budget_exhaustion_settles_failed_without_new_attempts() {
    for (work_limit, review_limit) in [(1, 3), (3, 1)] {
        let state = complete(cycle(work_limit, review_limit), "work", "completed", 11);
        roundtrip(state.clone());
        let work = state.executions()[&node("work")].clone();
        let state = roundtrip(complete(state, "review", "rework", 12));
        assert_attempt(&state, "review", 1, AttemptStatus::Failed);
        assert_eq!(
            state
                .current_attempt(&node("review"))
                .unwrap()
                .output_port(),
            Some("rework")
        );
        assert_eq!(state.executions()[&node("work")], work);
        assert!(state.ready_queue().is_empty());
        assert_eq!(project(&state).status, GraphStatus::Failed);
    }
}

#[test]
fn shared_path_budget_failure_is_atomic_across_all_targets() {
    let state = graph(
        vec![
            work("left", 3),
            work("right", 3),
            NodeDefinition::control(node("join"), NodeKind::Join, "Join", NonZeroU32::MIN),
            review("review", 3),
        ],
        vec![
            edge("left-join", "left", "completed", "join", EdgeAction::Gate),
            edge("right-join", "right", "completed", "join", EdgeAction::Gate),
            edge(
                "join-review",
                "join",
                "completed",
                "review",
                EdgeAction::Activate,
            ),
            edge(
                "review-left",
                "review",
                "rework",
                "left",
                EdgeAction::Rework,
            ),
            edge(
                "review-right",
                "review",
                "rework",
                "right",
                EdgeAction::Rework,
            ),
        ],
    );
    let state = complete(state, "left", "completed", 11);
    let state = complete(state, "right", "completed", 12);
    let state = complete(state, "join", "completed", 13);
    let before = state.clone();
    let state = roundtrip(complete(state, "review", "rework", 14));
    for id in ["left", "right", "join"] {
        assert_eq!(
            state.executions()[&node(id)],
            before.executions()[&node(id)]
        );
    }
    assert_attempt(&state, "review", 1, AttemptStatus::Failed);
    assert!(state.ready_queue().is_empty());
}

fn shared_reviewers() -> GraphState {
    graph(
        vec![
            work("work", 3),
            review("first", 3),
            review("second", 3),
            work("consumer", 3),
            NodeDefinition::control(node("end"), NodeKind::End, "End", attempts()),
            work("independent", 3),
            review("independent-review", 3),
        ],
        vec![
            edge(
                "work-first",
                "work",
                "completed",
                "first",
                EdgeAction::Activate,
            ),
            edge(
                "work-second",
                "work",
                "completed",
                "second",
                EdgeAction::Activate,
            ),
            edge("first-work", "first", "rework", "work", EdgeAction::Rework),
            edge(
                "second-work",
                "second",
                "rework",
                "work",
                EdgeAction::Rework,
            ),
            edge(
                "second-consumer",
                "second",
                "completed",
                "consumer",
                EdgeAction::Activate,
            ),
            edge(
                "consumer-end",
                "consumer",
                "completed",
                "end",
                EdgeAction::Finish,
            ),
            edge(
                "independent-review",
                "independent",
                "completed",
                "independent-review",
                EdgeAction::Activate,
            ),
            edge(
                "independent-rework",
                "independent-review",
                "rework",
                "independent",
                EdgeAction::Rework,
            ),
        ],
    )
}

#[test]
fn shared_reviewers_and_transitive_consumers_are_invalidated_in_every_phase() {
    for status in [
        AttemptStatus::Ready,
        AttemptStatus::Running,
        AttemptStatus::Waiting,
        AttemptStatus::Completed,
    ] {
        let mut state = complete(shared_reviewers(), "work", "completed", 11);
        let fence = state
            .current_attempt(&node("second"))
            .unwrap()
            .fence()
            .clone();
        state = match status {
            AttemptStatus::Running => reduce(
                state,
                GraphEvent::AttemptStarted {
                    node_id: node("second"),
                    fence: fence.clone(),
                    started_at: 12,
                },
            )
            .unwrap(),
            AttemptStatus::Waiting => reduce(
                state,
                GraphEvent::NodeWaiting {
                    node_id: node("second"),
                    fence: fence.clone(),
                    waiting_at: 12,
                },
            )
            .unwrap(),
            AttemptStatus::Completed => {
                let state = complete(state, "second", "completed", 12);
                complete(state, "consumer", "completed", 13)
            }
            _ => state,
        };
        let independent = state.executions()[&node("independent")].clone();
        let state = roundtrip(complete(state, "first", "rework", 14));
        assert_attempt(&state, "second", 2, AttemptStatus::Pending);
        assert_eq!(
            state.executions()[&node("second")].attempts()[0].status(),
            status
        );
        if status == AttemptStatus::Completed {
            assert_attempt(&state, "consumer", 2, AttemptStatus::Pending);
            assert_attempt(&state, "end", 2, AttemptStatus::Pending);
        } else {
            assert_attempt(&state, "consumer", 1, AttemptStatus::Pending);
            assert_attempt(&state, "end", 1, AttemptStatus::Pending);
        }
        assert_eq!(state.executions()[&node("independent")], independent);
        for output_port in ["completed", "rework"] {
            assert_eq!(
                reduce(
                    state.clone(),
                    GraphEvent::NodeCompleted {
                        node_id: node("second"),
                        fence: fence.clone(),
                        output_port: output_port.into(),
                        completed_at: 15
                    }
                ),
                Err(ReduceError::StaleFence {
                    node_id: node("second")
                })
            );
        }
        let state = complete(state, "work", "completed", 16);
        assert_attempt(&state, "first", 2, AttemptStatus::Ready);
        assert_attempt(&state, "second", 2, AttemptStatus::Ready);
        roundtrip(state);
    }
}

#[test]
fn independent_reviewers_rework_without_invalidating_each_other() {
    let state = complete(shared_reviewers(), "work", "completed", 11);
    let state = complete(state, "independent", "completed", 12);
    let state = complete(state, "first", "rework", 13);
    let shared =
        ["work", "first", "second"].map(|id| (node(id), state.executions()[&node(id)].clone()));
    let state = roundtrip(complete(state, "independent-review", "rework", 14));
    for (id, history) in shared {
        assert_eq!(state.executions()[&id], history);
    }
    assert_attempt(&state, "independent", 2, AttemptStatus::Ready);
    assert_attempt(&state, "independent-review", 2, AttemptStatus::Pending);
}

#[test]
fn invalidated_consumer_budget_is_preflighted() {
    for end_completed in [false, true] {
        let mut snapshot = shared_reviewers().durable_snapshot();
        snapshot
            .nodes
            .iter_mut()
            .find(|node| node.id == "second")
            .unwrap()
            .max_attempts = 1;
        let state = GraphState::restore_durable(snapshot).unwrap();
        let mut state = complete(state, "work", "completed", 11);
        if end_completed {
            for (id, at) in [("second", 12), ("consumer", 13), ("end", 14)] {
                state = complete(state, id, "completed", at);
            }
        }
        let before = state.clone();
        let state = roundtrip(complete(state, "first", "rework", 15));
        assert_attempt(&state, "first", 1, AttemptStatus::Failed);
        for (id, history) in before
            .executions()
            .iter()
            .filter(|(id, _)| **id != node("first"))
        {
            assert_eq!(&state.executions()[id], history);
        }
        assert_eq!(
            state.current_attempt(&node("first")).unwrap().output_port(),
            Some("rework")
        );
        assert_eq!(project(&state).status, GraphStatus::Failed);
    }
}

#[test]
fn completed_end_does_not_hide_an_active_parallel_review() {
    let mut state = shared_reviewers();
    for (id, at) in [
        ("independent", 11),
        ("independent-review", 12),
        ("work", 13),
        ("second", 14),
        ("consumer", 15),
        ("end", 16),
    ] {
        state = complete(state, id, "completed", at);
    }
    assert_eq!(
        project(&roundtrip(state.clone())).status,
        GraphStatus::Ready
    );
    let fence = state
        .current_attempt(&node("first"))
        .unwrap()
        .fence()
        .clone();
    let state = reduce(
        state,
        GraphEvent::AttemptStarted {
            node_id: node("first"),
            fence: fence.clone(),
            started_at: 17,
        },
    )
    .unwrap();
    assert_eq!(
        project(&roundtrip(state.clone())).status,
        GraphStatus::Running
    );
    let state = reduce(
        state,
        GraphEvent::NodeWaiting {
            node_id: node("first"),
            fence,
            waiting_at: 18,
        },
    )
    .unwrap();
    assert_eq!(
        project(&roundtrip(state.clone())).status,
        GraphStatus::Waiting
    );
    let state = complete(state, "first", "completed", 19);
    assert_eq!(project(&roundtrip(state)).status, GraphStatus::Completed);
}

#[test]
fn completed_end_allows_an_unselected_pending_branch() {
    let state = graph(
        vec![
            NodeDefinition::control(
                node("decision"),
                NodeKind::HumanDecision,
                "Decision",
                attempts(),
            ),
            work("unselected", 1),
            NodeDefinition::control(node("end"), NodeKind::End, "End", attempts()),
        ],
        vec![
            edge(
                "decision-end",
                "decision",
                "approved",
                "end",
                EdgeAction::Finish,
            ),
            edge(
                "decision-unselected",
                "decision",
                "rejected",
                "unselected",
                EdgeAction::Activate,
            ),
        ],
    );
    let state = complete(state, "decision", "approved", 11);
    let state = roundtrip(complete(state, "end", "completed", 12));
    assert_attempt(&state, "unselected", 1, AttemptStatus::Pending);
    assert_eq!(project(&state).status, GraphStatus::Completed);
}

#[test]
fn superseded_native_terminal_settlement_never_routes_or_changes_current_attempts() {
    let state = complete(shared_reviewers(), "work", "completed", 11);
    let fence = state
        .current_attempt(&node("second"))
        .unwrap()
        .fence()
        .clone();
    let state = reduce(
        state,
        GraphEvent::NodeWaiting {
            node_id: node("second"),
            fence: fence.clone(),
            waiting_at: 12,
        },
    )
    .unwrap();
    let state = roundtrip(complete(state, "first", "rework", 13));
    for (event, expected_status, expected_port) in [
        (
            GraphEvent::NodeCompleted {
                node_id: node("second"),
                fence: fence.clone(),
                output_port: "rework".into(),
                completed_at: 14,
            },
            AttemptStatus::Completed,
            Some("rework"),
        ),
        (
            GraphEvent::NodeFailed {
                node_id: node("second"),
                fence: fence.clone(),
                output_port: "failed".into(),
                failed_at: 14,
            },
            AttemptStatus::Failed,
            Some("failed"),
        ),
        (
            GraphEvent::NodeCancelled {
                node_id: node("second"),
                fence: fence.clone(),
                cancelled_at: 14,
            },
            AttemptStatus::Cancelled,
            None,
        ),
    ] {
        let settled = roundtrip(settle_superseded_attempt(state.clone(), event.clone()).unwrap());
        let old = &settled.executions()[&node("second")].attempts()[0];
        assert_eq!(old.status(), expected_status);
        assert_eq!(old.output_port(), expected_port);
        assert_eq!(settled.ready_queue(), state.ready_queue());
        for (id, history) in state.executions() {
            assert_eq!(settled.current_attempt(id), Some(history.current()));
        }
        if expected_status == AttemptStatus::Failed {
            let mut completed = settled.clone();
            for (id, at) in [
                ("work", 15),
                ("first", 16),
                ("second", 17),
                ("consumer", 18),
                ("end", 19),
                ("independent", 20),
                ("independent-review", 21),
            ] {
                completed = complete(completed, id, "completed", at);
            }
            assert_eq!(
                project(&roundtrip(completed)).status,
                GraphStatus::Completed
            );
        }
        assert!(matches!(
            settle_superseded_attempt(settled, event),
            Err(ReduceError::InvalidTransition { .. })
        ));
    }
    let current = state
        .current_attempt(&node("second"))
        .unwrap()
        .fence()
        .clone();
    assert_eq!(
        settle_superseded_attempt(
            state.clone(),
            GraphEvent::NodeCompleted {
                node_id: node("second"),
                fence: current,
                output_port: "completed".into(),
                completed_at: 14
            }
        ),
        Err(ReduceError::StaleFence {
            node_id: node("second")
        })
    );
    assert_eq!(
        settle_superseded_attempt(
            state,
            GraphEvent::NodeWaiting {
                node_id: node("second"),
                fence,
                waiting_at: 14
            }
        ),
        Err(ReduceError::InvalidSettlementEvent)
    );
}

#[test]
fn exhausted_rework_does_not_route_other_edges_on_the_same_output_port() {
    let state = graph(
        vec![
            NodeDefinition::control(
                node("decision"),
                NodeKind::HumanDecision,
                "Decision",
                attempts(),
            ),
            work("work", 1),
            NodeDefinition::control(node("end"), NodeKind::End, "End", attempts()),
        ],
        vec![
            edge(
                "decision-end",
                "decision",
                "rejected",
                "end",
                EdgeAction::Finish,
            ),
            edge(
                "decision-work",
                "decision",
                "rejected",
                "work",
                EdgeAction::Rework,
            ),
        ],
    );
    let state = roundtrip(complete(state, "decision", "rejected", 11));
    assert_attempt(&state, "decision", 1, AttemptStatus::Failed);
    assert_eq!(
        state
            .current_attempt(&node("decision"))
            .unwrap()
            .output_port(),
        Some("rejected")
    );
    assert_attempt(&state, "work", 1, AttemptStatus::Ready);
    assert_attempt(&state, "end", 1, AttemptStatus::Pending);
}

#[test]
fn every_activation_path_reopens_even_before_its_input_was_consumed() {
    let state = graph(
        vec![
            work("work", 3),
            work("pending", 3),
            work("blocker", 1),
            review("review", 3),
        ],
        vec![
            edge(
                "work-review",
                "work",
                "completed",
                "review",
                EdgeAction::Activate,
            ),
            edge(
                "work-pending",
                "work",
                "completed",
                "pending",
                EdgeAction::Gate,
            ),
            edge(
                "blocker-pending",
                "blocker",
                "completed",
                "pending",
                EdgeAction::Gate,
            ),
            edge(
                "pending-review",
                "pending",
                "completed",
                "review",
                EdgeAction::Finish,
            ),
            edge(
                "review-work",
                "review",
                "rework",
                "work",
                EdgeAction::Rework,
            ),
        ],
    );
    let state = complete(state, "work", "completed", 11);
    let state = roundtrip(complete(state, "review", "rework", 12));
    assert_attempt(&state, "pending", 2, AttemptStatus::Pending);
    assert_attempt(&state, "review", 2, AttemptStatus::Pending);
    assert!(
        state
            .current_attempt(&node("pending"))
            .unwrap()
            .inputs()
            .is_empty()
    );
}

#[test]
fn manual_rework_keeps_explicit_budget_error() {
    let state = cycle(1, 3);
    assert_eq!(
        reduce(
            state,
            GraphEvent::ReworkRequested {
                node_id: node("work"),
                requested_at: 11
            }
        ),
        Err(ReduceError::AttemptLimitExceeded {
            node_id: node("work"),
            max_attempts: NonZeroU32::MIN
        })
    );
}
