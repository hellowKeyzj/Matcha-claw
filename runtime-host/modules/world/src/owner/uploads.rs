use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{
        ApiFailure, CommandEnvelope, CommandResult, UploadKey, UploadReceipt, WorldCommand,
        WorldStatus,
    },
    authorization::{AccessMode, AccessScope, Actor, AuthorizationFailure},
    failure::{FailureStage, Recovery},
    ids::{ActorId, CommitId, Digest, TransferId, WorldRef},
};

use super::{Error, head, operation::SignedRequest, resources::Resources};
use crate::{
    authorization::{self, Admission, RestartIdentity, ServiceIngress},
    content::{Content, PreparedUploadChunk, PreparedUploadSeal},
    store::{CommitRequest, Committed, PreparedBatch, TransactionError, WorldStore},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadCommit {
    identity: RestartIdentity,
    receipt: UploadReceipt,
}

enum Prepared {
    None,
    Chunk(PreparedUploadChunk),
    Seal(PreparedUploadSeal),
}
impl Prepared {
    fn discard(&self, content: &Content) -> Result<(), Error> {
        match self {
            Self::None => Ok(()),
            Self::Chunk(chunk) => content.discard_upload_chunk(chunk).map_err(Error::from),
            Self::Seal(seal) => content.discard_upload_seal(seal).map_err(Error::from),
        }
    }
}

/// The Foundation-owned worker retains prepare/COMMIT/cleanup even if the HTTP observer disappears.
pub(crate) async fn run(
    store: WorldStore,
    resources: Arc<Resources>,
    ingress: Arc<ServiceIngress>,
    signed: SignedRequest,
    envelope: CommandEnvelope,
    maintenance: bool,
) -> Result<CommandResult, Error> {
    let tasks = resources.tasks.clone();
    tasks
        .spawn(async move { execute(store, resources, ingress, signed, envelope, maintenance).await })
        .await
        .map_err(|cause| Error::internal(FailureStage::Execute).caused(cause))?
}

async fn execute(
    store: WorldStore,
    resources: Arc<Resources>,
    ingress: Arc<ServiceIngress>,
    signed: SignedRequest,
    envelope: CommandEnvelope,
    maintenance: bool,
) -> Result<CommandResult, Error> {
    if envelope.world != *signed.binding.world()
        || !matches!(
            &envelope.command,
            WorldCommand::BeginUpload(_)
                | WorldCommand::UploadChunk(_)
                | WorldCommand::SealUpload(_)
                | WorldCommand::AbortUpload(_)
        )
    {
        return Err(AuthorizationFailure::RequestDigestMismatch.into());
    }
    let digest = signed.binding.request_digest().clone();
    let identity = crate::definitions::canonical_digest(&(
        "world.upload.v1",
        &envelope.world,
        &envelope.request_id,
    ))?;
    let commit_id = CommitId::try_new(format!("upload-{}", &identity.as_str()[7..]))
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
    let mut modes = vec![AccessMode::Read, AccessMode::Write];
    if maintenance { modes.push(AccessMode::Manage); }
    let admission = authenticate(&store, ingress, signed, modes).await?;
    if let Some(committed) = store
        .read_commit_optional::<UploadCommit>(&envelope.world, &commit_id, &digest)
        .await?
    {
        return disclose(&store, &admission, committed).await;
    }
    // Absence is not rollback proof. The original CommitId's unique reservation still arbitrates
    // the final transaction; preparation never deletes any shared digest on failure.
    let prepared = match prepare(&store, &resources.content, &admission, &envelope.command).await {
        Ok(prepared) => Arc::new(prepared),
        Err(error) => {
            if let Some(committed) = store
                .read_commit_optional::<UploadCommit>(&envelope.world, &commit_id, &digest)
                .await?
            {
                return disclose(&store, &admission, committed).await;
            }
            // A concurrent same-ID seal can have committed between the receipt read and
            // preparation. Reserve the original identity before declaring preparation failed.
            let batch = batch(
                &store,
                &envelope.world,
                commit_id,
                digest,
                &["content", "operation"],
            )
            .await?;
            let current = admission.clone();
            let replay = store
                .transact::<UploadCommit, Error, _>(batch, move |tx| {
                    Box::pin(async move {
                        let now = tx.now().await?;
                        authorization::recheck(tx, &current, &now).await?;
                        Err(error)
                    })
                })
                .await?;
            return disclose(&store, &admission, replay).await;
        }
    };
    let batch = match batch(
        &store,
        &envelope.world,
        commit_id,
        digest,
        &["content", "operation"],
    )
    .await
    {
        Ok(batch) => batch,
        Err(mut error) => {
            if let Err(cleanup) = prepared.discard(&resources.content) {
                error = error.with_related(cleanup);
            }
            return Err(error);
        }
    };
    let content = resources.content.clone();
    let staged = prepared.clone();
    let current = admission.clone();
    let result = store
        .transact(batch, move |tx| {
            Box::pin(async move {
                let now = tx.now().await?;
                authorization::recheck(tx, &current, &now).await?;
                if head::read(tx).await?.status != WorldStatus::Ready {
                    return Err(Error::new(
                        "world.upload_not_ready",
                        FailureStage::Admission,
                        "世界当前不能接收资料，请读取当前状态。",
                        ApiFailure::RevisionConflict,
                        Recovery::Refresh,
                    ));
                }
                let actor = actor(&current);
                let receipt = match (&envelope.command, staged.as_ref()) {
                    (WorldCommand::BeginUpload(request), Prepared::None) => {
                        let transfer_digest = crate::definitions::canonical_digest(&(
                            "world.upload-transfer.v1",
                            &envelope.world,
                            &envelope.request_id,
                            &actor,
                        ))?;
                        let id = TransferId::try_new(format!(
                            "upload-{}",
                            &transfer_digest.as_str()[7..]
                        ))
                        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
                        content.begin_upload(tx, &actor, id, request).await?
                    }
                    (WorldCommand::UploadChunk(_), Prepared::Chunk(chunk)) => {
                        content.append_upload_chunk(tx, &actor, chunk).await?
                    }
                    (WorldCommand::SealUpload(_), Prepared::Seal(seal)) => {
                        content.seal_upload(tx, &actor, seal).await?
                    }
                    (WorldCommand::AbortUpload(request), Prepared::None) => {
                        content.abort_upload(tx, &actor, request).await?
                    }
                    _ => return Err(Error::internal(FailureStage::Prepare)),
                };
                Ok::<_, Error>(UploadCommit {
                    identity: current.restart_identity(),
                    receipt,
                })
            })
        })
        .await;
    match result {
        Ok(committed) => {
            // Only this attempt's private stage; the published/shared digest is never removed.
            prepared.discard(&resources.content)?;
            disclose(&store, &admission, committed).await
        }
        Err(error @ TransactionError::NotCommitted { .. }) => {
            let mut error = Error::from(error);
            if let Err(cleanup) = prepared.discard(&resources.content) {
                error = error.with_related(cleanup);
            }
            Err(error)
        }
        Err(TransactionError::Indeterminate(error)) => Err(error.into()),
    }
}

async fn prepare(
    store: &WorldStore,
    content: &Arc<Content>,
    admission: &Admission,
    command: &WorldCommand,
) -> Result<Prepared, Error> {
    let cancellation = CancellationToken::new();
    match command {
        WorldCommand::UploadChunk(request) => {
            let content = content.clone();
            let request = request.clone();
            tokio::task::spawn_blocking(move || {
                content
                    .prepare_upload_chunk(&request, &cancellation)
                    .map(Prepared::Chunk)
                    .map_err(Error::from)
            })
            .await
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?
        }
        WorldCommand::SealUpload(request) => {
            let content = content.clone();
            let request = request.clone();
            let store = store.clone();
            let actor = actor(admission);
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                runtime
                    .block_on(content.prepare_seal_upload(&store, &actor, &request, &cancellation))
                    .map(Prepared::Seal)
                    .map_err(Error::from)
            })
            .await
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?
        }
        WorldCommand::BeginUpload(_) | WorldCommand::AbortUpload(_) => Ok(Prepared::None),
        _ => Err(Error::internal(FailureStage::Prepare)),
    }
}

