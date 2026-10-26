use world_protocol::{
    api::GrantPackage,
    authorization::{AccessMode, AuthorizationFailure},
    bindings::ImplementationRef,
    commit::CommittedRevision,
    ids::*,
    operation::{CancellationState, OperationReceipt, OperationResult},
    package::{InstalledRecord, PackageFailure, PackageManifest, RequestedAccess},
};

use super::{
    PackageError,
    inventory::{InstallContext, Inventory, encode},
    payload::digest,
};
use crate::{
    authorization, owner,
    store::{OutboxEvent, WorldSnapshot, WorldTransaction},
};

impl Inventory {
    pub(crate) async fn grant_package(
        &self,
        context: &InstallContext,
        command: &GrantPackage,
    ) -> Result<OperationReceipt, owner::Error> {
        let _mutation = self.mutation.lock().await;
        self.require_world(&context.accepted.world)?;
        let operation = context.accepted.operation_id.clone();
        let key = digest(operation.as_str().as_bytes());
        let input = digest(
            &serde_json::to_vec(command)
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
        );
        let batch = Self::commit_request(
            context,
            CommitId::try_new(format!("package-grant-{}", &key.as_str()[7..]))
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
            let world = tx.world().clone();
            let row = tx.query_opt("SELECT revision,phase,pending_removal,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 FOR UPDATE",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str()]).await?
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            if i64::try_from(command.expected_revision.0).ok() != Some(row.get::<_, i64>("revision"))
                || row.get::<_, String>("phase") != "installed" || row.get::<_, bool>("pending_removal") {
                return Err(PackageError::new(PackageFailure::InstallConflict).into());
            }
            let mut record: InstalledRecord = serde_json::from_value(row.get("body"))
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
            if record.world != world || record.install_id != command.install_id || record.revision != command.expected_revision {
                return Err(PackageError::new(PackageFailure::InstallConflict).into());
            }
            validate(&record.manifest, &command.grants)?;
            let row = tx.query_opt("SELECT revision FROM world_package_grant_head WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 FOR UPDATE",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str()]).await?
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            let previous: i64 = row.get("revision");
            let next = previous.checked_add(1).filter(|revision| *revision > 1)
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
            record.revision = Revision(command.expected_revision.0.checked_add(1).filter(|revision| *revision <= i64::MAX as u64)
                .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?);
            tx.execute("INSERT INTO world_package_grant_revision(tenant_id,world_id,install_id,revision,body) VALUES($1,$2,$3,$4,$5)",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str(), &next, &encode(&command.grants)?]).await?;
            let changed = tx.execute("UPDATE world_package_grant_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 AND revision=$5",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str(), &next, &previous]).await?;
            if changed != 1 { return Err(PackageError::new(PackageFailure::InstallConflict).into()); }
            tx.execute("UPDATE world_package_install SET revision=$4,body=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &command.install_id.as_str(), &(record.revision.0 as i64), &encode(&record)?]).await?;
            tx.record_revision(CommittedRevision { resource: ResourceRef::Package { id: command.install_id.clone() }, revision: record.revision })?;
            let receipt = owner::complete_operation(tx, &current.accepted,
                OperationResult::Package { install_id: command.install_id.clone(), revision: record.revision }, &at).await?;
            tx.emit(OutboxEvent { event_id: EventId::try_new(format!("package-grant-{}", &key.as_str()[7..])).expect("digest identifier"),
                aggregate_kind: "package_grant".into(), aggregate_id: command.install_id.to_string(), aggregate_revision: next as u64,
                event_kind: "world.package.grants_changed".into(), payload: encode(&(command.install_id, record.revision, Revision(next as u64)))?,
                causation_id: None, origin: "world.package".into() }).await?;
            Ok::<_, owner::Error>(receipt)
        })).await;
        self.settle_result(context, committed, None).await
    }
}

/// Current inventory narrowing only; actor/delegation/policy authority must still pass independently.
pub(crate) async fn read_package_grants(
    snapshot: &WorldSnapshot<'_>,
    implementation: &ImplementationRef,
) -> Result<Vec<RequestedAccess>, PackageError> {
    let row = snapshot.query_opt("SELECT i.phase,i.pending_removal,i.package_digest,i.body,p.manifest,h.revision,r.body AS grants FROM world_package_install i JOIN world_package p USING(tenant_id,world_id,package_digest) JOIN world_package_grant_head h USING(tenant_id,world_id,install_id) JOIN world_package_grant_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.install_id=h.install_id AND r.revision=h.revision WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.install_id=$3",
        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &implementation.install_id.as_str()]).await?
        .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
    decode(snapshot.world(), implementation, &row)
}

