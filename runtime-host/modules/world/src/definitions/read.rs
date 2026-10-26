use serde::de::DeserializeOwned;
use world_protocol::{
    commit::CommitFailure,
    definitions::{Definition, DefinitionBody, Scope},
    failure::FailureStage,
    ids::{DefinitionId, DefinitionRef, Revision, ScopeId},
};

use crate::store::{StoreError, WorldSnapshot, WorldTransaction};

type Model = Definition<DefinitionBody>;

pub(crate) async fn read_definition(
    tx: &WorldTransaction<'_>,
    reference: &DefinitionRef,
) -> Result<Option<Model>, StoreError> {
    if &reference.world != tx.world() || reference.revision.0 == 0 {
        return Err(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Read,
        ));
    }
    let revision = revision(reference.revision)?;
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT body FROM world_definition_revision WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &revision],
    ).await?;
    row.map(|row| decode(row.get("body"))).transpose()
}

pub(crate) async fn read_definition_snapshot(
    snapshot: &WorldSnapshot<'_>,
    reference: &DefinitionRef,
) -> Result<Option<Model>, StoreError> {
    if &reference.world != snapshot.world() || reference.revision.0 == 0 {
        return Err(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Read,
        ));
    }
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT body FROM world_definition_revision WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &revision(reference.revision)?],
    ).await?;
    let model: Option<Model> = row.map(|row| decode(row.get("body"))).transpose()?;
    if model
        .as_ref()
        .is_some_and(|model| model.reference != *reference)
    {
        return Err(StoreError::new(
            CommitFailure::InternalFault,
            FailureStage::Read,
        ));
    }
    Ok(model)
}

pub(crate) async fn read_scopes_snapshot(
    snapshot: &WorldSnapshot<'_>,
    ids: &[ScopeId],
) -> Result<Vec<Scope>, StoreError> {
    let world = snapshot.world();
    let ids: Vec<_> = ids.iter().map(ScopeId::as_str).collect();
    snapshot.query("SELECT body FROM world_scope_revision WHERE tenant_id=$1 AND world_id=$2 AND scope_id=ANY($3) ORDER BY scope_id,revision",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &ids]).await?.into_iter().map(|row| decode(row.get("body"))).collect()
}

pub(crate) async fn read_definition_head(
    tx: &WorldTransaction<'_>,
    id: &DefinitionId,
) -> Result<Option<Model>, StoreError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT r.body FROM world_definition_identity i JOIN world_definition_head h USING(tenant_id,world_id,definition_id) JOIN world_definition_revision r USING(tenant_id,world_id,definition_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.definition_id=$3 FOR SHARE OF i,h",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?;
    row.map(|row| decode(row.get("body"))).transpose()
}

pub(crate) async fn next_definition_revision(
    tx: &WorldTransaction<'_>,
    id: &DefinitionId,
) -> Result<Revision, StoreError> {
    let world = tx.world();
    let rows = tx.query(
        "SELECT COALESCE(MAX(revision),0) AS revision FROM world_definition_revision WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?;
    let next = rows[0].get::<_, i64>("revision").checked_add(1)
        .and_then(|revision| u64::try_from(revision).ok())
        .filter(|revision| *revision > 0)
        .ok_or_else(|| StoreError::new(CommitFailure::InvalidBatch, FailureStage::Validate))?;
    Ok(Revision(next))
}

pub(crate) async fn read_scopes(
    tx: &WorldTransaction<'_>,
    ids: &[ScopeId],
) -> Result<Vec<Scope>, StoreError> {
    let world = tx.world();
    let ids: Vec<&str> = ids.iter().map(ScopeId::as_str).collect();
    let rows = tx.query(
        "SELECT body FROM world_scope_revision WHERE tenant_id=$1 AND world_id=$2 AND scope_id=ANY($3) ORDER BY scope_id,revision",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &ids],
    ).await?;
    rows.into_iter()
        .map(|row| decode(row.get("body")))
        .collect()
}

pub(crate) async fn validate_current_reference_snapshot(
    snapshot: &WorldSnapshot<'_>,
    reference: &DefinitionRef,
    valid_time: &world_protocol::time::ValidTime,
) -> Result<(), super::DefinitionError> {
    use world_protocol::definitions::DefinitionFailure;
    if &reference.world != snapshot.world() {
        return Err(DefinitionFailure::CrossWorldReference {
            reference: reference.clone(),
        }
        .into());
    }
    let exact = read_definition_snapshot(snapshot, reference)
        .await?
        .ok_or_else(|| DefinitionFailure::MissingReference {
            reference: reference.clone(),
        })?;
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT r.body FROM world_definition_identity i JOIN world_definition_head h USING(tenant_id,world_id,definition_id) JOIN world_definition_revision r USING(tenant_id,world_id,definition_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.definition_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str()],
    ).await?;
    let current: Model = row
        .map(|row| decode(row.get("body")))
        .transpose()?
        .ok_or_else(|| DefinitionFailure::MissingReference {
            reference: reference.clone(),
        })?;
    validate_live_reference(&exact, &current, valid_time)
}

pub(crate) async fn validate_current_reference(
    tx: &WorldTransaction<'_>,
    reference: &DefinitionRef,
    valid_time: &world_protocol::time::ValidTime,
) -> Result<(), super::DefinitionError> {
    use world_protocol::definitions::DefinitionFailure;
    if &reference.world != tx.world() {
        return Err(DefinitionFailure::CrossWorldReference {
            reference: reference.clone(),
        }
        .into());
    }
    let exact = read_definition(tx, reference).await?.ok_or_else(|| {
        DefinitionFailure::MissingReference {
            reference: reference.clone(),
        }
    })?;
    let current = read_definition_head(tx, &reference.id)
        .await?
        .ok_or_else(|| DefinitionFailure::MissingReference {
            reference: reference.clone(),
        })?;
    validate_live_reference(&exact, &current, valid_time)
}

fn validate_live_reference(
    exact: &Model,
    current: &Model,
    valid_time: &world_protocol::time::ValidTime,
) -> Result<(), super::DefinitionError> {
    use world_protocol::definitions::{DefinitionFailure, DefinitionLifecycle};
    if !super::valid_time_contains(&exact.valid_time, valid_time) {
        return Err(DefinitionFailure::ValidTimeConflict {
            definitions: vec![exact.reference.clone()],
        }
        .into());
    }
    if current.reference.world != exact.reference.world
        || current.reference.id != exact.reference.id
    {
        return Err(DefinitionFailure::LifecycleConflict.into());
    }
    if let DefinitionLifecycle::Deprecated { effective_at, .. }
    | DefinitionLifecycle::Split { effective_at, .. } = &current.lifecycle
    {
        if valid_time.to.as_ref().is_none_or(|to| to > effective_at) {
            return Err(DefinitionFailure::DeprecatedReference {
                reference: current.reference.clone(),
            }
            .into());
        }
    }
    Ok(())
}

pub(super) fn revision(value: Revision) -> Result<i64, StoreError> {
    i64::try_from(value.0)
        .ok()
        .filter(|revision| *revision > 0)
        .ok_or_else(|| StoreError::new(CommitFailure::InvalidBatch, FailureStage::Validate))
}

pub(super) fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, StoreError> {
    serde_json::from_value(value).map_err(|error| {
        StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Read, error)
    })
}

pub(super) fn encode(value: &impl serde::Serialize) -> Result<serde_json::Value, StoreError> {
    serde_json::to_value(value).map_err(|error| {
        StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Prepare, error)
    })
}
