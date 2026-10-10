use serde_json::{Value, json};

use crate::{
    ActivityKind, ActivityPhase, DeliveryId, DeliveryPhase, EdgeAction,
    GraphPatchOperation, GraphRunFacts, GraphRunId, GraphRunLifecycleState, NodeExecutionId,
    NodeId, NodeKind, OrganizationFacts, OrganizationStore, RunStartGate, StoreFault,
    TeamGraphPatchDraft, TeamId, run::event::OpaqueId,
};

use super::{RuntimeGraphError, codec::graph_version};

#[derive(Clone)]
pub struct TeamRunExecutionScope {
    pub team_id: TeamId,
    pub run_id: GraphRunId,
    pub node_id: NodeId,
    pub node_execution_id: NodeExecutionId,
}

impl TeamRunExecutionScope {
    pub fn try_new(
        team_id: String,
        run_id: String,
        node_id: String,
        node_execution_id: String,
    ) -> Result<Self, ()> {
        let run_id = OpaqueId::try_new(run_id).map_err(|_| ())?;
        let node_id = OpaqueId::try_new(node_id).map_err(|_| ())?;
        let node_execution_id = OpaqueId::try_new(node_execution_id).map_err(|_| ())?;
        Ok(Self {
            team_id: TeamId::try_new(team_id).map_err(|_| ())?,
            run_id: GraphRunId::new(run_id.as_str()),
            node_id: NodeId::new(node_id.as_str()),
            node_execution_id: NodeExecutionId::from_durable(node_execution_id.as_str().to_owned()),
        })
    }
}

pub(crate) struct NodePromptPatch {
    pub node_id: NodeId,
    pub prompt: String,
}

pub(crate) struct RuntimePromptPatch {
    pub command_id: OpaqueId,
    pub idempotency_key: OpaqueId,
    pub expected_graph_version: String,
    pub operations: Vec<NodePromptPatch>,
    pub created_at: u64,
}

