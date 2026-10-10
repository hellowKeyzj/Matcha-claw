use super::*;
use crate::run::artifact::{ArtifactEvidenceProvenance, ArtifactId};

#[derive(Serialize, Deserialize)]
struct Row {
    id: String,
    run: String,
    node: String,
    execution: String,
    fence: Fence,
    role: String,
    kind: String,
    title: Body,
    content_ref: String,
    summary: Option<Body>,
    evidence: Vec<(String, String)>,
    source_envelope: String,
    idempotency: String,
    created_at: u64,
}
pub(super) fn encode(value: &ArtifactRecord, bodies: &Bodies<'_>) -> Result<Vec<u8>, StoreFault> {
    serialize(&Row {
        id: value.artifact_id().as_str().to_owned(),
        run: value.run_id().to_owned(),
        node: value.node_id().to_owned(),
        execution: value.node_execution_id().to_owned(),
        fence: Fence::from_domain(value.fence()),
        role: value.role_id().to_owned(),
        kind: value.kind().to_owned(),
        title: bodies.put(value.title())?,
        content_ref: value.content_ref().to_owned(),
        summary: bodies.optional(value.summary())?,
        evidence: value
            .evidence()
            .iter()
            .map(|item| {
                (
                    item.evidence_id().to_owned(),
                    item.reference_kind().to_owned(),
                )
            })
            .collect(),
        source_envelope: value.source_envelope_id().to_owned(),
        idempotency: value.idempotency_key().to_owned(),
        created_at: value.created_at(),
    })
}
pub(super) fn decode(bytes: &[u8], bodies: &Bodies<'_>) -> Result<ArtifactRecord, StoreFault> {
    let row: Row = deserialize(bytes)?;
    let evidence = row
        .evidence
        .into_iter()
        .map(|(id, kind)| valid(ArtifactEvidenceProvenance::new(id, kind)))
        .collect::<Result<Vec<_>, _>>()?;
    valid(ArtifactRecord::new(
        valid(ArtifactId::new(row.id))?,
        row.run,
        row.node,
        row.execution,
        row.fence.into_domain(),
        row.role,
        row.kind,
        bodies.read(row.title)?,
        row.content_ref,
        bodies.read_optional(row.summary)?,
        evidence,
        row.source_envelope,
        row.idempotency,
        row.created_at,
    ))
}
