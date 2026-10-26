use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::*,
    operation::{CancellationState, OperationPhase, OperationReceipt, OperationResult},
    package::{InstalledRecord, PackageFailure},
    time::Timestamp,
};

use super::{
    error::PackageError,
    inventory::{InstallContext, Inventory, encode},
    payload::{VerifiedPayload, digest},
};
use crate::{
    authorization, owner,
    store::{OutboxEvent, WorldTransaction},
};

impl Inventory {
    pub(crate) async fn install(
        &self,
        context: &InstallContext,
        request: &world_protocol::api::InstallPackage,
        bytes: &[u8],
        cancellation: &CancellationToken,
    ) -> Result<OperationReceipt, owner::Error> {
        self.install_inner(context, request, bytes, None, cancellation)
            .await
    }

    pub(crate) async fn upgrade(
        &self,
        context: &InstallContext,
        command: &world_protocol::api::UpgradePackage,
        bytes: &[u8],
        cancellation: &CancellationToken,
    ) -> Result<OperationReceipt, owner::Error> {
        let request = upgrade_request(&context.accepted.world, command)?;
        let source = world_protocol::api::InstallCommand {
            install_id: command.install_id.clone(),
            expected_revision: command.expected_revision,
        };
        self.install_inner(context, &request, bytes, Some(source), cancellation)
            .await
    }

