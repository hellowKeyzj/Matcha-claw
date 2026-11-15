use std::collections::{BTreeMap, BTreeSet};

use super::OrganizationFacts;
use crate::{
    ActivityKind, ActivityRequest, DeliveryPhase, GraphRunId, GraphState, NodeKind, StoreFault,
};

impl OrganizationFacts {
    pub(in crate::store) fn compose_activity_prompt(
        &self,
        request: ActivityRequest,
    ) -> Result<ActivityRequest, StoreFault> {
        let ActivityKind::AgentTask {
            task_id,
            role_id,
            session_ref,
            prompt: _,
        } = &request.activity_kind
        else {
            return Ok(request);
        };
        let run = self.run(&request.run_id).ok_or(StoreFault::InvalidFacts)?;
        let graph = run.graph();
        let node = graph
            .definition()
            .node(&request.node_id)
            .ok_or(StoreFault::InvalidFacts)?;
        let upstream = upstream_prompt_contexts(self, run.run_id(), graph, &request);
        let sources = upstream
            .iter()
            .map(|context| (context.source.node_id().as_str(), context.source.fence()))
            .collect::<BTreeSet<_>>();
        let input_artifact_ids = self
            .artifacts_for_run(run.run_id().as_str())
            .filter(|artifact| sources.contains(&(artifact.node_id(), artifact.fence())))
            .map(|artifact| artifact.artifact_id().clone())
            .collect();
        let prompt = organization::run::scheduler::compose_agent_task_prompt_with_upstream_context(
            run.team(),
            node,
            &request,
            &upstream,
            self.team_prompts(),
        )
        .ok_or(StoreFault::InvalidFacts)?;
        Ok(ActivityRequest {
            activity_kind: ActivityKind::AgentTask {
                task_id: task_id.clone(),
                role_id: role_id.clone(),
                session_ref: session_ref.clone(),
                prompt,
            },
            input_artifact_ids: Some(input_artifact_ids),
            ..request
        })
    }
}

