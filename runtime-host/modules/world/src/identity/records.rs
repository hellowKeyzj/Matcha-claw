use tokio_postgres::Row;
use world_protocol::{
    commit::CommittedRevision,
    definitions::{Definition, DefinitionBody, DefinitionKind, Scope},
    identity::{IdentityFailure, IdentityRecord, IdentitySnapshot, Object, Relation, SubjectRef},
    ids::{DefinitionId, DefinitionRef, Generation, ObjectId, RelationId, Revision, ScopeId},
    time::{Timestamp, ValidTime},
};

use crate::{authorization::Admission, store::{WorldSnapshot, WorldTransaction}};
use super::{IdentityError, check_snapshot, encode, parts, resource, revision, subject, type_id, world};

const READ: &str = "SELECT type_id,revision FROM world_object_identity WHERE tenant_id=$1 AND world_id=$2 AND object_id=$4 AND $3='object' UNION ALL SELECT type_id,revision FROM world_relation_identity WHERE tenant_id=$1 AND world_id=$2 AND relation_id=$4 AND $3='relation'";

pub(crate) async fn get(snapshot: &WorldSnapshot<'_>, subject: &SubjectRef) -> Result<Option<IdentitySnapshot>, IdentityError> {
    let (kind, id) = parts(subject);
    snapshot.query_opt(READ, &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &kind, &id])
        .await?.map(|row| from_row(snapshot.world(), subject, row)).transpose()
}

pub(crate) async fn get_in_transaction(transaction: &WorldTransaction<'_>, subject: &SubjectRef) -> Result<Option<IdentitySnapshot>, IdentityError> {
    let (kind, id) = parts(subject);
    transaction.query_opt(READ, &[&transaction.world().tenant_id.as_str(), &transaction.world().world_id.as_str(), &kind, &id])
        .await?.map(|row| from_row(transaction.world(), subject, row)).transpose()
}

fn from_row(world: &world_protocol::ids::WorldRef, subject: &SubjectRef, row: Row) -> Result<IdentitySnapshot, IdentityError> {
    let type_id = DefinitionId::try_new(row.get::<_, String>("type_id")).map_err(|_| IdentityFailure::InternalFault)?;
    let record = match subject {
        SubjectRef::Object { id } => IdentityRecord::Object(Object { world: world.clone(), id: id.clone(), type_id }),
        SubjectRef::Relation { id } => IdentityRecord::Relation(Relation { world: world.clone(), id: id.clone(), type_id }),
    };
    Ok(IdentitySnapshot { record, revision: Revision(row.get::<_, i64>("revision") as u64) })
}

pub(crate) async fn recheck_identity(transaction: &WorldTransaction<'_>, expected: &IdentitySnapshot) -> Result<(), IdentityError> {
    if world(&expected.record) != transaction.world() { return Err(IdentityFailure::CrossWorld.into()); }
    let reference = subject(&expected.record);
    lock_influence(transaction, std::slice::from_ref(&reference)).await?;
    check_snapshot(expected, get_in_transaction(transaction, &reference).await?.as_ref())
}

/// Every producer of a new or superseded identity reference shares these sorted row locks.
pub(crate) async fn touch_influence(transaction: &WorldTransaction<'_>, subjects: &[SubjectRef]) -> Result<(), IdentityError> {
    for (subject, _) in lock_influence(transaction, subjects).await? {
        let (kind, id) = parts(&subject);
        transaction.execute(
            "UPDATE world_identity_influence SET generation=generation+1 WHERE tenant_id=$1 AND world_id=$2 AND subject_kind=$3 AND subject_id=$4",
            &[&transaction.world().tenant_id.as_str(), &transaction.world().world_id.as_str(), &kind, &id],
        ).await?;
    }
    Ok(())
}

pub(crate) async fn lock_influence(transaction: &WorldTransaction<'_>, subjects: &[SubjectRef]) -> Result<Vec<(SubjectRef, Generation)>, IdentityError> {
    let mut subjects = subjects.to_vec();
    subjects.sort_unstable(); subjects.dedup();
    let mut result = Vec::with_capacity(subjects.len());
    for subject in subjects {
        let (kind, id) = parts(&subject);
        let row = transaction.query_opt(
            "SELECT generation FROM world_identity_influence WHERE tenant_id=$1 AND world_id=$2 AND subject_kind=$3 AND subject_id=$4 FOR UPDATE",
            &[&transaction.world().tenant_id.as_str(), &transaction.world().world_id.as_str(), &kind, &id],
        ).await?.ok_or_else(|| IdentityFailure::UnresolvedIdentity { subject: subject.clone() })?;
        result.push((subject, Generation(row.get::<_, i64>("generation") as u64)));
    }
    Ok(result)
}

