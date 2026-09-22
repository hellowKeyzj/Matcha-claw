use std::fmt;

use crate::run::graph::ExecutionFence;

use super::EvidenceReference;

const MAX_EVIDENCE_ID_BYTES: usize = 128;
const MAX_CORRELATION_BYTES: usize = 128;

#[derive(Clone, Eq, PartialEq)]
pub struct EvidenceRecord {
    evidence_id: EvidenceId,
    run_id: String,
    node_execution_id: String,
    reference: EvidenceReference,
    recorded_at: u64,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EvidenceId(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceIdError {
    Blank,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceRecordError {
    BlankRunId,
    BlankNodeExecutionId,
}

impl EvidenceId {
    pub fn new(value: impl Into<String>) -> Result<Self, EvidenceIdError> {
        let value = value.into();
        if value.trim().is_empty() || value.len() > MAX_EVIDENCE_ID_BYTES {
            return Err(EvidenceIdError::Blank);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl EvidenceRecord {
    pub fn new(
        evidence_id: EvidenceId,
        run_id: impl Into<String>,
        node_execution_id: impl Into<String>,
        reference: EvidenceReference,
        recorded_at: u64,
    ) -> Result<Self, EvidenceRecordError> {
        let run_id = run_id.into();
        if run_id.trim().is_empty() || run_id.len() > MAX_CORRELATION_BYTES {
            return Err(EvidenceRecordError::BlankRunId);
        }
        let node_execution_id = node_execution_id.into();
        if node_execution_id.trim().is_empty() || node_execution_id.len() > MAX_CORRELATION_BYTES {
            return Err(EvidenceRecordError::BlankNodeExecutionId);
        }
        Ok(Self {
            evidence_id,
            run_id,
            node_execution_id,
            reference,
            recorded_at,
        })
    }

    pub fn evidence_id(&self) -> &EvidenceId {
        &self.evidence_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn node_execution_id(&self) -> &str {
        &self.node_execution_id
    }

    pub fn matches_execution(&self, run_id: &str, fence: &ExecutionFence) -> bool {
        self.run_id == run_id && self.node_execution_id == fence.node_execution_id().as_str()
    }

    pub fn reference(&self) -> &EvidenceReference {
        &self.reference
    }

    pub fn is_artifact(&self) -> bool {
        self.reference.kind() == super::EvidenceReferenceKind::Artifact
    }

    pub const fn recorded_at(&self) -> u64 {
        self.recorded_at
    }
}

impl fmt::Debug for EvidenceRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EvidenceRecord")
            .field("evidence_id", &self.evidence_id)
            .field("run_id", &self.run_id)
            .field("node_execution_id", &self.node_execution_id)
            .field("reference", &self.reference)
            .field("recorded_at", &self.recorded_at)
            .finish()
    }
}
