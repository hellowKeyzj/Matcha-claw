use std::num::NonZeroU32;

mod rework;

use super::{
    AttemptId, AttemptStatus, DefinitionError, DependencyMetadata, DurableRestoreError, EdgeAction,
    EdgeDefinition, EdgeId, EdgePayloadPolicy, ExecutionFence, ExecutorPolicy, GraphDefinition,
    GraphEvent, GraphRunId, GraphState, GraphStatus, GroupId, JoinPolicy, NodeDefinition,
    NodeExecutionId, NodeId, NodeKind, ReviewAssignment, StartTrigger, WorkAssignment, WorkGroup,
    project, reduce, restore_oracle,
};

fn attempts() -> NonZeroU32 {
    NonZeroU32::new(3).unwrap()
}

fn node(id: &str) -> NodeId {
    NodeId::new(id)
}

fn edge(id: &str, source: &str, port: &str, target: &str, action: EdgeAction) -> EdgeDefinition {
    EdgeDefinition::new(
        EdgeId::new(id),
        node(source),
        port,
        node(target),
        "input",
        action,
    )
}

fn simple_definition(trigger: Option<StartTrigger>) -> GraphDefinition {
    GraphDefinition::new(
        "graph-1",
        "plan-1",
        GraphRunId::new("run-1"),
        "Team run",
        vec![
            NodeDefinition::start(node("start"), "Start", attempts(), trigger),
            NodeDefinition::work(
                node("work"),
                "Work",
                attempts(),
                WorkAssignment::new("task-work", "role-work"),
            ),
            NodeDefinition::control(node("end"), super::NodeKind::End, "End", attempts()),
        ],
        vec![
            edge(
                "start-work",
                "start",
                "completed",
                "work",
                EdgeAction::Activate,
            ),
            edge("work-end", "work", "completed", "end", EdgeAction::Finish),
        ],
    )
    .unwrap()
}

fn gate_definition() -> GraphDefinition {
    GraphDefinition::new(
        "graph-gate",
        "plan-gate",
        GraphRunId::new("run-gate"),
        "Gate run",
        vec![
            NodeDefinition::work(
                node("left"),
                "Left",
                attempts(),
                WorkAssignment::new("task-left", "role-left"),
            ),
            NodeDefinition::work(
                node("right"),
                "Right",
                attempts(),
                WorkAssignment::new("task-right", "role-right"),
            ),
            NodeDefinition::control(node("join"), super::NodeKind::Join, "Join", attempts()),
        ],
        vec![
            edge("left-join", "left", "completed", "join", EdgeAction::Gate),
            edge("right-join", "right", "completed", "join", EdgeAction::Gate),
        ],
    )
    .unwrap()
}

fn roots_in_reverse_definition_order() -> GraphDefinition {
    GraphDefinition::new(
        "graph-roots",
        "plan-roots",
        GraphRunId::new("run-roots"),
        "Root run",
        vec![
            NodeDefinition::work(
                node("zeta"),
                "Zeta",
                attempts(),
                WorkAssignment::new("task-zeta", "role-zeta"),
            ),
            NodeDefinition::work(
                node("alpha"),
                "Alpha",
                attempts(),
                WorkAssignment::new("task-alpha", "role-alpha"),
            ),
        ],
        Vec::new(),
    )
    .unwrap()
}

