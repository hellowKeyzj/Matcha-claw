use serde::Serialize;

use crate::run::evidence::{EvidenceRecord, EvidenceReferenceKind};

/// The renderer-safe evidence shape. The opaque reference and label contents remain private.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicEvidenceProjection {
    evidence_id: String,
    run_id: String,
    node_execution_id: String,
    reference_kind: PublicEvidenceType,
    recorded_at: u64,
}

impl PublicEvidenceProjection {
    pub fn evidence_id(&self) -> &str {
        &self.evidence_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn node_execution_id(&self) -> &str {
        &self.node_execution_id
    }

    pub const fn reference_kind(&self) -> PublicEvidenceType {
        self.reference_kind
    }

    pub const fn recorded_at(&self) -> u64 {
        self.recorded_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PublicEvidenceType {
    WorkspacePath,
    Uri,
    Artifact,
    InlineText,
}

pub fn project_public_evidence(record: &EvidenceRecord) -> PublicEvidenceProjection {
    PublicEvidenceProjection {
        evidence_id: record.evidence_id().as_str().to_owned(),
        run_id: record.run_id().to_owned(),
        node_execution_id: record.node_execution_id().to_owned(),
        reference_kind: public_evidence_type(record.reference().kind()),
        recorded_at: record.recorded_at(),
    }
}

const fn public_evidence_type(kind: EvidenceReferenceKind) -> PublicEvidenceType {
    match kind {
        EvidenceReferenceKind::WorkspacePath => PublicEvidenceType::WorkspacePath,
        EvidenceReferenceKind::Uri => PublicEvidenceType::Uri,
        EvidenceReferenceKind::Artifact => PublicEvidenceType::Artifact,
        EvidenceReferenceKind::InlineText => PublicEvidenceType::InlineText,
    }
}

#[cfg(test)]
mod tests {
    use crate::{EvidenceId, EvidenceReference, EvidenceReferenceKind};

    use super::*;

    #[test]
    fn public_evidence_projection_keeps_safe_facts_and_redacts_opaque_content() {
        let record = EvidenceRecord::new(
            EvidenceId::new("evidence:one").unwrap(),
            "run:one",
            "node:one:attempt:1",
            EvidenceReference::opaque(
                EvidenceReferenceKind::WorkspacePath,
                "C:/private/workspace/report.txt",
                Some("private report label".to_owned()),
            )
            .unwrap(),
            42,
        )
        .unwrap();

        let projection = project_public_evidence(&record);
        assert_eq!(projection.evidence_id(), "evidence:one");
        assert_eq!(projection.run_id(), "run:one");
        assert_eq!(projection.node_execution_id(), "node:one:attempt:1");
        assert_eq!(
            projection.reference_kind(),
            PublicEvidenceType::WorkspacePath
        );
        assert_eq!(projection.recorded_at(), 42);

        let serialized = serde_json::to_string(&projection).unwrap();
        let document: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        let object = document.as_object().unwrap();
        assert_eq!(object.len(), 5);
        assert_eq!(document["referenceKind"], "workspacePath");
        assert!(!serialized.contains("C:/private/workspace/report.txt"));
        assert!(!serialized.contains("private report label"));
        assert!(!object.contains_key("reference"));
        assert!(!object.contains_key("label"));
    }
}
