use std::{fmt, path::PathBuf};

use crate::{
    EnvironmentId, EnvironmentObservationFault, EnvironmentObservationPort,
    EnvironmentReconciliationInput, EnvironmentReconciliationOracle, EnvironmentReconciliationPlan,
    EnvironmentRevision, EnvironmentStore, RuntimeObservationScope, StoreFault,
};

/// Consumes only revision- and scope-bound native snapshots. Observations remain
/// runtime facts: this consumer does not persist them as Desired or Applied state.
pub struct EnvironmentObservedConsumer<P> {
    observation: P,
    store: EnvironmentStore,
    reconciliation: EnvironmentReconciliationOracle,
}

impl<P> EnvironmentObservedConsumer<P> {
    pub fn open(observation: P, store_path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        Ok(Self {
            observation,
            store: EnvironmentStore::open(store_path)?,
            reconciliation: EnvironmentReconciliationOracle,
        })
    }
}

impl<P: EnvironmentObservationPort> EnvironmentObservedConsumer<P> {
    pub async fn observe_revision(
        &mut self,
        environment_id: &EnvironmentId,
        expected_revision: EnvironmentRevision,
        scope: &RuntimeObservationScope,
    ) -> Result<EnvironmentObservedReceipt, EnvironmentObservedFailure> {
        let facts = self.current_facts(environment_id, expected_revision)?;
        if !facts.has_current_applied_evidence() {
            return Ok(self.receipt(&facts, scope, &[], &[]));
        }

        let connectors = self
            .observation
            .observe_connectors(environment_id, expected_revision, scope)
            .await
            .map_err(EnvironmentObservedFailure::Observation)?;
        if connectors.environment_id() != environment_id
            || connectors.scope() != scope
            || connectors.applied_revision() != expected_revision
        {
            return Err(EnvironmentObservedFailure::ObservationBindingMismatch);
        }

        let operational = self
            .observation
            .observe_operational(environment_id, expected_revision, scope)
            .await
            .map_err(EnvironmentObservedFailure::Observation)?;
        if operational.environment_id() != environment_id
            || operational.scope() != scope
            || operational.applied_revision() != expected_revision
        {
            return Err(EnvironmentObservedFailure::ObservationBindingMismatch);
        }

        Ok(self.receipt(&facts, scope, &[connectors], &[operational]))
    }

    fn current_facts(
        &self,
        environment_id: &EnvironmentId,
        expected_revision: EnvironmentRevision,
    ) -> Result<crate::EnvironmentFacts, EnvironmentObservedFailure> {
        let Some(facts) = self.store.environment(environment_id) else {
            return Err(EnvironmentObservedFailure::UnknownEnvironment);
        };
        if facts.is_tombstone() {
            return Err(EnvironmentObservedFailure::UnknownEnvironment);
        }
        if facts.desired_revision() != expected_revision {
            return Err(EnvironmentObservedFailure::RevisionConflict);
        }
        Ok(facts.clone())
    }

    fn receipt(
        &self,
        facts: &crate::EnvironmentFacts,
        scope: &RuntimeObservationScope,
        connectors: &[crate::EnvironmentObservation],
        operational: &[crate::OperationalObservation],
    ) -> EnvironmentObservedReceipt {
        let plan = self
            .reconciliation
            .evaluate(EnvironmentReconciliationInput::new(
                facts,
                scope,
                connectors,
                operational,
            ));
        EnvironmentObservedReceipt::new(
            facts.environment_id().as_str().to_owned(),
            facts.desired_revision(),
            plan,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentObservedReceipt {
    environment_id: String,
    revision: EnvironmentRevision,
    reconciliation: EnvironmentReconciliationPlan,
}

impl EnvironmentObservedReceipt {
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
pub enum EnvironmentObservedFailure {
    UnknownEnvironment,
    RevisionConflict,
    ObservationBindingMismatch,
    Observation(EnvironmentObservationFault),
}

impl fmt::Display for EnvironmentObservedFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnknownEnvironment => "environment desired configuration is unknown",
            Self::RevisionConflict => {
                "environment desired revision no longer matches the requested observation"
            }
            Self::ObservationBindingMismatch => {
                "environment observation readback does not match the requested revision and scope"
            }
            Self::Observation(error) => return error.fmt(formatter),
        })
    }
}

impl std::error::Error for EnvironmentObservedFailure {}

#[cfg(test)]
#[path = "observed_tests.rs"]
mod tests;
