use super::{
    Error, accounting, records,
    run::{self, EvaluationRun},
};
use crate::{
    authorization::Admission,
    content::{Content, ContentOwner, ContentReference, PinKind, pin, release_pin},
    store::{
        CommitRequest, Committed, StoreFuture, TransactionError, WorldStore, WorldTransaction,
    },
};
use serde::{Serialize, de::DeserializeOwned};
use world_protocol::{
    ids::{CommitId, ContentId},
    materials::BlobRef,
};

pub(super) fn transact<'a, T, F>(
    store: &'a WorldStore,
    template: &'a CommitRequest,
    stage: &'a str,
    input: &'a (impl Serialize + Sync),
    work: F,
) -> StoreFuture<'a, Committed<T>, Error>
where
    T: Serialize + DeserializeOwned + Send + 'a,
    F: for<'tx> FnOnce(&'tx mut WorldTransaction<'_>) -> StoreFuture<'tx, T, Error> + Send + 'a,
{
    Box::pin(async move {
        let identity = records::digest(&(template.world.clone(), &template.commit_id, stage))?;
        let mut request = template.clone();
        request.commit_id = CommitId::try_new(format!("eval-{}", &identity.as_str()[7..]))
            .expect("bounded digest identifier");
        request.input_digest = records::digest(&(stage, input))?;
        let id = request.commit_id.clone();
        let digest = request.input_digest.clone();
        match store.transact(request.prepare()?, work).await {
            Ok(committed) => Ok(committed),
            Err(TransactionError::NotCommitted { error, cleanup }) => Err(match cleanup {
                Some(cleanup) => Error::Rollback {
                    error: Box::new(error),
                    cleanup,
                },
                None => error,
            }),
            // Only read the original identity. Never replay execution or change commit ID.
            Err(TransactionError::Indeterminate(_)) => store
                .read_commit(&template.world, &id, &digest)
                .await
                .map_err(Error::from),
        }
    })
}

pub(super) async fn read_blob(
    store: &WorldStore,
    content: &Content,
    template: &CommitRequest,
    admission: &Admission,
    state: &EvaluationRun,
    blob: &BlobRef,
    owner: ContentOwner,
    stage: &str,
) -> Result<Vec<u8>, Error> {
    let reference = ContentReference::new(owner, blob.clone())?;
    let pin_id = ContentId::try_new(format!(
        "read-{}",
        &records::digest(&(
            &state.request.id,
            &admission.invocation().id,
            stage,
            &reference
        ))?
        .as_str()[7..]
    ))
    .expect("bounded digest identifier");
    let auth = admission.clone();
    let current = state.clone();
    let reference_for_pin = reference.clone();
    let pin = transact(
        store,
        template,
        &format!("{stage}.pin"),
        &reference,
        move |tx| {
            Box::pin(async move {
                let task = records::task(
                    tx,
                    &current.request.suite.task_id,
                    current.request.suite.task_revision,
                )
                .await?;
                run::authorize(tx, &auth, &task, &current, &accounting::now()).await?;
                Ok(pin(tx, &reference_for_pin, pin_id, PinKind::Read).await?)
            })
        },
    )
    .await?;
    let bytes = content.read_pinned(store, &pin).await;
    let live_pin = pin.value.clone();
    let released = transact(
        store,
        template,
        &format!("{stage}.release"),
        &reference,
        move |tx| {
            Box::pin(async move {
                release_pin(tx, &live_pin).await?;
                Ok(())
            })
        },
    )
    .await;
    match (bytes, released) {
        (Ok(bytes), Ok(_)) => Ok(bytes),
        (Err(error), Ok(_)) => Err(error.into()),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(Error::Owner(
            crate::owner::Error::from(error).with_related(cleanup.into()),
        )),
    }
}
