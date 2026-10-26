use super::{Admission, AuthError};
use crate::store::{
    Committed, PreparedBatch, StoreFuture, TransactionError, WorldStore, WorldTransaction,
};
use serde::{Serialize, de::DeserializeOwned};
use std::sync::{Arc, Mutex};

pub(crate) enum AdmissionCommit<T> {
    Committed {
        outcome: Committed<T>,
        admission: Admission,
    },
    Replayed(Committed<T>),
}

/// Keeps an opaque admission out of serde and releases it only after the sole store
/// commit succeeds. The closure authenticates, resolves impact, admits, and records
/// its real operation in that same transaction. Replays never renew an old authority.
pub(crate) async fn commit_admission<T, E, F>(
    store: &WorldStore,
    batch: PreparedBatch,
    action: F,
) -> Result<AdmissionCommit<T>, TransactionError<E>>
where
    T: Serialize + DeserializeOwned + Send,
    E: From<crate::store::StoreError> + From<AuthError> + Send,
    F: for<'a> FnOnce(&'a mut WorldTransaction<'_>) -> StoreFuture<'a, (T, Admission), E>
        + Send
        + 'static,
{
    let handoff = Arc::new(Mutex::new(None));
    let produced = handoff.clone();
    let committed = store
        .transact(batch, move |tx| {
            Box::pin(async move {
                let (value, admission) = action(tx).await?;
                *produced.lock().expect("admission handoff poisoned") = Some(admission);
                Ok::<_, E>(value)
            })
        })
        .await?;
    if committed.replayed {
        return Ok(AdmissionCommit::Replayed(committed));
    }
    let admission = handoff
        .lock()
        .expect("admission handoff poisoned")
        .take()
        .expect("non-replayed store mutation produced admission");
    Ok(AdmissionCommit::Committed {
        outcome: committed,
        admission,
    })
}
