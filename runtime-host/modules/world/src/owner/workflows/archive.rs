mod backup;
mod custody;
mod mutation;
mod recovery;

pub(crate) use custody::{ArchiveWorkflows, resume_intent};

use std::sync::Arc;

use world_protocol::{
    api::{ApiFailure, ParseArtifactQuery, QueryResult, WorldQuery},
    authorization::{ActualImpact, AuthorizationFailure},
    failure::{FailureStage, Recovery},
    ids::{CommitId, ContentId, Digest},
    time::Timestamp,
};

use crate::{
    authorization::{self, VerifiedInvocation},
    content::{self, Content, ParseRead},
    definitions::canonical_digest,
    owner::{Error, head},
    store::{CommitRequest, Committed, PreparedBatch, WorldStore, WorldTransaction},
};

pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    command: &world_protocol::api::WorldCommand,
) -> Result<ActualImpact, Error> {
    use world_protocol::{
        api::WorldCommand,
        authorization::{AccessMode, AccessScope},
    };
    let modes = match command {
        WorldCommand::Backup(_) => vec![AccessMode::Manage, AccessMode::Export],
        WorldCommand::Restore(_) => vec![AccessMode::Manage, AccessMode::Write],
        WorldCommand::DeleteWorld(_) => vec![AccessMode::Manage, AccessMode::Delete],
        _ => return Err(unsupported()),
    };
    Ok(authorization::actual_impact(
        vec![AccessScope {
            resources: Vec::new(),
            fields: Vec::new(),
            modes,
            scope: head::management_scope(tx).await?,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?)
}

pub(crate) async fn query_impact(
    tx: &WorldTransaction<'_>,
    query: &WorldQuery,
) -> Result<ActualImpact, Error> {
    let sources = match query {
        WorldQuery::Materials(request) => {
            content::list_source_versions(tx, &request.page)
                .await?
                .items
        }
        WorldQuery::SourceVersion(request) => {
            vec![content::read_source_version_in_transaction(tx, &request.reference).await?]
        }
        WorldQuery::ParseArtifact(request) => {
            vec![content::parse_source_version(tx, &request.id).await?]
        }
        _ => return Err(unsupported()),
    };
    let mut access = Vec::new();
    let mut labels = Vec::new();
    let mut source_ids = Vec::new();
    for source in sources {
        let impact = authorization::material_read_impact(tx, &source).await?;
        access.extend(impact.access);
        labels.extend(impact.labels);
        source_ids.extend(impact.source_ids);
    }
    authorization::actual_impact(access, Vec::new(), labels, Vec::new(), source_ids)
        .map_err(Error::from)
}

pub(crate) async fn query(
    _content: &Content,
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &WorldQuery,
    now: &Timestamp,
) -> Result<QueryResult, Error> {
    match query {
        WorldQuery::Materials(request) => {
            authorization::material_scopes(tx, verified, now).await?;
            let mut scan = request.page.clone();
            let mut items = Vec::new();
            let mut scanned = 0usize;
            loop {
                let page = content::list_source_versions(tx, &scan).await?;
                scanned += scan.limit as usize;
                for source in page.items {
                    let admission =
                        match authorization::material_read(tx, verified, &source, now).await {
                            Ok(admission) => admission,
                            Err(authorization::AuthError::Denied(
                                AuthorizationFailure::InsufficientScope,
                            )) => continue,
                            Err(error) => return Err(error.into()),
                        };
                    match authorization::check_admitted_output(
                        tx,
                        &admission,
                        admission.impact(),
                        1,
                        now,
                    )
                    .await
                    {
                        Ok(_) => {}
                        Err(authorization::AuthError::Denied(
                            AuthorizationFailure::InsufficientScope,
                        )) => continue,
                        Err(error) => return Err(error.into()),
                    }
                    if items.len() == request.page.limit as usize {
                        // Only an already disclosed source identity may leave in the cursor.
                        let last: &world_protocol::materials::SourceVersion =
                            items.last().expect("nonzero page limit");
                        let cursor = serde_json::to_string(&(
                            tx.world(),
                            last.reference.source_id.as_str(),
                            last.reference.version_id.as_str(),
                        ))
                        .map_err(|cause| Error::internal(FailureStage::Disclose).caused(cause))?;
                        return Ok(QueryResult::Materials(world_protocol::query::Page {
                            items,
                            next_cursor: Some(cursor),
                        }));
                    }
                    items.push(source);
                }
                let Some(cursor) = page.next_cursor else {
                    return Ok(QueryResult::Materials(world_protocol::query::Page {
                        items,
                        next_cursor: None,
                    }));
                };
                if scanned >= 65_536 {
                    return Err(content::Error::material(
                        world_protocol::materials::MaterialFailure::SizeLimit,
                    )
                    .into());
                }
                scan.cursor = Some(cursor);
            }
        }
        WorldQuery::SourceVersion(request) => {
            let source =
                content::read_source_version_in_transaction(tx, &request.reference).await?;
            let admission = authorization::material_read(tx, verified, &source, now).await?;
            authorization::check_admitted_output(tx, &admission, admission.impact(), 1, now)
                .await?;
            Ok(QueryResult::SourceVersion(source))
        }
        // The fixed root dispatches parse reads to `parse`, outside its SQL transaction.
        _ => Err(unsupported()),
    }
}

/// The root retains this entire future in its Foundation-owned worker, not the HTTP observer.
pub(crate) async fn parse(
    store: WorldStore,
    content: Arc<Content>,
    verified: VerifiedInvocation,
    request: ParseArtifactQuery,
) -> Result<QueryResult, Error> {
    let world = verified.invocation().world.clone();
    let digest = canonical_digest(&(&verified.invocation().request_digest, &request))?;
    let identity = canonical_digest(&(
        "world.parse-read.v1",
        &world,
        verified.restart_identity(),
        &verified.invocation().replay_id,
    ))?;
    let commit_id = CommitId::try_new(format!("parse-{}", &identity.as_str()[7..]))
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
    let committed = if let Some(committed) = store
        .read_commit_optional::<ParseRead>(&world, &commit_id, &digest)
        .await?
    {
        committed
    } else {
        let batch = parse_batch(&store, &world, commit_id, digest.clone()).await?;
        let current = verified.clone();
        let reader = content.clone();
        let id = request.id.clone();
        let pin_id = ContentId::try_new(format!("parse-{}", &identity.as_str()[7..]))
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        store
            .transact(batch, move |tx| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    let source = content::parse_source_version(tx, &id).await?;
                    authorization::material_read(tx, &current, &source, &now).await?;
                    reader
                        .prepare_parse_read(tx, &id, pin_id)
                        .await
                        .map_err(Error::from)
                })
            })
            .await?
    };
    let result = async {
        let artifact = content.read_parse_pinned(&store, &committed).await?;
        // A historical receipt is not current disclosure authority; this check never replays.
        let disclosure_id =
            CommitId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier");
        let batch = parse_batch(&store, &world, disclosure_id, digest.clone()).await?;
        let source_version = artifact.artifact().source_version.clone();
        store
            .transact(batch, move |tx| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    let source =
                        content::read_source_version_in_transaction(tx, &source_version).await?;
                    let admission =
                        authorization::material_read(tx, &verified, &source, &now).await?;
                    authorization::check_admitted_output(
                        tx,
                        &admission,
                        admission.impact(),
                        1,
                        &now,
                    )
                    .await?;
                    Ok::<_, Error>(())
                })
            })
            .await?;
        // Bytes are never the durable transaction result.
        Ok::<_, Error>(QueryResult::ParseArtifact(artifact.into_artifact()))
    }
    .await;
    let cleanup = release_parse_pin(&store, &world, &identity, digest, committed).await;
    match (result, cleanup) {
        (Ok(result), Ok(())) => Ok(result),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(error.with_related(cleanup)),
    }
}

