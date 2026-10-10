use crate::run::{
    delivery::AuthorizedGraphOutcome,
    evidence::EvidenceLedger,
    graph::{EdgeDefinition, ExecutionFence, GraphRunId, GraphState, NodeAttempt, NodeId, NodeKind},
};

/// The producer channel that decided a control node outcome.
///
/// Control nodes are never dispatched to an agent runtime, so their outcome carries no delivery
/// and never reaches the runtime-native terminal observation path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlAuthority {
    HumanDecision,
    ScriptReview,
    Join,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HumanDecision {
    Approve,
    Deny,
    Abort,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptReviewRule {
    PassThrough,
    AssertAllUpstreamCompleted,
    AssertNoBlockingGate,
    AssertArtifactExists,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlNodeResolutionOutcome {
    Recorded,
    Replayed,
}

impl ControlAuthority {
    const fn idempotency_prefix(self) -> &'static str {
        match self {
            Self::HumanDecision => "team-human-decision",
            Self::ScriptReview => "team-script-review",
            Self::Join => "team-join",
        }
    }
}

/// An authorized outcome for a control node, pinned to the attempt it resolves.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlNodeResolution {
    authority: ControlAuthority,
    graph_run_id: GraphRunId,
    node_id: NodeId,
    fence: ExecutionFence,
    outcome: AuthorizedGraphOutcome,
    output_port: String,
    script_review_rule: Option<ScriptReviewRule>,
    resolved_at: u64,
    idempotency_key: String,
}

/// Facts required to create or restore a control node resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ControlNodeResolutionInput {
    pub(crate) authority: ControlAuthority,
    pub(crate) graph_run_id: GraphRunId,
    pub(crate) node_id: NodeId,
    pub(crate) fence: ExecutionFence,
    pub(crate) outcome: AuthorizedGraphOutcome,
    pub(crate) output_port: String,
    pub(crate) script_review_rule: Option<ScriptReviewRule>,
    pub(crate) resolved_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlNodeResolutionError {
    UnknownNode(NodeId),
    UnexpectedNodeKind {
        node_id: NodeId,
        kind: NodeKind,
    },
    StaleFence {
        node_id: NodeId,
    },
    NodeNotAwaitingResolution {
        node_id: NodeId,
        status: crate::run::graph::AttemptStatus,
    },
    BlankGraphRunId,
    BlankOutputPort {
        node_id: NodeId,
    },
    UnsafeOutputPort {
        node_id: NodeId,
    },
    OutputPortDoesNotMatchEdge {
        node_id: NodeId,
    },
    GraphRunMismatch,
    GraphStateMismatch,
    MissingScriptReviewFacts {
        rule: ScriptReviewRule,
    },
    MissingScriptReviewRule,
    ConflictingResolution,
}

impl ControlNodeResolution {
    pub fn human_decision(
        graph_run_id: GraphRunId,
        node_id: NodeId,
        fence: ExecutionFence,
        decision: HumanDecision,
        resolved_at: u64,
    ) -> Result<Self, ControlNodeResolutionError> {
        let (outcome, output_port) = match decision {
            HumanDecision::Approve => (AuthorizedGraphOutcome::Completed, "approved"),
            HumanDecision::Deny => (AuthorizedGraphOutcome::Completed, "rejected"),
            HumanDecision::Abort => (AuthorizedGraphOutcome::Completed, "aborted"),
        };
        Self::try_new(
            ControlAuthority::HumanDecision,
            graph_run_id,
            node_id,
            fence,
            outcome,
            output_port,
            resolved_at,
        )
    }

    pub fn join(
        graph_run_id: GraphRunId,
        node_id: NodeId,
        fence: ExecutionFence,
        graph: &GraphState,
        resolved_at: u64,
    ) -> Result<Self, ControlNodeResolutionError> {
        require_resolvable_control_node(graph, &node_id, &fence, NodeKind::Join)?;
        require_join_ready(graph, &node_id)?;
        Self::try_new(
            ControlAuthority::Join,
            graph_run_id,
            node_id,
            fence,
            AuthorizedGraphOutcome::Completed,
            "joined",
            resolved_at,
        )
    }