fn rich_definition() -> GraphDefinition {
    GraphDefinition::new(
        "graph-rich",
        "plan-rich",
        GraphRunId::new("run-rich"),
        "Rich graph",
        vec![
            NodeDefinition::control(
                node("control-start"),
                NodeKind::Start,
                "Control start",
                attempts(),
            ),
            NodeDefinition::start(node("start"), "Start", attempts(), None),
            NodeDefinition::work(
                node("work"),
                "Work",
                attempts(),
                WorkAssignment::typed(
                    "task-work",
                    "work instruction",
                    ExecutorPolicy::team_role("role-work"),
                    Some("artifact-report".to_owned()),
                    Some(GroupId::new("group-work")),
                ),
            ),
            NodeDefinition::review(
                node("review"),
                "Review",
                attempts(),
                ReviewAssignment::new("role-review", "review instruction"),
            ),
            NodeDefinition::join(
                node("typed-join"),
                "Typed join",
                attempts(),
                WorkGroup::new(GroupId::new("group-typed"), JoinPolicy::new(true, false, 2)),
            ),
            NodeDefinition::control(
                node("control-review"),
                NodeKind::Review,
                "Review gate",
                attempts(),
            ),
            NodeDefinition::control(
                node("human-decision"),
                NodeKind::HumanDecision,
                "Human decision",
                attempts(),
            ),
            NodeDefinition::control(
                node("script-review"),
                NodeKind::ScriptReview,
                "Script review",
                attempts(),
            ),
            NodeDefinition::control(
                node("control-join"),
                NodeKind::Join,
                "Join gate",
                attempts(),
            ),
            NodeDefinition::control(node("end"), NodeKind::End, "End", attempts()),
        ],
        vec![
            edge(
                "control-start-start",
                "control-start",
                "completed",
                "start",
                EdgeAction::Activate,
            ),
            edge(
                "start-work",
                "start",
                "completed",
                "work",
                EdgeAction::Activate,
            )
            .with_payload(EdgePayloadPolicy::new(false))
            .with_dependency(DependencyMetadata::new("task-start", "task-work")),
            edge(
                "work-review",
                "work",
                "completed",
                "review",
                EdgeAction::Activate,
            ),
            edge(
                "review-typed-join",
                "review",
                "completed",
                "typed-join",
                EdgeAction::Gate,
            ),
            edge(
                "typed-join-control-review",
                "typed-join",
                "joined",
                "control-review",
                EdgeAction::Activate,
            ),
            edge(
                "control-review-human-decision",
                "control-review",
                "approved",
                "human-decision",
                EdgeAction::Activate,
            ),
            edge(
                "human-decision-script-review",
                "human-decision",
                "approved",
                "script-review",
                EdgeAction::Activate,
            ),
            edge(
                "script-review-control-join",
                "script-review",
                "approved",
                "control-join",
                EdgeAction::Gate,
            ),
            edge(
                "control-join-end",
                "control-join",
                "joined",
                "end",
                EdgeAction::Finish,
            ),
        ],
    )
    .unwrap()
}

fn complete(state: GraphState, node_id: &str, port: &str, at: u64) -> GraphState {
    let id = node(node_id);
    let fence = state.current_attempt(&id).unwrap().fence().clone();
    reduce(
        state,
        GraphEvent::NodeCompleted {
            node_id: id,
            fence,
            output_port: port.into(),
            completed_at: at,
        },
    )
    .unwrap()
}

#[test]
fn keeps_armed_start_dormant_until_its_trigger_fires() {
    let definition = simple_definition(Some(StartTrigger::Webhook {
        path: "/hooks/team".into(),
    }));
    let state = GraphState::initialize(definition, 10);

    assert!(state.ready_queue().is_empty());
    assert_eq!(
        state.current_attempt(&node("start")).unwrap().status(),
        AttemptStatus::Pending
    );

    let state = reduce(
        state,
        GraphEvent::TriggerFired {
            node_id: node("start"),
            fired_at: 11,
        },
    )
    .unwrap();

    assert_eq!(state.ready_queue().len(), 1);
    assert_eq!(state.ready_queue()[0].node_id(), &node("start"));
    assert_eq!(
        state.current_attempt(&node("start")).unwrap().status(),
        AttemptStatus::Ready
    );
}

#[test]
fn completion_routes_activate_and_finish_edges_to_end() {
    let state = GraphState::initialize(simple_definition(None), 10);
    let state = complete(state, "start", "completed", 11);
    assert_eq!(state.ready_queue()[0].node_id(), &node("work"));

    let state = complete(state, "work", "completed", 12);
    assert_eq!(state.ready_queue()[0].node_id(), &node("end"));

    let state = complete(state, "end", "completed", 13);
    assert_eq!(project(&state).status, GraphStatus::Completed);
}