    async fn install_inner(
        &self,
        context: &InstallContext,
        request: &world_protocol::api::InstallPackage,
        bytes: &[u8],
        source: Option<world_protocol::api::InstallCommand>,
        cancellation: &CancellationToken,
    ) -> Result<OperationReceipt, owner::Error> {
        let _mutation = self.mutation.lock().await;
        let world = &context.accepted.world;
        self.require_world(world)?;
        if &context.admission.invocation().world != world || &context.accepted.world != world {
            return Err(PackageError::new(PackageFailure::InstallConflict).into());
        }
        let input = digest(bytes);
        if input != request.package.digest || bytes.len() as u64 != request.package.byte_size {
            return self
                .settle_rejected(
                    context,
                    PackageError::new(PackageFailure::DigestMismatch {
                        path: "package".into(),
                    })
                    .into(),
                    None,
                )
                .await;
        }
        let key = digest(
            &serde_json::to_vec(&(world, &request.request_key))
                .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
        );
        let suffix = key.as_str()[7..].to_owned();
        let install = InstallId::try_new(format!("install-{suffix}")).expect("bounded identifier");
        let admission = context.admission.clone();
        let expected = context.accepted.clone();
        let install_id = install.clone();
        let request_id = request.request_key.clone();
        let input_digest = input.clone();
        let source_guard = source.clone();
        // The operation/request pair retains one admission commit identity through recovery.
        let batch = Self::commit_request(context, commit_id("admit", &suffix), input.clone())?;
        let admitted = self.store.transact(batch, move |tx| Box::pin(async move {
            let at = now(tx).await?;
            super::authority::require_access(tx, &admission, std::slice::from_ref(&install_id), world_protocol::authorization::AccessMode::Manage).await?;
            authorization::recheck(tx, &admission, &at).await?;
            if let Some(source) = &source_guard {
                super::authority::require_access(tx, &admission, std::slice::from_ref(&source.install_id), world_protocol::authorization::AccessMode::Manage).await?;
                require_install_revision(tx, &source.install_id, source.expected_revision).await?;
            }
            let receipt = owner::read_operation(tx, &expected.operation_id).await?;
            if receipt.accepted.world != expected.world || receipt.accepted.incarnation != expected.incarnation {
                return Err(PackageError::new(PackageFailure::InstallConflict).into());
            }
            if let Some(row) = tx.query_opt(
                "SELECT input_digest,operation_id FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND request_id=$3 FOR UPDATE",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &request_id.as_str()],
            ).await? {
                if row.get::<_, String>("input_digest") != input_digest.as_str()
                    || row.get::<_, String>("operation_id") != expected.operation_id.as_str() {
                    return Err(PackageError::new(PackageFailure::InstallConflict).into());
                }
            } else {
                tx.execute("INSERT INTO world_package_install(tenant_id,world_id,install_id,request_id,input_digest,operation_id,revision,phase,desired_enabled,body) VALUES($1,$2,$3,$4,$5,$6,1,'admitted',false,'null'::jsonb)",
                    &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &install_id.as_str(), &request_id.as_str(), &input_digest.as_str(), &expected.operation_id.as_str()]).await?;
            }
            Ok::<_, owner::Error>(receipt)
        })).await;
        self.settle_result(context, admitted, Some(&install))
            .await?;
        let operation = context.accepted.operation_id.clone();
        let admitted = self
            .store
            .snapshot(world.clone(), move |snapshot| {
                Box::pin(async move { owner::read_operation_snapshot(snapshot, &operation).await })
            })
            .await?;
        if admitted.accepted.incarnation != context.accepted.incarnation {
            return self
                .settle_rejected(
                    context,
                    PackageError::new(PackageFailure::InstallConflict).into(),
                    Some(&install),
                )
                .await;
        }
        if terminal(admitted.phase) {
            return Ok(admitted);
        }
        let policy = match self.trust_policy(world).await {
            Ok(policy) => policy,
            Err(error) => {
                return self
                    .settle_rejected(context, error.into(), Some(&install))
                    .await;
            }
        };
        let preparation = async {
            if admitted.cancellation != CancellationState::NotRequested {
                return Err(PackageError::new(PackageFailure::Cancelled));
            }
            let incoming = VerifiedPayload::read(bytes, &self.limits, cancellation)?;
            incoming.verify_trust(&policy, context.at.clone())?;
            let identity = incoming.manifest.identity.clone();
            let canonical = self.store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
                let row = snapshot.query_opt("SELECT p.package_digest,p.transport_digest,p.manifest_bytes,g.state,g.generation FROM world_package p LEFT JOIN world_package_gc g USING(tenant_id,world_id,package_digest) WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.publisher_id=$3 AND p.package_id=$4 AND p.version=$5",
                    &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &identity.publisher.as_str(), &identity.id.as_str(), &identity.version.to_string()]).await?;
                row.map(|row| {
                    let package = Digest::try_new(row.get::<_, String>("package_digest"))
                        .map_err(|_| PackageError::new(PackageFailure::InternalFault))?;
                    let transport = Digest::try_new(row.get::<_, String>("transport_digest"))
                        .map_err(|_| PackageError::new(PackageFailure::InternalFault))?;
                    Ok::<_, PackageError>((package, transport, row.get::<_, Vec<u8>>("manifest_bytes"),
                        row.get::<_, Option<String>>("state"), row.get::<_, Option<i64>>("generation")))
                }).transpose()
            })).await?;
            let (payload, removed_generation) = if let Some((package, transport, manifest, state, generation)) = canonical {
                if package != incoming.package_digest || manifest != incoming.manifest_bytes {
                    return Err(PackageError::new(PackageFailure::InstallConflict));
                }
                match state.as_deref() {
                    Some("live") => {
                        let canonical = self.files.read(&package, &transport, &self.limits, cancellation)?;
                        if canonical.manifest_bytes != manifest {
                            return Err(PackageError::new(PackageFailure::InstallConflict));
                        }
                        (canonical, None)
                    }
                    Some("removed") => {
                        let generation = generation.filter(|generation| *generation > 0 && *generation < i64::MAX)
                            .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
                        if incoming.transport_digest != transport {
                            return Err(PackageError::new(PackageFailure::InstallConflict));
                        }
                        (incoming, Some(generation))
                    }
                    Some("claimed" | "pending_removal") => return Err(PackageError::new(PackageFailure::RetainedReferences)),
                    _ => return Err(PackageError::new(PackageFailure::InstallConflict)),
                }
            } else {
                (incoming, None)
            };
            let trust = payload.verify_trust(&policy, context.at.clone())?;
            Ok::<_, PackageError>((payload, trust, removed_generation))
        }.await;
        let prepared = match preparation {
            Ok((payload, trust, removed_generation)) => match self
                .list(world)
                .await
                .and_then(|installed| super::dependencies::resolve(&payload, &installed))
            {
                Ok(lock) => {
                    let published = if payload.transport_digest == input {
                        self.files.publish(
                            &payload,
                            bytes,
                            self.limits.transport_bytes as usize,
                            cancellation,
                        )
                    } else {
                        // The validated canonical ZIP is already durable; do not publish a variant.
                        Ok(())
                    };
                    published.map(|()| (payload, trust, lock, removed_generation))
                }
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        let (payload, trust, lock, removed_generation) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                return self
                    .settle_rejected(context, error.into(), Some(&install))
                    .await;
            }
        };
        let mut record = InstalledRecord {
            world: world.clone(),
            install_id: install.clone(),
            manifest: payload.manifest.clone(),
            package_digest: payload.package_digest.clone(),
            transport_digest: payload.transport_digest.clone(),
            lock,
            trust,
            installed_at: context.at.clone(),
            revision: Revision(2),
        };
        let batch = Self::commit_request(context, commit_id("install", &suffix), input.clone())?;
        let admission = context.admission.clone();
        let operation = context.accepted.operation_id.clone();
        let cancellation = cancellation.clone();
        let committed = self
            .store
            .transact(batch, move |tx| {
                Box::pin(async move {
                    let at = now(tx).await?;
                    super::authority::require_access(
                        tx,
                        &admission,
                        std::slice::from_ref(&record.install_id),
                        world_protocol::authorization::AccessMode::Manage,
                    )
                    .await?;
                    authorization::recheck(tx, &admission, &at).await?;
                    let current = owner::read_operation(tx, &operation).await?;
                    if terminal(current.phase) {
                        return Ok(current);
                    }
                    if cancellation.is_cancelled()
                        || current.cancellation != CancellationState::NotRequested
                    {
                        return Err(PackageError::new(PackageFailure::Cancelled).into());
                    }
                    if let Some(source) = &source {
                        super::authority::require_access(
                            tx,
                            &admission,
                            std::slice::from_ref(&source.install_id),
                            world_protocol::authorization::AccessMode::Manage,
                        )
                        .await?;
                        let old = require_install_record(
                            tx,
                            &source.install_id,
                            source.expected_revision,
                        )
                        .await?;
                        if old.manifest.identity.publisher != record.manifest.identity.publisher
                            || old.manifest.identity.id != record.manifest.identity.id
                        {
                            return Err(PackageError::new(PackageFailure::InstallConflict).into());
                        }
                    }
                    let policy = super::read_trust_policy_in(tx).await?;
                    record.trust = payload.verify_trust(&policy, at.clone())?;
                    record.installed_at = at.clone();
                    persist(tx, &record, &payload, removed_generation).await?;
                    let receipt = owner::complete_operation(
                        tx,
                        &current.accepted,
                        OperationResult::Package {
                            install_id: record.install_id.clone(),
                            revision: record.revision,
                        },
                        &at,
                    )
                    .await?;
                    tx.emit(OutboxEvent {
                        event_id: EventId::try_new(format!("installed-{}", &key.as_str()[7..]))
                            .expect("bounded identifier"),
                        aggregate_kind: "package_install".into(),
                        aggregate_id: record.install_id.to_string(),
                        aggregate_revision: record.revision.0,
                        event_kind: "world.package.installed".into(),
                        payload: encode(&record)?,
                        causation_id: None,
                        origin: "world.package".into(),
                    })
                    .await?;
                    Ok::<_, owner::Error>(receipt)
                })
            })
            .await;
        self.settle_result(context, committed, Some(&install)).await
    }
}