impl OrganizationStore {
    pub(crate) fn runtime_graph_context(
        &mut self,
        scope: &TeamRunExecutionScope,
    ) -> Result<Value, StoreFault> {
        self.read_locked(|facts| {
            let run = execution_run(facts, scope)?;
            let definition = run.graph().definition();
            let nodes = definition
                .nodes()
                .iter()
                .map(|node| {
                    let kind = match node.kind() {
                        NodeKind::Start => "start",
                        NodeKind::Work => "work",
                        NodeKind::Review => "review",
                        NodeKind::HumanDecision => "human_decision",
                        NodeKind::ScriptReview => "script_review",
                        NodeKind::Join => "join",
                        NodeKind::End => "end",
                    };
                    let mut value =
                        json!({"nodeId": node.id().as_str(), "kind": kind, "title": node.title()});
                    if let Some((role, prompt)) = node
                        .work_assignment()
                        .map(|work| (work.role_id(), work.prompt()))
                        .or_else(|| {
                            node.review_assignment()
                                .map(|review| (review.role_id(), review.prompt()))
                        })
                    {
                        value["roleId"] = json!(role);
                        value["prompt"] = json!(prompt);
                    }
                    value
                })
                .collect::<Vec<_>>();
            let edges = definition
                .edges()
                .iter()
                .map(|edge| {
                    json!({
                        "edgeId": edge.id().as_str(),
                        "sourceNodeId": edge.source_node_id().as_str(),
                        "sourcePort": edge.source_port(),
                        "targetNodeId": edge.target_node_id().as_str(),
                        "targetPort": edge.target_port(),
                        "action": match edge.action() {
                            EdgeAction::Activate => "activate",
                            EdgeAction::Rework => "rework",
                            EdgeAction::Gate => "gate",
                            EdgeAction::Finish => "finish",
                        },
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "outcome": "available", "teamId": scope.team_id.as_str(),
                "runId": scope.run_id.as_str(), "graphVersion": graph_version(definition)?,
                "nodes": nodes, "edges": edges,
            }))
        })
    }

    pub(crate) fn runtime_graph_patch(
        &mut self,
        scope: &TeamRunExecutionScope,
        patch: RuntimePromptPatch,
    ) -> Result<Value, StoreFault> {
        self.transact(|facts| {
            let run = execution_run(facts, scope)?;
            let definition = run.graph().definition();
            let mut operations = Vec::with_capacity(patch.operations.len());
            for operation in patch.operations {
                let mut node = definition
                    .node(&operation.node_id)
                    .cloned()
                    .ok_or_else(|| {
                        StoreFault::RuntimeGraph(RuntimeGraphError::UnknownNode(
                            operation.node_id.clone(),
                        ))
                    })?;
                if operation.prompt.trim().is_empty() {
                    return Err(StoreFault::RuntimeGraph(RuntimeGraphError::EmptyPrompt(
                        operation.node_id,
                    )));
                }
                if !node.set_agent_prompt(operation.prompt) {
                    return Err(StoreFault::RuntimeGraph(RuntimeGraphError::InvalidNode(
                        operation.node_id,
                    )));
                }
                operations.push(GraphPatchOperation::ReplaceNode(node));
            }
            let draft = TeamGraphPatchDraft::new(
                scope.run_id.clone(),
                OpaqueId::try_new(scope.run_id.as_str()).map_err(StoreFault::GraphPatchInput)?,
                patch.command_id,
                patch.idempotency_key,
                None,
                None,
                operations,
                patch.created_at,
            );
            let command = draft.command(definition)?;
            let replayed = if let Some(existing) = facts
                .events()
                .command_by_idempotency(command.run_id(), command.idempotency_key())
            {
                if existing.command().command_id() != command.command_id()
                    || existing.command().payload() != command.payload()
                {
                    return Err(StoreFault::EventLedger(
                        crate::RecordCommandError::IdempotencyConflict,
                    ));
                }
                true
            } else {
                if graph_version(definition)? != patch.expected_graph_version {
                    return Err(StoreFault::RuntimeGraph(
                        RuntimeGraphError::StaleGraphVersion,
                    ));
                }
                let graph_patch = draft.resolve(definition, run.runtime().map_or(&[], |runtime| runtime.bindings()))?;
                facts.team_graph_patch(command, &graph_patch)?;
                false
            };
            let definition = facts
                .run(&scope.run_id)
                .ok_or(StoreFault::InvalidFacts)?
                .graph()
                .definition();
            Ok(json!({
                "success": true, "outcome": if replayed { "replayed" } else { "applied" },
                "teamId": scope.team_id.as_str(), "runId": scope.run_id.as_str(),
                "graphVersion": graph_version(definition)?,
            }))
        })
    }
}

fn execution_run<'a>(
    facts: &'a OrganizationFacts,
    scope: &TeamRunExecutionScope,
) -> Result<&'a GraphRunFacts, StoreFault> {
    let run = facts
        .run(&scope.run_id)
        .ok_or(StoreFault::RuntimeGraph(RuntimeGraphError::UnknownRun))?;
    if run.team() != &scope.team_id {
        return Err(StoreFault::RuntimeGraph(RuntimeGraphError::TeamMismatch));
    }
    if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
        || !matches!(run.start_gate(), RunStartGate::Started)
        || facts
            .team(&scope.team_id)
            .is_none_or(|team| team.tombstoned())
    {
        return Err(StoreFault::RuntimeGraph(RuntimeGraphError::RunInactive));
    }
    let inactive = || StoreFault::RuntimeGraph(RuntimeGraphError::ExecutionInactive);
    let current = run
        .graph()
        .current_attempt(&scope.node_id)
        .ok_or_else(inactive)?;
    if current.fence().node_execution_id() != &scope.node_execution_id {
        return Err(inactive());
    }
    let activity_key = crate::run::scheduler::activity_idempotency_key(&scope.run_id, current.fence());
    let activity = facts
        .activities()
        .activity_by_idempotency_key(scope.run_id.as_str(), &activity_key)
        .ok_or_else(inactive)?;
    let request = activity.facts();
    let delivery_id = DeliveryId::new(request.activity_id.as_str()).map_err(|_| inactive())?;
    let delivery = facts
        .deliveries()
        .delivery(&delivery_id)
        .ok_or_else(inactive)?;
    let ActivityKind::AgentTask {
        task_id,
        role_id,
        session_ref,
        prompt,
    } = &request.activity_kind
    else {
        return Err(inactive());
    };
    let target = delivery.facts();
    if target.team_id != scope.team_id.as_str()
        || target.run_id != scope.run_id.as_str()
        || request.run_id != scope.run_id
        || request.node_id != scope.node_id
        || target.node_id != request.node_id.as_str()
        || target.node_execution_id != scope.node_execution_id.as_str()
        || request.fence.node_execution_id() != &scope.node_execution_id
        || current.fence() != &request.fence
        || !matches!(current.node_kind(), NodeKind::Work | NodeKind::Review)
        || !current.status().accepts_outcome()
        || target.task_id != *task_id
        || target.role_id != *role_id
        || target.session_ref != *session_ref
        || target.message != *prompt
        || !matches!(
            activity.phase(),
            ActivityPhase::Claimed(_) | ActivityPhase::Dispatched(_)
        )
        || !matches!(
            delivery.phase(),
            DeliveryPhase::Delivering(_) | DeliveryPhase::Delivered { .. }
        )
    {
        return Err(inactive());
    }
    Ok(run)
}
