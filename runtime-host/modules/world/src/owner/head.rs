use serde::{Deserialize, Serialize};
use world_protocol::{api::WorldStatus, failure::FailureStage, ids::*, time::Timestamp};
use crate::store::{WorldSnapshot, WorldTransaction};
use super::Error;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldHead {
    pub world: WorldRef,
    pub generation: Generation,
    pub revision: Revision,
    pub status: WorldStatus,
    pub management_scope_id: ScopeId,
}

pub(crate) async fn read(tx: &WorldTransaction<'_>) -> Result<WorldHead, Error> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT generation,revision,status,management_scope_id FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?.ok_or(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal)?;
    let head = WorldHead {
        world: world.clone(), generation: Generation(positive(row.get("generation"))?),
        revision: Revision(positive(row.get("revision"))?),
        status: match row.get::<_, String>("status").as_str() {
            "ready" => WorldStatus::Ready, "restoring" => WorldStatus::Restoring,
            "deleting" => WorldStatus::Deleting, "retained" => WorldStatus::Retained,
            _ => return Err(Error::internal(FailureStage::Read)),
        },
        management_scope_id: ScopeId::try_new(row.get::<_, String>("management_scope_id"))
            .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?,
    };
    Ok(head)
}

pub(crate) async fn management_scope(tx: &WorldTransaction<'_>) -> Result<ScopeId, Error> {
    Ok(read(tx).await?.management_scope_id)
}

pub(crate) async fn now(tx: &WorldTransaction<'_>) -> Result<Timestamp, Error> {
    tx.now().await.map_err(Error::from)
}

pub(crate) async fn operation_fence(snapshot: &WorldSnapshot<'_>) -> Result<(WriterEpoch, world_protocol::commit::WriteFence), Error> {
    let (storage_epoch, mut fences) = writer_fences(snapshot, &["operation"]).await?;
    Ok((storage_epoch, fences.remove(0)))
}

pub(crate) async fn writer_fences(
    snapshot: &WorldSnapshot<'_>, domains: &[&str],
) -> Result<(WriterEpoch, Vec<world_protocol::commit::WriteFence>), Error> {
    let world = snapshot.world();
    let domains: Vec<_> = domains.iter().map(|domain| (*domain).to_owned()).collect();
    let rows = snapshot.query(
        "SELECT h.writer_epoch AS storage_epoch,g.domain,g.writer_epoch FROM world_storage_head h JOIN world_writer_gate g USING(tenant_id,world_id) WHERE h.tenant_id=$1 AND h.world_id=$2 AND g.domain=ANY($3) AND h.mode='active' AND g.mode='active' ORDER BY g.domain",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &domains],
    ).await?;
    if rows.len() != domains.len() || rows.is_empty() {
        return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
    }
    let storage_epoch = WriterEpoch(positive(rows[0].get("storage_epoch"))?);
    let fences = rows.into_iter().map(|row| Ok(world_protocol::commit::WriteFence {
        world: world.clone(),
        domain: WriterDomain::try_new(row.get::<_, String>("domain"))
            .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?,
        epoch: WriterEpoch(positive(row.get("writer_epoch"))?),
    })).collect::<Result<_, Error>>()?;
    Ok((storage_epoch, fences))
}

fn positive(value: i64) -> Result<u64, Error> {
    u64::try_from(value).ok().filter(|value| *value > 0).ok_or_else(|| Error::internal(FailureStage::Read))
}