async fn persist(
    tx: &mut WorldTransaction<'_>,
    record: &InstalledRecord,
    payload: &VerifiedPayload,
    removed_generation: Option<i64>,
) -> Result<(), owner::Error> {
    let identity = &record.manifest.identity;
    let inserted = tx.execute("INSERT INTO world_package(tenant_id,world_id,publisher_id,package_id,version,package_digest,transport_digest,manifest,manifest_bytes,signature,trust_evidence,verified_files,target,trust_policy_revision,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text::timestamptz) ON CONFLICT DO NOTHING",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &identity.publisher.as_str(), &identity.id.as_str(), &identity.version.to_string(), &record.package_digest.as_str(), &record.transport_digest.as_str(), &encode(&record.manifest)?, &payload.manifest_bytes, &encode(&payload.signatures)?, &encode(&record.trust)?, &encode(&record.manifest.files)?, &encode(&record.manifest.artifacts.iter().map(|artifact| &artifact.target).collect::<Vec<_>>())?, &(record.trust.policy_revision.0 as i64), &record.installed_at.as_str()]).await?;
    if inserted == 0 {
        let row = tx.query_opt("SELECT package_digest,transport_digest,manifest_bytes FROM world_package WHERE tenant_id=$1 AND world_id=$2 AND publisher_id=$3 AND package_id=$4 AND version=$5 FOR SHARE",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &identity.publisher.as_str(), &identity.id.as_str(), &identity.version.to_string()]).await?;
        if row.is_none_or(|row| {
            row.get::<_, String>("package_digest") != record.package_digest.as_str()
                || row.get::<_, String>("transport_digest") != record.transport_digest.as_str()
                || row.get::<_, Vec<u8>>("manifest_bytes") != payload.manifest_bytes
        }) {
            return Err(PackageError::new(PackageFailure::InstallConflict).into());
        }
    }
    tx.execute("INSERT INTO world_package_gc(tenant_id,world_id,package_digest,generation,state) VALUES($1,$2,$3,1,'live') ON CONFLICT DO NOTHING",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.package_digest.as_str()]).await?;
    if let Some(generation) = removed_generation {
        let changed = tx.execute("UPDATE world_package_gc SET state='live',generation=generation+1,claim_token=NULL,failure_code=NULL,failure_stage=NULL WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND state='removed' AND generation=$4 AND generation<9223372036854775807",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.package_digest.as_str(), &generation]).await?;
        if changed != 1 {
            return Err(PackageError::new(PackageFailure::InstallConflict).into());
        }
    }
    let packages: Vec<_> = record
        .lock
        .packages
        .iter()
        .map(|package| package.package_digest.clone())
        .collect();
    super::retain_packages(
        tx,
        super::RetentionOwner::InstallLock(&record.install_id),
        record.revision,
        &packages,
    )
    .await?;
    let changed = tx.execute("UPDATE world_package_install SET phase='installed',revision=2,package_digest=$4,install_lock=$5,body=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 AND phase='admitted'",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.install_id.as_str(), &record.package_digest.as_str(), &encode(&record.lock)?, &encode(record)?]).await?;
    if changed != 1 {
        return Err(PackageError::new(PackageFailure::InstallConflict).into());
    }
    tx.execute("INSERT INTO world_extension_trust(tenant_id,world_id,package_digest,revision,trusted,quarantined,policy_id,policy_revision,body) VALUES($1,$2,$3,1,true,false,'package-trust',$4,$5) ON CONFLICT DO NOTHING",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.package_digest.as_str(), &(record.trust.policy_revision.0 as i64), &encode(&record.trust)?]).await?;
    let fields = super::config::validate_fields(&record.manifest.config, &[], false)?;
    let config = encode(&fields)?;
    let config_digest = world_protocol::api::package_config_digest(&fields)
        .map_err(|cause| PackageError::caused(PackageFailure::SchemaInvalid, cause))?;
    tx.execute("INSERT INTO world_extension_config_revision(tenant_id,world_id,install_id,revision,config_digest,body) VALUES($1,$2,$3,1,$4,$5)",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.install_id.as_str(), &config_digest.as_str(), &config]).await?;
    tx.execute("INSERT INTO world_extension_config_head(tenant_id,world_id,install_id,revision) VALUES($1,$2,$3,1)",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.install_id.as_str()]).await?;
    tx.execute("INSERT INTO world_package_grant_revision(tenant_id,world_id,install_id,revision,body) VALUES($1,$2,$3,1,'[]'::jsonb)",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.install_id.as_str()]).await?;
    tx.execute("INSERT INTO world_package_grant_head(tenant_id,world_id,install_id,revision) VALUES($1,$2,$3,1)",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &record.install_id.as_str()]).await?;
    Ok(())
}