#[test]
fn cancellation_terminates_without_routing_edges_and_restores_consistently() {
    let state = GraphState::initialize(simple_definition(None), 10);
    let start = node("start");
    let fence = state.current_attempt(&start).unwrap().fence().clone();
    let state = reduce(
        state,
        GraphEvent::NodeCancelled {
            node_id: start.clone(),
            fence,
            cancelled_at: 11,
        },
    )
    .unwrap();

    assert_eq!(
        state.current_attempt(&start).unwrap().status(),
        AttemptStatus::Cancelled
    );
    assert!(state.ready_queue().is_empty());
    assert_eq!(
        state.current_attempt(&node("work")).unwrap().status(),
        AttemptStatus::Pending
    );
    assert_eq!(project(&state).status, GraphStatus::Cancelled);
    assert_eq!(restore_oracle(state.clone()).unwrap(), state);
}

#[test]
fn restore_oracle_rejects_a_cancelled_attempt_with_an_output_port() {
    let state = GraphState::initialize(simple_definition(None), 10);
    let start = node("start");
    let fence = state.current_attempt(&start).unwrap().fence().clone();
    let mut state = reduce(
        state,
        GraphEvent::NodeCancelled {
            node_id: start.clone(),
            fence,
            cancelled_at: 11,
        },
    )
    .unwrap();
    state.set_attempt_output_port_for_test(&start, 0, Some("completed"));

    assert_eq!(
        restore_oracle(state),
        Err(super::RestoreError::CancelledAttemptHasOutput {
            node_id: start,
            number: NonZeroU32::MIN,
        })
    );
}

#[test]
fn stale_cancellation_cannot_mutate_a_reworked_attempt() {
    let state = GraphState::initialize(simple_definition(None), 10);
    let start = node("start");
    let old_fence = state.current_attempt(&start).unwrap().fence().clone();
    let state = reduce(
        state,
        GraphEvent::ReworkRequested {
            node_id: start.clone(),
            requested_at: 11,
        },
    )
    .unwrap();

    assert_eq!(
        reduce(
            state.clone(),
            GraphEvent::NodeCancelled {
                node_id: start.clone(),
                fence: old_fence,
                cancelled_at: 12,
            },
        ),
        Err(super::ReduceError::StaleFence { node_id: start })
    );
    assert_eq!(
        state.current_attempt(&node("start")).unwrap().status(),
        AttemptStatus::Ready
    );
}

#[test]
fn gate_waits_for_every_satisfied_input() {
    let state = GraphState::initialize(gate_definition(), 10);
    assert_eq!(state.ready_queue().len(), 2);

    let state = complete(state, "left", "completed", 11);
    assert_eq!(
        state.current_attempt(&node("join")).unwrap().status(),
        AttemptStatus::Pending
    );

    let state = complete(state, "right", "completed", 12);
    assert_eq!(
        state.current_attempt(&node("join")).unwrap().status(),
        AttemptStatus::Ready
    );
    assert_eq!(state.ready_queue()[0].node_id(), &node("join"));
}

#[test]
fn orders_equally_enqueued_roots_by_node_id() {
    let state = GraphState::initialize(roots_in_reverse_definition_order(), 10);

    assert_eq!(state.ready_queue().len(), 2);
    assert_eq!(state.ready_queue()[0].node_id(), &node("alpha"));
    assert_eq!(state.ready_queue()[1].node_id(), &node("zeta"));
    assert_eq!(restore_oracle(state.clone()).unwrap(), state);
}

#[test]
fn rejects_unknown_node_outcomes() {
    let state = GraphState::initialize(simple_definition(None), 10);
    let fence = state
        .current_attempt(&node("start"))
        .unwrap()
        .fence()
        .clone();

    let error = reduce(
        state,
        GraphEvent::NodeCompleted {
            node_id: node("missing"),
            fence,
            output_port: "completed".into(),
            completed_at: 11,
        },
    )
    .unwrap_err();

    assert_eq!(error, super::ReduceError::UnknownNode(node("missing")));
}

