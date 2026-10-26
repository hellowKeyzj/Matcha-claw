use super::Error;
use crate::{definitions::canonical_digest, store::WorldTransaction};
use tokio_postgres::Row;
use world_protocol::{
    compiler::{ArtifactManifest, CompileFailure},
    definitions::{Definition, DefinitionBody, DefinitionFailure},
    failure::FieldPath,
    ids::{
        ActivationLockId, ArtifactId, BranchId, CandidateId, ChannelId, DefinitionId,
        DefinitionRef, Generation, ReleaseId, Revision, WorldRef,
    },
    learning::{Candidate, ChangeStatus},
    releases::{BranchRef, Release, ReleaseFailure, ReleaseHead, WorldBranch},
};

pub(super) enum DefinitionCarrier {
    Archive,
    Release(ReleaseId),
    Branches(Vec<BranchRef>),
}

pub(super) struct HistoricalDefinition {
    pub definition: Definition<DefinitionBody>,
    pub carrier: DefinitionCarrier,
}

/// Historical interpretation only. This grants neither current definition nor branch authority.
pub(crate) async fn read_definition_exact(
    tx: &WorldTransaction<'_>,
    reference: &DefinitionRef,
) -> Result<Option<Definition<DefinitionBody>>, Error> {
    Ok(read_definition_history(tx, reference)
        .await?
        .map(|historical| historical.definition))
}

pub(super) async fn read_definition_history(
    tx: &WorldTransaction<'_>,
    reference: &DefinitionRef,
) -> Result<Option<HistoricalDefinition>, Error> {
    if &reference.world != tx.world() || reference.revision.0 == 0 {
        return Err(invalid("reference"));
    }
    if let Some(model) = crate::definitions::read_definition(tx, reference).await? {
        check_exact_definition(&model, reference)?;
        return Ok(Some(HistoricalDefinition {
            definition: model,
            carrier: DefinitionCarrier::Archive,
        }));
    }
    let world = tx.world();
    let rows = tx.query(
        "SELECT release_id,content_digest FROM world_release_definition WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 AND revision=$4 ORDER BY release_id LIMIT 4097",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?],
    ).await?;
    history_limit(rows.len())?;
    if let Some(first) = rows.first() {
        let digest = first.get::<_, String>("content_digest");
        if rows
            .iter()
            .any(|row| row.get::<_, String>("content_digest") != digest)
        {
            return Err(DefinitionFailure::ImmutableRevision {
                reference: reference.clone(),
            }
            .into());
        }
        let id = ReleaseId::try_new(first.get::<_, String>("release_id"))
            .map_err(|_| invalid("releaseId"))?;
        let release = read_release(tx, &id)
            .await?
            .ok_or_else(|| invalid("release"))?;
        let model = release
            .definitions
            .into_iter()
            .find(|definition| definition.reference == *reference)
            .ok_or_else(|| invalid("definitionIndex"))?;
        check_exact_definition(&model, reference)?;
        return Ok(Some(HistoricalDefinition {
            definition: model,
            carrier: DefinitionCarrier::Release(id),
        }));
    }
    let fragment = serde_json::json!([{ "reference": reference }]);
    let rows = tx.query(
        "SELECT branch_id,revision FROM world_branch_revision WHERE tenant_id=$1 AND world_id=$2 AND body->'compile'->'definitions' @> $3::jsonb ORDER BY branch_id,revision LIMIT 4097",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &fragment],
    ).await?;
    history_limit(rows.len())?;
    let mut exact: Option<HistoricalDefinition> = None;
    for row in rows {
        let reference_branch = BranchRef {
            world: world.clone(),
            id: BranchId::try_new(row.get::<_, String>("branch_id"))
                .map_err(|_| invalid("branchId"))?,
            revision: Revision(
                u64::try_from(row.get::<_, i64>("revision")).map_err(|_| invalid("revision"))?,
            ),
        };
        let branch = read_branch_revision(tx, &reference_branch)
            .await?
            .ok_or_else(|| invalid("branch"))?;
        let model = branch
            .compile
            .definitions
            .into_iter()
            .find(|definition| definition.reference == *reference)
            .ok_or_else(|| invalid("definitionIndex"))?;
        check_exact_definition(&model, reference)?;
        if exact
            .as_ref()
            .is_some_and(|previous| previous.definition.content_digest != model.content_digest)
        {
            return Err(DefinitionFailure::ImmutableRevision {
                reference: reference.clone(),
            }
            .into());
        }
        match &mut exact {
            Some(HistoricalDefinition {
                carrier: DefinitionCarrier::Branches(references),
                ..
            }) => references.push(reference_branch),
            None => {
                exact = Some(HistoricalDefinition {
                    definition: model,
                    carrier: DefinitionCarrier::Branches(vec![reference_branch]),
                });
            }
            _ => unreachable!("branch history carrier"),
        }
    }
    Ok(exact)
}

