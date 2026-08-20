mod applied;
mod observed;

pub use applied::{
    EnvironmentAppliedConsumer, EnvironmentAppliedFailure, EnvironmentAppliedReceipt,
};
pub use observed::{
    EnvironmentObservedConsumer, EnvironmentObservedFailure, EnvironmentObservedReceipt,
};

use std::{fmt, path::PathBuf, time::SystemTime};

use crate::{
    EnvironmentAuthorizationPort, EnvironmentCommand, EnvironmentFacts, EnvironmentIngress,
    EnvironmentIngressFailure, EnvironmentReconciliationInput, EnvironmentReconciliationOracle,
    EnvironmentReconciliationPlan, EnvironmentRevision, EnvironmentStore, RuntimeObservationScope,
    SecurityPreset, StoreFault,
};

/// The sole Environment Desired consumer: it admits a verified command into the durable Domain
/// store, then derives the next reconciliation plan. It does not interpret transport credentials,
/// config writes, probes, caches, or runtime health as authorization or observation.
pub struct EnvironmentDesiredConsumer<A> {
    ingress: EnvironmentIngress<A>,
    store: EnvironmentStore,
    reconciliation: EnvironmentReconciliationOracle,
}

impl<A> EnvironmentDesiredConsumer<A> {
    pub fn open(authority: A, store_path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        Ok(Self {
            ingress: EnvironmentIngress::new(authority),
            store: EnvironmentStore::open(store_path)?,
            reconciliation: EnvironmentReconciliationOracle,
        })
    }
}

impl<A: EnvironmentAuthorizationPort> EnvironmentDesiredConsumer<A> {
    pub fn accept(
        &mut self,
        envelope: &[u8],
        scope: RuntimeObservationScope,
        now: SystemTime,
    ) -> Result<EnvironmentDesiredReceipt, EnvironmentDesiredFailure> {
        let command = self
            .ingress
            .accept(envelope, now)
            .map_err(EnvironmentDesiredFailure::Ingress)?;
        let facts = self.apply(command)?;
        if facts.is_tombstone() {
            return Ok(EnvironmentDesiredReceipt::deleted(
                facts.environment_id().as_str().to_owned(),
                facts.desired_revision(),
            ));
        }
        let desired = facts.desired();
        let plan = self
            .reconciliation
            .evaluate(EnvironmentReconciliationInput::new(
                &facts,
                &scope,
                &[],
                &[],
            ));
        Ok(EnvironmentDesiredReceipt::desired(
            facts.environment_id().as_str().to_owned(),
            facts.desired_revision(),
            desired.security_preset(),
            plan,
        ))
    }

    fn apply(
        &mut self,
        command: EnvironmentCommand,
    ) -> Result<EnvironmentFacts, EnvironmentDesiredFailure> {
        let expected = command.expected_revision();
        let current = self.store.environment(command.environment_id());
        match (command, current) {
            (EnvironmentCommand::Create(definition), None) => self
                .store
                .persist_desired(definition.definition().clone())
                .cloned()
                .map_err(EnvironmentDesiredFailure::after_authorization),
            (EnvironmentCommand::Create(_), Some(_)) => {
                Err(EnvironmentDesiredFailure::AlreadyExists)
            }
            (EnvironmentCommand::Replace(replace), Some(current))
                if Some(current.desired_revision()) == expected =>
            {
                self.store
                    .persist_desired(replace.definition().clone())
                    .cloned()
                    .map_err(EnvironmentDesiredFailure::after_authorization)
            }
            (EnvironmentCommand::Replace(_), Some(_)) => {
                Err(EnvironmentDesiredFailure::RevisionConflict)
            }
            (EnvironmentCommand::Replace(_), None) => {
                Err(EnvironmentDesiredFailure::UnknownEnvironment)
            }
            (EnvironmentCommand::Delete(delete), Some(current))
                if current.desired_revision() == delete.expected_revision() =>
            {
                self.store
                    .persist_delete(delete.environment_id(), delete.expected_revision())
                    .cloned()
                    .map_err(EnvironmentDesiredFailure::after_authorization)
            }
            (EnvironmentCommand::Delete(_), Some(_)) => {
                Err(EnvironmentDesiredFailure::RevisionConflict)
            }
            (EnvironmentCommand::Delete(_), None) => {
                Err(EnvironmentDesiredFailure::UnknownEnvironment)
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvironmentDesiredReceipt {
    Desired {
        environment_id: String,
        revision: EnvironmentRevision,
        security_preset: SecurityPreset,
        reconciliation: EnvironmentReconciliationPlan,
    },
    Deleted {
        environment_id: String,
        revision: EnvironmentRevision,
    },
}

impl EnvironmentDesiredReceipt {
    fn desired(
        environment_id: String,
        revision: EnvironmentRevision,
        security_preset: SecurityPreset,
        reconciliation: EnvironmentReconciliationPlan,
    ) -> Self {
        Self::Desired {
            environment_id,
            revision,
            security_preset,
            reconciliation,
        }
    }

    fn deleted(environment_id: String, revision: EnvironmentRevision) -> Self {
        Self::Deleted {
            environment_id,
            revision,
        }
    }

    pub fn environment_id(&self) -> &str {
        match self {
            Self::Desired { environment_id, .. } | Self::Deleted { environment_id, .. } => {
                environment_id
            }
        }
    }

    pub const fn revision(&self) -> EnvironmentRevision {
        match self {
            Self::Desired { revision, .. } | Self::Deleted { revision, .. } => *revision,
        }
    }

    pub const fn security_preset(&self) -> Option<SecurityPreset> {
        match self {
            Self::Desired {
                security_preset, ..
            } => Some(*security_preset),
            Self::Deleted { .. } => None,
        }
    }

    pub fn reconciliation(&self) -> Option<&EnvironmentReconciliationPlan> {
        match self {
            Self::Desired { reconciliation, .. } => Some(reconciliation),
            Self::Deleted { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentDesiredFailure {
    Ingress(EnvironmentIngressFailure),
    RetryUnsafeAfterAuthorization,
    AlreadyExists,
    UnknownEnvironment,
    RevisionConflict,
    Store(StoreFault),
}

impl EnvironmentDesiredFailure {
    fn after_authorization(error: StoreFault) -> Self {
        match error {
            StoreFault::CommitOutcomeUnknown(_) => Self::RetryUnsafeAfterAuthorization,
            error => Self::Store(error),
        }
    }
}

impl fmt::Display for EnvironmentDesiredFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Ingress(error) => return error.fmt(formatter),
            Self::RetryUnsafeAfterAuthorization => {
                "environment desired commit outcome is unknown after authorization; retry is unsafe"
            }
            Self::AlreadyExists => "environment desired configuration already exists",
            Self::UnknownEnvironment => "environment desired configuration is unknown",
            Self::RevisionConflict => "environment desired configuration revision conflicts",
            Self::Store(error) => return error.fmt(formatter),
        })
    }
}

impl std::error::Error for EnvironmentDesiredFailure {}

#[cfg(test)]
mod tests;
