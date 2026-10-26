use super::{Error, read::*};
use crate::store::WorldSnapshot;
use world_protocol::{
    ids::{BranchId, ChannelId, Generation, ReleaseId, Revision},
    releases::{BranchRef, Release, ReleaseHead, WorldBranch},
};

pub(crate) async fn read_release_snapshot(
    snapshot: &WorldSnapshot<'_>,
    id: &ReleaseId,
) -> Result<Option<Release>, Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt("SELECT parent_release_id,artifact_id,activation_lock_id,content_digest,model_digest,source_branch_id,source_branch_revision,body FROM world_release WHERE tenant_id=$1 AND world_id=$2 AND release_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let release = release_row(world, id, &row)?;
    let artifact = snapshot.query_opt("SELECT content_digest,body FROM world_artifact_manifest WHERE tenant_id=$1 AND world_id=$2 AND artifact_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &release.artifact.id.as_str()]).await?
        .map(|row| artifact_row(world, &release.artifact.id, &row)).transpose()?;
    if artifact.as_ref() != Some(&release.artifact) {
        return Err(invalid("artifact"));
    }
    let rows = snapshot.query("SELECT definition_id,revision,content_digest FROM world_release_definition WHERE tenant_id=$1 AND world_id=$2 AND release_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?;
    validate_definition_rows(&release, &rows)?;
    if let Some(reference) = &release.source_branch {
        let branch = read_branch_revision_snapshot(snapshot, reference)
            .await?
            .ok_or_else(|| invalid("sourceBranch"))?;
        validate_release_source(&release, &branch)?;
    }
    Ok(Some(release))
}

pub(crate) async fn read_branch_snapshot(
    snapshot: &WorldSnapshot<'_>,
    id: &BranchId,
) -> Result<Option<WorldBranch>, Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt("SELECT r.revision,r.base_release_id,r.activation_lock_id,r.basis_digest,r.content_digest,r.status,r.body FROM world_branch_head h JOIN world_branch_revision r USING(tenant_id,world_id,branch_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.branch_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let branch = branch_row(world, id, &row)?;
    let reference = BranchRef {
        world: world.clone(),
        id: id.clone(),
        revision: branch.revision,
    };
    if read_branch_revision_snapshot(snapshot, &reference)
        .await?
        .as_ref()
        != Some(&branch)
    {
        return Err(invalid("branchRevision"));
    }
    Ok(Some(branch))
}

pub(crate) async fn read_branch_revision_snapshot(
    snapshot: &WorldSnapshot<'_>,
    reference: &BranchRef,
) -> Result<Option<WorldBranch>, Error> {
    if &reference.world != snapshot.world() || reference.revision.0 == 0 {
        return Err(invalid("branchRevision"));
    }
    let world = snapshot.world();
    snapshot.query_opt("SELECT revision,base_release_id,activation_lock_id,basis_digest,content_digest,status,body FROM world_branch_revision WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?]).await?
        .map(|row| branch_revision_row(reference, &row)).transpose()
}

pub(crate) async fn read_active_release_snapshot(
    snapshot: &WorldSnapshot<'_>,
) -> Result<Option<ReleaseId>, Error> {
    Ok(read_active_head_snapshot(snapshot)
        .await?
        .map(|head| head.release_id))
}

/// The configured release channel, not an execution BindingChannel.
pub(crate) async fn read_active_head_snapshot(
    snapshot: &WorldSnapshot<'_>,
) -> Result<Option<ReleaseHead>, Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt("SELECT h.channel,h.generation,h.revision,h.release_id FROM world_runtime_head r JOIN world_release_head h ON h.tenant_id=r.tenant_id AND h.world_id=r.world_id AND h.channel=r.active_release_channel WHERE r.tenant_id=$1 AND r.world_id=$2", &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?;
    row.map(|row| {
        let positive = |value: i64| {
            u64::try_from(value)
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| invalid("head"))
        };
        Ok(ReleaseHead {
            world: world.clone(),
            channel: ChannelId::try_new(row.get::<_, String>("channel"))
                .map_err(|_| invalid("channel"))?,
            generation: Generation(positive(row.get("generation"))?),
            revision: Revision(positive(row.get("revision"))?),
            release_id: ReleaseId::try_new(row.get::<_, String>("release_id"))
                .map_err(|_| invalid("releaseId"))?,
        })
    })
    .transpose()
}
