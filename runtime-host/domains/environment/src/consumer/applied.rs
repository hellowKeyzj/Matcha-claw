use std::{fmt, path::PathBuf};

use crate::{
    ApplyEvidenceFault, DesiredDefinition, EnvironmentId, EnvironmentProjectionFault,
    EnvironmentProjectionPort, EnvironmentReconciliationInput, EnvironmentReconciliationOracle,
    EnvironmentReconciliationPlan, EnvironmentRevision, EnvironmentStore, RuntimeObservationScope,
    StoreFault,
};

pub struct EnvironmentAppliedConsumer<P> {
    projection: P,
    store: EnvironmentStore,
    reconciliation: EnvironmentReconciliationOracle,
}

impl<P> EnvironmentAppliedConsumer<P> {
    pub fn open(projection: P, store_path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        Ok(Self {
            projection,
            store: EnvironmentStore::open(store_path)?,
            reconciliation: EnvironmentReconciliationOracle,
        })
    }
}

impl<P: EnvironmentProjectionPort> EnvironmentAppliedConsumer<P> {
    pub async fn apply_revision(
        &mut self,
        environment_id: &EnvironmentId,
        expected_revision: EnvironmentRevision,
        scope: &RuntimeObservationScope,
    ) -> Result<EnvironmentAppliedReceipt, EnvironmentAppliedFailure> {
        let desired = self.current_desired(environment_id, expected_revision)?;
        let projection = self
            .projection
            .apply(&desired)
            .await
            .map_err(EnvironmentAppliedFailure::Projection)?;
        if projection.environment_id() != desired.environment_id()
            || projection.revision() != desired.revision()
        {
            return Err(EnvironmentAppliedFailure::ProjectionBindingMismatch);
        }
        self.store
            .record_applied(projection)
            .map_err(EnvironmentAppliedFailure::after_projection)?;
        Ok(self.receipt_for_current_facts(environment_id, scope))
    }

    fn current_desired(
        &self,
        environment_id: &EnvironmentId,
        expected_revision: EnvironmentRevision,
    ) -> Result<DesiredDefinition, EnvironmentAppliedFailure> {
        let Some(facts) = self.store.environment(environment_id) else {
            return Err(EnvironmentAppliedFailure::UnknownEnvironment);
        };
        if facts.is_tombstone() {
            return Err(EnvironmentAppliedFailure::UnknownEnvironment);
        }
        if facts.desired_revision() != expected_revision {
            return Err(EnvironmentAppliedFailure::RevisionConflict);
        }
        Ok(facts.desired().clone())
    }

    fn receipt_for_current_facts(
        &self,
        environment_id: &EnvironmentId,
        scope: &RuntimeObservationScope,
    ) -> EnvironmentAppliedReceipt {
        let facts = self
            .store
            .environment(environment_id)
            .expect("current Environment facts remain available");
        let plan = self
            .reconciliation
            .evaluate(EnvironmentReconciliationInput::new(facts, scope, &[], &[]));
        EnvironmentAppliedReceipt::new(
            facts.environment_id().as_str().to_owned(),
            facts.desired_revision(),
            plan,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentAppliedReceipt {
    environment_id: String,
    revision: EnvironmentRevision,
    reconciliation: EnvironmentReconciliationPlan,
}

impl EnvironmentAppliedReceipt {
    fn new(
        environment_id: String,
        revision: EnvironmentRevision,
        reconciliation: EnvironmentReconciliationPlan,
    ) -> Self {
        Self {
            environment_id,
            revision,
            reconciliation,
        }
    }

    pub fn environment_id(&self) -> &str {
        &self.environment_id
    }

    pub const fn revision(&self) -> EnvironmentRevision {
        self.revision
    }

    pub fn reconciliation(&self) -> &EnvironmentReconciliationPlan {
        &self.reconciliation
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentAppliedFailure {
    UnknownEnvironment,
    RevisionConflict,
    ProjectionBindingMismatch,
    Projection(EnvironmentProjectionFault),
    RetryUnsafeAfterProjection,
    Store(StoreFault),
}

impl EnvironmentAppliedFailure {
    fn after_projection(error: StoreFault) -> Self {
        match error {
            StoreFault::CommitOutcomeUnknown(_) => Self::RetryUnsafeAfterProjection,
            StoreFault::ApplyEvidence(ApplyEvidenceFault::UnknownEnvironment) => {
                Self::UnknownEnvironment
            }
            StoreFault::ApplyEvidence(ApplyEvidenceFault::RevisionMismatch { .. }) => {
                Self::RevisionConflict
            }
            error => Self::Store(error),
        }
    }
}

impl fmt::Display for EnvironmentAppliedFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnknownEnvironment => "environment desired configuration is unknown",
            Self::RevisionConflict => {
                "environment desired revision no longer matches the requested projection"
            }
            Self::ProjectionBindingMismatch => {
                "environment projection readback does not match the requested desired revision"
            }
            Self::Projection(error) => return error.fmt(formatter),
            Self::RetryUnsafeAfterProjection => {
                "environment applied commit outcome is unknown after projection; retry is unsafe"
            }
            Self::Store(error) => return error.fmt(formatter),
        })
    }
}

impl std::error::Error for EnvironmentAppliedFailure {}

#[cfg(test)]
#[path = "applied_tests.rs"]
mod tests;