async fn release_parse_pin(
    store: &WorldStore,
    world: &world_protocol::ids::WorldRef,
    identity: &Digest,
    digest: Digest,
    committed: Committed<ParseRead>,
) -> Result<(), Error> {
    let id = CommitId::try_new(format!("parse-release-{}", &identity.as_str()[7..]))
        .map_err(|cause| Error::internal(FailureStage::Stop).caused(cause))?;
    let batch = parse_batch(store, world, id, digest).await?;
    store
        .transact(batch, move |tx| {
            Box::pin(async move {
                content::release_pin(tx, committed.value.pin())
                    .await
                    .map_err(Error::from)
            })
        })
        .await?;
    Ok(())
}

async fn parse_batch(
    store: &WorldStore,
    world: &world_protocol::ids::WorldRef,
    commit_id: CommitId,
    input_digest: Digest,
) -> Result<PreparedBatch, Error> {
    let (storage_epoch, fences) = store
        .snapshot(world.clone(), |snapshot| {
            Box::pin(head::writer_fences(snapshot, &["authorization", "content"]))
        })
        .await?;
    Ok(CommitRequest {
        world: world.clone(),
        commit_id,
        input_digest,
        storage_epoch,
        fences,
        watch_basis: Vec::new(),
    }
    .prepare()?)
}

fn unsupported() -> Error {
    Error::new(
        "world.archive_query_mismatch",
        FailureStage::Decode,
        "此查询不属于资料读取入口。",
        ApiFailure::Authorization(AuthorizationFailure::RequestDigestMismatch),
        Recovery::None,
    )
}
