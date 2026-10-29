use std::{collections::BTreeSet, ffi::OsString, sync::Arc};

use foundation::execution::OwnedTask;
use tokio::{sync::oneshot, time::{Instant, timeout_at}};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{ConfigValue, PackageConfigView},
    bindings::{Entrypoint, ImplementationRef},
    failure::FailureStage,
    ids::*,
    lifecycle::{LifecycleFailure, LifecycleStage},
    operation::{CancellationState, OperationPhase},
    package::{ArtifactKind, ArtifactRuntime, InstalledRecord, PackageFailure, PackageFile},
    process::HostFailure,
};

use super::{LifecycleError, LiveExtensions, PreparationPorts, live::{Generation, GenerationKind}};
use crate::{
    authorization::{self, Admission},
    definitions::canonical_digest,
    extensions::{
        bindings::PublicationGate,
        invocation::{AcquisitionTicket, CallBudget, DrainOutcome, ResourceKind, ResourceLedger, ResourceSpec, TaskResource},
        package::{self, Inventory, PackageError, RetentionOwner},
        process::{self, MaterialsClient, ProcessError, ProcessLaunch},
    },
    materials::{MaterialImplementation, MaterialRequest, MaterialResponse},
    owner::{self, RunRecord, StepRecord},
    store::{WorldSnapshot, WorldStore},
};

/// Select the enabled, trusted parser package. Resume consumes the durable pin.
pub(crate) async fn select_materials(
    store: &WorldStore, admission: &Admission, inventory: &Inventory,
    deadline: Instant,
) -> Result<MaterialImplementation, owner::Error> {
    check_deadline(deadline)?;
    let records = inventory.list(&admission.invocation().world).await?;
    let mut selected = None;
    for record in records {
        if record.manifest.identity.publisher.as_str() != "matcha"
            || record.manifest.identity.id.as_str() != "world-materials" { continue; }
        let matching: Vec<_> = record.manifest.artifacts.iter().filter(|artifact| {
            artifact.kind == ArtifactKind::Implementation && artifact.runtime == ArtifactRuntime::TrustedProcess
                && artifact.target == process::native_target()
        }).collect();
        if matching.is_empty() { continue; }
        if matching.len() != 1 { return Err(invalid()); }
        let artifact = matching[0];
        let config = read_selection(store, admission, &record).await?;
        let Some(config) = config else { continue };
        let pin = MaterialImplementation {
            implementation: ImplementationRef {
                install_id: record.install_id.clone(), package_digest: record.package_digest.clone(),
                artifact_id: artifact.id.clone(), artifact_digest: artifact.digest.clone(), entrypoint: artifact.entrypoint.clone(),
                contracts: vec![crate::materials::material_contract().map_err(|_| invalid())?],
                config_digest: config.digest.clone(), dependency_lock: record.lock.digest.clone(), checkpoint_format: None,
            },
            config, native_files: native_files(&record),
        };
        validate_package(&record, &pin)?;
        let check = pin.clone();
        let authority = admission.clone();
        store.snapshot(admission.invocation().world.clone(), move |snapshot| Box::pin(async move {
            authorization::recheck_read(snapshot, &authority, &snapshot.now().await?).await?;
            package::require_grants_read(snapshot, &check.implementation, &record.manifest.requested_access).await?;
            Ok::<_, owner::Error>(())
        })).await?;
        if selected.replace(pin).is_some() { return Err(invalid()); }
    }
    let pin = selected.ok_or_else(unavailable)?;
    // Verify the original signed bytes before persisting selection, not merely inventory metadata.
    let cancellation = CancellationToken::new();
    let at = current_time()?;
    timeout_at(deadline, inventory.artifact(&admission.invocation().world, &pin.implementation, at, &cancellation))
        .await.map_err(|_| owner::Error::from(LifecycleError::Deadline))??;
    check_deadline(deadline)?;
    Ok(pin)
}