async fn authenticate(
    store: &WorldStore,
    ingress: Arc<ServiceIngress>,
    signed: SignedRequest,
    modes: Vec<AccessMode>,
) -> Result<Admission, Error> {
    let world = signed.binding.world().clone();
    let digest = signed.binding.request_digest().clone();
    let batch = batch(
        store,
        &world,
        CommitId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
        digest,
        &["authorization", "operation"],
    )
    .await?;
    let (send, receive) = oneshot::channel();
    // Admission is deliberately not serializable. Its live value is used only after this
    // authorization transaction is known committed, then rechecked at every later boundary.
    store
        .transact(batch, move |tx| {
            Box::pin(async move {
                let now = tx.now().await?;
                let verified = ingress
                    .authenticate(tx, &signed.token, signed.binding, &now)
                    .await?;
                let scope = head::management_scope(tx).await?;
                let impact = authorization::actual_impact(
                    vec![AccessScope {
                        resources: Vec::new(),
                        fields: Vec::new(),
                        modes,
                        scope,
                        valid_time: None,
                    }],
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                )?;
                let admission =
                    authorization::admit(tx, &verified, &impact, &[], None, &now).await?;
                send.send(admission)
                    .map_err(|_| Error::internal(FailureStage::Admission))?;
                Ok::<_, Error>(())
            })
        })
        .await?;
    receive
        .await
        .map_err(|cause| Error::internal(FailureStage::Admission).caused(cause))
}

