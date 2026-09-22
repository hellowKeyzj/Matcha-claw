//! Pure TeamRun control executor. Host integration should attribute emitted steps to
//! `ActivityKind::Control`; this domain crate does not define the shared activity enum.

use crate::run::graph::{
    AttemptStatus, ExecutionFence, GraphDefinition, GraphEvent, GraphState, NodeId, NodeKind,
    ReduceError, reduce,
};

use super::{ControlNodeResolution, ControlNodeResolutionError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlExecutionPlan {
    steps: Vec<ControlExecutionStep>,
}

impl ControlExecutionPlan {
    pub fn steps(&self) -> &[ControlExecutionStep] {
        &self.steps
    }

    pub fn into_steps(self) -> Vec<ControlExecutionStep> {
        self.steps
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlExecutionStep {
    GraphEvent(GraphEvent),
    ControlResolution(ControlNodeResolution),
}

impl ControlExecutionStep {
    pub fn node_id(&self) -> &NodeId {
        match self {
            Self::GraphEvent(event) => graph_event_node_id(event),
            Self::ControlResolution(resolution) => resolution.node_id(),
        }
    }

    pub fn fence(&self) -> Option<&ExecutionFence> {
        match self {
            Self::GraphEvent(event) => graph_event_fence(event),
            Self::ControlResolution(resolution) => Some(resolution.fence()),
        }
    }

    pub fn resolved_at(&self) -> u64 {
        match self {
            Self::GraphEvent(event) => graph_event_at(event),
            Self::ControlResolution(resolution) => resolution.resolved_at(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlExecutionError {
    GraphDefinitionMismatch,
    UnknownReadyNode(NodeId),
    StaleReadyQueue(NodeId),
    OutputPortDoesNotMatchEdge { node_id: NodeId },
    ControlResolution(ControlNodeResolutionError),
    Reduce(ReduceError),
}

pub fn plan_ready_control_execution(
    definition: &GraphDefinition,
    graph: &GraphState,
    now: u64,
) -> Result<ControlExecutionPlan, ControlExecutionError> {
    if definition != graph.definition() {
        return Err(ControlExecutionError::GraphDefinitionMismatch);
    }

    let mut state = graph.clone();
    let mut steps = Vec::new();
    while let Some(step) = next_ready_control_step(definition, &state, now)? {
        let event = graph_event_for_step(&step);
        state = reduce(state, event).map_err(ControlExecutionError::Reduce)?;
        steps.push(step);
    }
    Ok(ControlExecutionPlan { steps })
}

fn next_ready_control_step(
    definition: &GraphDefinition,
    graph: &GraphState,
    now: u64,
) -> Result<Option<ControlExecutionStep>, ControlExecutionError> {
    for item in graph.ready_queue() {
        let attempt = graph
            .current_attempt(item.node_id())
            .ok_or_else(|| ControlExecutionError::UnknownReadyNode(item.node_id().clone()))?;
        if attempt.status() != AttemptStatus::Ready || attempt.fence() != item.fence() {
            return Err(ControlExecutionError::StaleReadyQueue(
                item.node_id().clone(),
            ));
        }
        let node = definition
            .node(item.node_id())
            .ok_or_else(|| ControlExecutionError::UnknownReadyNode(item.node_id().clone()))?;
        let step = match node.kind() {
            NodeKind::Start | NodeKind::End => {
                let output_port = "completed";
                require_existing_output_port(definition, item.node_id(), output_port)?;
                ControlExecutionStep::GraphEvent(GraphEvent::NodeCompleted {
                    node_id: item.node_id().clone(),
                    fence: item.fence().clone(),
                    output_port: output_port.to_owned(),
                    completed_at: now,
                })
            }
            NodeKind::Join => {
                let output_port = "joined";
                require_existing_output_port(definition, item.node_id(), output_port)?;
                ControlExecutionStep::ControlResolution(
                    ControlNodeResolution::join(
                        definition.run_id().clone(),
                        item.node_id().clone(),
                        item.fence().clone(),
                        graph,
                        now,
                    )
                    .map_err(ControlExecutionError::ControlResolution)?,
                )
            }
            NodeKind::Work
            | NodeKind::Review
            | NodeKind::HumanDecision
            | NodeKind::ScriptReview => {
                continue;
            }
        };
        return Ok(Some(step));
    }
    Ok(None)
}

fn require_existing_output_port(
    definition: &GraphDefinition,
    node_id: &NodeId,
    output_port: &str,
) -> Result<(), ControlExecutionError> {
    let mut outgoing = definition.outgoing_edges(node_id);
    match outgoing.next() {
        None => Ok(()),
        Some(first) if first.source_port() == output_port => Ok(()),
        Some(_) if outgoing.any(|edge| edge.source_port() == output_port) => Ok(()),
        Some(_) => Err(ControlExecutionError::OutputPortDoesNotMatchEdge {
            node_id: node_id.clone(),
        }),
    }
}

fn graph_event_node_id(event: &GraphEvent) -> &NodeId {
    match event {
        GraphEvent::AttemptStarted { node_id, .. }
        | GraphEvent::NodeWaiting { node_id, .. }
        | GraphEvent::NodeCompleted { node_id, .. }
        | GraphEvent::NodeFailed { node_id, .. }
        | GraphEvent::NodeCancelled { node_id, .. }
        | GraphEvent::ReworkRequested { node_id, .. }
        | GraphEvent::TriggerFired { node_id, .. } => node_id,
        GraphEvent::GraphPatched { .. } => {
            unreachable!("control execution never emits graph patches")
        }
    }
}

fn graph_event_fence(event: &GraphEvent) -> Option<&ExecutionFence> {
    match event {
        GraphEvent::AttemptStarted { fence, .. }
        | GraphEvent::NodeWaiting { fence, .. }
        | GraphEvent::NodeCompleted { fence, .. }
        | GraphEvent::NodeFailed { fence, .. }
        | GraphEvent::NodeCancelled { fence, .. } => Some(fence),
        GraphEvent::ReworkRequested { .. }
        | GraphEvent::TriggerFired { .. }
        | GraphEvent::GraphPatched { .. } => None,
    }
}

fn graph_event_at(event: &GraphEvent) -> u64 {
    match event {
        GraphEvent::AttemptStarted { started_at, .. } => *started_at,
        GraphEvent::NodeWaiting { waiting_at, .. } => *waiting_at,
        GraphEvent::NodeCompleted { completed_at, .. } => *completed_at,
        GraphEvent::NodeFailed { failed_at, .. } => *failed_at,
        GraphEvent::NodeCancelled { cancelled_at, .. } => *cancelled_at,
        GraphEvent::ReworkRequested { requested_at, .. } => *requested_at,
        GraphEvent::TriggerFired { fired_at, .. } => *fired_at,
        GraphEvent::GraphPatched { patched_at, .. } => *patched_at,
    }
}

fn graph_event_for_step(step: &ControlExecutionStep) -> GraphEvent {
    match step {
        ControlExecutionStep::GraphEvent(event) => event.clone(),
        ControlExecutionStep::ControlResolution(resolution) => match resolution.outcome() {
            crate::AuthorizedGraphOutcome::Completed => GraphEvent::NodeCompleted {
                node_id: resolution.node_id().clone(),
                fence: resolution.fence().clone(),
                output_port: resolution.output_port().to_owned(),
                completed_at: resolution.resolved_at(),
            },
            crate::AuthorizedGraphOutcome::Failed => GraphEvent::NodeFailed {
                node_id: resolution.node_id().clone(),
                fence: resolution.fence().clone(),
                output_port: resolution.output_port().to_owned(),
                failed_at: resolution.resolved_at(),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::graph::{
        EdgeAction, EdgeDefinition, EdgeId, GraphRunId, GraphStatus, NodeDefinition,
        WorkAssignment, project,
    };
    use std::num::NonZeroU32;

    fn attempts() -> NonZeroU32 {
        NonZeroU32::new(3).unwrap()
    }

    fn node(id: &str) -> NodeId {
        NodeId::new(id)
    }

    fn edge(
        id: &str,
        source: &str,
        port: &str,
        target: &str,
        action: EdgeAction,
    ) -> EdgeDefinition {
        EdgeDefinition::new(
            EdgeId::new(id),
            node(source),
            port,
            node(target),
            "input",
            action,
        )
    }

    fn start_work_end_definition() -> GraphDefinition {
        GraphDefinition::new(
            "graph-control",
            "plan-control",
            GraphRunId::new("run-control"),
            "control graph",
            vec![
                NodeDefinition::start(node("start"), "Start", attempts(), None),
                NodeDefinition::work(
                    node("work"),
                    "Work",
                    attempts(),
                    WorkAssignment::new("task-work", "role-work"),
                ),
                NodeDefinition::control(node("end"), NodeKind::End, "End", attempts()),
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

    fn join_end_definition() -> GraphDefinition {
        GraphDefinition::new(
            "graph-join",
            "plan-join",
            GraphRunId::new("run-join"),
            "join graph",
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
                NodeDefinition::control(node("join"), NodeKind::Join, "Join", attempts()),
                NodeDefinition::control(node("end"), NodeKind::End, "End", attempts()),
            ],
            vec![
                edge("left-join", "left", "completed", "join", EdgeAction::Gate),
                edge("right-join", "right", "completed", "join", EdgeAction::Gate),
                edge("join-end", "join", "joined", "end", EdgeAction::Finish),
            ],
        )
        .unwrap()
    }

    fn complete(state: GraphState, node_id: &str, at: u64) -> GraphState {
        let node_id = node(node_id);
        let fence = state.current_attempt(&node_id).unwrap().fence().clone();
        reduce(
            state,
            GraphEvent::NodeCompleted {
                node_id,
                fence,
                output_port: "completed".to_owned(),
                completed_at: at,
            },
        )
        .unwrap()
    }

    fn apply_plan(mut state: GraphState, plan: ControlExecutionPlan) -> GraphState {
        for step in plan.into_steps() {
            state = reduce(state, graph_event_for_step(&step)).unwrap();
        }
        state
    }

    #[test]
    fn start_completes_through_completed_port_and_activates_work() {
        let definition = start_work_end_definition();
        let state = GraphState::initialize(definition.clone(), 10);

        let plan = plan_ready_control_execution(&definition, &state, 11).unwrap();

        assert!(matches!(
            &plan.steps()[0],
            ControlExecutionStep::GraphEvent(GraphEvent::NodeCompleted { node_id, output_port, .. })
                if node_id == &node("start") && output_port == "completed"
        ));
        assert_eq!(plan.steps()[0].node_id(), &node("start"));
        assert!(plan.steps()[0].fence().is_some());
        assert_eq!(plan.steps()[0].resolved_at(), 11);
        let state = apply_plan(state, plan);
        assert_eq!(state.ready_queue()[0].node_id(), &node("work"));
        assert_eq!(
            state.current_attempt(&node("start")).unwrap().status(),
            AttemptStatus::Completed
        );
    }

    #[test]
    fn end_completes_through_completed_port_after_work_finishes() {
        let definition = start_work_end_definition();
        let state = GraphState::initialize(definition.clone(), 10);
        let state = apply_plan(
            state.clone(),
            plan_ready_control_execution(&definition, &state, 11).unwrap(),
        );
        let state = complete(state, "work", 12);

        let plan = plan_ready_control_execution(&definition, &state, 13).unwrap();

        assert!(matches!(
            &plan.steps()[0],
            ControlExecutionStep::GraphEvent(GraphEvent::NodeCompleted { node_id, output_port, .. })
                if node_id == &node("end") && output_port == "completed"
        ));
        let state = apply_plan(state, plan);
        assert_eq!(project(&state).status, GraphStatus::Completed);
    }

    #[test]
    fn join_completes_through_joined_port_and_advances_end() {
        let definition = join_end_definition();
        let state = GraphState::initialize(definition.clone(), 10);
        let state = complete(complete(state, "left", 11), "right", 12);

        let plan = plan_ready_control_execution(&definition, &state, 13).unwrap();

        assert_eq!(plan.steps().len(), 2);
        match &plan.steps()[0] {
            ControlExecutionStep::ControlResolution(resolution) => {
                assert_eq!(resolution.node_id(), &node("join"));
                assert_eq!(resolution.output_port(), "joined");
                assert_eq!(plan.steps()[0].node_id(), &node("join"));
                assert_eq!(plan.steps()[0].fence(), Some(resolution.fence()));
                assert_eq!(plan.steps()[0].resolved_at(), 13);
            }
            ControlExecutionStep::GraphEvent(_) => {
                panic!("join must resolve through control resolution")
            }
        }
        assert!(matches!(
            &plan.steps()[1],
            ControlExecutionStep::GraphEvent(GraphEvent::NodeCompleted { node_id, output_port, .. })
                if node_id == &node("end") && output_port == "completed"
        ));
        let state = apply_plan(state, plan);
        assert_eq!(project(&state).status, GraphStatus::Completed);
    }
}
