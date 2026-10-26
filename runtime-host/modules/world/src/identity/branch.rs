use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope}, definitions::DefinitionBody, expression::Effect,
    identity::{AliasResolution, IdentityFailure, IdentityRecord, IdentitySnapshot, Object, Relation, SourceKey},
    ids::*, releases::BranchRef, time::Timestamp,
};
use crate::{authorization::{self, Admission}, store::{WorldSnapshot, WorldTransaction}};
use super::{IdentityError, aliases, decode, encode, parts, resource, revision, subject, type_id};

#[derive(Serialize, Deserialize)]
struct Reservation { branch: BranchRef, key: SourceKey, type_ref: DefinitionRef, scope: ScopeId, identity: IdentitySnapshot }
#[derive(Serialize, Deserialize)]
struct Promotion { reservation: Digest, target: IdentitySnapshot, decision: DecisionId, evidence: Vec<EvidenceRef> }

fn digest(branch: &BranchRef, reference: &DefinitionRef, key: &SourceKey) -> Result<Digest, IdentityError> {
    crate::definitions::canonical_digest(&("world.identity.branch.v1", branch, key, reference))
        .map_err(|error| IdentityError::Fact(error.into()))
}
pub(super) fn release_error(error: crate::releases::Error) -> IdentityError {
    IdentityError::Store(crate::store::StoreError::caused_by(world_protocol::commit::CommitFailure::InvalidBatch, world_protocol::failure::FailureStage::Validate, error))
}
async fn authorize(tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, key: &SourceKey, scope: &ScopeId, at: &Timestamp) -> Result<(), IdentityError> {
    tx.require_domain(&WriterDomain::try_new("identity").map_err(|_| IdentityFailure::InternalFault)?)?;
    if tx.world() != &branch.world || tx.world() != &key.world || tx.world() != &admission.invocation().world { return Err(IdentityFailure::CrossWorld.into()); }
    super::validate_interval(&key.valid_time)?;
    if key.namespace.is_empty() || key.native_key.is_empty() || key.incarnation.is_empty() { return Err(IdentityFailure::AliasConflict { key: key.clone() }.into()); }
    let impact = authorization::actual_impact(vec![
        AccessScope { resources: vec![ResourceRef::Branch { id: branch.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Write], scope: scope.clone(), valid_time: Some(key.valid_time.clone()) },
        AccessScope { resources: vec![ResourceRef::Source { id: key.source_id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(key.valid_time.clone()) },
    ], vec![Effect::Pure], Vec::new(), Vec::new(), vec![key.source_id.clone()]).map_err(auth_error)?;
    admission.require_access(&impact).map_err(auth_error)?;
    authorization::recheck(tx, admission, at).await.map_err(auth_error)?;
    Ok(())
}
fn auth_error(error: authorization::AuthError) -> IdentityError {
    match error { authorization::AuthError::Store(error) => error.into(), error => IdentityError::Store(crate::store::StoreError::caused_by(world_protocol::commit::CommitFailure::InvalidBatch, world_protocol::failure::FailureStage::Admission, error)) }
}

/// Canonical branch-only reservation; it never inserts current identities, aliases or facts.
pub(crate) async fn reserve_branch_identity(
    tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, reference: &DefinitionRef,
    key: &SourceKey, scope: &ScopeId, at: &Timestamp,
) -> Result<IdentitySnapshot, IdentityError> {
    authorize(tx, admission, branch, key, scope, at).await?;
    if &reference.world != tx.world() { return Err(IdentityFailure::CrossWorld.into()); }
    let definition = resolve_type(tx, branch, reference, scope, &key.valid_time).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let record = match &definition.body {
        DefinitionBody::ObjectType(_) => IdentityRecord::Object(Object { world: tx.world().clone(), id: ObjectId::try_new(id).map_err(|_| IdentityFailure::InternalFault)?, type_id: reference.id.clone() }),
        DefinitionBody::RelationType(_) => IdentityRecord::Relation(Relation { world: tx.world().clone(), id: RelationId::try_new(id).map_err(|_| IdentityFailure::InternalFault)?, type_id: reference.id.clone() }),
        _ => return Err(IdentityFailure::TypeKindMismatch { reference: reference.clone() }.into()),
    };
    let reservation = Reservation { branch: branch.clone(), key: key.clone(), type_ref: reference.clone(), scope: scope.clone(), identity: IdentitySnapshot { record, revision: Revision(1) } };
    let digest = digest(branch, reference, key)?;
    let subject = subject(&reservation.identity.record); let (kind, id) = parts(&subject);
    tx.execute("INSERT INTO world_branch_identity_reservation(tenant_id,world_id,reservation_digest,branch_id,branch_revision,source_id,namespace,native_key,incarnation,valid_from_ns,valid_to_ns,type_id,type_revision,subject_kind,subject_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text::numeric,$11::text::numeric,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &digest.as_str(), &branch.id.as_str(), &revision(branch.revision.0)?, &key.source_id.as_str(), &key.namespace, &key.native_key, &key.incarnation, &key.valid_time.from.unix_nanos().to_string(), &key.valid_time.to.as_ref().map(|at| at.unix_nanos().to_string()), &reference.id.as_str(), &revision(reference.revision.0)?, &kind, &id, &encode(&reservation)?]).await?;
    let row = tx.query_opt(READ, &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &digest.as_str()]).await?.ok_or(IdentityFailure::InternalFault)?;
    checked(row, branch, reference, key, scope)
}
const READ: &str = "SELECT *,valid_from_ns::text AS from_ns,valid_to_ns::text AS to_ns FROM world_branch_identity_reservation WHERE tenant_id=$1 AND world_id=$2 AND reservation_digest=$3";
fn checked(row: tokio_postgres::Row, branch: &BranchRef, reference: &DefinitionRef, key: &SourceKey, scope: &ScopeId) -> Result<IdentitySnapshot, IdentityError> {
    let stored: Reservation = decode(row.get("body"))?;
    let subject = subject(&stored.identity.record); let (kind, id) = parts(&subject);
    if stored.branch != *branch || stored.type_ref != *reference || stored.key != *key
        || row.get::<_, String>("reservation_digest") != digest(branch, reference, key)?.as_str()
        || row.get::<_, String>("branch_id") != branch.id.as_str() || row.get::<_, i64>("branch_revision") != revision(branch.revision.0)?
        || row.get::<_, String>("source_id") != key.source_id.as_str() || row.get::<_, String>("namespace") != key.namespace
        || row.get::<_, String>("native_key") != key.native_key || row.get::<_, String>("incarnation") != key.incarnation
        || row.get::<_, String>("from_ns") != key.valid_time.from.unix_nanos().to_string() || row.get::<_, Option<String>>("to_ns") != key.valid_time.to.as_ref().map(|at| at.unix_nanos().to_string())
        || row.get::<_, String>("type_id") != reference.id.as_str() || row.get::<_, i64>("type_revision") != revision(reference.revision.0)?
        || row.get::<_, String>("subject_kind") != kind || row.get::<_, String>("subject_id") != id
        || super::world(&stored.identity.record) != &branch.world || type_id(&stored.identity.record) != &reference.id || stored.identity.revision != Revision(1) {
        return Err(IdentityFailure::CandidateScopeIncomplete.into());
    }
    if stored.scope != *scope { return Err(IdentityFailure::ScopeConflict.into()); }
    Ok(stored.identity)
}
pub(crate) async fn read_branch_identity(snapshot: &WorldSnapshot<'_>, branch: &BranchRef, reference: &DefinitionRef, key: &SourceKey, scope: &ScopeId) -> Result<Option<IdentitySnapshot>, IdentityError> {
    if snapshot.world() != &branch.world || snapshot.world() != &reference.world || snapshot.world() != &key.world { return Err(IdentityFailure::CrossWorld.into()); }
    let digest = digest(branch, reference, key)?;
    snapshot.query_opt(READ, &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &digest.as_str()]).await?.map(|row| checked(row, branch, reference, key, scope)).transpose()
}

pub(crate) async fn read_branch_identity_transaction(tx: &WorldTransaction<'_>, branch: &BranchRef, reference: &DefinitionRef, key: &SourceKey, scope: &ScopeId) -> Result<Option<IdentitySnapshot>, IdentityError> {
    if tx.world() != &branch.world || tx.world() != &reference.world || tx.world() != &key.world { return Err(IdentityFailure::CrossWorld.into()); }
    let digest = digest(branch, reference, key)?;
    tx.query_opt(READ, &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &digest.as_str()]).await?.map(|row| checked(row, branch, reference, key, scope)).transpose()
}

async fn resolve_type(tx: &WorldTransaction<'_>, branch: &BranchRef, reference: &DefinitionRef, scope: &ScopeId, interval: &world_protocol::time::ValidTime) -> Result<world_protocol::definitions::Definition<DefinitionBody>, IdentityError> {
    if tx.world() != &branch.world { return Err(IdentityFailure::CrossWorld.into()); }
    let model = crate::releases::read_branch_revision(tx, branch).await.map_err(release_error)?.ok_or(IdentityFailure::CandidateScopeIncomplete)?;
    super::records::type_in_model(tx.world(), reference, scope, interval, &model.compile.definitions, &model.compile.scopes)
}

pub(crate) async fn branch_identity_retention_roots(tx: &WorldTransaction<'_>, branches: &[BranchRef]) -> Result<crate::store::RetentionRoots, IdentityError> {
    let mut roots = crate::store::RetentionRoots::default();
    for branch in branches {
        if tx.world() != &branch.world { return Err(IdentityFailure::CrossWorld.into()); }
        for row in tx.query("SELECT *,valid_from_ns::text AS from_ns,valid_to_ns::text AS to_ns FROM world_branch_identity_reservation WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND branch_revision=$4 ORDER BY reservation_digest", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &branch.id.as_str(), &revision(branch.revision.0)?]).await? {
            let reservation: Reservation = decode(row.get("body"))?;
            let identity = checked(row, branch, &reservation.type_ref, &reservation.key, &reservation.scope)?;
            resolve_type(tx, branch, &reservation.type_ref, &reservation.scope, &reservation.key.valid_time).await?;
            roots.branches.push(branch.clone()); roots.scopes.push(reservation.scope);
            roots.definitions.push(reservation.type_ref.clone());
            roots.resources.push(ResourceRef::Source { id: reservation.key.source_id.clone() });
            roots.resources.push(resource(&subject(&identity.record)));
            let digest = digest(branch, &reservation.type_ref, &reservation.key)?;
            if let Some(row) = tx.query_opt("SELECT target_kind,target_id,body FROM world_branch_identity_promotion WHERE tenant_id=$1 AND world_id=$2 AND reservation_digest=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &digest.as_str()]).await? {
                let promotion: Promotion = decode(row.get("body"))?;
                let target = subject(&promotion.target.record); let (kind, id) = parts(&target);
                if promotion.reservation != digest || row.get::<_, String>("target_kind") != kind || row.get::<_, String>("target_id") != id || super::world(&promotion.target.record) != tx.world() || type_id(&promotion.target.record) != &reservation.type_ref.id || std::mem::discriminant(&promotion.target.record) != std::mem::discriminant(&identity.record) || promotion.target.revision.0 == 0 || promotion.evidence.iter().any(|reference| &reference.world != tx.world()) { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
                super::retention::retain_identity(&mut roots, promotion.target);
                roots.evidence.extend(promotion.evidence);
            }
        }
    }
    roots.scopes.sort(); roots.scopes.dedup(); roots.resources.sort(); roots.resources.dedup();
    roots.definitions.sort(); roots.definitions.dedup(); roots.evidence.sort(); roots.evidence.dedup();
    roots.branches.dedup();
    Ok(roots)
}

/// Promotion explicitly claims the reserved ID or maps it to an existing current identity.
pub(crate) async fn promote_branch_identity(
    tx: &mut WorldTransaction<'_>, admission: &Admission, branch: &BranchRef,
    reference: &DefinitionRef, key: &SourceKey, scope: &ScopeId, target: Option<&IdentitySnapshot>, evidence: &[EvidenceRef], at: &Timestamp, budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<IdentitySnapshot, IdentityError> {
    authorize(tx, admission, branch, key, scope, at).await?;
    let definition = resolve_type(tx, branch, reference, scope, &key.valid_time).await?;
    crate::facts::support::lock_ranges(tx, std::slice::from_ref(&reference.id), &[]).await?;
    let digest = digest(branch, reference, key)?;
    let row = tx.query_opt(READ, &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &digest.as_str()]).await?.ok_or(IdentityFailure::CandidateScopeIncomplete)?;
    let candidate = checked(row, branch, reference, key, scope)?;
    let generation = aliases::lock_range(tx, key, None).await?;
    let receipt = aliases::resolve_in_transaction(tx, key, scope, generation).await?;
    if let Some(row) = tx.query_opt("SELECT target_kind,target_id,body FROM world_branch_identity_promotion WHERE tenant_id=$1 AND world_id=$2 AND reservation_digest=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &digest.as_str()]).await? {
        let promotion: Promotion = decode(row.get("body"))?;
        let subject = subject(&promotion.target.record); let (kind, id) = parts(&subject);
        if promotion.reservation != digest || row.get::<_, String>("target_kind") != kind || row.get::<_, String>("target_id") != id || target.is_some_and(|target| target != &promotion.target) || promotion.evidence != evidence { return Err(IdentityFailure::ImpactSetChanged.into()); }
        if super::world(&promotion.target.record) != tx.world() || type_id(&promotion.target.record) != &reference.id || !matches!((&definition.body, &promotion.target.record), (DefinitionBody::ObjectType(_), IdentityRecord::Object(_)) | (DefinitionBody::RelationType(_), IdentityRecord::Relation(_))) { return Err(IdentityFailure::TypeKindMismatch { reference: reference.clone() }.into()); }
        super::bind_alias(tx, &receipt, &promotion.target, evidence, admission, at, budget, cancellation).await?;
        return Ok(promotion.target);
    }
    let selected = match (&receipt.resolution, target) {
        (AliasResolution::Ambiguous { candidates, .. }, _) => return Err(IdentityFailure::Ambiguous { candidates: candidates.clone() }.into()),
        (AliasResolution::Existing { identity, .. }, Some(target)) if identity != target => return Err(IdentityFailure::AliasConflict { key: key.clone() }.into()),
        (AliasResolution::Existing { identity, .. }, _) => identity.clone(),
        (AliasResolution::NotFound, Some(target)) => target.clone(),
        (AliasResolution::NotFound, None) => {
            let decision = super::authorize(tx, admission, scope, &key.valid_time, &[], std::slice::from_ref(&key.source_id), at).await?;
            super::records::insert(tx, &candidate, admission, &decision, at, budget, cancellation).await?;
            candidate
        },
    };
    if super::world(&selected.record) != tx.world() || type_id(&selected.record) != &reference.id || !matches!((&definition.body, &selected.record), (DefinitionBody::ObjectType(_), IdentityRecord::Object(_)) | (DefinitionBody::RelationType(_), IdentityRecord::Relation(_))) { return Err(IdentityFailure::TypeKindMismatch { reference: reference.clone() }.into()); }
    super::bind_alias(tx, &receipt, &selected, evidence, admission, at, budget, cancellation).await?;
    let target_subject = subject(&selected.record); let (kind, id) = parts(&target_subject);
    let promotion = Promotion { reservation: digest.clone(), target: selected.clone(), decision: admission.decision().id.clone(), evidence: evidence.to_vec() };
    tx.execute("INSERT INTO world_branch_identity_promotion(tenant_id,world_id,reservation_digest,target_kind,target_id,body) VALUES($1,$2,$3,$4,$5,$6)", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &digest.as_str(), &kind, &id, &encode(&promotion)?]).await?;
    Ok(selected)
}
