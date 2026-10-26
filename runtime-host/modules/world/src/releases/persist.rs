use super::{Error, PreparedArtifact, read_head, read_release, require_writer};
use crate::{
    authorization::AuthorityRoot,
    content::{self, Content, ContentOwner, ContentReference},
    definitions::{canonical_digest, read_scopes},
    extensions::{
        bindings::read_graph_in_transaction,
        package::{RetentionOwner, retain_packages},
    },
    store::{OutboxEvent, WorldTransaction},
};
use world_protocol::{
    commit::CommittedRevision,
    definitions::Scope,
    expression::ExpressionIr,
    failure::FieldPath,
    ids::{EventId, Generation, ResourceRef, Revision},
    releases::{Release, ReleaseFailure, ReleaseHead, ReleaseHeadCas},
    value::Value,
};

/// Only the store's first-world provision transaction may establish an unprivileged genesis.
pub(crate) async fn bootstrap_release(
    tx: &mut WorldTransaction<'_>,
    _authority: &AuthorityRoot,
    content: &Content,
    prepared: &PreparedArtifact,
    head: &ReleaseHeadCas,
) -> Result<Release, Error> {
    tx.require_provision()?;
    require_writer(tx)?;
    let request = prepared.request();
    let lock = &request.activation_lock;
    if request.world != *tx.world()
        || !request.definitions.is_empty()
        || request.scopes.len() != 1
        || request.base_release != prepared.manifest().release_id
        || head.next != prepared.manifest().release_id
        || head.world != *tx.world()
        || head.expected.is_some()
        || !lock.nodes.is_empty()
        || !lock.edges.is_empty()
        || !lock.compositions.is_empty()
        || !lock.roots.is_empty()
        || !lock.trusted_roots.is_empty()
        || !universal(&request.scopes[0], tx.world())
    {
        return Err(invalid("genesis"));
    }
    let stored = read_scopes(tx, &[request.scopes[0].id.clone()]).await?;
    if stored != request.scopes {
        return Err(invalid("scope"));
    }
    let artifact = super::artifact::persist_artifact(tx, content, prepared).await?;
    let release = Release {
        world: tx.world().clone(),
        id: artifact.release_id.clone(),
        parent: None,
        source_branch: None,
        artifact,
        definitions: Vec::new(),
        scopes: request.scopes.clone(),
        basis: Vec::new(),
        sources: Vec::new(),
        read_receipts: Vec::new(),
        evaluations: Vec::new(),
        published_at: tx.now().await?,
    };
    insert_release(tx, content, prepared, &release).await?;
    switch_head(tx, head).await?;
    Ok(release)
}

pub(super) async fn insert_release(
    tx: &mut WorldTransaction<'_>,
    content: &Content,
    prepared: &PreparedArtifact,
    release: &Release,
) -> Result<(), Error> {
    require_writer(tx)?;
    let request = prepared.request();
    if release.world != *tx.world()
        || content.world() != tx.world()
        || &release.artifact != prepared.manifest()
        || release.id != release.artifact.release_id
        || release.definitions != request.definitions
        || release.scopes != request.scopes
    {
        return Err(invalid("release"));
    }
    let graph = read_graph_in_transaction(tx, &release.artifact.activation_lock_id).await?;
    if graph.lock() != &request.activation_lock {
        return Err(invalid("activationLock"));
    }
    let packages: Vec<_> = graph
        .lock()
        .nodes
        .iter()
        .map(|node| node.implementation.package_digest.clone())
        .collect();
    retain_packages(
        tx,
        RetentionOwner::Release(&release.id),
        Revision(1),
        &packages,
    )
    .await?;
    for output in &release.artifact.outputs {
        content::retain(
            tx,
            &ContentReference::new(
                ContentOwner::Release {
                    id: release.id.clone(),
                },
                output.content.clone(),
            )?,
        )
        .await?;
    }
    let world = tx.world().clone();
    let digest = super::read::release_digest(release)?;
    let source_revision = release
        .source_branch
        .as_ref()
        .map(|branch| super::read::number(branch.revision.0))
        .transpose()?;
    if release
        .source_branch
        .as_ref()
        .is_some_and(|branch| branch.world != world || branch.revision.0 == 0)
    {
        return Err(invalid("sourceBranch"));
    }
    let inserted = tx.execute("INSERT INTO world_release(tenant_id,world_id,release_id,parent_release_id,artifact_id,activation_lock_id,content_digest,model_digest,body,source_branch_id,source_branch_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &release.id.as_str(), &release.parent.as_ref().map(|id| id.as_str()),
          &release.artifact.id.as_str(), &release.artifact.activation_lock_id.as_str(), &digest.as_str(), &release.artifact.model_digest.as_str(),
          &serde_json::to_value(release)?, &release.source_branch.as_ref().map(|branch| branch.id.as_str()), &source_revision]).await?;
    if inserted == 0 {
        if read_release(tx, &release.id).await?.as_ref() != Some(release) {
            return Err(invalid("releaseId"));
        }
        return Ok(());
    }
    for definition in &release.definitions {
        tx.execute("INSERT INTO world_release_definition(tenant_id,world_id,release_id,definition_id,revision,content_digest) VALUES($1,$2,$3,$4,$5,$6)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &release.id.as_str(), &definition.reference.id.as_str(),
              &super::read::number(definition.reference.revision.0)?, &definition.content_digest.as_str()]).await?;
    }
    emit(
        tx,
        "release",
        release.id.as_str(),
        Revision(1),
        "release.sealed",
        &serde_json::to_value(release)?,
    )
    .await
}

