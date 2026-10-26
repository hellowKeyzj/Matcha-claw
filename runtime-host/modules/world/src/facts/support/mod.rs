mod basis;
pub(super) use basis::{Reader as DependencyReader, Validity as DependencyValidity, check_read as check_dependency};
mod explanation;
mod graph;
mod interval;
mod maintenance;
mod prepared;
pub(crate) use prepared::{PreparedProvenance, check_proposal};
mod recompute;
mod verified;
mod watches;

pub(crate) use verified::resolve_verified_interval;
pub(super) use verified::{ReadAuthority as DependencyAuthority, dependency_closure_impact, recheck_authorized_dependencies};
pub(crate) use interval::{IntervalBasis, interval_basis};

pub(crate) use basis::{
    require_current as recheck_dependencies,
    require_current_in_model as recheck_dependencies_in_model,
    require_current_snapshot as recheck_dependencies_snapshot,
    require_current_snapshot_in_model as recheck_dependencies_snapshot_in_model, retain_support,
    support_retention,
};
pub(crate) use explanation::{
    dependency_impact, dependency_impact_snapshot, explain, explain_impact, explanation_retention,
};
pub(crate) use maintenance::{
    accept, assertion_ranges, derivation_impact, invalidate, invalidate_dependencies,
    lock_assertion_ranges, prepare_derivation, resolve,
    resolve_interval, resolve_transaction, resolve_transaction_interval, snapshot,
};
pub(crate) use recompute::{RecomputeClaim, claim, complete, recompute_impact, recompute_retention, release_claim, world_deletion_roots};
pub(crate) use watches::{
    DueWatches, due_impact, due_retention, expire_due, select_due,
    invalidate_ranges, lock_ranges, recheck_ranges, register_watch, watch_retention,
};

use crate::store::StoreError;
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest as _, Sha256};
use std::{error::Error, fmt};
use world_protocol::{
    commit::{CommitFailure, ConstraintCode},
    failure::FailureStage,
    ids::*,
    provenance::{PremiseRef, ProvenanceFailure, ReadDependency, SupportSet},
    time::ValidTime,
};

const BATCH_LIMIT: usize = 4096;

#[derive(Debug)]
struct Rejected(ProvenanceFailure);
impl fmt::Display for Rejected {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("world.provenance_rejected")
    }
}
impl Error for Rejected {}

fn reject(reason: ProvenanceFailure) -> StoreError {
    let failure = match &reason {
        ProvenanceFailure::CyclicSupport { .. } => CommitFailure::ConstraintConflict {
            constraint: ConstraintCode::SupportCycle,
        },
        ProvenanceFailure::BasisChanged { watch_id, .. } => CommitFailure::ReadDependencyChanged {
            resource: ResourceRef::Watch {
                id: watch_id.clone(),
            },
        },
        _ => CommitFailure::InvalidBatch,
    };
    StoreError::caused_by(failure, FailureStage::Validate, Rejected(reason))
}
fn checkpoint(
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(), StoreError> {
    if cancellation.is_cancelled() {
        return Err(reject(
            world_protocol::provenance::ProvenanceFailure::Cancelled,
        ));
    }
    budget
        .charge(world_protocol::budget::BudgetDimension::Steps, 1)
        .map_err(|failure| {
            query_error(
                world_protocol::expression::ExpressionFailure::BudgetExceeded {
                    dimension: failure.dimension,
                }
                .into(),
            )
        })
}

fn query_error(error: crate::query::QueryError) -> StoreError {
    match error {
        crate::query::QueryError::Store(error) => error,
        error => StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, error),
    }
}

fn limit(resource: world_protocol::provenance::ProvenanceLimit) -> StoreError {
    reject(ProvenanceFailure::LimitExceeded {
        resource,
        limit: BATCH_LIMIT as u64,
    })
}

