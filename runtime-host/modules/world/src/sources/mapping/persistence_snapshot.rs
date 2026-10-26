use super::MappingError;
use crate::store::WorldSnapshot;
use serde::de::DeserializeOwned;
use world_protocol::{
    definitions::{Definition, DefinitionBody},
    facts::SourceAuthority,
    ids::*,
    sources::{AuthorityRef, MappingFailure, SchemaDiscovery, SchemaMapping, SourceBinding},
};

pub(crate) async fn read_binding_snapshot(
    snapshot: &WorldSnapshot<'_>,
    reference: &DefinitionRef,
) -> Result<Option<Definition<SourceBinding>>, MappingError> {
    same_world(snapshot, &reference.world)?;
    let Some(d) = super::published_definition_snapshot(snapshot, reference).await? else {
        return Ok(None);
    };
    let DefinitionBody::SourceBinding(body) = d.body else {
        return Err(MappingFailure::RevisionMismatch.into());
    };
    Ok(Some(Definition {
        reference: d.reference,
        scope: d.scope,
        valid_time: d.valid_time,
        body,
        content_digest: d.content_digest,
        dependencies: d.dependencies,
        evidence: d.evidence,
        previous_ref: d.previous_ref,
        lifecycle: d.lifecycle,
    }))
}
pub(crate) async fn read_schema_snapshot(
    snapshot: &WorldSnapshot<'_>,
    reference: &SchemaRef,
) -> Result<Option<SchemaDiscovery>, MappingError> {
    same_world(snapshot, &reference.world)?;
    let w = snapshot.world();
    let row = snapshot.query_opt("SELECT body FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &reference.id.as_str(), &revision(reference.revision)?]).await?;
    row.map(|row| decode(row.get("body"))).transpose()
}
pub(crate) async fn read_mapping_snapshot(
    snapshot: &WorldSnapshot<'_>,
    reference: &MappingRef,
) -> Result<Option<SchemaMapping>, MappingError> {
    same_world(snapshot, &reference.world)?;
    let w = snapshot.world();
    let row = snapshot.query_opt("SELECT body FROM world_schema_mapping_revision WHERE tenant_id=$1 AND world_id=$2 AND mapping_id=$3 AND revision=$4", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &reference.id.as_str(), &revision(reference.revision)?]).await?;
    row.map(|row| decode(row.get("body"))).transpose()
}
pub(crate) async fn read_authority_snapshot(
    snapshot: &WorldSnapshot<'_>,
    binding: &DefinitionRef,
    authority: &AuthorityRef,
) -> Result<Option<SourceAuthority>, MappingError> {
    same_world(snapshot, &binding.world)?;
    let w = snapshot.world();
    let row = snapshot.query_opt("SELECT r.body FROM world_source_authority_revision r JOIN world_source_authority_head h USING(tenant_id,world_id,policy_id,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.policy_id=$3 AND r.revision=$4 AND r.binding_id=$5 AND r.binding_revision=$6 AND r.status='approved'", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &authority.policy_id.as_str(), &revision(authority.revision)?, &binding.id.as_str(), &revision(binding.revision)?]).await?;
    row.map(|row| decode(row.get("body"))).transpose()
}
fn same_world(snapshot: &WorldSnapshot<'_>, world: &WorldRef) -> Result<(), MappingError> {
    if snapshot.world() == world {
        Ok(())
    } else {
        Err(MappingFailure::CrossWorld.into())
    }
}
fn revision(r: Revision) -> Result<i64, MappingError> {
    i64::try_from(r.0)
        .ok()
        .filter(|r| *r > 0)
        .ok_or_else(|| MappingFailure::RevisionMismatch.into())
}
fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, MappingError> {
    serde_json::from_value(value).map_err(|cause| {
        crate::store::StoreError::caused_by(
            world_protocol::commit::CommitFailure::InternalFault,
            world_protocol::failure::FailureStage::Decode,
            cause,
        )
        .into()
    })
}