#[test]
fn rejects_duplicate_or_conflicting_terminal_outcomes() {
    let state = GraphState::initialize(simple_definition(None), 10);
    let start = node("start");
    let fence = state.current_attempt(&start).unwrap().fence().clone();
    let state = reduce(
        state,
        GraphEvent::NodeCompleted {
            node_id: start.clone(),
            fence: fence.clone(),
            output_port: "completed".into(),
            completed_at: 11,
        },
    )
    .unwrap();

    for event in [
        GraphEvent::NodeCompleted {
            node_id: start.clone(),
            fence: fence.clone(),
            output_port: "completed".into(),
            completed_at: 12,
        },
        GraphEvent::NodeFailed {
            node_id: start.clone(),
            fence,
            output_port: "failed".into(),
            failed_at: 12,
        },
    ] {
        assert_eq!(
            reduce(state.clone(), event),
            Err(super::ReduceError::InvalidTransition {
                node_id: start.clone(),
                status: AttemptStatus::Completed,
            })
        );
    }
    assert_eq!(
        state.current_attempt(&start).unwrap().status(),
        AttemptStatus::Completed
    );
    assert_eq!(
        state.current_attempt(&node("work")).unwrap().status(),
        AttemptStatus::Ready
    );
}

#[test]
fn stale_completion_cannot_mutate_a_reworked_attempt() {
    let state = GraphState::initialize(simple_definition(None), 10);
    let old_fence = state
        .current_attempt(&node("start"))
        .unwrap()
        .fence()
        .clone();
    let state = reduce(
        state,
        GraphEvent::ReworkRequested {
            node_id: node("start"),
            requested_at: 11,
        },
    )
    .unwrap();

    let error = reduce(
        state.clone(),
        GraphEvent::NodeCompleted {
            node_id: node("start"),
            fence: old_fence,
            output_port: "completed".into(),
            completed_at: 12,
        },
    )
    .unwrap_err();
    assert!(matches!(error, super::ReduceError::StaleFence { .. }));
    assert_eq!(
        state.current_attempt(&node("start")).unwrap().status(),
        AttemptStatus::Ready
    );
    assert_eq!(
        state.current_attempt(&node("work")).unwrap().status(),
        AttemptStatus::Pending
    );
}

#[test]
fn repeated_trigger_discards_reachable_stale_queue_items() {
    let definition = simple_definition(Some(StartTrigger::Cron {
        expression: "* * * * *".into(),
    }));
    let state = GraphState::initialize(definition, 10);
    let state = reduce(
        state,
        GraphEvent::TriggerFired {
            node_id: node("start"),
            fired_at: 11,
        },
    )
    .unwrap();
    let state = complete(state, "start", "completed", 12);
    let old_work_fence = state
        .current_attempt(&node("work"))
        .unwrap()
        .fence()
        .clone();
    assert_eq!(state.ready_queue()[0].fence(), &old_work_fence);

    let state = reduce(
        state,
        GraphEvent::TriggerFired {
            node_id: node("start"),
            fired_at: 13,
        },
    )
    .unwrap();

    assert_eq!(state.ready_queue().len(), 1);
    assert_eq!(state.ready_queue()[0].node_id(), &node("start"));
    assert_ne!(
        state.current_attempt(&node("work")).unwrap().fence(),
        &old_work_fence
    );
    assert_eq!(
        state.current_attempt(&node("work")).unwrap().status(),
        AttemptStatus::Pending
    );
    assert_eq!(restore_oracle(state.clone()).unwrap(), state);
}

#[test]
fn restore_oracle_rejects_a_noncanonical_ready_queue() {
    let mut state = GraphState::initialize(roots_in_reverse_definition_order(), 10);
    state.reverse_ready_queue_for_test();

    assert_eq!(
        restore_oracle(state),
        Err(super::RestoreError::NonCanonicalReadyQueue)
    );
}

#[test]
fn restore_oracle_rejects_a_corrupted_historical_fence() {
    let mut state = GraphState::initialize(simple_definition(None), 10);
    let start = node("start");
    let incorrect_attempt = AttemptId::for_node(&start, NonZeroU32::new(2).unwrap());
    state.replace_attempt_fence_for_test(
        &start,
        0,
        ExecutionFence::new(
            incorrect_attempt.clone(),
            NodeExecutionId::for_attempt(&incorrect_attempt),
        ),
    );

    assert_eq!(
        restore_oracle(state),
        Err(super::RestoreError::InvalidAttemptFence {
            node_id: start,
            number: NonZeroU32::MIN,
        })
    );
}