pub(super) async fn definition_history_references(
    tx: &WorldTransaction<'_>,
    id: &DefinitionId,
) -> Result<Vec<DefinitionRef>, Error> {
    let world = tx.world();
    let rows = tx.query(
        "SELECT revision FROM world_definition_revision WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 UNION SELECT revision FROM world_release_definition WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 ORDER BY revision LIMIT 4097",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?;
    history_limit(rows.len())?;
    let mut references = std::collections::BTreeSet::new();
    for row in rows {
        let revision = u64::try_from(row.get::<_, i64>("revision"))
            .ok()
            .filter(|revision| *revision > 0)
            .ok_or_else(|| invalid("revision"))?;
        references.insert(DefinitionRef {
            world: world.clone(),
            id: id.clone(),
            revision: Revision(revision),
        });
    }
    let fragment = serde_json::json!([{ "reference": { "world": world, "id": id } }]);
    let rows = tx.query(
        "SELECT branch_id,revision FROM world_branch_revision WHERE tenant_id=$1 AND world_id=$2 AND body->'compile'->'definitions' @> $3::jsonb ORDER BY branch_id,revision LIMIT 4097",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &fragment],
    ).await?;
    history_limit(rows.len())?;
    for row in rows {
        let reference = BranchRef {
            world: world.clone(),
            id: BranchId::try_new(row.get::<_, String>("branch_id"))
                .map_err(|_| invalid("branchId"))?,
            revision: Revision(
                u64::try_from(row.get::<_, i64>("revision")).map_err(|_| invalid("revision"))?,
            ),
        };
        let branch = read_branch_revision(tx, &reference)
            .await?
            .ok_or_else(|| invalid("branch"))?;
        let definition = branch
            .compile
            .definitions
            .iter()
            .find(|definition| &definition.reference.id == id)
            .ok_or_else(|| invalid("definitionIndex"))?;
        check_exact_definition(definition, &definition.reference)?;
        references.insert(definition.reference.clone());
        history_limit(references.len())?;
    }
    Ok(references.into_iter().collect())
}

fn check_exact_definition(
    model: &Definition<DefinitionBody>,
    reference: &DefinitionRef,
) -> Result<(), Error> {
    if model.reference != *reference
        || crate::definitions::content_digest(model)? != model.content_digest
    {
        return Err(DefinitionFailure::ImmutableRevision {
            reference: reference.clone(),
        }
        .into());
    }
    Ok(())
}

fn history_limit(rows: usize) -> Result<(), Error> {
    if rows > 4096 {
        return Err(DefinitionFailure::LimitExceeded {
            field: FieldPath(vec!["definitionHistory".into()]),
            maximum: 4096,
        }
        .into());
    }
    Ok(())
}