    pub fn script_review(
        graph_run_id: GraphRunId,
        node_id: NodeId,
        fence: ExecutionFence,
        rule: ScriptReviewRule,
        graph: &GraphState,
        resolved_at: u64,
    ) -> Result<Self, ControlNodeResolutionError> {
        require_resolvable_control_node(graph, &node_id, &fence, NodeKind::ScriptReview)?;
        let output_port = script_review_output_port(rule, graph, &node_id, &fence)?;
        Self::try_new_with_rule(ControlNodeResolutionInput {
            authority: ControlAuthority::ScriptReview,
            graph_run_id,
            node_id,
            fence,
            outcome: AuthorizedGraphOutcome::Completed,
            output_port: output_port.to_owned(),
            script_review_rule: Some(rule),
            resolved_at,
        })
    }

    pub fn script_review_with_evidence(
        graph_run_id: GraphRunId,
        node_id: NodeId,
        fence: ExecutionFence,
        rule: ScriptReviewRule,
        graph: &GraphState,
        evidence: &EvidenceLedger,
        resolved_at: u64,
    ) -> Result<Self, ControlNodeResolutionError> {
        require_resolvable_control_node(graph, &node_id, &fence, NodeKind::ScriptReview)?;
        let output_port = script_review_output_port_with_evidence(
            rule,
            &graph_run_id,
            graph,
            &node_id,
            &fence,
            evidence,
        )?;
        Self::try_new_with_rule(ControlNodeResolutionInput {
            authority: ControlAuthority::ScriptReview,
            graph_run_id,
            node_id,
            fence,
            outcome: AuthorizedGraphOutcome::Completed,
            output_port: output_port.to_owned(),
            script_review_rule: Some(rule),
            resolved_at,
        })
    }

    pub fn try_new(
        authority: ControlAuthority,
        graph_run_id: GraphRunId,
        node_id: NodeId,
        fence: ExecutionFence,
        outcome: AuthorizedGraphOutcome,
        output_port: impl Into<String>,
        resolved_at: u64,
    ) -> Result<Self, ControlNodeResolutionError> {
        Self::try_new_with_rule(ControlNodeResolutionInput {
            authority,
            graph_run_id,
            node_id,
            fence,
            outcome,
            output_port: output_port.into(),
            script_review_rule: None,
            resolved_at,
        })
    }

    pub(crate) fn from_durable(
        input: ControlNodeResolutionInput,
    ) -> Result<Self, ControlNodeResolutionError> {
        Self::try_new_with_rule(input)
    }

    fn try_new_with_rule(
        input: ControlNodeResolutionInput,
    ) -> Result<Self, ControlNodeResolutionError> {
        let ControlNodeResolutionInput {
            authority,
            graph_run_id,
            node_id,
            fence,
            outcome,
            output_port,
            script_review_rule,
            resolved_at,
        } = input;
        if graph_run_id.as_str().trim().is_empty() {
            return Err(ControlNodeResolutionError::BlankGraphRunId);
        }
        if authority == ControlAuthority::ScriptReview && script_review_rule.is_none() {
            return Err(ControlNodeResolutionError::MissingScriptReviewRule);
        }
        if authority != ControlAuthority::ScriptReview && script_review_rule.is_some() {
            return Err(ControlNodeResolutionError::GraphStateMismatch);
        }
        if output_port.trim().is_empty() {
            return Err(ControlNodeResolutionError::BlankOutputPort { node_id });
        }
        if !is_safe_output_port(&output_port) {
            return Err(ControlNodeResolutionError::UnsafeOutputPort { node_id });
        }
        let idempotency_key = format!(
            "{}:{}:{}",
            authority.idempotency_prefix(),
            graph_run_id.as_str(),
            fence.node_execution_id().as_str()
        );
        Ok(Self {
            authority,
            graph_run_id,
            node_id,
            fence,
            outcome,
            output_port,
            script_review_rule,
            resolved_at,
            idempotency_key,
        })
    }

    pub const fn authority(&self) -> ControlAuthority {
        self.authority
    }

    pub fn graph_run_id(&self) -> &GraphRunId {
        &self.graph_run_id
    }

    pub fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }

    pub const fn outcome(&self) -> AuthorizedGraphOutcome {
        self.outcome
    }

    pub fn output_port(&self) -> &str {
        &self.output_port
    }

    pub const fn script_review_rule(&self) -> Option<ScriptReviewRule> {
        self.script_review_rule
    }

    pub const fn resolved_at(&self) -> u64 {
        self.resolved_at
    }

    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }
}