pub(crate) async fn create(
    transaction: &mut WorldTransaction<'_>, reference: &DefinitionRef, scope: &ScopeId,
    valid_time: &ValidTime, admission: &Admission, now: &Timestamp, budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<IdentitySnapshot, IdentityError> {
    // Creating an unknown ID requires scope creation authority, not write access to its type alone.
    crate::facts::support::lock_ranges(transaction, std::slice::from_ref(&reference.id), &[]).await?;
    let decision = super::authorize(transaction, admission, scope, valid_time, &[], &[], now).await?;
    let definition = resolve_type(transaction, reference, scope, valid_time).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let record = match definition.body.kind() {
        DefinitionKind::ObjectType => IdentityRecord::Object(Object {
            world: transaction.world().clone(), id: ObjectId::try_new(id).map_err(|_| IdentityFailure::InternalFault)?, type_id: reference.id.clone(),
        }),
        DefinitionKind::RelationType => IdentityRecord::Relation(Relation {
            world: transaction.world().clone(), id: RelationId::try_new(id).map_err(|_| IdentityFailure::InternalFault)?, type_id: reference.id.clone(),
        }),
        _ => return Err(IdentityFailure::TypeKindMismatch { reference: reference.clone() }.into()),
    };
    let snapshot = IdentitySnapshot { record, revision: Revision(1) };
    insert(transaction, &snapshot, admission, &decision, now, budget, cancellation).await?;
    Ok(snapshot)
}

pub(super) async fn insert(
    transaction: &mut WorldTransaction<'_>, snapshot: &IdentitySnapshot, admission: &Admission,
    decision: &world_protocol::authorization::Decision, now: &Timestamp, budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(), IdentityError> {
    let reference = subject(&snapshot.record);
    let (kind, id) = parts(&reference);
    let sql = match reference {
        SubjectRef::Object { .. } => "INSERT INTO world_object_identity(tenant_id,world_id,object_id,type_id,revision) VALUES($1,$2,$3,$4,1)",
        SubjectRef::Relation { .. } => "INSERT INTO world_relation_identity(tenant_id,world_id,relation_id,type_id,revision) VALUES($1,$2,$3,$4,1)",
    };
    transaction.execute(sql, &[&transaction.world().tenant_id.as_str(), &transaction.world().world_id.as_str(), &id, &type_id(&snapshot.record).as_str()]).await?;
    transaction.execute(
        "INSERT INTO world_identity_influence(tenant_id,world_id,subject_kind,subject_id) VALUES($1,$2,$3,$4)",
        &[&transaction.world().tenant_id.as_str(), &transaction.world().world_id.as_str(), &kind, &id],
    ).await?;
    persist_revision(transaction, snapshot, admission, decision).await?;
    transaction.record_revision(CommittedRevision { resource: resource(&reference), revision: snapshot.revision })?;
    crate::facts::support::invalidate_ranges(transaction, std::slice::from_ref(type_id(&snapshot.record)), &[], budget, cancellation, now).await?;
    Ok(())
}

pub(super) async fn resolve_type(
    transaction: &WorldTransaction<'_>, reference: &DefinitionRef, scope: &ScopeId, interval: &ValidTime,
) -> Result<Definition<DefinitionBody>, IdentityError> {
    let model = crate::releases::read_active_model(transaction).await.map_err(super::branch::release_error)?
        .ok_or_else(|| IdentityFailure::UnresolvedType { reference: reference.clone() })?;
    type_in_model(transaction.world(), reference, scope, interval, &model.definitions, &model.scopes)
}

pub(super) fn type_in_model(
    world: &world_protocol::ids::WorldRef, reference: &DefinitionRef, scope: &ScopeId, interval: &ValidTime,
    definitions: &[Definition<DefinitionBody>], scopes: &[Scope],
) -> Result<Definition<DefinitionBody>, IdentityError> {
    super::validate_interval(interval)?;
    if &reference.world != world { return Err(IdentityFailure::CrossWorld.into()); }
    revision(reference.revision.0)?;
    let definition = definitions.iter().find(|definition| definition.reference == *reference)
        .ok_or_else(|| IdentityFailure::UnresolvedType { reference: reference.clone() })?;
    crate::definitions::validate_applicability(definition, scope, interval, scopes)
        .map_err(|error| IdentityError::Fact(error.into()))?;
    if !matches!(definition.body, DefinitionBody::ObjectType(_) | DefinitionBody::RelationType(_)) {
        return Err(IdentityFailure::TypeKindMismatch { reference: reference.clone() }.into());
    }
    Ok(definition.clone())
}

pub(super) async fn persist_revision(
    transaction: &WorldTransaction<'_>, snapshot: &IdentitySnapshot, admission: &Admission,
    decision: &world_protocol::authorization::Decision,
) -> Result<(), IdentityError> {
    let reference = subject(&snapshot.record);
    let (kind, id) = parts(&reference);
    transaction.execute(
        "INSERT INTO world_identity_revision(tenant_id,world_id,subject_kind,subject_id,revision,type_id,actor_id,admission,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        &[&transaction.world().tenant_id.as_str(), &transaction.world().world_id.as_str(), &kind, &id,
          &revision(snapshot.revision.0)?, &type_id(&snapshot.record).as_str(), &super::actor_id(admission).as_str(), &encode(decision)?, &encode(snapshot)?],
    ).await?;
    Ok(())
}