pub(super) async fn switch_head(
    tx: &mut WorldTransaction<'_>,
    cas: &ReleaseHeadCas,
) -> Result<ReleaseHead, Error> {
    require_writer(tx)?;
    if &cas.world != tx.world()
        || cas
            .expected
            .as_ref()
            .is_some_and(|head| head.world != cas.world || head.channel != cas.channel)
    {
        return Err(invalid("head"));
    }
    let actual = read_head(tx, &cas.channel).await?;
    if actual != cas.expected {
        return Err(ReleaseFailure::HeadConflict {
            channel: cas.channel.clone(),
            expected: cas.expected.clone(),
            actual,
        }
        .into());
    }
    let next = ReleaseHead {
        world: cas.world.clone(),
        channel: cas.channel.clone(),
        generation: Generation(actual.as_ref().map_or(Ok(1), |head| {
            head.generation
                .0
                .checked_add(1)
                .ok_or_else(|| invalid("generation"))
        })?),
        revision: Revision(actual.as_ref().map_or(Ok(1), |head| {
            head.revision
                .0
                .checked_add(1)
                .ok_or_else(|| invalid("revision"))
        })?),
        release_id: cas.next.clone(),
    };
    let world = tx.world().clone();
    let changed = if let Some(actual) = &actual {
        tx.execute("UPDATE world_release_head SET generation=$4,revision=$5,release_id=$6 WHERE tenant_id=$1 AND world_id=$2 AND channel=$3 AND generation=$7 AND revision=$8 AND release_id=$9",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &cas.channel.as_str(), &super::read::number(next.generation.0)?,
              &super::read::number(next.revision.0)?, &cas.next.as_str(), &super::read::number(actual.generation.0)?,
              &super::read::number(actual.revision.0)?, &actual.release_id.as_str()]).await?
    } else {
        tx.execute("INSERT INTO world_release_head(tenant_id,world_id,channel,generation,revision,release_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &cas.channel.as_str(), &super::read::number(next.generation.0)?,
              &super::read::number(next.revision.0)?, &cas.next.as_str()]).await?
    };
    if changed != 1 {
        return Err(ReleaseFailure::HeadConflict {
            channel: cas.channel.clone(),
            expected: cas.expected.clone(),
            actual: read_head(tx, &cas.channel).await?,
        }
        .into());
    }
    tx.execute("INSERT INTO world_release_head_history(tenant_id,world_id,channel,generation,revision,release_id,previous_release_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &cas.channel.as_str(), &super::read::number(next.generation.0)?,
          &super::read::number(next.revision.0)?, &cas.next.as_str(), &actual.as_ref().map(|head| head.release_id.as_str()), &serde_json::to_value(&next)?]).await?;
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Head {
            channel: cas.channel.clone(),
        },
        revision: next.revision,
    })?;
    emit(
        tx,
        "release_head",
        cas.channel.as_str(),
        next.revision,
        "release.head_changed",
        &serde_json::to_value(&next)?,
    )
    .await?;
    Ok(next)
}

pub(super) async fn emit(
    tx: &mut WorldTransaction<'_>,
    aggregate: &str,
    id: &str,
    revision: Revision,
    kind: &str,
    payload: &serde_json::Value,
) -> Result<(), Error> {
    let digest = canonical_digest(&(tx.world(), aggregate, id, revision, kind, tx.commit_id()))?;
    let event_id = EventId::try_new(format!("release-{}", &digest.as_str()[7..]))
        .map_err(|_| invalid("eventId"))?;
    tx.emit(OutboxEvent {
        event_id,
        aggregate_kind: aggregate.into(),
        aggregate_id: id.into(),
        aggregate_revision: revision.0,
        event_kind: kind.into(),
        payload: payload.clone(),
        causation_id: None,
        origin: "world.releases".into(),
    })
    .await?;
    Ok(())
}
fn universal(scope: &Scope, world: &world_protocol::ids::WorldRef) -> bool {
    &scope.world == world
        && scope.predicate
            == (ExpressionIr::Literal {
                value: Value::Boolean { value: true },
            })
}
fn invalid(field: &str) -> Error {
    ReleaseFailure::InvalidArtifact {
        field: FieldPath(vec![field.into()]),
    }
    .into()
}