async fn batch(
    store: &WorldStore,
    world: &WorldRef,
    commit_id: CommitId,
    input_digest: Digest,
    domains: &[&str],
) -> Result<PreparedBatch, Error> {
    let domains: Vec<_> = domains.iter().map(|value| (*value).to_owned()).collect();
    let (storage_epoch, fences) = store
        .snapshot(world.clone(), move |snapshot| {
            Box::pin(async move {
                let domains: Vec<_> = domains.iter().map(String::as_str).collect();
                head::writer_fences(snapshot, &domains).await
            })
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

async fn disclose(
    store: &WorldStore,
    admission: &Admission,
    committed: Committed<UploadCommit>,
) -> Result<CommandResult, Error> {
    committed
        .value
        .identity
        .require_resume(admission.verified())?;
    let admission = admission.clone();
    store
        .snapshot(admission.invocation().world.clone(), move |snapshot| {
            Box::pin(async move {
                let now = snapshot.now().await?;
                authorization::check_admitted_output_read(
                    snapshot,
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
    Ok(CommandResult::Upload(committed.value.receipt))
}

fn actor(admission: &Admission) -> ActorId {
    match &admission.invocation().actor {
        Actor::Human { id } | Actor::Service { id } => id.clone(),
    }
}

pub(crate) async fn status(
    store: WorldStore,
    resources: Arc<Resources>,
    ingress: Arc<ServiceIngress>,
    signed: SignedRequest,
    key: UploadKey,
) -> Result<UploadReceipt, Error> {
    let tasks = resources.tasks.clone();
    tasks
        .spawn(async move {
            let admission = authenticate(&store, ingress, signed, vec![AccessMode::Read]).await?;
            let actor = actor(&admission);
            store
                .snapshot(admission.invocation().world.clone(), move |snapshot| {
                    Box::pin(async move {
                        let now = snapshot.now().await?;
                        authorization::check_admitted_output_read(
                            snapshot,
                            &admission,
                            admission.impact(),
                            1,
                            &now,
                        )
                        .await?;
                        resources
                            .content
                            .read_upload(snapshot, &actor, &key)
                            .await
                            .map_err(Error::from)
                    })
                })
                .await
        })
        .await
        .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?
}
