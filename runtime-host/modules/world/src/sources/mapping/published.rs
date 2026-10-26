use super::MappingError;
use crate::store::{WorldSnapshot, WorldTransaction};
use world_protocol::{
    definitions::{Definition, DefinitionBody},
    ids::DefinitionRef,
    sources::MappingFailure,
};

type Model = Definition<DefinitionBody>;

pub(crate) async fn published_definition(
    tx: &WorldTransaction<'_>,
    reference: &DefinitionRef,
) -> Result<Option<Model>, MappingError> {
    if &reference.world != tx.world() {
        return Err(MappingFailure::CrossWorld.into());
    }
    let Some(release) = crate::releases::read_active_model(tx).await? else {
        return Ok(None);
    };
    Ok(release
        .definitions
        .into_iter()
        .find(|d| d.reference == *reference))
}

pub(crate) async fn published_definition_snapshot(
    snapshot: &WorldSnapshot<'_>,
    reference: &DefinitionRef,
) -> Result<Option<Model>, MappingError> {
    if &reference.world != snapshot.world() {
        return Err(MappingFailure::CrossWorld.into());
    }
    let Some(id) = crate::releases::read_active_release_snapshot(snapshot).await? else {
        return Ok(None);
    };
    let release = crate::releases::read_release_snapshot(snapshot, &id)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    Ok(release
        .definitions
        .into_iter()
        .find(|d| d.reference == *reference))
}
