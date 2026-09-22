use std::fmt;

use crate::run::graph::ExecutionFence;

const MAX_OPAQUE_BYTES: usize = 128;
const MAX_TEXT_BYTES: usize = 512;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ArtifactId(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactIdError {
    BlankOrTooLong,
}

impl ArtifactId {
    pub fn new(value: impl Into<String>) -> Result<Self, ArtifactIdError> {
        let value = value.into();
        if value.trim().is_empty() || value.len() > MAX_OPAQUE_BYTES {
            return Err(ArtifactIdError::BlankOrTooLong);
        }
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactKindError {
    BlankOrTooLong,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactEvidenceProvenance {
    evidence_id: String,
    reference_kind: String,
}

impl ArtifactEvidenceProvenance {
    pub fn new(
        evidence_id: impl Into<String>,
        reference_kind: impl Into<String>,
    ) -> Result<Self, ArtifactRecordError> {
        let evidence_id = bounded(evidence_id.into(), MAX_OPAQUE_BYTES)
            .ok_or(ArtifactRecordError::InvalidEvidenceProvenance)?;
        let reference_kind = bounded(reference_kind.into(), MAX_OPAQUE_BYTES)
            .ok_or(ArtifactRecordError::InvalidEvidenceProvenance)?;
        Ok(Self {
            evidence_id,
            reference_kind,
        })
    }
    pub fn evidence_id(&self) -> &str {
        &self.evidence_id
    }
    pub fn reference_kind(&self) -> &str {
        &self.reference_kind
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ArtifactRecord {
    artifact_id: ArtifactId,
    run_id: String,
    node_id: String,
    node_execution_id: String,
    fence: ExecutionFence,
    role_id: String,
    kind: String,
    title: String,
    content_ref: String,
    summary: Option<String>,
    evidence: Vec<ArtifactEvidenceProvenance>,
    source_envelope_id: String,
    idempotency_key: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactRecordError {
    BlankIdentity,
    InvalidEvidenceProvenance,
    InvalidKind,
    InvalidTitle,
    InvalidContentReference,
    InvalidSummary,
}

impl ArtifactRecord {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        artifact_id: ArtifactId,
        run_id: impl Into<String>,
        node_id: impl Into<String>,
        node_execution_id: impl Into<String>,
        fence: ExecutionFence,
        role_id: impl Into<String>,
        kind: impl Into<String>,
        title: impl Into<String>,
        content_ref: impl Into<String>,
        summary: Option<String>,
        evidence: Vec<ArtifactEvidenceProvenance>,
        source_envelope_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        created_at: u64,
    ) -> Result<Self, ArtifactRecordError> {
        let run_id = identity(run_id.into())?;
        let node_id = identity(node_id.into())?;
        let node_execution_id = identity(node_execution_id.into())?;
        if fence.node_execution_id().as_str() != node_execution_id {
            return Err(ArtifactRecordError::BlankIdentity);
        }
        let role_id = identity(role_id.into())?;
        let kind =
            bounded(kind.into(), MAX_OPAQUE_BYTES).ok_or(ArtifactRecordError::InvalidKind)?;
        let title =
            bounded(title.into(), MAX_TEXT_BYTES).ok_or(ArtifactRecordError::InvalidTitle)?;
        let content_ref = bounded(content_ref.into(), MAX_OPAQUE_BYTES)
            .ok_or(ArtifactRecordError::InvalidContentReference)?;
        let summary = summary
            .map(|v| bounded(v, MAX_TEXT_BYTES).ok_or(ArtifactRecordError::InvalidSummary))
            .transpose()?;
        let source_envelope_id = identity(source_envelope_id.into())?;
        let idempotency_key = identity(idempotency_key.into())?;
        Ok(Self {
            artifact_id,
            run_id,
            node_id,
            node_execution_id,
            fence,
            role_id,
            kind,
            title,
            content_ref,
            summary,
            evidence,
            source_envelope_id,
            idempotency_key,
            created_at,
            updated_at: created_at,
        })
    }
    pub fn artifact_id(&self) -> &ArtifactId {
        &self.artifact_id
    }
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
    pub fn node_id(&self) -> &str {
        &self.node_id
    }
    pub fn node_execution_id(&self) -> &str {
        &self.node_execution_id
    }
    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }
    pub fn role_id(&self) -> &str {
        &self.role_id
    }
    pub fn kind(&self) -> &str {
        &self.kind
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn content_ref(&self) -> &str {
        &self.content_ref
    }
    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }
    pub fn evidence(&self) -> &[ArtifactEvidenceProvenance] {
        &self.evidence
    }
    pub fn source_envelope_id(&self) -> &str {
        &self.source_envelope_id
    }
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }
    pub fn created_at(&self) -> u64 {
        self.created_at
    }
    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }
}

impl fmt::Debug for ArtifactRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ArtifactRecord")
            .field("artifact_id", &self.artifact_id)
            .field("run_id", &self.run_id)
            .field("node_id", &self.node_id)
            .field("node_execution_id", &self.node_execution_id)
            .field("fence", &self.fence)
            .field("role_id", &self.role_id)
            .field("kind", &self.kind)
            .field("title", &self.title)
            .field("has_content_ref", &true)
            .field("has_summary", &self.summary.is_some())
            .field("evidence_count", &self.evidence.len())
            .field("source_envelope_id", &self.source_envelope_id)
            .field("idempotency_key", &self.idempotency_key)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionMetadata {
    pub output_port: String,
    pub summary: Option<String>,
    pub evidence: Vec<ArtifactEvidenceProvenance>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphCompletionArtifactReceipt {
    pub artifact: ArtifactRecord,
    pub output_port: String,
}

fn bounded(value: String, max: usize) -> Option<String> {
    (!value.trim().is_empty() && value.len() <= max).then_some(value)
}
fn identity(value: String) -> Result<String, ArtifactRecordError> {
    bounded(value, MAX_OPAQUE_BYTES).ok_or(ArtifactRecordError::BlankIdentity)
}
