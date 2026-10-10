use std::collections::BTreeMap;

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

#[derive(Clone, Debug, Default)]
pub struct ArtifactLedger {
    records: BTreeMap<ArtifactId, ArtifactRecord>,
    undo: Option<BTreeMap<ArtifactId, Option<ArtifactRecord>>>,
}
impl PartialEq for ArtifactLedger {
    fn eq(&self, other: &Self) -> bool {
        self.records == other.records
    }
}
impl Eq for ArtifactLedger {}

impl ArtifactLedger {
    pub fn restore(
        records: impl IntoIterator<Item = ArtifactRecord>,
    ) -> Result<Self, RestoreArtifactLedgerError> {
        let mut ledger = Self::default();
        for record in records {
            if ledger
                .records
                .insert(record.artifact_id().clone(), record.clone())
                .is_some()
            {
                return Err(RestoreArtifactLedgerError::DuplicateArtifactId(
                    record.artifact_id().clone(),
                ));
            }
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
        self.records
            .values()
            .filter(move |record| record.run_id() == run_id.as_str() && record.fence() == fence)
    }
    pub fn lookup_for_execution(
        &self,
        run_id: &GraphRunId,
        fence: &ExecutionFence,
    ) -> Option<&ArtifactRecord> {
        self.records
            .values()
            .find(|record| record.run_id() == run_id.as_str() && record.fence() == fence)
    }
    pub fn has_kind_for_run(&self, run_id: &GraphRunId, kind: Option<&str>) -> bool {
        self.records.values().any(|record| {
            record.run_id() == run_id.as_str() && kind.is_none_or(|wanted| record.kind() == wanted)
        })
    }

    pub(crate) fn restore_record(&mut self, record: ArtifactRecord) {
        let id = record.artifact_id().clone();
        if let Some(undo) = &mut self.undo {
            undo.entry(id.clone())
                .or_insert_with(|| self.records.get(&id).cloned());
        }
        self.records.insert(id, record);
    }

    pub(crate) fn remove_record(&mut self, id: &ArtifactId) {
        if let Some(record) = self.records.remove(id)
            && let Some(undo) = &mut self.undo
        {
            undo.entry(id.clone()).or_insert(Some(record));
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
