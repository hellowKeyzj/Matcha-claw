use world_protocol::{
    authorization::{AccessMode, AccessScope, AuthorizationFailure},
    ids::*,
    operation::{CancellationState, OperationReceipt, OperationResult},
    package::{PackageFailure, TrustEvidence},
};

use super::{
    error::PackageError,
    install::now,
    inventory::{InstallContext, Inventory, encode},
    payload::digest,
};
use crate::{
    authorization::{self, Admission},
    owner,
    store::{OutboxEvent, WorldTransaction},
};

/// Only the trusted composition passes policy evidence; requested_access never enters this reducer.
pub(crate) struct TrustChange {
    pub package: Digest,
    pub expected_revision: Revision,
    pub trusted: bool,
    pub quarantined: bool,
    pub evidence: TrustEvidence,
}

impl Inventory {
    pub(crate) async fn change_trust(
        &self,
        context: &InstallContext,
        change: TrustChange,
    ) -> Result<OperationReceipt, owner::Error> {
        let _mutation = self.mutation.lock().await;
        self.require_world(&context.accepted.world)?;
        if change.evidence.package_digest != change.package
            || change.evidence.policy_revision.0 == 0
        {
            return Err(PackageError::new(PackageFailure::PublisherUntrusted).into());
        }
        let operation = context.accepted.operation_id.clone();
        let input = digest(
            &serde_json::to_vec(&(
                &change.package,
                change.expected_revision,
                change.trusted,
                change.quarantined,
                &change.evidence,
            ))
            .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
        );
        let key = digest(operation.as_str().as_bytes());
        let commit = CommitId::try_new(format!("package-trust-{}", &key.as_str()[7..]))
            .expect("digest identifier");
        let batch = Self::commit_request(context, commit, input)?;
        let admission = context.admission.clone();
        let committed = self.store.transact(batch, move |tx| Box::pin(async move {
            let at = now(tx).await?;
            let installs = package_installs(tx, &change.package).await?;
            require_access(tx, &admission, &installs, AccessMode::Manage).await?;
            authorization::recheck(tx, &admission, &at).await?;
            let current = owner::read_operation(tx, &operation).await?;
            if current.cancellation != CancellationState::NotRequested {
                return Err(PackageError::new(PackageFailure::Cancelled).into());
            }
            let world = tx.world().clone();
            let row = tx.query_opt("SELECT revision FROM world_extension_trust WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 FOR UPDATE",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &change.package.as_str()]).await?
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            if row.get::<_, i64>("revision") as u64 != change.expected_revision.0 {
                return Err(PackageError::new(PackageFailure::InstallConflict).into());
            }
            let revision = change.expected_revision.0.checked_add(1).filter(|value| *value <= i64::MAX as u64)
                .map(Revision).ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            tx.execute("UPDATE world_extension_trust SET revision=$4,trusted=$5,quarantined=$6,policy_revision=$7,body=$8 WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &change.package.as_str(), &(revision.0 as i64), &change.trusted, &change.quarantined, &(change.evidence.policy_revision.0 as i64), &encode(&change.evidence)?]).await?;
            let receipt = owner::complete_operation(tx, &current.accepted, OperationResult::PackageTrust { package_digest: change.package.clone(), revision }, &at).await?;
            tx.emit(OutboxEvent { event_id: EventId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"), aggregate_kind: "package_trust".into(), aggregate_id: change.package.to_string(), aggregate_revision: revision.0,
                event_kind: "world.package.trust_changed".into(), payload: encode(&(&change.package, revision, change.trusted, change.quarantined))?, causation_id: None, origin: "world.package".into() }).await?;
            Ok::<_, owner::Error>(receipt)
        })).await;
        self.settle_result(context, committed, None).await
    }
}

pub(super) async fn package_installs(
    tx: &WorldTransaction<'_>,
    package: &Digest,
) -> Result<Vec<InstallId>, owner::Error> {
    let world = tx.world();
    tx.query("SELECT install_id FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 ORDER BY install_id FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str()]).await?.into_iter()
        .map(|row| InstallId::try_new(row.get::<_, String>("install_id")).map_err(|_| PackageError::new(PackageFailure::InternalFault).into())).collect()
}

pub(super) async fn require_access(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    installs: &[InstallId],
    mode: AccessMode,
) -> Result<(), owner::Error> {
    if &admission.invocation().world != tx.world() {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let world = tx.world();
    let row = tx.query_opt("SELECT management_scope_id,status FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?
        .ok_or(AuthorizationFailure::InsufficientScope)?;
    if row.get::<_, String>("status") != "ready" {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let scope = ScopeId::try_new(row.get::<_, String>("management_scope_id"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: installs
                .iter()
                .cloned()
                .map(|id| ResourceRef::Package { id })
                .collect(),
            fields: Vec::new(),
            modes: vec![mode],
            scope,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    Ok(())
}
