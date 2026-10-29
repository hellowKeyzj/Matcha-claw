use serde::{Serialize, de::DeserializeOwned};
use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    commit::CommitFailure,
    failure::FailureStage,
    ids::WorldRef,
    package::PackageLimits,
    process::HostFailure,
    slots::{self, StorageReadRequest, StorageReadResult},
};

use super::{Committed, PreparedBatch, StoreError, StoreFuture, TransactionError, WorldTransaction};
use crate::{
    extensions::{
        invocation::{
            InvocationContext, NativePrepareFailure, NativeProof, check_current_in_transaction,
        },
        package::ArtifactLease,
    },
    owner::Error,
};

/// Trusted endpoint of the existing PostgreSQL authority; no connection or guest write surface.
pub(crate) struct PreparedStorage {
    proof: NativeProof,
}

impl PreparedStorage {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
    ) -> Result<Self, NativePrepareFailure> {
        let contract = slots::slot_contract(SlotKind::Storage)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) {
            return Err(NativePrepareFailure::Entrypoint);
        }
        Ok(Self {
            proof: NativeProof::prepare(
                node, config, artifact, slots::STORAGE_REGISTRATION, SlotKind::Storage,
            )?,
        })
    }

    pub fn implementation(&self) -> &ImplementationRef {
        self.proof.implementation()
    }
    pub fn config(&self) -> &PackageConfigView {
        self.proof.config()
    }
    pub fn limits(&self) -> &PackageLimits {
        self.proof.limits()
    }

    pub(crate) async fn read(
        &self,
        context: &InvocationContext,
        request: &StorageReadRequest,
    ) -> Result<StorageReadResult, Error> {
        self.require_context(context, &request.world)?;
        super::storage_read::read(context, request).await
    }

    /// Reservation/replay/unknown arbitration remains entirely in WorldStore::transact.
    /// The owner must await this through COMMIT, including cancellation and deadline expiry.
    pub(crate) async fn transact<T, E, F>(
        &self,
        context: InvocationContext,
        batch: PreparedBatch,
        mutation: F,
    ) -> Result<Committed<T>, TransactionError<E>>
    where
        T: Serialize + DeserializeOwned + Send,
        E: From<StoreError> + From<Error> + Send,
        F: for<'a> FnOnce(&'a mut WorldTransaction<'_>) -> StoreFuture<'a, T, E> + Send + 'static,
    {
        let current = async {
            self.require_context(&context, &batch.request.world)?;
            context.check_current().await.map_err(|cause| Error::from_host_failure(
                cause.host_failure(), FailureStage::Admission,
            ).caused(cause))
        }.await;
        if let Err(cause) = current {
            // A rejected call has not arbitrated the original receipt and cannot prove rollback.
            return Err(TransactionError::Indeterminate(StoreError::caused_by(
                CommitFailure::CommitIndeterminate { commit_id: batch.request.commit_id.clone() },
                FailureStage::Admission, cause,
            )));
        }
        let store = context.store().clone();
        store.transact(batch, move |tx| Box::pin(async move {
            check_call(&context).map_err(E::from)?;
            check_current_in_transaction(tx, context.admission(), context.lease(), context.node())
                .await
                .map_err(|cause| E::from(Error::from_host_failure(
                    cause.host_failure(), FailureStage::Commit,
                ).caused(cause)))?;
            mutation(tx).await
        })).await
    }

    fn require_context(&self, context: &InvocationContext, world: &WorldRef) -> Result<(), Error> {
        let selected = context.lease().graph().node(context.node());
        if world != &context.admission().invocation().world
            || context.lease().invocation() != &context.admission().invocation().id
            || &context.lease().graph().lock().world != world
            || context.lease().ledger(context.node()).is_none()
            || selected.map_or(true, |node| node.slot != SlotKind::Storage
                || &node.implementation != self.implementation())
            || context.lease().storage(context.node())
                .is_none_or(|endpoint| !std::ptr::eq(endpoint.as_ref(), self))
        {
            return Err(Error::from_host_failure(HostFailure::Authorization(
                world_protocol::authorization::AuthorizationFailure::InsufficientScope,
            ), FailureStage::Admission));
        }
        Ok(())
    }
}

pub(super) fn check_call(context: &InvocationContext) -> Result<(), Error> {
    if context.lease().cancellation(context.node()).is_none_or(|cancel| cancel.is_cancelled()) {
        return Err(Error::from_host_failure(HostFailure::Cancelled, FailureStage::Read));
    }
    context.budget().check().map_err(|failure| Error::from_host_failure(
        HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Read,
    ))
}
