use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::InstallCommand,
    commit::CommittedRevision,
    ids::*,
    operation::{CancellationState, OperationReceipt, OperationResult},
    package::PackageFailure,
};

use super::{
    error::PackageError,
    install::now,
    inventory::{InstallContext, Inventory, encode},
    payload::{check_cancelled, digest},
};
use crate::{authorization, owner, store::OutboxEvent};

impl Inventory {
    /// Inventory removal is not disable, stop, revocation, state deletion, or physical GC.
    pub(crate) async fn uninstall(
        &self,
        context: &InstallContext,
        command: &InstallCommand,
        cancellation: &CancellationToken,
    ) -> Result<OperationReceipt, owner::Error> {
        let _mutation = self.mutation.lock().await;
        self.require_world(&context.accepted.world)?;
        check_cancelled(cancellation)?;
        let operation = context.accepted.operation_id.clone();
        let input = digest(
            &serde_json::to_vec(command)
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
        );
        let key = digest(operation.as_str().as_bytes());
        let commit = CommitId::try_new(format!("package-uninstall-{}", &key.as_str()[7..]))
            .expect("digest identifier");
        let batch = Self::commit_request(context, commit, input)?;
        let command = command.clone();
        let admission = context.admission.clone();
        let cancellation = cancellation.clone();
        let files = self.files.clone();
        let committed = self.store.transact(batch, move |tx| Box::pin(async move {
            let at = now(tx).await?;
            super::authority::require_access(tx, &admission, std::slice::from_ref(&command.install_id), world_protocol::authorization::AccessMode::Delete).await?;
            authorization::recheck(tx, &admission, &at).await?;
            let current = owner::read_operation(tx, &operation).await?;
            if current.cancellation != CancellationState::NotRequested || cancellation.is_cancelled() {
                return Err(PackageError::new(PackageFailure::Cancelled).into());
            }
            let mut record = super::install::require_install_record(tx, &command.install_id, command.expected_revision).await?;
            let world = tx.world().clone();
            let row = tx.query_opt(
                "SELECT desired_enabled,package_digest,install_lock FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str()],
            ).await?.ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            let package = record.package_digest.clone();
            if row.get::<_, String>("package_digest") != package.as_str() {
                return Err(PackageError::new(PackageFailure::InstallConflict).into());
            }
            if row.get::<_, bool>("desired_enabled") || files.is_live(&package) {
                return Err(PackageError::new(PackageFailure::RetainedReferences).into());
            }
            let gc = tx.query_opt("SELECT state FROM world_package_gc WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 FOR UPDATE",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str()]).await?;
            if gc.is_none_or(|row| row.get::<_, String>("state") != "live") {
                return Err(PackageError::new(PackageFailure::RetainedReferences).into());
            }
            let retained = tx.query_opt(
                "SELECT 1 FROM world_package_retention WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND released_at IS NULL AND NOT(owner_kind='install_lock' AND owner_id=$4) LIMIT 1",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str(), &command.install_id.as_str()],
            ).await?.is_some();
            let state = tx.query_opt("SELECT 1 FROM world_state_namespace WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 LIMIT 1",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str()]).await?.is_some();
            if retained || state { return Err(PackageError::new(PackageFailure::RetainedReferences).into()); }
            let revision = command.expected_revision.0.checked_add(1).filter(|value| *value <= i64::MAX as u64)
                .map(Revision).ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            record.revision = revision;
            let lock: world_protocol::package::InstallLock = serde_json::from_value(row.get("install_lock"))
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
            if lock != record.lock { return Err(PackageError::new(PackageFailure::InstallConflict).into()); }
            tx.execute("UPDATE world_package_install SET phase='uninstalled',revision=$4,body=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str(), &(revision.0 as i64), &encode(&record)?]).await?;
            let packages: Vec<_> = lock.packages.iter().map(|package| package.package_digest.clone()).collect();
            super::release_packages(tx, super::RetentionOwner::InstallLock(&command.install_id), Revision(2), &packages).await?;
            tx.record_revision(CommittedRevision { resource: ResourceRef::Package { id: command.install_id.clone() }, revision })?;
            let receipt = owner::complete_operation(tx, &current.accepted, OperationResult::Package { install_id: command.install_id.clone(), revision }, &at).await?;
            tx.emit(OutboxEvent { event_id: EventId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"), aggregate_kind: "package_install".into(), aggregate_id: command.install_id.to_string(), aggregate_revision: revision.0,
                event_kind: "world.package.uninstalled".into(), payload: encode(&(command.install_id, revision))?, causation_id: None, origin: "world.package".into() }).await?;
            Ok::<_, owner::Error>(receipt)
        })).await;
        self.settle_result(context, committed, None).await
    }
}
