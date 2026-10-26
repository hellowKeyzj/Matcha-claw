use std::sync::Arc;

use serde::Serialize;
use world_protocol::{commit::CommitReceipt, ids::{CommitId, Digest, WorldRef}};

use crate::{
    authorization::{self, AuthorityRoot, GrantRequest},
    definitions::canonical_digest,
    store::{TransactionError, WorldStore},
};

use super::{Error, execution::prepare_request};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationStatus {
    pub world: WorldRef,
    pub configured: bool,
    pub commit_id: Option<CommitId>,
}

pub(super) async fn install_evaluation(
    store: WorldStore,
    authority: Arc<AuthorityRoot>,
    input: authorization::InstallEvaluation,
) -> Result<CommitReceipt, Error> {
    let digest = authorization::installation_digest(&input.world, &input.evaluation,
        &input.principals, &input.grants, &input.policies, &input.retention_policies)?;
    if let Some(committed) = store.read_commit_optional::<()>(&input.world, &input.commit_id, &digest).await? {
        return Ok(committed.receipt);
    }
    let request = prepare_request(&store, &input.world, input.commit_id.clone(), digest.clone(), &["authorization"]).await?;
    let world = input.world.clone();
    let commit_id = input.commit_id.clone();
    let committed_digest = digest.clone();
    let outcome = store.transact(request.prepare()?, move |tx| Box::pin(async move {
        authorization::install_evaluation(tx, &authority, &input, &digest, &tx.now().await?).await
    })).await;
    confirmed(&store, &world, &commit_id, outcome, committed_digest).await
}

pub(super) async fn backfill_evaluation(
    store: &WorldStore,
    world: &WorldRef,
    provision_commit: &CommitId,
    configuration: authorization::InitialEvaluation,
    digest: Digest,
) -> Result<(), Error> {
    if load_evaluation(store, world).await?.is_some() { return Ok(()); }
    let identity = canonical_digest(&("world.evaluation.bootstrap.v1", world, provision_commit, &digest))?;
    let commit_id = CommitId::try_new(format!("evaluation-{}", &identity.as_str()[7..]))
        .map_err(|cause| Error::internal(world_protocol::failure::FailureStage::Prepare).caused(cause))?;
    let request = prepare_request(store, world, commit_id.clone(), digest.clone(), &["authorization"]).await?;
    let committed_digest = digest.clone();
    let outcome = store.transact(request.prepare()?, move |tx| Box::pin(async move {
        // The original provision receipt has already authenticated this immutable input.
        // Do not replay its principals, grants or policies into current authorization.
        authorization::backfill_evaluation(tx, &configuration, &digest).await
    })).await;
    confirmed(store, world, &commit_id, outcome, committed_digest).await?;
    Ok(())
}

pub(super) async fn load_evaluation(store: &WorldStore, world: &WorldRef) -> Result<Option<authorization::InstalledEvaluation>, Error> {
    store.snapshot(world.clone(), |snapshot| Box::pin(authorization::read_evaluation(snapshot))).await
}

async fn confirmed(
    store: &WorldStore,
    world: &WorldRef,
    commit_id: &CommitId,
    outcome: Result<crate::store::Committed<()>, TransactionError<Error>>,
    digest: Digest,
) -> Result<CommitReceipt, Error> {
    match outcome {
        Ok(committed) => Ok(committed.receipt),
        Err(TransactionError::Indeterminate(error)) => match store.read_commit::<()>(world, commit_id, &digest).await {
            Ok(committed) => Ok(committed.receipt),
            Err(recovery) => Err(Error::from(error).with_related(recovery.into())),
        },
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn grant(
    store: WorldStore,
    authority: Arc<AuthorityRoot>,
    input: GrantRequest,
) -> Result<CommitReceipt, Error> {
    let digest = canonical_digest(&("world.access.grant.v1", &input))?;
    if let Some(committed) = store
        .read_commit_optional::<()>(&input.world, &input.commit_id, &digest)
        .await?
    {
        return Ok(committed.receipt);
    }
    let request = prepare_request(
        &store,
        &input.world,
        input.commit_id.clone(),
        digest.clone(),
        &["authorization"],
    )
    .await?;
    let world = input.world.clone();
    let commit_id = input.commit_id.clone();
    match store
        .transact(request.prepare()?, move |tx| {
            Box::pin(async move {
                authorization::grant_access(tx, &authority, &input, &tx.now().await?).await
            })
        })
        .await
    {
        Ok(committed) => Ok(committed.receipt),
        Err(TransactionError::Indeterminate(error)) => {
            match store.read_commit::<()>(&world, &commit_id, &digest).await {
                Ok(committed) => Ok(committed.receipt),
                Err(recovery) => Err(Error::from(error).with_related(recovery.into())),
            }
        }
        Err(error) => Err(error.into()),
    }
}