#[test]
fn restore_oracle_rejects_an_output_on_a_nonterminal_attempt() {
    let mut state = GraphState::initialize(simple_definition(None), 10);
    let start = node("start");
    state.set_attempt_output_port_for_test(&start, 0, Some("completed"));

    assert_eq!(
        restore_oracle(state),
        Err(super::RestoreError::NonTerminalAttemptHasOutput {
            node_id: start,
            number: NonZeroU32::MIN,
        })
    );
}

#[test]
fn definition_rejects_an_empty_graph_title() {
    let error = GraphDefinition::new(
        "graph-empty-title",
        "plan-empty-title",
        GraphRunId::new("run-empty-title"),
        " ",
        vec![NodeDefinition::start(
            node("start"),
            "Start",
            attempts(),
            None,
        )],
        Vec::new(),
    )
    .unwrap_err();

    assert_eq!(error, DefinitionError::EmptyGraphTitle);
}

#[test]
fn restore_oracle_keeps_projection_and_reducer_behavior() {
    let state = GraphState::initialize(simple_definition(None), 10);
    let state = complete(state, "start", "completed", 11);
    let projection = project(&state);
    let restored = restore_oracle(state).unwrap();

    assert_eq!(project(&restored), projection);
    let restored = complete(restored, "work", "completed", 12);
    assert_eq!(restored.ready_queue()[0].node_id(), &node("end"));
}

#[test]
fn durable_snapshot_round_trips_projection_and_reducer_behavior() {
    let state = GraphState::initialize(simple_definition(None), 10);
    let state = complete(state, "start", "completed", 11);
    let projection = project(&state);
    let restored = GraphState::restore_durable(state.durable_snapshot()).unwrap();

    assert_eq!(project(&restored), projection);
    let restored = complete(restored, "work", "completed", 12);
    assert_eq!(restored.ready_queue()[0].node_id(), &node("end"));
}

#[test]
fn durable_snapshot_round_trips_full_node_and_edge_metadata() {
    let state = GraphState::initialize(rich_definition(), 10);
    let snapshot = state.durable_snapshot();
    let restored = GraphState::restore_durable(snapshot.clone()).unwrap();

    assert_eq!(restored.definition(), state.definition());
    assert_eq!(restored.durable_snapshot(), snapshot);
    assert!(restored.definition().nodes()[0].is_control());
    assert_eq!(
        restored.definition().nodes()[2]
            .work_assignment()
            .unwrap()
            .prompt(),
        "work instruction"
    );
    assert_eq!(
        restored.definition().nodes()[2]
            .work_assignment()
            .unwrap()
            .output_artifact_kind(),
        Some("artifact-report")
    );
    assert_eq!(
        restored.definition().nodes()[2]
            .work_assignment()
            .unwrap()
            .group_id()
            .unwrap()
            .as_str(),
        "group-work"
    );
    assert_eq!(
        restored.definition().nodes()[3]
            .review_assignment()
            .unwrap()
            .role_id(),
        "role-review"
    );
    assert_eq!(
        restored.definition().nodes()[3]
            .review_assignment()
            .unwrap()
            .prompt(),
        "review instruction"
    );
    assert_eq!(
        restored.definition().nodes()[4]
            .work_group()
            .unwrap()
            .join_policy(),
        &JoinPolicy::new(true, false, 2)
    );
    assert!(
        !restored.definition().edges()[1]
            .payload()
            .include_upstream_result()
    );
    assert_eq!(
        restored.definition().edges()[1]
            .dependency()
            .unwrap()
            .dependency_task_id(),
        "task-start"
    );
    assert_eq!(
        restored.definition().edges()[1]
            .dependency()
            .unwrap()
            .task_id(),
        "task-work"
    );
}

#[test]
fn durable_restore_rejects_control_marker_payload_mismatches() {
    let state = GraphState::initialize(rich_definition(), 10);

    let mut typed_review = state.durable_snapshot();
    typed_review
        .nodes
        .iter_mut()
        .find(|node| node.id == "review")
        .unwrap()
        .is_control = true;
    assert!(matches!(
        GraphState::restore_durable(typed_review),
        Err(DurableRestoreError::InvalidNodeSnapshot { .. })
    ));

    let mut control_join = state.durable_snapshot();
    control_join
        .nodes
        .iter_mut()
        .find(|node| node.id == "control-join")
        .unwrap()
        .is_control = false;
    assert!(matches!(
        GraphState::restore_durable(control_join),
        Err(DurableRestoreError::InvalidNodeSnapshot { .. })
    ));
}