pub(crate) fn provenance_failure(error: &StoreError) -> ProvenanceFailure {
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(rejected) = cause.downcast_ref::<Rejected>() {
            return rejected.0.clone();
        }
        if let Some(error) = cause.downcast_ref::<crate::query::QueryError>() {
            use world_protocol::{expression::ExpressionFailure, query::QueryFailure};
            match error {
                crate::query::QueryError::Provenance(failure) => return failure.clone(),
                crate::query::QueryError::Rejected(
                    QueryFailure::Cancelled
                    | QueryFailure::Expression {
                        failure: ExpressionFailure::Cancelled,
                    },
                ) => {
                    return ProvenanceFailure::Cancelled;
                }
                crate::query::QueryError::Rejected(QueryFailure::Dirty { watches }) => {
                    return ProvenanceFailure::Dirty {
                        watches: watches.clone(),
                    };
                }
                _ => {}
            }
        }
        source = cause.source();
    }
    ProvenanceFailure::Commit {
        failure: error.reason.clone(),
    }
}

fn encode(value: &impl Serialize) -> Result<serde_json::Value, StoreError> {
    serde_json::to_value(value).map_err(|error| {
        StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, error)
    })
}
fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, StoreError> {
    serde_json::from_value(value).map_err(|error| {
        StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Read, error)
    })
}
fn number(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|error| {
        StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, error)
    })
}
fn key(value: &(impl Serialize + ?Sized)) -> Result<String, StoreError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, error)
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn contains(outer: &ValidTime, inner: &ValidTime) -> bool {
    outer.from <= inner.from
        && match (&outer.to, &inner.to) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(outer), Some(inner)) => inner <= outer,
        }
}
pub(super) fn dependencies(support: &SupportSet) -> Vec<ReadDependency> {
    let mut result = vec![ReadDependency::Definition {
        reference: support.rule.clone(),
    }];
    for premise in &support.premises {
        let dependency = match premise {
            PremiseRef::Assertion(reference) => ReadDependency::Assertion {
                reference: reference.clone(),
            },
            PremiseRef::Evidence(reference) => ReadDependency::Evidence {
                reference: reference.clone(),
            },
            PremiseRef::Read(dependency) => dependency.clone(),
        };
        if !result.contains(&dependency) {
            result.push(dependency);
        }
    }
    result
}
fn dependency_key(
    dependency: &ReadDependency,
) -> Result<(&'static str, String, Option<i64>, Option<i64>), StoreError> {
    Ok(match dependency {
        ReadDependency::Assertion { reference } => (
            "assertion",
            reference.id.to_string(),
            Some(number(reference.revision.0)?),
            None,
        ),
        ReadDependency::Evidence { reference } => (
            "evidence",
            reference.id.to_string(),
            Some(number(reference.revision.0)?),
            None,
        ),
        ReadDependency::Definition { reference } => (
            "definition",
            reference.id.to_string(),
            Some(number(reference.revision.0)?),
            None,
        ),
        ReadDependency::Watch { id, generation } => {
            ("watch", id.to_string(), None, Some(number(generation.0)?))
        }
        ReadDependency::Source { position, binding } => (
            "source",
            key(&(
                position.source_id.clone(),
                &position.partition,
                binding.id.clone(),
            ))?,
            Some(number(binding.revision.0)?),
            None,
        ),
        ReadDependency::SourceMapping { binding, .. } => (
            "source_mapping",
            binding.id.to_string(),
            Some(number(binding.revision.0)?),
            None,
        ),
        ReadDependency::SourceField { schema, field, .. } => (
            "source_field",
            key(&(&schema.id, field))?,
            Some(number(schema.revision.0)?),
            None,
        ),
        ReadDependency::TimeBoundary { at } => ("time_boundary", at.to_string(), None, None),
        ReadDependency::Identity { subject, revision } => {
            ("identity", key(subject)?, Some(number(revision.0)?), None)
        }
        ReadDependency::AliasRange { digest, generation } => (
            "alias_range",
            digest.to_string(),
            None,
            Some(number(generation.0)?),
        ),
    })
}
