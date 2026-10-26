use serde::{Deserialize, Serialize};
use world_protocol::{
    api::{ApiFailure, InstallCommand, WorldCommand},
    authorization::AccessMode,
    commit::{CommitReceipt, CommittedRevision},
    failure::{FailureStage, Recovery},
    ids::*,
    lifecycle::{LifecycleFailure, LifecycleStage, RetainedResource},
    operation::{
        CancellationState, OperationAccepted, OperationFailure, OperationPhase, OperationReceipt,
        OperationResult,
    },
};

use super::{
    PackageError,
    inventory::{InstallContext, Inventory, encode},
    payload::digest,
};
use crate::{
    authorization,
    extensions::lifecycle::{AcceptedClosing, ClosingInstall, DrainedInstall, LiveExtensions},
    owner,
    store::{Committed, OutboxEvent, TransactionError, WorldTransaction},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesiredIntent {
    install: InstallId,
    revision: Revision,
    operation: OperationReceipt,
}

/// Only the package transaction's observed receipt can change live admission.
pub(crate) struct CommittedEnable {
    committed: Committed<DesiredIntent>,
}
pub(crate) struct CommittedDisable {
    committed: Committed<DesiredIntent>,
}

impl CommittedEnable {
    pub fn world(&self) -> &WorldRef {
        &self.committed.receipt.world
    }
    pub fn install(&self) -> &InstallId {
        &self.committed.value.install
    }
    pub fn commit_id(&self) -> &CommitId {
        &self.committed.receipt.commit_id
    }
    pub fn revision(&self) -> Revision {
        self.committed.value.revision
    }
    pub fn operation(&self) -> &OperationAccepted {
        &self.committed.value.operation.accepted
    }
    pub(crate) fn into_receipt(self) -> OperationReceipt {
        let mut receipt = self.committed.value.operation;
        receipt.commit = Some(self.committed.receipt);
        receipt
    }
}
impl CommittedDisable {
    pub fn world(&self) -> &WorldRef {
        &self.committed.receipt.world
    }
    pub fn install(&self) -> &InstallId {
        &self.committed.value.install
    }
    pub fn commit_id(&self) -> &CommitId {
        &self.committed.receipt.commit_id
    }
    pub fn revision(&self) -> Revision {
        self.committed.value.revision
    }
    pub fn operation(&self) -> &OperationAccepted {
        &self.committed.value.operation.accepted
    }
}

/// Rechecks the original durable disable intent before the fixed accepted-work checkpoint.
pub(crate) async fn check_accepted_disable(
    tx: &WorldTransaction<'_>,
    closing: &AcceptedClosing,
) -> Result<(), PackageError> {
    let invalid = || PackageError::new(PackageFailure::InstallConflict);
    let install = closing.install().ok_or_else(invalid)?;
    let revision = closing.revision().ok_or_else(invalid)?;
    if closing.world() != tx.world()
        || closing.operation().world != *tx.world()
        || closing.world_intent().is_some()
    {
        return Err(invalid());
    }
    let operation = owner::read_operation_record(tx, &closing.operation().operation_id)
        .await
        .map_err(|cause| PackageError::caused(PackageFailure::InstallConflict, cause))?;
    let WorldCommand::DisablePackage(command) = operation
        .input
        .command()
        .map_err(|cause| PackageError::caused(PackageFailure::InstallConflict, cause))?
    else {
        return Err(invalid());
    };
    if command.install_id != *install
        || command.expected_revision.0.checked_add(1) != Some(revision.0)
        || operation.receipt.accepted.incarnation != closing.operation().incarnation
    {
        return Err(invalid());
    }
    let key = digest(closing.operation().operation_id.as_str().as_bytes());
    let commit = CommitId::try_new(format!("package-enabled-{}", &key.as_str()[7..]))
        .expect("digest identifier");
    if closing.commit_id() != &commit {
        return Err(invalid());
    }
    let input = digest(
        &serde_json::to_vec(&(command, false))
            .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
    );
    let row = tx.query_opt(
        "SELECT input_digest,receipt,result FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &commit.as_str()],
    ).await?.ok_or_else(invalid)?;
    let receipt: CommitReceipt = serde_json::from_value(
        row.get::<_, Option<serde_json::Value>>("receipt")
            .ok_or_else(invalid)?,
    )
    .map_err(|cause| PackageError::caused(PackageFailure::InstallConflict, cause))?;
    let intent: DesiredIntent = serde_json::from_value(
        row.get::<_, Option<serde_json::Value>>("result")
            .ok_or_else(invalid)?,
    )
    .map_err(|cause| PackageError::caused(PackageFailure::InstallConflict, cause))?;
    if row.get::<_, String>("input_digest") != input.as_str()
        || receipt.world != *tx.world()
        || receipt.commit_id != commit
        || receipt.fence.world != *tx.world()
        || !receipt.revisions.contains(&CommittedRevision {
            resource: ResourceRef::Package {
                id: install.clone(),
            },
            revision,
        })
        || intent.install != *install
        || intent.revision != revision
        || intent.operation.accepted != *closing.operation()
        || intent.operation.phase != OperationPhase::Draining
    {
        return Err(invalid());
    }
    let row = tx.query_opt(
        "SELECT revision,desired_enabled,phase,pending_removal FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 FOR SHARE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &install.as_str()],
    ).await?.ok_or_else(invalid)?;
    check_desired_row(&row, revision, false)
}

fn check_desired_row(
    row: &tokio_postgres::Row,
    revision: Revision,
    enabled: bool,
) -> Result<(), PackageError> {
    if i64::try_from(revision.0).ok() != Some(row.get("revision"))
        || row.get::<_, bool>("desired_enabled") != enabled
        || row.get::<_, String>("phase") != "installed"
        || row.get::<_, bool>("pending_removal")
    {
        return Err(PackageError::new(PackageFailure::InstallConflict));
    }
    Ok(())
}

impl Inventory {
    /// Enables future preparation only; never reopens a cancelled generation or activates a graph.
    pub(crate) async fn enable(
        &self,
        context: &InstallContext,
        command: &InstallCommand,
        live: &LiveExtensions,
    ) -> Result<CommittedEnable, owner::Error> {
        let _mutation = self.mutation.lock().await;
        let committed = self.set_desired(context, command, true).await?;
        self.check_desired(context, &committed, true).await?;
        let proof = CommittedEnable { committed };
        live.enable_install(&proof)?;
        Ok(proof)
    }

    /// Durable desired=false fences new admission before any live cancellation.
    pub(crate) async fn begin_disable(
        &self,
        context: &InstallContext,
        command: &InstallCommand,
        live: &LiveExtensions,
    ) -> Result<(CommittedDisable, ClosingInstall), owner::Error> {
        let _mutation = self.mutation.lock().await;
        let committed = self.set_desired(context, command, false).await?;
        self.check_desired(context, &committed, false).await?;
        let proof = CommittedDisable { committed };
        let closing = live.close_install(&proof)?;
        Ok((proof, closing))
    }

    async fn set_desired(
        &self,
        context: &InstallContext,
        command: &InstallCommand,
        enabled: bool,
    ) -> Result<Committed<DesiredIntent>, owner::Error> {
        self.require_world(&context.accepted.world)?;
        let operation = context.accepted.operation_id.clone();
        let key = digest(operation.as_str().as_bytes());
        let input = digest(
            &serde_json::to_vec(&(command, enabled))
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
        );
        let batch = Self::commit_request(
            context,
            CommitId::try_new(format!("package-enabled-{}", &key.as_str()[7..]))
                .expect("digest identifier"),
            input,
        )?;
        let command = command.clone();
        let admission = context.admission.clone();
        let committed = self.store.transact(batch, move |tx| Box::pin(async move {
            let at = tx.now().await?;
            super::authority::require_access(tx, &admission, std::slice::from_ref(&command.install_id), AccessMode::Manage).await?;
            authorization::recheck(tx, &admission, &at).await?;
            let current = owner::read_operation(tx, &operation).await?;
            if current.cancellation != CancellationState::NotRequested {
                return Err(PackageError::new(PackageFailure::Cancelled).into());
            }
            let record = super::install::require_install_record(tx, &command.install_id, command.expected_revision).await?;
            if enabled {
                let trust = tx.query_opt("SELECT trusted,quarantined FROM world_extension_trust WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 FOR SHARE",
                    &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.package_digest.as_str()]).await?;
                if !trust.is_some_and(|row| row.get::<_, bool>("trusted") && !row.get::<_, bool>("quarantined")) {
                    return Err(PackageError::new(PackageFailure::PublisherUntrusted).into());
                }
            }
            let mut record = record;
            record.revision = Revision(command.expected_revision.0.checked_add(1)
                .filter(|value| *value <= i64::MAX as u64).ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?);
            tx.execute("UPDATE world_package_install SET desired_enabled=$4,revision=$5,body=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.install_id.as_str(), &enabled, &(record.revision.0 as i64), &encode(&record)?]).await?;
            tx.record_revision(CommittedRevision { resource: ResourceRef::Package { id: record.install_id.clone() }, revision: record.revision })?;
            let receipt = if enabled {
                owner::complete_operation(tx, &current.accepted, OperationResult::Package { install_id: record.install_id.clone(), revision: record.revision }, &at).await?
            } else {
                let mut progress = current.progress;
                progress.stage = FailureStage::Drain;
                owner::update_operation(tx, &current.accepted, owner::OperationUpdate {
                    phase: OperationPhase::Draining, progress, failure: None, effects: Vec::new(),
                }, &at).await?
            };
            tx.emit(OutboxEvent { event_id: EventId::try_new(format!("package-enabled-{}", &key.as_str()[7..])).expect("digest identifier"),
                aggregate_kind: "package_install".into(), aggregate_id: record.install_id.to_string(), aggregate_revision: record.revision.0,
                event_kind: if enabled { "world.package.enabled" } else { "world.package.disabling" }.into(),
                payload: encode(&(&record.install_id, record.revision, enabled))?, causation_id: None, origin: "world.package".into() }).await?;
            Ok::<_, owner::Error>(DesiredIntent { install: record.install_id, revision: record.revision, operation: receipt })
        })).await;
        match committed {
            Ok(committed) => Ok(committed),
            Err(error @ TransactionError::NotCommitted { .. }) => {
                self.settle_rejected(context, error.into(), None).await?;
                Err(owner::Error::internal(FailureStage::Commit))
            }
            Err(TransactionError::Indeterminate(error)) => Err(error.into()),
        }
    }

    async fn check_desired(
        &self,
        context: &InstallContext,
        committed: &Committed<DesiredIntent>,
        enabled: bool,
    ) -> Result<(), owner::Error> {
        if committed.receipt.world != context.accepted.world
            || committed.value.operation.accepted.world != context.accepted.world
            || committed.value.operation.accepted.operation_id != context.accepted.operation_id
            || committed.value.operation.accepted.incarnation != context.accepted.incarnation
        {
            return Err(PackageError::new(PackageFailure::InstallConflict).into());
        }
        let install = committed.value.install.clone();
        let revision = committed.value.revision;
        let admission = context.admission.clone();
        self.store.snapshot(context.accepted.world.clone(), move |snapshot| Box::pin(async move {
            let at = snapshot.now().await?;
            authorization::recheck_read(snapshot, &admission, &at).await?;
            let row = snapshot.query_opt("SELECT revision,desired_enabled,phase,pending_removal FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
                &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &install.as_str()]).await?
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            check_desired_row(&row, revision, enabled)?;
            Ok::<_, owner::Error>(())
        })).await
    }

    pub(crate) async fn finish_disable(
        &self,
        context: &InstallContext,
        proof: &CommittedDisable,
        live: &LiveExtensions,
        drained: &DrainedInstall,
    ) -> Result<OperationReceipt, owner::Error> {
        let _mutation = self.mutation.lock().await;
        if !live.validate_install_drained(drained)
            || drained.world() != proof.world()
            || drained.install() != proof.install()
            || drained.commit_id() != proof.commit_id()
            || drained.revision() != proof.revision()
        {
            return Err(PackageError::new(PackageFailure::InstallConflict).into());
        }
        let settlement = if drained.process_failures().is_empty() {
            None
        } else {
            Some(owner::DrainedDisableSettlement::new(live, proof, drained)?)
        };
        self.settle_disable(context, proof, None, true, settlement)
            .await
    }

    pub(crate) async fn retain_disable(
        &self,
        context: &InstallContext,
        proof: &CommittedDisable,
        remaining_resources: Vec<RetainedResource>,
    ) -> Result<OperationReceipt, owner::Error> {
        let _mutation = self.mutation.lock().await;
        let error = owner::Error::new(
            "world.package_disable_retained",
            FailureStage::Drain,
            "插件资源尚未排空，禁用意图与资源托管仍保留。",
            ApiFailure::Operation(OperationFailure::Lifecycle(LifecycleFailure::Retained {
                stage: LifecycleStage::Join,
                remaining_resources,
            })),
            Recovery::ManualReview,
        );
        self.settle_disable(context, proof, Some(&error), false, None)
            .await
    }

    async fn settle_disable(
        &self,
        context: &InstallContext,
        proof: &CommittedDisable,
        error: Option<&owner::Error>,
        drained: bool,
        settlement: Option<owner::DrainedDisableSettlement>,
    ) -> Result<OperationReceipt, owner::Error> {
        self.require_world(proof.world())?;
        if proof.operation().operation_id != context.accepted.operation_id
            || proof.operation().incarnation != context.accepted.incarnation
            || proof.world() != &context.accepted.world
        {
            return Err(PackageError::new(PackageFailure::InstallConflict).into());
        }
        let install = proof.install().clone();
        let revision = proof.revision();
        let operation = proof.operation().operation_id.clone();
        let key = digest(operation.as_str().as_bytes());
        let failure = error
            .map(|error| {
                let mut failure = error.operation_failure().ok_or_else(|| error.clone())?;
                failure.stage = FailureStage::Drain;
                failure.operation_id = Some(operation.clone());
                Ok::<_, owner::Error>(failure)
            })
            .transpose()?;
        // A retained checkpoint is revision-keyed; the final drain always keeps its original stable identity.
        let suffix = if drained {
            "drained".to_owned()
        } else {
            format!("retained-{}", context.accepted.revision.0)
        };
        let input = digest(
            &serde_json::to_vec(&(proof.commit_id(), &install, revision, drained))
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
        );
        let batch = Self::commit_request(
            context,
            CommitId::try_new(format!("package-disable-{suffix}-{}", &key.as_str()[7..]))
                .expect("digest identifier"),
            input,
        )?;
        let admission = context.admission.clone();
        let committed = self.store.transact(batch, move |tx| Box::pin(async move {
            let at = tx.now().await?;
            super::authority::require_access(tx, &admission, std::slice::from_ref(&install), AccessMode::Manage).await?;
            authorization::recheck(tx, &admission, &at).await?;
            super::require_install_revision(tx, &install, revision).await?;
            let row = tx.query_opt("SELECT desired_enabled FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &install.as_str()]).await?
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            if row.get::<_, bool>("desired_enabled") { return Err(PackageError::new(PackageFailure::InstallConflict).into()); }
            let current = owner::read_operation(tx, &operation).await?;
            if super::operation::terminal(current.phase) { return Ok(current); }
            let receipt = if drained {
                if let Some(settlement) = settlement {
                    owner::fail_drained_disable(tx, &current.accepted, &settlement, &at).await?
                } else {
                    owner::complete_operation(tx, &current.accepted, OperationResult::Package { install_id: install.clone(), revision }, &at).await?
                }
            } else {
                let mut progress = current.progress;
                progress.stage = FailureStage::Drain;
                owner::update_operation(tx, &current.accepted, owner::OperationUpdate {
                    phase: OperationPhase::Retained, progress, failure, effects: Vec::new(),
                }, &at).await?
            };
            tx.emit(OutboxEvent { event_id: EventId::try_new(format!("package-disable-{suffix}-{}", &key.as_str()[7..])).expect("digest identifier"),
                aggregate_kind: "package_install".into(), aggregate_id: install.to_string(), aggregate_revision: revision.0,
                event_kind: if drained { "world.package.disabled" } else { "world.package.disable_retained" }.into(),
                payload: encode(&(&install, revision, receipt.phase))?, causation_id: None, origin: "world.package".into() }).await?;
            Ok::<_, owner::Error>(receipt)
        })).await.map_err(owner::Error::from)?;
        let mut receipt = committed.value;
        receipt.commit = Some(committed.receipt);
        Ok(receipt)
    }
}

use world_protocol::package::PackageFailure;
