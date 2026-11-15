use std::collections::{BTreeMap, BTreeSet};

use crate::{
    Approval, ApprovalDecision, ApprovalResolution, ControlNodeResolution, GraphRunFacts,
    GraphRunId, GraphRunLifecycleState, GraphState, NodeId, NodeKind,
    run::{approval::{ApprovalBinding, ApprovalResolutionCause}, control::ControlResolutionLedger},
};

use super::{OrganizationFacts, OrganizationFactsError};

pub(super) fn cancellation_resolution_key(idempotency_key: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("run-cancelled:{:x}", Sha256::digest(idempotency_key.as_bytes()))
}

pub(super) fn validate_approval_resolutions<'a>(
    run: &GraphRunFacts,
    approval: &Approval,
    receipts: impl IntoIterator<Item = &'a ApprovalResolution>,
    resolutions: &ControlResolutionLedger,
) -> Result<(), OrganizationFactsError> {
    let facts = approval.facts();
    let human_decision = match facts.binding() {
        Some(ApprovalBinding::HumanDecision { node_id, execution_fence }) => {
            let node_id = NodeId::new(node_id);
            let fence = run.graph().executions().get(&node_id)
                .and_then(|history| history.attempts().iter()
                    .find(|attempt| attempt.fence().node_execution_id().as_str() == execution_fence))
                .map(|attempt| attempt.fence())
                .or_else(|| run.retired_executions.iter().find_map(|(node, fence)| {
                    (node == &node_id && fence.node_execution_id().as_str() == execution_fence
                        && run.retired_execution_has_attempt(node, fence)).then_some(fence)
                }))
                .ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
            Some((node_id, fence))
        }
        Some(_) => None,
        None => return Err(OrganizationFactsError::InvalidApprovalLedger),
    };
    for receipt in receipts {
        if receipt.cause == ApprovalResolutionCause::RunCancelled {
            if receipt.decision != ApprovalDecision::Abort {
                return Err(OrganizationFactsError::InvalidApprovalLedger);
            }
            match run.lifecycle().state() {
                GraphRunLifecycleState::Cancelled { idempotency_key, .. }
                    if receipt.idempotency_key == cancellation_resolution_key(idempotency_key) => {}
                GraphRunLifecycleState::Tombstoned { .. } => {}
                _ => return Err(OrganizationFactsError::InvalidApprovalLedger),
            }
        }
        if let Some((node_id, fence)) = &human_decision {
            let resolution = ControlNodeResolution::human_decision(
                run.run_id().clone(), node_id.clone(), (*fence).clone(),
                match receipt.decision {
                    ApprovalDecision::Approve => crate::HumanDecision::Approve,
                    ApprovalDecision::Deny => crate::HumanDecision::Deny,
                    ApprovalDecision::Abort => crate::HumanDecision::Abort,
                }, receipt.resolved_at,
            ).map_err(|_| OrganizationFactsError::InvalidApprovalLedger)?;
            let control = resolutions.resolution(resolution.idempotency_key());
            let valid = match receipt.cause {
                ApprovalResolutionCause::HumanDecision => control == Some(&resolution),
                ApprovalResolutionCause::RunCancelled => control.is_none(),
            };
            if !valid { return Err(OrganizationFactsError::InvalidApprovalLedger); }
        }
    }
    Ok(())
}

impl OrganizationFacts {
    pub(super) fn approval_input_artifacts(&self, run: &GraphRunId, graph: &GraphState, node: &NodeId) -> Vec<String> {
        let Some(attempt) = graph.current_attempt(node) else { return Vec::new() };
        if matches!(attempt.node_kind(), NodeKind::Work | NodeKind::Review) {
            let key = crate::run::scheduler::activity_idempotency_key(run, attempt.fence());
            return self.activities.activity_by_idempotency_key(run.as_str(), &key)
                .filter(|activity| activity.facts().node_id == *node && activity.facts().fence == *attempt.fence())
                .and_then(|activity| activity.facts().input_artifact_ids.as_ref())
                .map(|ids| ids.iter().map(|id| id.as_str().to_owned()).collect())
                .unwrap_or_default();
        }
        let attempts = graph.executions().values().flat_map(|history| history.attempts())
            .map(|attempt| ((attempt.node_id(), attempt.fence()), attempt)).collect::<BTreeMap<_, _>>();
        let edges = graph.definition().edges().iter().map(|edge| (edge.id(), edge)).collect::<BTreeMap<_, _>>();
        let mut pending = attempt.inputs().iter().map(|input| (node, input)).collect::<Vec<_>>();
        let mut visited = BTreeSet::new();
        let mut ids = BTreeSet::new();
        while let Some((target, input)) = pending.pop() {
            if !edges.get(input.edge_id()).is_some_and(|edge| {
                edge.target_node_id() == target && edge.payload().include_upstream_result()
            }) { continue; }
            let Some(source) = attempts.get(&(input.source_node_id(), input.source_fence())) else { continue };
            if !visited.insert(source.fence()) { continue; }
            if source.node_kind() == NodeKind::Join {
                pending.extend(source.inputs().iter().map(|input| (source.node_id(), input)));
            } else {
                ids.extend(self.artifacts.records_for_execution(run, source.fence())
                    .filter(|artifact| artifact.node_id() == source.node_id().as_str())
                    .map(|artifact| artifact.artifact_id().as_str().to_owned()));
            }
        }
        ids.into_iter().collect()
    }
}