/// Admits only the control node attempt a producer channel may still resolve.
///
/// Attempt status legality beyond this admission stays owned by the graph reducer.
pub(crate) fn script_review_output_port(
    rule: ScriptReviewRule,
    graph: &GraphState,
    node_id: &NodeId,
    fence: &ExecutionFence,
) -> Result<&'static str, ControlNodeResolutionError> {
    match rule {
        ScriptReviewRule::PassThrough => Ok("passed"),
        ScriptReviewRule::AssertAllUpstreamCompleted | ScriptReviewRule::AssertNoBlockingGate => {
            let attempt = script_review_attempt(graph, node_id, fence)?;
            let mut edges = graph.definition().incoming_edges(node_id).filter(|edge| {
                if rule == ScriptReviewRule::AssertAllUpstreamCompleted {
                    edge.action() != crate::EdgeAction::Rework
                } else {
                    edge.action() == crate::EdgeAction::Gate
                }
            }).peekable();
            let has_inputs = edges.peek().is_some();
            let satisfied = edges.all(|edge| completed_input_source(graph, attempt, edge))
                && (has_inputs || rule == ScriptReviewRule::AssertNoBlockingGate);
            Ok(if satisfied { "passed" } else { "failed" })
        }
        ScriptReviewRule::AssertArtifactExists => Ok("failed"),
    }
}

fn script_review_attempt<'a>(
    graph: &'a GraphState,
    node_id: &NodeId,
    fence: &ExecutionFence,
) -> Result<&'a NodeAttempt, ControlNodeResolutionError> {
    graph.executions().get(node_id)
        .and_then(|history| history.attempts().iter().find(|attempt| attempt.fence() == fence))
        .ok_or_else(|| ControlNodeResolutionError::StaleFence { node_id: node_id.clone() })
}

fn completed_input_source(graph: &GraphState, attempt: &NodeAttempt, edge: &EdgeDefinition) -> bool {
    attempt.inputs().iter().any(|input| {
        input.edge_id() == edge.id()
            && input.source_node_id() == edge.source_node_id()
            && input.source_port() == edge.source_port()
            && input.target_port() == edge.target_port()
            && input.action() == edge.action()
            && graph.executions().get(input.source_node_id()).is_some_and(|history| {
                history.attempts().iter().any(|source| {
                    source.fence() == input.source_fence()
                        && source.status() == crate::AttemptStatus::Completed
                        && source.output_port() == Some(input.source_port())
                })
            })
    })
}

/// Resolves a script review using the persisted evidence ledger.
///
/// Only typed artifacts from this attempt's consumed direct input executions in the
/// same run count; the script's own execution and arbitrary ancestors do not.
pub(crate) fn script_review_output_port_with_evidence(
    rule: ScriptReviewRule,
    graph_run_id: &GraphRunId,
    graph: &GraphState,
    node_id: &NodeId,
    fence: &ExecutionFence,
    evidence: &EvidenceLedger,
) -> Result<&'static str, ControlNodeResolutionError> {
    match rule {
        ScriptReviewRule::AssertArtifactExists => {
            let attempt = script_review_attempt(graph, node_id, fence)?;
            let exists = attempt.inputs().iter().any(|input| {
                evidence.artifact_reference_for_execution(graph_run_id.as_str(), input.source_fence())
                    .is_some()
            });
            Ok(if exists { "passed" } else { "failed" })
        }
        _ => script_review_output_port(rule, graph, node_id, fence),
    }
}

pub(crate) fn require_join_ready(
    graph: &GraphState,
    node_id: &NodeId,
) -> Result<(), ControlNodeResolutionError> {
    let attempt = graph
        .current_attempt(node_id)
        .ok_or_else(|| ControlNodeResolutionError::UnknownNode(node_id.clone()))?;
    if attempt.status() != crate::AttemptStatus::Ready {
        return Err(ControlNodeResolutionError::NodeNotAwaitingResolution {
            node_id: node_id.clone(),
            status: attempt.status(),
        });
    }
    let edges = graph
        .definition()
        .incoming_edges(node_id)
        .collect::<Vec<_>>();
    if edges.is_empty() || edges.len() != attempt.inputs().len() {
        return Err(ControlNodeResolutionError::GraphStateMismatch);
    }
    let inputs = attempt
        .inputs()
        .iter()
        .map(|input| (input.edge_id(), input))
        .collect::<std::collections::BTreeMap<_, _>>();
    for edge in edges {
        let source = graph
            .current_attempt(edge.source_node_id())
            .ok_or(ControlNodeResolutionError::GraphStateMismatch)?;
        let input = inputs
            .get(edge.id())
            .ok_or(ControlNodeResolutionError::GraphStateMismatch)?;
        if edge.action() != crate::EdgeAction::Gate
            || source.status() != crate::AttemptStatus::Completed
            || source.output_port() != Some(edge.source_port())
            || input.source_node_id() != edge.source_node_id()
            || input.source_port() != edge.source_port()
            || input.target_port() != edge.target_port()
            || input.action() != edge.action()
            || input.source_fence() != source.fence()
        {
            return Err(ControlNodeResolutionError::GraphStateMismatch);
        }
    }
    Ok(())
}