pub(crate) fn install_id(world: &WorldRef, request: &RequestId) -> Result<InstallId, PackageError> {
    let key = digest(
        &serde_json::to_vec(&(world, request))
            .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
    );
    Ok(InstallId::try_new(format!("install-{}", &key.as_str()[7..])).expect("digest identifier"))
}

pub(crate) fn upgrade_request(
    world: &WorldRef,
    command: &world_protocol::api::UpgradePackage,
) -> Result<world_protocol::api::InstallPackage, PackageError> {
    let digest = digest(
        &serde_json::to_vec(&(world, command))
            .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?,
    );
    Ok(world_protocol::api::InstallPackage {
        upload: command.upload.clone(),
        package: command.package.clone(),
        request_key: RequestId::try_new(format!("upgrade-{}", &digest.as_str()[7..]))
            .expect("digest identifier"),
    })
}

pub(crate) async fn require_install_revision(
    tx: &WorldTransaction<'_>,
    install: &InstallId,
    expected: Revision,
) -> Result<(), PackageError> {
    require_install_record(tx, install, expected)
        .await
        .map(|_| ())
}

pub(super) async fn require_install_record(
    tx: &WorldTransaction<'_>,
    install: &InstallId,
    expected: Revision,
) -> Result<InstalledRecord, PackageError> {
    let row = tx.query_opt("SELECT phase,pending_removal,revision,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 FOR UPDATE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &install.as_str()]).await?
        .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
    let record: InstalledRecord = serde_json::from_value(row.get("body"))
        .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
    if row.get::<_, String>("phase") != "installed"
        || row.get::<_, bool>("pending_removal")
        || i64::try_from(expected.0).ok() != Some(row.get::<_, i64>("revision"))
        || &record.world != tx.world()
        || &record.install_id != install
        || record.revision != expected
    {
        return Err(PackageError::new(PackageFailure::InstallConflict));
    }
    Ok(record)
}

fn commit_id(stage: &str, suffix: &str) -> CommitId {
    CommitId::try_new(format!("package-{stage}-{suffix}")).expect("bounded identifier")
}
fn terminal(phase: OperationPhase) -> bool {
    matches!(
        phase,
        OperationPhase::Completed
            | OperationPhase::Failed
            | OperationPhase::CancelledBeforeCommit
            | OperationPhase::CancelledAfterCommit
    )
}
pub(super) async fn now(tx: &WorldTransaction<'_>) -> Result<Timestamp, owner::Error> {
    tx.now().await.map_err(Into::into)
}