pub(crate) async fn require_grants_read(
    snapshot: &WorldSnapshot<'_>,
    implementation: &ImplementationRef,
    required: &[RequestedAccess],
) -> Result<(), PackageError> {
    require(
        &read_package_grants(snapshot, implementation).await?,
        required,
    )
}

/// Grant head is locked through the effect's existing transaction, excluding concurrent revocation.
pub(crate) async fn require_grants(
    tx: &WorldTransaction<'_>,
    implementation: &ImplementationRef,
    required: &[RequestedAccess],
) -> Result<(), PackageError> {
    require(
        &read_package_grants_in_transaction(tx, implementation).await?,
        required,
    )
}

pub(crate) async fn read_package_grants_in_transaction(
    tx: &WorldTransaction<'_>,
    implementation: &ImplementationRef,
) -> Result<Vec<RequestedAccess>, PackageError> {
    let row = tx.query_opt("SELECT i.phase,i.pending_removal,i.package_digest,i.body,p.manifest,h.revision,r.body AS grants FROM world_package_install i JOIN world_package p USING(tenant_id,world_id,package_digest) JOIN world_package_grant_head h USING(tenant_id,world_id,install_id) JOIN world_package_grant_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.install_id=h.install_id AND r.revision=h.revision WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.install_id=$3 FOR SHARE OF i,h",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &implementation.install_id.as_str()]).await?
        .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
    decode(tx.world(), implementation, &row)
}

fn decode(
    world: &WorldRef,
    implementation: &ImplementationRef,
    row: &tokio_postgres::Row,
) -> Result<Vec<RequestedAccess>, PackageError> {
    let record: InstalledRecord = serde_json::from_value(row.get("body"))
        .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
    let manifest: PackageManifest = serde_json::from_value(row.get("manifest"))
        .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
    if &record.world != world
        || record.install_id != implementation.install_id
        || record.manifest != manifest
        || row.get::<_, String>("phase") != "installed"
        || row.get::<_, bool>("pending_removal")
        || row.get::<_, String>("package_digest") != implementation.package_digest.as_str()
        || record.package_digest != implementation.package_digest
        || record.lock.digest != implementation.dependency_lock
        || row.get::<_, i64>("revision") <= 0
        || !manifest.artifacts.iter().any(|artifact| {
            artifact.id == implementation.artifact_id
                && artifact.digest == implementation.artifact_digest
                && artifact.entrypoint == implementation.entrypoint
        })
    {
        return Err(PackageError::new(PackageFailure::InstallConflict));
    }
    let grants: Vec<RequestedAccess> = serde_json::from_value(row.get("grants"))
        .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
    validate(&manifest, &grants)?;
    Ok(grants)
}

fn validate(manifest: &PackageManifest, grants: &[RequestedAccess]) -> Result<(), PackageError> {
    if grants.iter().enumerate().any(|(index, grant)| {
        grants[..index].contains(grant)
            || !manifest
                .requested_access
                .iter()
                .any(|request| covers(request, grant))
    }) {
        return Err(denied());
    }
    Ok(())
}

fn require(grants: &[RequestedAccess], required: &[RequestedAccess]) -> Result<(), PackageError> {
    if required
        .iter()
        .any(|request| !grants.iter().any(|grant| covers(grant, request)))
    {
        return Err(denied());
    }
    Ok(())
}

fn covers(grant: &RequestedAccess, request: &RequestedAccess) -> bool {
    match (grant, request) {
        (RequestedAccess::WorldRead { fields: allowed }, RequestedAccess::WorldRead { fields }) => {
            if fields.is_empty() {
                allowed.is_empty()
            } else {
                fields.iter().all(|field| allowed.contains(field))
            }
        }
        _ => grant == request,
    }
}
fn denied() -> PackageError {
    PackageError::new(PackageFailure::Authorization {
        failure: AuthorizationFailure::InsufficientScope,
    })
}
