use std::collections::{BTreeMap, BTreeSet};

use crate::run::graph::ExecutionFence;

use super::{EvidenceId, EvidenceRecord, EvidenceReferenceKind};

#[derive(Clone, Default)]
pub struct EvidenceLedger {
    records: BTreeMap<EvidenceId, EvidenceRecord>,
    record_ids_by_run: BTreeMap<String, BTreeSet<EvidenceId>>,
    undo: Option<BTreeMap<EvidenceId, Option<EvidenceRecord>>>,
}
impl PartialEq for EvidenceLedger {
    fn eq(&self, other: &Self) -> bool {
        self.records == other.records
    }
}
impl Eq for EvidenceLedger {}

impl std::fmt::Debug for EvidenceLedger {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("EvidenceLedger")
            .field("records", &self.records)
            .field("undo", &self.undo)
            .finish()
    }
}

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
            ledger.restore_record(record);
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
        self.records_for_run(run_id).find_map(|record| {
            (record.reference().kind() == EvidenceReferenceKind::Artifact
                && record.matches_execution(run_id, fence))
            .then_some(record.reference().reference())
        })
    }

    pub fn records_for_run(&self, run_id: &str) -> impl Iterator<Item = &EvidenceRecord> {
        self.record_ids_by_run.get(run_id).into_iter().flatten()
            .map(|id| self.records.get(id).expect("evidence Run index references its record"))
    }

    pub(crate) fn restore_record(&mut self, record: EvidenceRecord) {
        let id = record.evidence_id().clone();
        self.remove_record(&id);
        if let Some(undo) = &mut self.undo {
            undo.entry(id.clone()).or_insert(None);
        }
        self.record_ids_by_run.entry(record.run_id().to_owned()).or_default().insert(id.clone());
        self.records.insert(id, record);
    }

    pub(crate) fn remove_record(&mut self, id: &EvidenceId) {
        if let Some(record) = self.records.remove(id) {
            if let Some(ids) = self.record_ids_by_run.get_mut(record.run_id()) {
                ids.remove(id);
                if ids.is_empty() { self.record_ids_by_run.remove(record.run_id()); }
            }
            if let Some(undo) = &mut self.undo { undo.entry(id.clone()).or_insert(Some(record)); }
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
        let Some(undo) = self.undo.take() else { return; };
        for id in undo.keys() { self.remove_record(id); }
        for record in undo.into_values().flatten() { self.restore_record(record); }
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        let ids = self.records_for_run(run_id)
            .map(|record| record.evidence_id().clone()).collect::<Vec<_>>();
        for id in ids { self.remove_record(&id); }
    }
}
