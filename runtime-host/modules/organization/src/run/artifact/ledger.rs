use std::collections::{BTreeMap, BTreeSet};

use super::{ArtifactId, ArtifactRecord};
use crate::run::graph::{ExecutionFence, GraphRunId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArtifactRecordOutcome {
    Recorded(ArtifactRecord),
    Replayed(ArtifactRecord),
    ConflictingArtifactId { artifact_id: ArtifactId },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreArtifactLedgerError {
    DuplicateArtifactId(ArtifactId),
}

#[derive(Clone, Default)]
pub struct ArtifactLedger {
    records: BTreeMap<ArtifactId, ArtifactRecord>,
    record_ids_by_run: BTreeMap<String, BTreeSet<ArtifactId>>,
    undo: Option<BTreeMap<ArtifactId, Option<ArtifactRecord>>>,
}
impl PartialEq for ArtifactLedger {
    fn eq(&self, other: &Self) -> bool {
        self.records == other.records
    }
}
impl Eq for ArtifactLedger {}

impl std::fmt::Debug for ArtifactLedger {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("ArtifactLedger")
            .field("records", &self.records)
            .field("undo", &self.undo)
            .finish()
    }
}

impl ArtifactLedger {
    pub fn restore(
        records: impl IntoIterator<Item = ArtifactRecord>,
    ) -> Result<Self, RestoreArtifactLedgerError> {
        let mut ledger = Self::default();
        for record in records {
            if ledger.records.contains_key(record.artifact_id()) {
                return Err(RestoreArtifactLedgerError::DuplicateArtifactId(
                    record.artifact_id().clone(),
                ));
            }
            ledger.restore_record(record);
        }
        Ok(ledger)
    }
    pub fn record(&mut self, record: ArtifactRecord) -> ArtifactRecordOutcome {
        match self.records.get(record.artifact_id()) {
            Some(existing) if existing == &record => {
                ArtifactRecordOutcome::Replayed(existing.clone())
            }
            Some(_) => ArtifactRecordOutcome::ConflictingArtifactId {
                artifact_id: record.artifact_id().clone(),
            },
            None => {
                self.restore_record(record.clone());
                ArtifactRecordOutcome::Recorded(record)
            }
        }
    }
    pub fn artifact(&self, id: &ArtifactId) -> Option<&ArtifactRecord> {
        self.records.get(id)
    }
    pub fn records(&self) -> impl Iterator<Item = &ArtifactRecord> {
        self.records.values()
    }
    pub fn records_for_execution<'a>(
        &'a self,
        run_id: &'a GraphRunId,
        fence: &'a ExecutionFence,
    ) -> impl Iterator<Item = &'a ArtifactRecord> {
        self.records_for_run(run_id.as_str())
            .filter(move |record| record.fence() == fence)
    }
    pub fn lookup_for_execution(
        &self,
        run_id: &GraphRunId,
        fence: &ExecutionFence,
    ) -> Option<&ArtifactRecord> {
        self.records_for_run(run_id.as_str())
            .find(|record| record.fence() == fence)
    }
    pub fn has_kind_for_run(&self, run_id: &GraphRunId, kind: Option<&str>) -> bool {
        self.records_for_run(run_id.as_str()).any(|record| {
            kind.is_none_or(|wanted| record.kind() == wanted)
        })
    }

    pub(crate) fn records_for_run(&self, run_id: &str) -> impl Iterator<Item = &ArtifactRecord> {
        self.record_ids_by_run.get(run_id).into_iter().flatten()
            .map(|id| self.records.get(id).expect("artifact Run index references its record"))
    }

    pub(crate) fn restore_record(&mut self, record: ArtifactRecord) {
        let id = record.artifact_id().clone();
        self.remove_record(&id);
        if let Some(undo) = &mut self.undo {
            undo.entry(id.clone()).or_insert(None);
        }
        self.record_ids_by_run.entry(record.run_id().to_owned()).or_default().insert(id.clone());
        self.records.insert(id, record);
    }

    pub(crate) fn remove_record(&mut self, id: &ArtifactId) {
        if let Some(record) = self.records.remove(id) {
            if let Some(ids) = self.record_ids_by_run.get_mut(record.run_id()) {
                ids.remove(id);
                if ids.is_empty() { self.record_ids_by_run.remove(record.run_id()); }
            }
            if let Some(undo) = &mut self.undo { undo.entry(id.clone()).or_insert(Some(record)); }
        }
    }

    pub(crate) fn begin_transaction(&mut self) {
        assert!(self.undo.is_none(), "artifact transaction already active");
        self.undo = Some(BTreeMap::new());
    }

    pub(crate) fn changed_ids(&self) -> impl Iterator<Item = &ArtifactId> {
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
            .map(|record| record.artifact_id().clone()).collect::<Vec<_>>();
        for id in ids { self.remove_record(&id); }
    }
}
