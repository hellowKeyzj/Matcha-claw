use world_protocol::{
    ids::*,
    operation::{OperationFailure, OperationPhase, OperationReceipt},
};

use super::{
    inventory::{InstallContext, Inventory, encode},
    payload::digest,
};
use crate::{
    owner,
    store::{Committed, TransactionError},
};

impl Inventory {
    pub(super) async fn settle_result(
        &self,
        context: &InstallContext,
        outcome: Result<Committed<OperationReceipt>, TransactionError<owner::Error>>,
        install: Option<&InstallId>,
    ) -> Result<OperationReceipt, owner::Error> {
        match outcome {
            Ok(committed) => {
                let mut receipt = committed.value;
                receipt.commit = Some(committed.receipt);
                Ok(receipt)
            }
            Err(error @ TransactionError::NotCommitted { .. }) => {
                self.settle_rejected(context, error.into(), install).await
            }
            Err(TransactionError::Indeterminate(error)) => Err(error.into()),
        }
    }

    /// Only a proven non-commit may reach this reducer. Unknown identities are never failed or retried.
    pub(super) async fn settle_rejected(
        &self,
        context: &InstallContext,
        error: owner::Error,
        install: Option<&InstallId>,
    ) -> Result<OperationReceipt, owner::Error> {
        if error.unresolved_phase().is_some() {
            return Err(error);
        }
        let Some(mut failure) = error.operation_failure() else {
            return Err(error);
        };
        failure.operation_id = Some(context.accepted.operation_id.clone());
        let cancelled = matches!(
            failure.details,
            OperationFailure::Cancelled
                | OperationFailure::Package(world_protocol::package::PackageFailure::Cancelled)
        );
        let key = digest(context.accepted.operation_id.as_str().as_bytes());
        let batch = match Self::commit_request(
            context,
            CommitId::try_new(format!("package-rejected-{}", &key.as_str()[7..]))
                .expect("digest identifier"),
            context.admission.invocation().request_digest.clone(),
        ) {
            Ok(batch) => batch,
            Err(settlement) => return Err(error.with_related(settlement.into())),
        };
        let operation = context.accepted.operation_id.clone();
        let install = install.cloned();
        let settlement = self.store.transact(batch, move |tx| Box::pin(async move {
            let at = tx.now().await?;
            let current = owner::read_operation(tx, &operation).await?;
            if terminal(current.phase) { return Ok(current); }
            let receipt = owner::fail_operation(tx, &current.accepted, failure.clone(), cancelled, &at).await?;
            if let Some(install) = install {
                let phase = match receipt.phase { OperationPhase::CancelledBeforeCommit => "cancelled", OperationPhase::Failed => "failed", _ => "retained" };
                tx.execute("UPDATE world_package_install SET phase=$4,revision=revision+1,failure=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 AND phase='admitted'",
                    &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &install.as_str(), &phase, &encode(&failure)?]).await?;
            }
            Ok::<_, owner::Error>(receipt)
        })).await;
        match settlement {
            Ok(_) => Err(error),
            Err(settlement @ TransactionError::NotCommitted { .. }) => {
                Err(error.with_related(settlement.into()))
            }
            Err(TransactionError::Indeterminate(settlement)) => {
                Err(owner::Error::from(settlement).with_related(error))
            }
        }
    }
}

pub(super) fn terminal(phase: OperationPhase) -> bool {
    matches!(
        phase,
        OperationPhase::Completed
            | OperationPhase::Failed
            | OperationPhase::CancelledBeforeCommit
            | OperationPhase::CancelledAfterCommit
    )
}