#[test]
fn durable_snapshot_preserves_display_and_trigger_semantics() {
    let state = GraphState::initialize(
        GraphDefinition::new(
            "graph-display",
            "plan-display",
            GraphRunId::new("run-display"),
            "Team release graph",
            vec![
                NodeDefinition::start(
                    node("webhook"),
                    "Webhook intake",
                    attempts(),
                    Some(StartTrigger::Webhook {
                        path: "/team/release".into(),
                    }),
                ),
                NodeDefinition::start(
                    node("cron"),
                    "Daily reconciliation",
                    attempts(),
                    Some(StartTrigger::Cron {
                        expression: "0 9 * * 1-5".into(),
                    }),
                ),
            ],
            Vec::new(),
        )
        .unwrap(),
        10,
    );

    let restored = GraphState::restore_durable(state.durable_snapshot()).unwrap();
    assert_eq!(restored.definition().title(), "Team release graph");
    assert_eq!(restored.definition().nodes()[0].title(), "Webhook intake");
    assert_eq!(
        restored.definition().nodes()[0].trigger(),
        Some(&StartTrigger::Webhook {
            path: "/team/release".into(),
        })
    );
    assert_eq!(
        restored.definition().nodes()[1].title(),
        "Daily reconciliation"
    );
    assert_eq!(
        restored.definition().nodes()[1].trigger(),
        Some(&StartTrigger::Cron {
            expression: "0 9 * * 1-5".into(),
        })
    );
}

#[test]
fn durable_restore_preserves_armed_trigger_semantics() {
    let state = GraphState::initialize(
        simple_definition(Some(StartTrigger::Webhook {
            path: "/non-durable-trigger-path".into(),
        })),
        10,
    );

    let restored = GraphState::restore_durable(state.durable_snapshot()).unwrap();
    assert!(restored.ready_queue().is_empty());
    let restored = reduce(
        restored,
        GraphEvent::TriggerFired {
            node_id: node("start"),
            fired_at: 11,
        },
    )
    .unwrap();
    assert_eq!(restored.ready_queue()[0].node_id(), &node("start"));
}

#[test]
fn durable_restore_keeps_distinct_display_facts_distinct() {
    let left = GraphState::initialize(
        GraphDefinition::new(
            "graph-title-left",
            "plan-title",
            GraphRunId::new("run-title"),
            "first graph title",
            vec![NodeDefinition::start(
                node("start"),
                "first node title",
                attempts(),
                None,
            )],
            Vec::new(),
        )
        .unwrap(),
        10,
    );
    let right = GraphState::initialize(
        GraphDefinition::new(
            "graph-title-left",
            "plan-title",
            GraphRunId::new("run-title"),
            "second graph title",
            vec![NodeDefinition::start(
                node("start"),
                "second node title",
                attempts(),
                None,
            )],
            Vec::new(),
        )
        .unwrap(),
        10,
    );

    let restored_left = GraphState::restore_durable(left.durable_snapshot()).unwrap();
    let restored_right = GraphState::restore_durable(right.durable_snapshot()).unwrap();
    assert_ne!(
        restored_left.definition().title(),
        restored_right.definition().title()
    );
    assert_ne!(
        restored_left.definition().nodes()[0].title(),
        restored_right.definition().nodes()[0].title()
    );
}