fn upstream_prompt_contexts<'a>(
    facts: &'a OrganizationFacts,
    run_id: &GraphRunId,
    graph: &'a GraphState,
    request: &ActivityRequest,
) -> Vec<organization::run::scheduler::UpstreamPromptContext<'a>> {
    let Some(attempt) = graph.current_attempt(&request.node_id) else {
        return Vec::new();
    };
    if attempt.inputs().is_empty() {
        return Vec::new();
    }
    let edges = graph
        .definition()
        .edges()
        .iter()
        .map(|edge| (edge.id(), edge))
        .collect::<BTreeMap<_, _>>();
    let attempts = graph
        .executions()
        .values()
        .flat_map(|history| history.attempts())
        .map(|attempt| ((attempt.node_id().as_str(), attempt.fence()), attempt))
        .collect::<BTreeMap<_, _>>();
    let mut outputs = BTreeMap::new();
    for delivery in facts.deliveries_for_run(run_id.as_str()) {
        let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
            continue;
        };
        if matches!(
            observation.resolution(),
            organization::run::delivery::TerminalObservationResolution::GraphResolved(_)
        ) {
            if let Some(output) = observation.output() {
                outputs
                    .entry((observation.node_id(), observation.fence()))
                    .or_insert(output);
            }
        }
    }
    let human_decisions = facts
        .approvals_for_run(run_id.as_str())
        .filter_map(|approval| {
            let crate::run::approval::ApprovalBinding::HumanDecision {
                node_id,
                execution_fence,
            } = approval.facts().binding()?
            else {
                return None;
            };
            let resolution = approval.resolution()?;
            if resolution.cause != crate::run::approval::ApprovalResolutionCause::HumanDecision {
                return None;
            }
            Some(((node_id, execution_fence), resolution.note.as_deref()?))
        })
        .collect::<BTreeMap<_, _>>();
    let mut pending = attempt
        .inputs()
        .iter()
        .rev()
        .map(|input| (attempt.node_id(), input))
        .collect::<Vec<_>>();
    let mut visited_joins = BTreeSet::new();
    let mut included_executions = BTreeSet::new();
    let mut contexts = Vec::new();
    while let Some((target_node_id, input)) = pending.pop() {
        let Some(edge) = edges.get(input.edge_id()) else {
            continue;
        };
        if edge.target_node_id() != target_node_id || !edge.payload().include_upstream_result() {
            continue;
        }
        let source_key = (input.source_node_id().as_str(), input.source_fence());
        let Some(source) = attempts.get(&source_key) else {
            continue;
        };
        if source.node_kind() == NodeKind::Join {
            if visited_joins.insert(source.fence()) {
                pending.extend(
                    source
                        .inputs()
                        .iter()
                        .rev()
                        .map(|input| (source.node_id(), input)),
                );
            }
        } else if included_executions.insert(source.fence().node_execution_id()) {
            if source.node_kind() == NodeKind::HumanDecision {
                if let Some(note) = human_decisions.get(&(
                    source.node_id().as_str(),
                    source.fence().node_execution_id().as_str(),
                )) {
                    contexts.push(organization::run::scheduler::UpstreamPromptContext {
                        source,
                        summary: note,
                        files: &[],
                    });
                }
            } else if let Some(output) = outputs.get(&source_key) {
                contexts.push(organization::run::scheduler::UpstreamPromptContext {
                    source,
                    summary: output.summary(),
                    files: output.files(),
                });
            }
        }
    }
    contexts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ActivityTarget, EdgeAction, EdgeDefinition, EdgeId, EdgePayloadPolicy, ExecutorPolicy,
        GraphDefinition, NodeDefinition, NodeId, WorkAssignment,
    };

    #[test]
    fn upstream_context_respects_edge_payload_policy() {
        let source = NodeId::new("source");
        let target = NodeId::new("target");
        let disabled = EdgeDefinition::new(
            EdgeId::new("disabled"),
            source.clone(),
            "completed",
            target.clone(),
            "input",
            EdgeAction::Activate,
        )
        .with_payload(EdgePayloadPolicy::new(false));
        let enabled = EdgeDefinition::new(
            EdgeId::new("enabled"),
            source.clone(),
            "completed",
            target.clone(),
            "input",
            EdgeAction::Activate,
        );
        let definition = GraphDefinition::new(
            "graph:test",
            "plan:test",
            GraphRunId::new("run:one"),
            "upstream filter",
            vec![
                NodeDefinition::work(
                    source,
                    "source",
                    std::num::NonZeroU32::new(1).unwrap(),
                    WorkAssignment::typed(
                        "task:source",
                        "source prompt",
                        ExecutorPolicy::team_role("leader"),
                        None,
                    ),
                ),
                NodeDefinition::work(
                    target.clone(),
                    "target",
                    std::num::NonZeroU32::new(1).unwrap(),
                    WorkAssignment::typed(
                        "task:target",
                        "target prompt",
                        ExecutorPolicy::team_role("leader"),
                        None,
                    ),
                ),
            ],
            vec![disabled, enabled],
        )
        .unwrap();

        for (edge_id, expected) in [("disabled", Vec::new()), ("enabled", vec!["source result"])] {
            let definition = GraphDefinition::new(
                definition.graph_id(),
                definition.workflow_plan_id(),
                definition.run_id().clone(),
                definition.title(),
                definition.nodes().to_vec(),
                definition
                    .edges()
                    .iter()
                    .filter(|edge| edge.id().as_str() == edge_id)
                    .cloned()
                    .collect(),
            )
            .unwrap();
            let (_temp, mut store) =
                crate::owner::actor::tests::store_with_graph(GraphState::initialize(definition, 1));
            let (_claim, delivery_id, session) =
                crate::owner::actor::tests::claim_native_activity(&mut store, 3);
            store
                .accept_native_terminal_context(&delivery_id, session, "native:source".into())
                .unwrap();
            crate::owner::actor::tests::settle_native_output(
                &mut store,
                &delivery_id,
                organization::NativeTerminalStatus::Completed,
                Some(r#"<team_message>{"summary":"source result","decision":"completed"}</team_message>"#.into()),
                5,
            );
            let run_id = GraphRunId::new("run:one");
            let graph = store.facts().run(&run_id).unwrap().graph();
            let scheduled =
                organization::run::scheduler::schedule_ready_nodes(graph, 1, 0).unwrap();
            let request = scheduled[0]
                .bind_activity_target(ActivityTarget::new("rs0").unwrap(), 6, 1)
                .unwrap();
            let contexts = upstream_prompt_contexts(store.facts(), &run_id, graph, &request);
            assert_eq!(
                contexts
                    .iter()
                    .map(|context| context.summary)
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }
}
