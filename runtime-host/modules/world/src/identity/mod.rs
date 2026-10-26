mod aliases;
mod branch;
pub(crate) use branch::{reserve_branch_identity, read_branch_identity, read_branch_identity_transaction, promote_branch_identity, branch_identity_retention_roots};
mod change;
mod matching;
mod prepared;
mod records;
mod retention;
pub(crate) use retention::retention_roots;
mod remap;
mod source;

pub(crate) use aliases::{bind_alias, close_alias, register_alias_range, lock_source_alias_range, resolve_native_key_transaction, resolve_native_key_snapshot, resolve, resolve_transaction as resolve_in_transaction, recheck_receipt, recheck_receipts};
pub(crate) use change::{apply_change, prepare_change};
pub(crate) use matching::{IdentityProposer, SourceIdentity, accept_proposal, propose};
pub(crate) use prepared::PreparedIdentity;
pub(crate) use records::{create, get, get_in_transaction, lock_influence, recheck_identity, touch_influence};
pub(crate) use remap::RemappedObservation;
pub(crate) use source::{PreparedSourceIdentities, prepare_source_identities, recheck_source_identities, accept_source_identities, close_source_aliases};

use std::fmt;

use serde::{Serialize, de::DeserializeOwned};
use world_protocol::{
    commit::CommitFailure,
    identity::{IdentityFailure, IdentityRecord, IdentitySnapshot, SubjectRef},
    ids::{DefinitionId, ResourceRef, WorldRef},
    time::ValidTime,
};

use crate::store::StoreError;

pub(crate) enum IdentityError {
    Rejected(IdentityFailure),
    Store(StoreError),
    Fact(crate::facts::assertions::Error),
}

impl From<IdentityFailure> for IdentityError {
    fn from(reason: IdentityFailure) -> Self { Self::Rejected(reason) }
}
impl From<StoreError> for IdentityError {
    fn from(error: StoreError) -> Self { Self::Store(error) }
}
impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self { Self::Rejected(_) => f.write_str("world.identity_rejected"), Self::Store(error) => error.fmt(f), Self::Fact(error) => error.fmt(f) }
    }
}
impl fmt::Debug for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Candidate IDs, keys and actual revisions are private, not public diagnostics.
        match self { Self::Rejected(_) => f.write_str("IdentityRejected"), Self::Store(error) => error.fmt(f), Self::Fact(error) => error.fmt(f) }
    }
}
impl std::error::Error for IdentityError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self { Self::Store(error) => Some(error), Self::Fact(error) => Some(error), Self::Rejected(_) => None }
    }
}

fn subject(record: &IdentityRecord) -> SubjectRef {
    match record {
        IdentityRecord::Object(record) => SubjectRef::Object { id: record.id.clone() },
        IdentityRecord::Relation(record) => SubjectRef::Relation { id: record.id.clone() },
    }
}
fn world(record: &IdentityRecord) -> &WorldRef {
    match record { IdentityRecord::Object(record) => &record.world, IdentityRecord::Relation(record) => &record.world }
}
fn type_id(record: &IdentityRecord) -> &DefinitionId {
    match record { IdentityRecord::Object(record) => &record.type_id, IdentityRecord::Relation(record) => &record.type_id }
}
fn parts(subject: &SubjectRef) -> (&'static str, &str) {
    match subject { SubjectRef::Object { id } => ("object", id.as_str()), SubjectRef::Relation { id } => ("relation", id.as_str()) }
}
fn resource(subject: &SubjectRef) -> ResourceRef {
    match subject { SubjectRef::Object { id } => ResourceRef::Object { id: id.clone() }, SubjectRef::Relation { id } => ResourceRef::Relation { id: id.clone() } }
}
fn validate_interval(interval: &ValidTime) -> Result<(), IdentityError> {
    if interval.to.as_ref().is_some_and(|to| to <= &interval.from) { return Err(IdentityFailure::InvalidInterval.into()); }
    Ok(())
}
fn overlaps(left: &ValidTime, right: &ValidTime) -> bool {
    left.to.as_ref().is_none_or(|to| &right.from < to) && right.to.as_ref().is_none_or(|to| &left.from < to)
}
fn contains(outer: &ValidTime, inner: &ValidTime) -> bool {
    outer.from <= inner.from && match (&outer.to, &inner.to) {
        (None, _) => true, (Some(outer), Some(inner)) => inner <= outer, (Some(_), None) => false,
    }
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, IdentityError> {
    serde_json::to_value(value).map_err(|_| IdentityFailure::InternalFault.into())
}
fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, IdentityError> {
    serde_json::from_value(value).map_err(|_| IdentityFailure::InternalFault.into())
}
fn revision(value: u64) -> Result<i64, IdentityError> {
    i64::try_from(value).ok().filter(|value| *value > 0)
        .ok_or_else(|| IdentityFailure::Commit { failure: CommitFailure::InvalidBatch }.into())
}
fn actor_id(admission: &crate::authorization::Admission) -> &world_protocol::ids::ActorId {
    match &admission.invocation().actor {
        world_protocol::authorization::Actor::Human { id } | world_protocol::authorization::Actor::Service { id } => id,
    }
}
async fn authorize(
    transaction: &crate::store::WorldTransaction<'_>, admission: &crate::authorization::Admission,
    scope: &world_protocol::ids::ScopeId, interval: &ValidTime, resources: &[ResourceRef],
    sources: &[world_protocol::ids::SourceId], now: &world_protocol::time::Timestamp,
) -> Result<world_protocol::authorization::Decision, IdentityError> {
    use crate::authorization::{AuthError, actual_impact, recheck};
    use world_protocol::{authorization::{AccessMode, AccessScope}, expression::Effect};
    fn auth_error(error: AuthError) -> IdentityError {
        match error {
            AuthError::Store(error) => IdentityError::Store(error),
            AuthError::Denied(_) => IdentityFailure::PermissionDenied.into(),
            AuthError::Codec(error) => IdentityError::Store(StoreError::caused_by(
                CommitFailure::InternalFault, world_protocol::failure::FailureStage::Admission, error)),
        }
    }
    transaction.require_domain(&world_protocol::ids::WriterDomain::try_new("identity").map_err(|_| IdentityFailure::InternalFault)?)?;
    if &admission.invocation().world != transaction.world() { return Err(IdentityFailure::PermissionDenied.into()); }
    let impact = actual_impact(vec![AccessScope {
        resources: resources.to_vec(), fields: Vec::new(), modes: vec![AccessMode::Write], scope: scope.clone(), valid_time: Some(interval.clone()),
    }], vec![Effect::Pure], Vec::new(), Vec::new(), sources.to_vec()).map_err(auth_error)?;
    admission.require_access(&impact).map_err(auth_error)?;
    recheck(transaction, admission, now).await.map_err(auth_error)
}
fn check_snapshot(expected: &IdentitySnapshot, actual: Option<&IdentitySnapshot>) -> Result<(), IdentityError> {
    let Some(actual) = actual else { return Err(IdentityFailure::UnresolvedIdentity { subject: subject(&expected.record) }.into()); };
    if expected.revision != actual.revision {
        return Err(IdentityFailure::RevisionConflict { expected: expected.revision, actual: actual.revision }.into());
    }
    if expected.record != actual.record { return Err(IdentityFailure::CrossWorld.into()); }
    Ok(())
}