#[test]
fn durable_restore_rejects_corrupted_node_fence_queue_and_attempt_data() {
    let state = GraphState::initialize(simple_definition(None), 10);

    let mut node_snapshot = state.durable_snapshot();
    node_snapshot.nodes[0].order = 1;
    assert_eq!(
        GraphState::restore_durable(node_snapshot),
        Err(DurableRestoreError::NonCanonicalNodeOrder)
    );

    let mut fence_snapshot = state.durable_snapshot();
    fence_snapshot.executions[0].attempts[0].fence.attempt_id = "wrong".into();
    assert!(matches!(
        GraphState::restore_durable(fence_snapshot),
        Err(DurableRestoreError::InvalidState(
            super::RestoreError::InvalidAttemptFence { .. }
        ))
    ));

    let mut queue_snapshot = state.durable_snapshot();
    queue_snapshot.ready_queue[0].node_id = "work".into();
    assert!(matches!(
        GraphState::restore_durable(queue_snapshot),
        Err(DurableRestoreError::InvalidState(
            super::RestoreError::QueueContainsStaleFence(_)
        ))
    ));

    let mut attempt_snapshot = state.durable_snapshot();
    attempt_snapshot.executions[0].attempts[0].number = 0;
    assert!(matches!(
        GraphState::restore_durable(attempt_snapshot),
        Err(DurableRestoreError::InvalidAttemptNumber { .. })
    ));

    let mut node_mismatch_snapshot = state.durable_snapshot();
    node_mismatch_snapshot.executions[0].attempts[0].node_id = "work".into();
    assert!(matches!(
        GraphState::restore_durable(node_mismatch_snapshot),
        Err(DurableRestoreError::InvalidState(
            super::RestoreError::InvalidAttemptNode { .. }
        ))
    ));

    let completed = complete(state, "start", "completed", 11);
    let mut input_snapshot = completed.durable_snapshot();
    input_snapshot
        .executions
        .iter_mut()
        .find(|execution| execution.node_id == "work")
        .unwrap()
        .attempts[0]
        .inputs[0]
        .edge_id = "missing-edge".into();
    assert!(matches!(
        GraphState::restore_durable(input_snapshot),
        Err(DurableRestoreError::InvalidAttemptInputs { .. })
    ));
}

#[test]
fn durable_restore_rejects_propagation_that_arrived_before_the_target_attempt_existed() {
    let state = complete(
        GraphState::initialize(simple_definition(None), 10),
        "start",
        "completed",
        11,
    );
    let mut snapshot = state.durable_snapshot();
    let work = snapshot
        .executions
        .iter_mut()
        .find(|execution| execution.node_id == "work")
        .unwrap();
    work.attempts[0].created_at = 12;
    work.attempts[0].updated_at = 13;

    assert!(matches!(
        GraphState::restore_durable(snapshot),
        Err(DurableRestoreError::InvalidInputTimestamp { .. })
    ));
}

#[test]
fn rejects_cyclic_activation_graphs() {
    let error = GraphDefinition::new(
        "graph-cycle",
        "plan-cycle",
        GraphRunId::new("run-cycle"),
        "Cycle",
        vec![
            NodeDefinition::work(
                node("one"),
                "One",
                attempts(),
                WorkAssignment::new("task-one", "role-one"),
            ),
            NodeDefinition::work(
                node("two"),
                "Two",
                attempts(),
                WorkAssignment::new("task-two", "role-two"),
            ),
        ],
        vec![
            edge("one-two", "one", "completed", "two", EdgeAction::Activate),
            edge("two-one", "two", "completed", "one", EdgeAction::Activate),
        ],
    )
    .unwrap_err();

    assert!(matches!(error, DefinitionError::ActivationCycle(_)));
}