pub(crate) fn require_resolvable_control_node(
    graph: &GraphState,
    node_id: &NodeId,
    fence: &ExecutionFence,
    expected: NodeKind,
) -> Result<(), ControlNodeResolutionError> {
    let node = graph
        .definition()
        .node(node_id)
        .ok_or_else(|| ControlNodeResolutionError::UnknownNode(node_id.clone()))?;
    if node.kind() != expected {
        return Err(ControlNodeResolutionError::UnexpectedNodeKind {
            node_id: node_id.clone(),
            kind: node.kind(),
        });
    }
    let attempt = graph
        .current_attempt(node_id)
        .ok_or_else(|| ControlNodeResolutionError::UnknownNode(node_id.clone()))?;
    if attempt.fence() != fence {
        return Err(ControlNodeResolutionError::StaleFence {
            node_id: node_id.clone(),
        });
    }
    if !attempt.status().accepts_outcome() {
        return Err(ControlNodeResolutionError::NodeNotAwaitingResolution {
            node_id: node_id.clone(),
            status: attempt.status(),
        });
    }
    Ok(())
}

fn is_safe_output_port(output_port: &str) -> bool {
    output_port
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'/' | b'\\'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::evidence::{
        EvidenceId, EvidenceLedger, EvidenceRecord, EvidenceReference, EvidenceReferenceKind,
        RecordOutcome,
    };
    use crate::run::graph::{GraphDefinition, GraphRunId, NodeDefinition};
    use std::num::NonZeroU32;

    fn graph() -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                "graph:script-review",
                "plan:script-review",
                GraphRunId::new("run:one"),
                "script review",
                vec![NodeDefinition::script_review(
                    NodeId::new("review"),
                    "review",
                    NonZeroU32::new(1).unwrap(),
                    ScriptReviewRule::AssertArtifactExists,
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        )
    }

    fn artifact(run_id: &str, node_execution_id: &str) -> EvidenceRecord {
        EvidenceRecord::new(
            EvidenceId::new(format!("evidence:{node_execution_id}")).unwrap(),
            run_id,
            node_execution_id,
            EvidenceReference::opaque(EvidenceReferenceKind::Artifact, "artifact:opaque", None)
                .unwrap(),
            1,
        )
        .unwrap()
    }

    #[test]
    fn artifact_rule_is_failed_without_matching_persisted_artifact() {
        let graph = graph();
        let fence = graph
            .current_attempt(&NodeId::new("review"))
            .unwrap()
            .fence()
            .clone();
        let ledger = EvidenceLedger::default();

        assert_eq!(
            script_review_output_port_with_evidence(
                ScriptReviewRule::AssertArtifactExists,
                &GraphRunId::new("run:one"),
                &graph,
                &NodeId::new("review"),
                &fence,
                &ledger,
            )
            .unwrap(),
            "failed"
        );
        assert_eq!(
            script_review_output_port(
                ScriptReviewRule::AssertArtifactExists,
                &graph,
                &NodeId::new("review"),
                &fence
            )
            .unwrap(),
            "failed"
        );
    }

    #[test]
    fn artifact_rule_rejects_self_fence_and_foreign_run_provenance() {
        let graph = graph();
        let fence = graph
            .current_attempt(&NodeId::new("review"))
            .unwrap()
            .fence()
            .clone();
        let mut ledger = EvidenceLedger::default();
        assert!(matches!(
            ledger.record(artifact("run:one", fence.node_execution_id().as_str())),
            RecordOutcome::Recorded(_)
        ));

        assert_eq!(
            script_review_output_port_with_evidence(
                ScriptReviewRule::AssertArtifactExists,
                &GraphRunId::new("run:one"),
                &graph,
                &NodeId::new("review"),
                &fence,
                &ledger,
            )
            .unwrap(),
            "failed"
        );
        assert_eq!(
            script_review_output_port_with_evidence(
                ScriptReviewRule::AssertArtifactExists,
                &GraphRunId::new("run:other"),
                &graph,
                &NodeId::new("review"),
                &fence,
                &ledger,
            )
            .unwrap(),
            "failed"
        );
    }
}
