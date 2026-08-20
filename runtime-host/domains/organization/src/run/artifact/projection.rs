use crate::run::graph::{ExecutionFence, GraphRunId, NodeAttempt, NodeDefinition};

use super::{
    ArtifactId, ArtifactLedger, ArtifactRecord, ArtifactRecordError, CompletionMetadata,
    GraphCompletionArtifactReceipt,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DownstreamInputContextInput {
    pub run_id: GraphRunId,
    pub source_fence: ExecutionFence,
    pub edge_id: String,
    pub source_node_id: String,
    pub source_node_execution_id: String,
    pub action: String,
    pub include_upstream_result: bool,
    pub artifact_ids: Vec<ArtifactId>,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DownstreamInputContext {
    pub run_id: GraphRunId,
    pub source_fence: ExecutionFence,
    pub edge_id: String,
    pub source_node_id: String,
    pub source_node_execution_id: String,
    pub action: String,
    pub artifact_ids: Vec<ArtifactId>,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicArtifactProjection {
    pub artifact_id: ArtifactId,
    pub run_id: String,
    pub node_id: String,
    pub node_execution_id: String,
    pub role_id: String,
    pub kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub evidence_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssertArtifactExists {
    pub run_id: GraphRunId,
    pub kind: Option<String>,
}

impl AssertArtifactExists {
    pub fn evaluate(&self, ledger: &ArtifactLedger) -> bool {
        ledger.has_kind_for_run(&self.run_id, self.kind.as_deref())
    }
}

pub fn build_graph_completion_artifact(
    run_id: &GraphRunId,
    node: &NodeDefinition,
    attempt: &NodeAttempt,
    role_id: impl Into<String>,
    metadata: CompletionMetadata,
    source_envelope_id: impl Into<String>,
    idempotency_key: impl Into<String>,
    completed_at: u64,
) -> Result<GraphCompletionArtifactReceipt, ArtifactRecordError> {
    let kind = node
        .work_assignment()
        .and_then(|work| work.output_artifact_kind())
        .unwrap_or("nodeSummary");
    let idempotency_key = idempotency_key.into();
    let artifact_id = ArtifactId::new(format!("team-artifact-{idempotency_key}"))
        .map_err(|_| ArtifactRecordError::BlankIdentity)?;
    let output_port = metadata.output_port;
    let content_ref = metadata
        .evidence
        .first()
        .map(|e| e.evidence_id().to_owned())
        .unwrap_or_else(|| attempt.fence().node_execution_id().as_str().to_owned());
    let evidence = metadata.evidence;
    let artifact = ArtifactRecord::new(
        artifact_id,
        run_id.as_str(),
        node.id().as_str(),
        attempt.fence().node_execution_id().as_str(),
        attempt.fence().clone(),
        role_id,
        kind,
        node.title(),
        content_ref,
        metadata.summary,
        evidence,
        source_envelope_id,
        idempotency_key,
        completed_at,
    )?;
    Ok(GraphCompletionArtifactReceipt {
        artifact,
        output_port,
    })
}

pub fn build_graph_delivery_input_context(
    ledger: &ArtifactLedger,
    inputs: impl IntoIterator<Item = DownstreamInputContextInput>,
) -> Vec<DownstreamInputContext> {
    inputs
        .into_iter()
        .map(|input| {
            let artifact_ids = input
                .artifact_ids
                .into_iter()
                .filter(|id| {
                    ledger.artifact(id).is_some_and(|artifact| {
                        artifact.run_id() == input.run_id.as_str()
                            && artifact.fence() == &input.source_fence
                    })
                })
                .collect();
            DownstreamInputContext {
                run_id: input.run_id,
                source_fence: input.source_fence,
                edge_id: input.edge_id,
                source_node_id: input.source_node_id,
                source_node_execution_id: input.source_node_execution_id,
                action: input.action,
                artifact_ids,
                source_summary: input
                    .include_upstream_result
                    .then_some(input.source_summary)
                    .flatten(),
            }
        })
        .collect()
}

pub fn project_public_artifact(record: &ArtifactRecord) -> PublicArtifactProjection {
    PublicArtifactProjection {
        artifact_id: record.artifact_id().clone(),
        run_id: record.run_id().to_owned(),
        node_id: record.node_id().to_owned(),
        node_execution_id: record.node_execution_id().to_owned(),
        role_id: record.role_id().to_owned(),
        kind: record.kind().to_owned(),
        title: record.title().to_owned(),
        summary: record.summary().map(ToOwned::to_owned),
        evidence_count: record.evidence().len(),
    }
}

#[allow(dead_code)]
fn _fence_is_explicit(fence: &ExecutionFence) -> &ExecutionFence {
    fence
}