async fn read_selection(
    store: &WorldStore, admission: &Admission, expected: &InstalledRecord,
) -> Result<Option<PackageConfigView>, owner::Error> {
    let admission = admission.clone();
    let expected = expected.clone();
    store.snapshot(admission.invocation().world.clone(), move |snapshot| Box::pin(async move {
        authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
        let world = snapshot.world();
        let row = snapshot.query_opt("SELECT phase,desired_enabled,pending_removal,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &expected.install_id.as_str()]).await?.ok_or_else(invalid)?;
        if row.get::<_, String>("phase") != "installed" || !row.get::<_, bool>("desired_enabled") || row.get::<_, bool>("pending_removal") { return Ok(None); }
        let record: InstalledRecord = decode(row.get("body"))?;
        if record != expected { return Err(invalid()); }
        let trust = snapshot.query_opt("SELECT trusted,quarantined FROM world_extension_trust WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &record.package_digest.as_str()]).await?;
        if trust.is_none_or(|row| !row.get::<_, bool>("trusted") || row.get::<_, bool>("quarantined")) { return Ok(None); }
        Ok(Some(read_config(snapshot, &record.install_id).await?))
    })).await
}

#[must_use = "close the pure worker with checked joins before waiting for models"]
pub(crate) struct MaterialsLease {
    store: WorldStore,
    admission: Admission,
    run: RunRecord,
    step: StepRecord,
    pin: MaterialImplementation,
    ledger: ResourceLedger,
    gate: PublicationGate,
    client: MaterialsClient,
    closed: bool,
}

impl LiveExtensions {
    pub(crate) async fn lease_materials(
        &self, store: &WorldStore, admission: &Admission, run: &RunRecord, step: &StepRecord,
        pin: &MaterialImplementation, inventory: &Arc<Inventory>, ports: &PreparationPorts, deadline: Instant,
    ) -> Result<MaterialsLease, owner::Error> {
        check_deadline(deadline)?;
        check_current(store, admission, run, step, pin, false).await?;
        let (ledger, ticket) = self.gate.synchronized(|_| {
            let mut registry = self.registry.lock().expect("world extension registry poisoned");
            let world = &admission.invocation().world;
            if registry.closing_worlds.contains(world) || registry.stopped_worlds.contains(world)
                || registry.transfer_closing(world)
                || registry.install_fences.get(&(world.clone(), pin.implementation.install_id.clone())).is_some_and(|fence| fence.closing) {
                return Err(LifecycleError::Retiring);
            }
            for generation in registry.generations.values().filter(|generation| &generation.world == world) {
                if matches!(&generation.kind, GenerationKind::Materials { run: held, step: held_step, .. } if held == &run.id && held_step == &step.id) {
                    let snapshot = generation.ledger.snapshot();
                    if snapshot.admission != crate::extensions::invocation::Admission::Closed || !snapshot.resources.is_empty() {
                        return Err(LifecycleError::Contract(LifecycleFailure::Retained {
                            stage: LifecycleStage::Cleanup, remaining_resources: super::retained_resources(&snapshot),
                        }));
                    }
                }
            }
            let id = PluginGenerationId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID generation");
            let ledger = ResourceLedger::new(id.clone());
            let ticket = ledger.begin_acquisition(
                AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID acquisition"),
                ResourceSpec { token: ResourceToken::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID resource"),
                    kind: ResourceKind::TaskJoin, parent: None, invocation: Some(admission.invocation().id.clone()) },
            ).map_err(|_| LifecycleError::Retiring)?;
            registry.generations.insert(id, Generation { world: world.clone(), install: pin.implementation.install_id.clone(),
                kind: GenerationKind::Materials { run: run.id.clone(), step: step.id.clone(), implementation: pin.implementation.clone() }, ledger: ledger.clone() });
            Ok((ledger, ticket))
        })?;
        let mut guard = LeaseGuard { ledger: ledger.clone(), gate: self.gate.clone(), armed: true };
        let client = prepare_owned(ticket, ledger.clone(), self.gate.clone(), inventory.clone(), ports.clone(),
            admission.invocation().world.clone(), pin.clone(), deadline).await;
        let client = match client {
            Ok(client) => client,
            Err(error) => return Err(with_cleanup(error, guard.close_checked(deadline).await)),
        };
        if let Err(error) = check_current(store, admission, run, step, pin, false).await {
            return Err(with_cleanup(error, guard.close_checked(deadline).await));
        }
        guard.armed = false;
        Ok(MaterialsLease { store: store.clone(), admission: admission.clone(), run: run.clone(), step: step.clone(),
            pin: pin.clone(), ledger, gate: self.gate.clone(), client, closed: false })
    }
}

impl MaterialsLease {
    pub(crate) async fn invoke(
        &self, request: MaterialRequest, budget: CallBudget, cancellation: CancellationToken, deadline: Instant,
    ) -> Result<MaterialResponse, owner::Error> {
        if self.closed { return Err(LifecycleError::Retiring.into()); }
        check_deadline(deadline)?;
        if cancellation.is_cancelled() { return Err(LifecycleError::Cancelled.into()); }
        let first_parse = matches!(&request, MaterialRequest::Parse { .. });
        check_current(&self.store, &self.admission, &self.run, &self.step, &self.pin, first_parse).await?;
        if self.ledger.snapshot().admission != crate::extensions::invocation::Admission::Open { return Err(LifecycleError::Retiring.into()); }
        let result = self.client.invoke(request, budget, cancellation.clone(), deadline).await
            .map_err(|cause| owner::Error::from(LifecycleError::Process(cause)))?;
        if cancellation.is_cancelled() { return Err(LifecycleError::Cancelled.into()); }
        check_current(&self.store, &self.admission, &self.run, &self.step, &self.pin, first_parse).await?;
        result.map_err(owner::Error::from)
    }

    pub(crate) async fn close_checked(&mut self, deadline: Instant) -> Result<(), owner::Error> {
        if self.closed { return Ok(()); }
        self.gate.synchronized(|_| self.ledger.close_admission());
        let _ = self.ledger.request_cancel();
        drain(&self.ledger, deadline).await?;
        self.closed = true;
        Ok(())
    }
}

impl Drop for MaterialsLease {
    fn drop(&mut self) {
        if !self.closed {
            self.gate.synchronized(|_| self.ledger.close_admission());
            self.client.cancel();
            let _ = self.ledger.request_cancel();
        }
    }
}

struct LeaseGuard { ledger: ResourceLedger, gate: PublicationGate, armed: bool }
impl LeaseGuard {
    async fn close_checked(&mut self, deadline: Instant) -> Result<(), owner::Error> {
        self.gate.synchronized(|_| self.ledger.close_admission());
        let _ = self.ledger.request_cancel();
        let result = drain(&self.ledger, deadline).await;
        if result.is_ok() { self.armed = false; }
        result
    }
}
impl Drop for LeaseGuard {
    fn drop(&mut self) {
        if self.armed {
            self.gate.synchronized(|_| self.ledger.close_admission());
            let _ = self.ledger.request_cancel();
        }
    }
}

async fn prepare_owned(
    ticket: AcquisitionTicket, ledger: ResourceLedger, gate: PublicationGate, inventory: Arc<Inventory>,
    ports: PreparationPorts, world: WorldRef, pin: MaterialImplementation, deadline: Instant,
) -> Result<MaterialsClient, owner::Error> {
    let cancellation = ticket.cancellation().clone();
    let (send, receive) = oneshot::channel();
    let work_ledger = ledger.clone();
    let (task, _) = OwnedTask::spawn(move |task_cancel| async move {
        let work_cancel = CancellationToken::new();
        let work = async {
            let at = current_time()?;
            let artifact = inventory.artifact(&world, &pin.implementation, at.clone(), &work_cancel).await?;
            let _directory = ports.process_directory().open().map_err(|_| LifecycleError::Process(Arc::new(ProcessError::InvalidLaunch)))?;
            let launch = ProcessLaunch {
                working_directory: ports.process_directory().as_path().to_path_buf(), arguments: vec![OsString::from("world-materials")],
                environment: Vec::new(), private_descriptor: None,
                require_sandbox: artifact.artifact.features.iter().any(|feature| feature == world_protocol::package::REQUIRES_SANDBOX),
                artifact_limit: ports.artifact_limit(),
            };
            let prepared = process::prepare_materials(ports.containment(), pin, artifact, launch,
                ports.execution_policy().host_io_timeout, &work_ledger, deadline).await.map_err(LifecycleError::Process)?;
            Ok::<_, owner::Error>(prepared.client)
        };
        tokio::pin!(work);
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => { work_cancel.cancel(); let _ = work.await; Err(LifecycleError::Cancelled.into()) },
            _ = task_cancel.cancelled() => { work_cancel.cancel(); let _ = work.await; Err(LifecycleError::Cancelled.into()) },
            _ = tokio::time::sleep_until(deadline) => { work_cancel.cancel(); let _ = work.await; Err(LifecycleError::Deadline.into()) },
            result = &mut work => result,
        };
        if send.send(result).is_err() {
            gate.synchronized(|_| work_ledger.close_admission());
            let _ = work_ledger.request_cancel();
        }
    });
    let acquired = ticket.complete(Box::new(TaskResource::new(task, |_| Ok(()))));
    let mut registration = acquired.registration;
    if acquired.must_release { return Err(LifecycleError::Retiring.into()); }
    let result = timeout_at(deadline, receive).await.map_err(|_| owner::Error::from(LifecycleError::Deadline))?
        .map_err(|_| owner::Error::internal(FailureStage::Prepare));
    let joined = registration.close_checked(deadline).await;
    if let Err(cause) = joined {
        registration.retain(cause);
        return Err(retained(&ledger));
    }
    result?
}

async fn check_current(
    store: &WorldStore, admission: &Admission, expected_run: &RunRecord, expected_step: &StepRecord,
    pin: &MaterialImplementation, first_parse: bool,
) -> Result<(), owner::Error> {
    let admission = admission.clone();
    let expected_run = expected_run.clone();
    let expected_step = expected_step.clone();
    let pin = pin.clone();
    store.snapshot(admission.invocation().world.clone(), move |snapshot| Box::pin(async move {
        let at = snapshot.now().await?;
        authorization::recheck_read(snapshot, &admission, &at).await?;
        let run = owner::read_run_snapshot(snapshot, &expected_run.id).await?;
        let operation = owner::read_record_snapshot(snapshot, &run.operation.operation_id).await?;
        operation.identity.require_resume(admission.verified())?;
        let step = owner::read_step_snapshot(snapshot, &run.id, &expected_step.id).await?.ok_or_else(invalid)?;
        if run.operation.world != admission.invocation().world || run.branch_id != admission.invocation().branch_id
            || canonical_digest(&run)? != canonical_digest(&expected_run)? || canonical_digest(&step)? != canonical_digest(&expected_step)?
            || operation.receipt.cancellation != CancellationState::NotRequested
            || !matches!(run.phase, OperationPhase::Admitted | OperationPhase::Running | OperationPhase::Verifying)
            || owner::terminal_phase(operation.receipt.phase)
            || !matches!(step.phase, OperationPhase::Running | OperationPhase::Completed)
            || (first_parse && step.phase != OperationPhase::Running)
            || owner::read_material_implementation(&step)? != pin {
            return Err(invalid());
        }
        let world_protocol::api::WorldCommand::ImportMaterials(request) = operation.input.command()? else { return Err(invalid()); };
        if step.input_digest != canonical_digest(request)? { return Err(invalid()); }
        let record = read_current_package(snapshot, &pin).await?;
        validate_package(&record, &pin)?;
        let closure: BTreeSet<_> = record.lock.packages.iter().map(|item| item.package_digest.clone())
            .chain(std::iter::once(record.package_digest.clone())).collect();
        if closure.iter().any(|digest| !run.packages.contains(digest)) { return Err(invalid()); }
        let packages: Vec<_> = closure.into_iter().collect();
        package::require_retained_packages_snapshot(snapshot, RetentionOwner::Run(&run.id), Revision(1), &packages).await?;
        package::require_retained_packages_snapshot(snapshot, RetentionOwner::Step(&step.id), Revision(1), &packages).await?;
        package::require_grants_read(snapshot, &pin.implementation, &record.manifest.requested_access).await?;
        Ok(())
    })).await
}

async fn read_current_package(snapshot: &WorldSnapshot<'_>, pin: &MaterialImplementation) -> Result<InstalledRecord, owner::Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt("SELECT revision,phase,desired_enabled,pending_removal,package_digest,install_lock,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &pin.implementation.install_id.as_str()]).await?.ok_or_else(unavailable)?;
    let record: InstalledRecord = decode(row.get("body"))?;
    if row.get::<_, String>("phase") != "installed" || !row.get::<_, bool>("desired_enabled") || row.get::<_, bool>("pending_removal")
        || record.world != *world || record.install_id != pin.implementation.install_id || record.package_digest != pin.implementation.package_digest
        || i64::try_from(record.revision.0).ok() != Some(row.get("revision"))
        || row.get::<_, Option<String>>("package_digest").as_deref() != Some(record.package_digest.as_str())
        || serde_json::to_value(&record.lock).map_err(|_| invalid())? != row.get::<_, serde_json::Value>("install_lock")
        || read_config(snapshot, &record.install_id).await? != pin.config { return Err(unavailable()); }
    let trust = snapshot.query_opt("SELECT trusted,quarantined FROM world_extension_trust WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &record.package_digest.as_str()]).await?;
    if trust.is_none_or(|row| !row.get::<_, bool>("trusted") || row.get::<_, bool>("quarantined")) {
        return Err(PackageError::new(PackageFailure::PublisherUntrusted).into());
    }
    Ok(record)
}

async fn read_config(snapshot: &WorldSnapshot<'_>, install: &InstallId) -> Result<PackageConfigView, owner::Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt("SELECT h.revision,r.config_digest,r.body FROM world_extension_config_head h JOIN world_extension_config_revision r USING(tenant_id,world_id,install_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.install_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &install.as_str()]).await?.ok_or_else(unavailable)?;
    let fields: Vec<ConfigValue> = decode(row.get("body"))?;
    let digest = world_protocol::api::package_config_digest(&fields).map_err(|_| invalid())?;
    let revision: i64 = row.get("revision");
    if revision <= 0 || digest.as_str() != row.get::<_, String>("config_digest") { return Err(invalid()); }
    Ok(PackageConfigView { install_id: install.clone(), revision: Revision(revision as u64), digest, fields })
}

fn validate_package(record: &InstalledRecord, pin: &MaterialImplementation) -> Result<(), owner::Error> {
    let contract = crate::materials::material_contract().map_err(|_| invalid())?;
    let implementation = &pin.implementation;
    let artifact = record.manifest.artifacts.iter().find(|artifact| artifact.id == implementation.artifact_id).ok_or_else(unavailable)?;
    if record.manifest.identity.publisher.as_str() != "matcha" || record.manifest.identity.id.as_str() != "world-materials"
        || !record.trust.signature_verified || record.trust.package_digest != record.package_digest
        || artifact.kind != ArtifactKind::Implementation || artifact.runtime != ArtifactRuntime::TrustedProcess
        || artifact.target != process::native_target() || artifact.digest != implementation.artifact_digest
        || artifact.entrypoint != implementation.entrypoint || implementation.contracts != vec![contract.clone()]
        || !matches!(&implementation.entrypoint, Entrypoint::Process { executable, protocol } if executable == executable_path() && protocol == &contract)
        || artifact.path.as_deref() != Some(executable_path())
        || !record.manifest.contracts.iter().any(|declared| declared.reference == contract)
        || record.lock.digest != implementation.dependency_lock
        || world_protocol::package::install_lock_digest(&record.lock.packages, &record.lock.contracts, &record.lock.artifacts).map_err(|_| invalid())? != record.lock.digest
        || pin.native_files.iter().any(|file| !record.manifest.files.contains(file))
        || pin.config.install_id != implementation.install_id || pin.config.digest != implementation.config_digest {
        return Err(unavailable());
    }
    Ok(())
}

fn native_files(record: &InstalledRecord) -> Vec<PackageFile> {
    record.manifest.files.clone()
}
fn executable_path() -> &'static str { if cfg!(windows) { "bin/runtime-host.exe" } else { "bin/runtime-host" } }
fn decode<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T, owner::Error> {
    serde_json::from_value(value).map_err(|cause| owner::Error::internal(FailureStage::Read).caused(cause))
}
fn current_time() -> Result<world_protocol::time::Timestamp, owner::Error> {
    world_protocol::time::Timestamp::try_new(chrono::Utc::now().to_rfc3339()).map_err(|_| invalid())
}
fn check_deadline(deadline: Instant) -> Result<(), owner::Error> {
    if Instant::now() >= deadline { Err(LifecycleError::Deadline.into()) } else { Ok(()) }
}
fn invalid() -> owner::Error { LifecycleError::InvalidPersistedState.into() }
fn unavailable() -> owner::Error {
    owner::Error::from_host_failure(HostFailure::Operation(world_protocol::operation::OperationFailure::Material(
        world_protocol::materials::MaterialFailure::ParserUnavailable)), FailureStage::Prepare)
}
fn retained(ledger: &ResourceLedger) -> owner::Error {
    LifecycleError::Contract(LifecycleFailure::Retained { stage: LifecycleStage::Cleanup,
        remaining_resources: super::retained_resources(&ledger.snapshot()) }).into()
}
async fn drain(ledger: &ResourceLedger, deadline: Instant) -> Result<(), owner::Error> {
    match ledger.drain_until(deadline).await.map_err(|_| LifecycleError::Retiring)? {
        DrainOutcome::Drained => Ok(()), DrainOutcome::Retained(_) => Err(retained(ledger)),
    }
}
fn with_cleanup(error: owner::Error, cleanup: Result<(), owner::Error>) -> owner::Error {
    match cleanup { Ok(()) => error, Err(cleanup) => error.with_related(cleanup) }
}
