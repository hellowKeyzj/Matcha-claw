use super::*;
use crate::{EvidenceId, EvidenceReference, EvidenceReferenceKind};

#[derive(Serialize, Deserialize)]
struct Row {
    id: String,
    run: String,
    execution: String,
    #[serde(with = "Kind")]
    kind: EvidenceReferenceKind,
    reference: Body,
    label: Option<Body>,
    recorded_at: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(remote = "EvidenceReferenceKind")]
enum Kind {
    WorkspacePath,
    Uri,
    Artifact,
    InlineText,
}

pub(super) fn encode(value: &EvidenceRecord, bodies: &Bodies<'_>) -> Result<Vec<u8>, StoreFault> {
    let reference = value.reference();
    serialize(&Row {
        id: value.evidence_id().as_str().to_owned(),
        run: value.run_id().to_owned(),
        execution: value.node_execution_id().to_owned(),
        kind: reference.kind(),
        reference: bodies.put(reference.reference())?,
        label: bodies.optional(reference.label())?,
        recorded_at: value.recorded_at(),
    })
}
pub(super) fn decode(bytes: &[u8], bodies: &Bodies<'_>) -> Result<EvidenceRecord, StoreFault> {
    let row: Row = deserialize(bytes)?;
    valid(EvidenceRecord::new(
        valid(EvidenceId::new(row.id))?,
        row.run,
        row.execution,
        valid(EvidenceReference::opaque(
            row.kind,
            bodies.read(row.reference)?,
            bodies.read_optional(row.label)?,
        ))?,
        row.recorded_at,
    ))
}