#[test]
fn validates_agent_node_edge_ports_and_rework_action() {
    let work_default = GraphDefinition::new(
        "graph-work-default",
        "plan-work-default",
        GraphRunId::new("run-work-default"),
        "Work default",
        vec![
            NodeDefinition::work(
                node("work"),
                "Work",
                attempts(),
                WorkAssignment::new("task-work", "role-work"),
            ),
            NodeDefinition::control(node("end"), NodeKind::End, "End", attempts()),
        ],
        vec![edge(
            "work-end",
            "work",
            "default",
            "end",
            EdgeAction::Finish,
        )],
    )
    .unwrap_err();
    assert_eq!(
        work_default,
        DefinitionError::InvalidWorkEdgeSourcePort {
            edge_id: EdgeId::new("work-end"),
            source_port: "default".into(),
        }
    );

    let completed_rework = GraphDefinition::new(
        "graph-completed-rework",
        "plan-completed-rework",
        GraphRunId::new("run-completed-rework"),
        "Completed rework",
        vec![
            NodeDefinition::work(
                node("work"),
                "Work",
                attempts(),
                WorkAssignment::new("task-work", "role-work"),
            ),
            NodeDefinition::work(
                node("target"),
                "Target",
                attempts(),
                WorkAssignment::new("task-target", "role-target"),
            ),
        ],
        vec![edge(
            "completed-rework",
            "work",
            "completed",
            "target",
            EdgeAction::Rework,
        )],
    )
    .unwrap_err();
    assert_eq!(
        completed_rework,
        DefinitionError::InvalidCompletedEdgeAction(EdgeId::new("completed-rework"))
    );

    let rework_activate = GraphDefinition::new(
        "graph-rework-activate",
        "plan-rework-activate",
        GraphRunId::new("run-rework-activate"),
        "Rework activate",
        vec![
            NodeDefinition::review(
                node("review"),
                "Review",
                attempts(),
                ReviewAssignment::new("role-review", "review prompt"),
            ),
            NodeDefinition::work(
                node("target"),
                "Target",
                attempts(),
                WorkAssignment::new("task-target", "role-target"),
            ),
        ],
        vec![edge(
            "rework-activate",
            "review",
            "rework",
            "target",
            EdgeAction::Activate,
        )],
    )
    .unwrap_err();
    assert_eq!(
        rework_activate,
        DefinitionError::InvalidReworkEdgeAction(EdgeId::new("rework-activate"))
    );

    let review_approved = GraphDefinition::new(
        "graph-review-approved",
        "plan-review-approved",
        GraphRunId::new("run-review-approved"),
        "Review approved",
        vec![
            NodeDefinition::review(
                node("review"),
                "Review",
                attempts(),
                ReviewAssignment::new("role-review", "review prompt"),
            ),
            NodeDefinition::work(
                node("target"),
                "Target",
                attempts(),
                WorkAssignment::new("task-target", "role-target"),
            ),
        ],
        vec![edge(
            "review-approved",
            "review",
            "approved",
            "target",
            EdgeAction::Activate,
        )],
    )
    .unwrap_err();
    assert_eq!(
        review_approved,
        DefinitionError::InvalidReviewEdgeSourcePort {
            edge_id: EdgeId::new("review-approved"),
            source_port: "approved".into(),
        }
    );

    let valid = GraphDefinition::new(
        "graph-review-valid",
        "plan-review-valid",
        GraphRunId::new("run-review-valid"),
        "Review valid",
        vec![
            NodeDefinition::review(
                node("review"),
                "Review",
                attempts(),
                ReviewAssignment::new("role-review", "review prompt"),
            ),
            NodeDefinition::work(
                node("work"),
                "Work",
                attempts(),
                WorkAssignment::new("task-work", "role-work"),
            ),
        ],
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
    assert!(valid.is_ok());
}

#[test]
fn keeps_control_node_internal_ports_available() {
    let definition = GraphDefinition::new(
        "graph-control-ports",
        "plan-control-ports",
        GraphRunId::new("run-control-ports"),
        "Control ports",
        vec![
            NodeDefinition::start(node("start"), "Start", attempts(), None),
            NodeDefinition::control(
                node("human-decision"),
                NodeKind::HumanDecision,
                "Decision",
                attempts(),
            ),
            NodeDefinition::control(
                node("script-review"),
                NodeKind::ScriptReview,
                "Script review",
                attempts(),
            ),
            NodeDefinition::control(node("join"), NodeKind::Join, "Join", attempts()),
            NodeDefinition::control(node("end"), NodeKind::End, "End", attempts()),
        ],
        vec![
            edge(
                "start-decision",
                "start",
                "completed",
                "human-decision",
                EdgeAction::Activate,
            ),
            edge(
                "decision-approved",
                "human-decision",
                "approved",
                "script-review",
                EdgeAction::Activate,
            ),
            edge(
                "decision-rejected",
                "human-decision",
                "rejected",
                "end",
                EdgeAction::Finish,
            ),
            edge(
                "decision-aborted",
                "human-decision",
                "aborted",
                "end",
                EdgeAction::Finish,
            ),
            edge(
                "script-approved",
                "script-review",
                "approved",
                "join",
                EdgeAction::Gate,
            ),
            edge("join-end", "join", "joined", "end", EdgeAction::Finish),
        ],
    );

    assert!(definition.is_ok());
}