/// Immutable branch history retains locks even after the mutable branch has been rebased.
pub(crate) async fn has_activation_references(
    tx: &WorldTransaction<'_>,
    id: &ActivationLockId,
) -> Result<bool, Error> {
    let world = tx.world();
    Ok(tx.query_opt(
        "SELECT 1 WHERE EXISTS(SELECT 1 FROM world_release WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3) OR EXISTS(SELECT 1 FROM world_branch_revision WHERE tenant_id=$1 AND world_id=$2 AND (activation_lock_id=$3 OR body->'compile'->'activationLock'->>'id'=$3)) OR EXISTS(SELECT 1 FROM world_artifact_manifest WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.is_some())
}

pub(crate) async fn read_artifact(
    tx: &WorldTransaction<'_>,
    id: &ArtifactId,
) -> Result<Option<ArtifactManifest>, Error> {
    let world = tx.world();
    tx.query_opt("SELECT content_digest,body FROM world_artifact_manifest WHERE tenant_id=$1 AND world_id=$2 AND artifact_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?
        .map(|row| artifact_row(world, id, &row)).transpose()
}

pub(super) fn artifact_row(
    world: &WorldRef,
    id: &ArtifactId,
    row: &Row,
) -> Result<ArtifactManifest, Error> {
    let manifest: ArtifactManifest = serde_json::from_value(row.get("body"))?;
    super::validate_manifest(&manifest)?;
    if manifest.world != *world
        || &manifest.id != id
        || manifest.digest.as_str() != row.get::<_, String>("content_digest")
    {
        return Err(CompileFailure::ArtifactInvalid {
            field: FieldPath(vec!["artifact".into()]),
        }
        .into());
    }
    Ok(manifest)
}

pub(crate) async fn read_release(
    tx: &WorldTransaction<'_>,
    id: &ReleaseId,
) -> Result<Option<Release>, Error> {
    let world = tx.world();
    let row = tx.query_opt("SELECT parent_release_id,artifact_id,activation_lock_id,content_digest,model_digest,source_branch_id,source_branch_revision,body FROM world_release WHERE tenant_id=$1 AND world_id=$2 AND release_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let release = release_row(world, id, &row)?;
    if read_artifact(tx, &release.artifact.id).await?.as_ref() != Some(&release.artifact) {
        return Err(invalid("artifact"));
    }
    let rows = tx.query("SELECT definition_id,revision,content_digest FROM world_release_definition WHERE tenant_id=$1 AND world_id=$2 AND release_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?;
    validate_definition_rows(&release, &rows)?;
    if let Some(reference) = &release.source_branch {
        let branch = read_branch_revision(tx, reference)
            .await?
            .ok_or_else(|| invalid("sourceBranch"))?;
        validate_release_source(&release, &branch)?;
    }
    Ok(Some(release))
}

pub(super) fn release_row(world: &WorldRef, id: &ReleaseId, row: &Row) -> Result<Release, Error> {
    let release: Release = serde_json::from_value(row.get("body"))?;
    let source = release.source_branch.as_ref();
    if release.world != *world
        || &release.id != id
        || release.artifact.world != *world
        || release.artifact.release_id != *id
        || release.parent.as_ref().map(ToString::to_string)
            != row.get::<_, Option<String>>("parent_release_id")
        || release.artifact.id.as_str() != row.get::<_, String>("artifact_id")
        || release.artifact.activation_lock_id.as_str()
            != row.get::<_, String>("activation_lock_id")
        || release.artifact.model_digest.as_str() != row.get::<_, String>("model_digest")
        || release_digest(&release)?.as_str() != row.get::<_, String>("content_digest")
        || source.is_some_and(|branch| branch.world != *world || branch.revision.0 == 0)
        || source.map(|branch| branch.id.to_string())
            != row.get::<_, Option<String>>("source_branch_id")
        || source.map(|branch| number(branch.revision.0)).transpose()?
            != row.get::<_, Option<i64>>("source_branch_revision")
    {
        return Err(invalid("release"));
    }
    Ok(release)
}

pub(super) fn validate_definition_rows(release: &Release, rows: &[Row]) -> Result<(), Error> {
    let ids: std::collections::BTreeSet<_> = release
        .definitions
        .iter()
        .map(|definition| &definition.reference.id)
        .collect();
    if rows.len() != release.definitions.len()
        || ids.len() != rows.len()
        || release.definitions.iter().any(|definition| {
            definition.reference.world != release.world
                || !rows.iter().any(|row| {
                    row.get::<_, String>("definition_id") == definition.reference.id.as_str()
                        && u64::try_from(row.get::<_, i64>("revision")).ok()
                            == Some(definition.reference.revision.0)
                        && row.get::<_, String>("content_digest")
                            == definition.content_digest.as_str()
                })
        })
    {
        return Err(invalid("definitions"));
    }
    Ok(())
}

pub(super) fn validate_release_source(
    release: &Release,
    branch: &WorldBranch,
) -> Result<(), Error> {
    if branch.status != ChangeStatus::Ready
        || release.parent.as_ref() != Some(&branch.basis.release_id)
        || release.definitions != branch.compile.definitions
        || release.scopes != branch.compile.scopes
        || release.artifact.activation_lock_id != branch.basis.activation_lock_id
        || release.artifact.config_digest != branch.compile.config_digest
        || release.artifact.targets != branch.compile.targets
        || release.artifact.model_digest != crate::compiler::model_digest(&branch.compile)?
        || release.sources != branch.basis.sources
        || release.read_receipts != branch.basis.read_receipts
        || release.basis != super::basis::dependencies(&branch.basis)
    {
        return Err(invalid("sourceBranch"));
    }
    Ok(())
}

pub(crate) async fn read_branch(
    tx: &WorldTransaction<'_>,
    id: &BranchId,
) -> Result<Option<WorldBranch>, Error> {
    let world = tx.world();
    let row = tx.query_opt("SELECT r.revision,r.base_release_id,r.activation_lock_id,r.basis_digest,r.content_digest,r.status,r.body FROM world_branch_head h JOIN world_branch_revision r USING(tenant_id,world_id,branch_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.branch_id=$3 FOR SHARE OF h,r",
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
    if read_branch_revision(tx, &reference).await?.as_ref() != Some(&branch) {
        return Err(invalid("branchRevision"));
    }
    Ok(Some(branch))
}

pub(crate) async fn read_branch_revision(
    tx: &WorldTransaction<'_>,
    reference: &BranchRef,
) -> Result<Option<WorldBranch>, Error> {
    if &reference.world != tx.world() || reference.revision.0 == 0 {
        return Err(invalid("branchRevision"));
    }
    let world = tx.world();
    tx.query_opt("SELECT revision,base_release_id,activation_lock_id,basis_digest,content_digest,status,body FROM world_branch_revision WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?]).await?
        .map(|row| branch_revision_row(reference, &row)).transpose()
}

pub(super) fn branch_row(world: &WorldRef, id: &BranchId, row: &Row) -> Result<WorldBranch, Error> {
    let branch: WorldBranch = serde_json::from_value(row.get("body"))?;
    validate_branch_row(world, id, &branch, row)?;
    if branch_digest(&branch)?.as_str() != row.get::<_, String>("content_digest") {
        return Err(invalid("branchRevision"));
    }
    Ok(branch)
}

pub(super) fn branch_revision_row(reference: &BranchRef, row: &Row) -> Result<WorldBranch, Error> {
    let branch: WorldBranch = serde_json::from_value(row.get("body"))?;
    validate_branch_row(&reference.world, &reference.id, &branch, row)?;
    if branch.revision != reference.revision
        || branch_digest(&branch)?.as_str() != row.get::<_, String>("content_digest")
    {
        return Err(invalid("branchRevision"));
    }
    Ok(branch)
}

fn validate_branch_row(
    world: &WorldRef,
    id: &BranchId,
    branch: &WorldBranch,
    row: &Row,
) -> Result<(), Error> {
    if branch.world != *world
        || &branch.id != id
        || branch.compile.world != *world
        || branch.revision.0 == 0
        || u64::try_from(row.get::<_, i64>("revision")).ok() != Some(branch.revision.0)
        || branch.basis.release_id.as_str() != row.get::<_, String>("base_release_id")
        || branch.compile.base_release != branch.basis.release_id
        || (branch.status != ChangeStatus::Proposed
            && branch.compile.activation_lock.id != branch.basis.activation_lock_id)
        || branch.basis.activation_lock_id.as_str() != row.get::<_, String>("activation_lock_id")
        || canonical_digest(&branch.basis)?.as_str() != row.get::<_, String>("basis_digest")
        || status(branch.status) != row.get::<_, String>("status")
    {
        return Err(invalid("branch"));
    }
    Ok(())
}

/// The branch owns task identity; Candidate's wire shape deliberately does not duplicate it.
pub(crate) async fn read_candidate(
    tx: &WorldTransaction<'_>,
    id: &CandidateId,
) -> Result<Option<(WorldBranch, Candidate)>, Error> {
    let world = tx.world();
    let row = tx.query_opt("SELECT c.revision,c.task_id,c.task_revision,c.change_set_id,c.content_digest,c.status,c.body,s.branch_id,s.branch_revision,s.content_digest AS change_digest,s.body AS change_body FROM world_candidate_head h JOIN world_candidate_revision c USING(tenant_id,world_id,candidate_id,revision) JOIN world_change_set s ON s.tenant_id=c.tenant_id AND s.world_id=c.world_id AND s.change_set_id=c.change_set_id AND s.revision=c.revision WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.candidate_id=$3 FOR SHARE OF h,c,s",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let candidate: Candidate = serde_json::from_value(row.get("body"))?;
    let branch_id =
        BranchId::try_new(row.get::<_, String>("branch_id")).map_err(|_| invalid("branchId"))?;
    super::branch::lock(tx, &branch_id).await?;
    let branch = read_branch(tx, &branch_id)
        .await?
        .ok_or_else(|| ReleaseFailure::BranchMissing { branch_id })?;
    let born = read_branch_revision(tx, &BranchRef {
        world: world.clone(),
        id: branch.id.clone(),
        revision: Revision(u64::try_from(row.get::<_, i64>("branch_revision"))
            .map_err(|_| invalid("branchRevision"))?),
    }).await?.ok_or_else(|| invalid("branchRevision"))?;
    if candidate.world != *world
        || &candidate.id != id
        || branch.candidate_id != *id
        || born.candidate_id != *id
        || born.change_set_id != candidate.change_set.id
        || born.task_id != branch.task_id
        || born.task_revision != branch.task_revision
        || born.basis.release_id != candidate.change_set.base_release
        || born.basis.overlay != candidate.change_set.operations
        || born.status != candidate.change_set.status
        || candidate.change_set.world != *world
        || candidate.change_set.id != branch.change_set_id
        || candidate.change_set.id.as_str() != row.get::<_, String>("change_set_id")
        || serde_json::to_value(&candidate.change_set)? != row.get::<_, serde_json::Value>("change_body")
        || canonical_digest(&candidate.change_set)?.as_str() != row.get::<_, String>("change_digest")
        || candidate.change_set.base_release != branch.basis.release_id
        || candidate.change_set.operations != branch.basis.overlay
        || candidate.change_set.status != branch.status
        || u64::try_from(row.get::<_, i64>("revision")).ok()
            != Some(candidate.change_set.revision.0)
        || branch.task_id.as_str() != row.get::<_, String>("task_id")
        || u64::try_from(row.get::<_, i64>("task_revision")).ok() != Some(branch.task_revision.0)
        || canonical_digest(&candidate)?.as_str() != row.get::<_, String>("content_digest")
        || status(candidate.change_set.status) != row.get::<_, String>("status")
    {
        return Err(invalid("candidate"));
    }
    Ok(Some((branch, candidate)))
}

pub(crate) async fn read_head(
    tx: &WorldTransaction<'_>,
    channel: &ChannelId,
) -> Result<Option<ReleaseHead>, Error> {
    let world = tx.world();
    tx.query_opt("SELECT generation,revision,release_id FROM world_release_head WHERE tenant_id=$1 AND world_id=$2 AND channel=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &channel.as_str()]).await?.map(|row| {
        Ok(ReleaseHead { world: world.clone(), channel: channel.clone(),
            generation: Generation(u64::try_from(row.get::<_, i64>("generation")).map_err(|_| invalid("generation"))?),
            revision: Revision(u64::try_from(row.get::<_, i64>("revision")).map_err(|_| invalid("revision"))?),
            release_id: ReleaseId::try_new(row.get::<_, String>("release_id")).map_err(|_| invalid("releaseId"))? })
    }).transpose()
}

/// Loads the published canonical model once for a batch of exact definition lookups.
pub(crate) async fn read_active_model(tx: &WorldTransaction<'_>) -> Result<Option<Release>, Error> {
    let Some(id) = read_active_release(tx).await? else {
        return Ok(None);
    };
    Ok(Some(
        read_release(tx, &id)
            .await?
            .ok_or_else(|| invalid("activeRelease"))?,
    ))
}

pub(crate) async fn read_active_release(
    tx: &WorldTransaction<'_>,
) -> Result<Option<ReleaseId>, Error> {
    Ok(read_active_head(tx).await?.map(|head| head.release_id))
}

pub(crate) async fn read_active_head(
    tx: &WorldTransaction<'_>,
) -> Result<Option<ReleaseHead>, Error> {
    let world = tx.world();
    tx.query_opt("SELECT h.channel,h.generation,h.revision,h.release_id FROM world_runtime_head r JOIN world_release_head h ON h.tenant_id=r.tenant_id AND h.world_id=r.world_id AND h.channel=r.active_release_channel WHERE r.tenant_id=$1 AND r.world_id=$2 FOR SHARE OF r,h",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?.map(|row| {
        let positive = |value: i64| u64::try_from(value).ok().filter(|value| *value > 0).ok_or_else(|| invalid("head"));
        Ok(ReleaseHead {
            world: world.clone(),
            channel: ChannelId::try_new(row.get::<_, String>("channel")).map_err(|_| invalid("channel"))?,
            generation: Generation(positive(row.get("generation"))?),
            revision: Revision(positive(row.get("revision"))?),
            release_id: ReleaseId::try_new(row.get::<_, String>("release_id")).map_err(|_| invalid("activeRelease"))?,
        })
    }).transpose()
}

pub(super) fn release_digest(release: &Release) -> Result<world_protocol::ids::Digest, Error> {
    Ok(canonical_digest(&("world.release.v1", release))?)
}
pub(super) fn branch_digest(branch: &WorldBranch) -> Result<world_protocol::ids::Digest, Error> {
    Ok(canonical_digest(&("world.branch.v1", branch))?)
}
pub(super) fn number(value: u64) -> Result<i64, Error> {
    i64::try_from(value).map_err(|_| invalid("revision"))
}
pub(super) fn status(status: ChangeStatus) -> &'static str {
    match status {
        ChangeStatus::Proposed => "proposed",
        ChangeStatus::Validated => "validated",
        ChangeStatus::Testing => "testing",
        ChangeStatus::Ready => "ready",
        ChangeStatus::Rejected => "rejected",
        ChangeStatus::Published => "published",
        ChangeStatus::Superseded => "superseded",
    }
}
pub(super) fn invalid(field: &str) -> Error {
    ReleaseFailure::InvalidBranch {
        field: FieldPath(vec![field.into()]),
    }
    .into()
}
