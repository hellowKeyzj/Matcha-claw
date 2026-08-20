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

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ArtifactLedger {
    records: BTreeMap<ArtifactId, ArtifactRecord>,
}

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
                self.records
                    .insert(record.artifact_id().clone(), record.clone());
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

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        self.records.retain(|_, record| record.run_id() != run_id);
    }
}
