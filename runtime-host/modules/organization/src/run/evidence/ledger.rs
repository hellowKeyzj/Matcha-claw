use std::collections::BTreeMap;

use crate::run::graph::ExecutionFence;

use super::{EvidenceId, EvidenceRecord, EvidenceReferenceKind};

#[derive(Clone, Debug, Default)]
pub struct EvidenceLedger {
    records: BTreeMap<EvidenceId, EvidenceRecord>,
    undo: Option<BTreeMap<EvidenceId, Option<EvidenceRecord>>>,
}
impl PartialEq for EvidenceLedger {
    fn eq(&self, other: &Self) -> bool {
        self.records == other.records
    }
}
impl Eq for EvidenceLedger {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecordOutcome {
    Recorded(EvidenceRecord),
    Replayed(EvidenceRecord),
    ConflictingEvidenceId { evidence_id: EvidenceId },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreLedgerError {
    DuplicateEvidenceId(EvidenceId),
}

impl EvidenceLedger {
    pub fn restore(
        records: impl IntoIterator<Item = EvidenceRecord>,
    ) -> Result<Self, RestoreLedgerError> {
        let mut ledger = Self::default();
        for record in records {
            if ledger.records.contains_key(record.evidence_id()) {
                return Err(RestoreLedgerError::DuplicateEvidenceId(
                    record.evidence_id().clone(),
                ));
            }
            ledger.records.insert(record.evidence_id().clone(), record);
        }
        Ok(ledger)
    }

    pub fn record(&mut self, record: EvidenceRecord) -> RecordOutcome {
        match self.records.get(record.evidence_id()) {
            Some(existing) if existing == &record => RecordOutcome::Replayed(existing.clone()),
            Some(_) => RecordOutcome::ConflictingEvidenceId {
                evidence_id: record.evidence_id().clone(),
            },
            None => {
                self.restore_record(record.clone());
                RecordOutcome::Recorded(record)
            }
        }
    }

    pub fn evidence(&self, evidence_id: &EvidenceId) -> Option<&EvidenceRecord> {
        self.records.get(evidence_id)
    }

    pub fn records(&self) -> impl Iterator<Item = &EvidenceRecord> {
        self.records.values()
    }

    pub fn records_for_node_execution(
        &self,
        node_execution_id: &str,
    ) -> impl Iterator<Item = &EvidenceRecord> {
        self.records
            .values()
            .filter(move |record| record.node_execution_id() == node_execution_id)
    }

    /// Returns only artifact references attached to the current node execution.
    ///
    /// Workspace paths, URIs, and inline text remain evidence facts but are not
    /// promoted to artifacts by the TeamRun owner.
    pub fn artifact_records_for_node_execution(
        &self,
        node_execution_id: &str,
    ) -> impl Iterator<Item = &EvidenceRecord> {
        self.records_for_node_execution(node_execution_id)
            .filter(|record| record.reference().kind() == super::EvidenceReferenceKind::Artifact)
    }

    pub fn has_artifact_for_node_execution(&self, node_execution_id: &str) -> bool {
        self.artifact_records_for_node_execution(node_execution_id)
            .next()
            .is_some()
    }

    pub fn artifact_reference_for_node_execution(&self, node_execution_id: &str) -> Option<&str> {
        self.artifact_records_for_node_execution(node_execution_id)
            .next()
            .map(|record| record.reference().reference())
    }

    /// Returns an artifact only when its durable record matches the active run and execution fence.
    pub fn artifact_reference_for_execution(
        &self,
        run_id: &str,
        fence: &ExecutionFence,
    ) -> Option<&str> {
        self.records.values().find_map(|record| {
            (record.reference().kind() == EvidenceReferenceKind::Artifact
                && record.matches_execution(run_id, fence))
            .then_some(record.reference().reference())
        })
    }

    pub fn records_for_run(&self, run_id: &str) -> impl Iterator<Item = &EvidenceRecord> {
        self.records
            .values()
            .filter(move |record| record.run_id() == run_id)
    }

    pub(crate) fn restore_record(&mut self, record: EvidenceRecord) {
        let id = record.evidence_id().clone();
        if let Some(undo) = &mut self.undo {
            undo.entry(id.clone())
                .or_insert_with(|| self.records.get(&id).cloned());
        }
        self.records.insert(id, record);
    }

    pub(crate) fn remove_record(&mut self, id: &EvidenceId) {
        if let Some(record) = self.records.remove(id)
            && let Some(undo) = &mut self.undo
        {
            undo.entry(id.clone()).or_insert(Some(record));
        }
    }

    pub(crate) fn begin_transaction(&mut self) {
        assert!(self.undo.is_none(), "evidence transaction already active");
        self.undo = Some(BTreeMap::new());
    }

    pub(crate) fn changed_ids(&self) -> impl Iterator<Item = &EvidenceId> {
        self.undo.iter().flat_map(|undo| undo.keys())
    }

    pub(crate) fn commit_transaction(&mut self) {
        self.undo = None;
    }

    pub(crate) fn rollback_transaction(&mut self) {
        for (id, previous) in self.undo.take().into_iter().flatten() {
            if let Some(record) = previous {
                self.records.insert(id, record);
            } else {
                self.records.remove(&id);
            }
        }
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        self.records.retain(|id, record| {
            if record.run_id() != run_id {
                return true;
            }
            if let Some(undo) = &mut self.undo {
                undo.entry(id.clone())
                    .or_insert_with(|| Some(record.clone()));
            }
            false
        });
    }
}
