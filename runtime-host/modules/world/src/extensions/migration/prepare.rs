use std::sync::Arc;

use foundation::execution::OwnedTask;
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;
use wasm_host::{CallControl, Engine};
use world_protocol::{
    api::PackageConfigView,
    bindings::{ImplementationRef, StateBinding},
    ids::*,
    package::{ArtifactKind, ArtifactRuntime},
    state::{KV_CHECKPOINT_FORMAT, StateFailure, StateMigration, StateMigrationInput},
};

use super::{
    PreparedCheckpoint, StateError,
    data::{StateData, StateLimits},
};
use crate::{
    authorization::Admission,
    content::PreparedBlob,
    extensions::{
        bindings::BindingGraph,
        invocation::{ResourceKind, ResourceSpec, TaskResource},
        lifecycle::LiveExtensions,
        package::Inventory,
        wasm::{ExecutionPolicy, PreparedStateMigration},
    },
    store::WorldStore,
};

/// Constructed only after the real runtime's typed transform and host-format validation.
/// Neither a caller-supplied StateMigrationOutput nor a guessed checkpoint can mint this proof.
pub(crate) struct PreparedMigration {
    pub(super) checkpoint: Arc<PreparedCheckpoint>,
    pub(super) request: StateMigration,
    pub(super) implementation: ImplementationRef,
    pub(super) config: PackageConfigView,
    pub(super) data: StateData,
    pub(super) blob: PreparedBlob,
    pub(super) binding: StateBinding,
}
impl PreparedMigration {
    pub(crate) fn binding(&self) -> &StateBinding {
        &self.binding
    }
    pub(crate) fn source_node(&self) -> &world_protocol::bindings::BindingNode {
        &self.checkpoint.source
    }
    pub(crate) fn implementation(&self) -> &ImplementationRef {
        &self.implementation
    }
    pub(crate) fn commit_id(&self) -> &CommitId {
        self.checkpoint.commit_id()
    }
    pub(crate) fn migration(&self) -> &StateMigration {
        &self.request
    }
    pub(crate) fn expected(&self) -> &world_protocol::state::StateEpoch {
        &self.request.expected
    }
    pub(crate) fn staged_commit(
        &self,
        request: crate::store::CommitRequest,
    ) -> Result<crate::content::StagedCommit, crate::owner::Error> {
        if request.world != self.request.expected.world || &request.commit_id != self.commit_id() {
            return Err(StateError::from(StateFailure::CheckpointBarrierUnsatisfied).into());
        }
        self.checkpoint
            .content
            .stage_commit(request, &[&self.checkpoint.blob, &self.blob])
            .map_err(Into::into)
    }
    pub(crate) fn discard_prepared(&self) -> Result<(), crate::owner::Error> {
        let shadow = self
            .checkpoint
            .content
            .discard_prepared(&self.blob)
            .map_err(crate::owner::Error::from);
        let checkpoint = self.checkpoint.discard_prepared();
        match (shadow, checkpoint) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(error.with_related(cleanup)),
        }
    }
}

pub(crate) async fn prepare_migration(
    store: &WorldStore,
    inventory: &Inventory,
    live: &LiveExtensions,
    source_graph: &BindingGraph,
    admission: &Admission,
    checkpoint: Arc<PreparedCheckpoint>,
    request: StateMigration,
    implementation: ImplementationRef,
    config: PackageConfigView,
    engine: Engine,
    policy: ExecutionPolicy,
    artifact_limit: usize,
    limits: StateLimits,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<PreparedMigration, StateError> {
    if cancellation.is_cancelled() {
        return Err(StateError::Cancelled);
    }
    if checkpoint.snapshot.epoch != request.expected
        || request.shadow_root == request.expected.root.id
        || request.contract
            != world_protocol::state::migration_contract()
                .map_err(|_| StateFailure::ShadowValidationFailed)?
        || source_graph.lock().world != request.expected.world
        || source_graph
            .node(&checkpoint.source.id)
            .map_err(crate::extensions::bindings::BindingError::from)?
            != &checkpoint.source
    {
        return Err(StateFailure::CheckpointBarrierUnsatisfied.into());
    }
    if request.target_checkpoint_format.as_str() != KV_CHECKPOINT_FORMAT {
        return Err(StateFailure::CheckpointIncompatible {
            format: request.target_checkpoint_format.clone(),
        }
        .into());
    }
    let record = inventory
        .lookup(
            &request.expected.world,
            &implementation.install_id,
            &implementation.package_digest,
        )
        .await?;
    let declaration = record
        .manifest
        .migrations
        .iter()
        .find(|migration| {
            migration.id == request.id
                && migration.artifact_id == implementation.artifact_id
                && migration.from_schema == request.expected.schema
                && migration.to_schema == request.target_schema
                && migration.checkpoint_from == request.expected.checkpoint_format
                && migration.checkpoint_to == request.target_checkpoint_format
                && migration.reversible == request.reversible
        })
        .ok_or_else(|| StateFailure::MigrationUnavailable {
            migration_id: request.id.clone(),
        })?;
    let artifact = record
        .manifest
        .artifacts
        .iter()
        .find(|artifact| {
            artifact.id == declaration.artifact_id
                && artifact.kind == ArtifactKind::Migration
                && artifact.digest == implementation.artifact_digest
                && artifact.entrypoint == implementation.entrypoint
        })
        .ok_or_else(|| StateFailure::MigrationUnavailable {
            migration_id: request.id.clone(),
        })?;
    if artifact.runtime != ArtifactRuntime::WasmComponent {
        return Err(StateFailure::MigrationUnavailable {
            migration_id: request.id.clone(),
        }
        .into());
    }
    if !record.manifest.state.iter().any(|state| {
        state.namespace == request.expected.namespace
            && state.schema_digest == request.target_schema
            && state.checkpoint_format == request.target_checkpoint_format
    }) || implementation.checkpoint_format.as_ref() != Some(&request.target_checkpoint_format)
        || record.lock.digest != implementation.dependency_lock
    {
        return Err(StateFailure::ShadowValidationFailed.into());
    }
    let limits = StateLimits {
        maximum_keys: limits
            .maximum_keys
            .min(record.manifest.limits.budget.max_rows),
        maximum_bytes: limits
            .maximum_bytes
            .min(record.manifest.limits.budget.max_bytes)
            .min(record.manifest.limits.memory_bytes),
    };
    let implementation_guard = implementation.clone();
    let config_guard = config.clone();
    let admission_guard = admission.clone();
    let at = store.snapshot(request.expected.world.clone(), move |snapshot| Box::pin(async move {
        let row = snapshot.query_opt("SELECT i.phase,i.desired_enabled,i.pending_removal,t.trusted,t.quarantined,h.revision,r.config_digest,r.body FROM world_package_install i JOIN world_extension_trust t USING(tenant_id,world_id,package_digest) JOIN world_extension_config_head h USING(tenant_id,world_id,install_id) JOIN world_extension_config_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.install_id=h.install_id AND r.revision=h.revision WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.install_id=$3 AND i.package_digest=$4",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &implementation_guard.install_id.as_str(), &implementation_guard.package_digest.as_str()]).await?.ok_or(StateFailure::Fenced)?;
        if row.get::<_, String>("phase") != "installed" || !row.get::<_, bool>("desired_enabled") || row.get::<_, bool>("pending_removal") || !row.get::<_, bool>("trusted") || row.get::<_, bool>("quarantined")
            || row.get::<_, i64>("revision") as u64 != config_guard.revision.0 || row.get::<_, String>("config_digest") != config_guard.digest.as_str()
            || serde_json::from_value::<Vec<world_protocol::api::ConfigValue>>(row.get("body"))? != config_guard.fields {
            return Err(StateFailure::Fenced.into());
        }
        let at = snapshot.now().await?;
        crate::authorization::recheck_read(snapshot, &admission_guard, &at).await?;
        Ok::<_, StateError>(at)
    })).await?;
    let artifact = inventory
        .artifact(&request.expected.world, &implementation, at, cancellation)
        .await?;
    let input = StateMigrationInput {
        migration: request.clone(),
        checkpoint: checkpoint.bytes()?,
    };
    let next = request
        .expected
        .writer_epoch
        .0
        .checked_add(1)
        .filter(|epoch| *epoch <= i64::MAX as u64)
        .map(WriterEpoch)
        .ok_or(StateFailure::Fenced)?;
    let (ledger, permit) = live
        .gate()
        .synchronized(|access| {
            live.new_migration_generation_in(
                access,
                &request.expected,
                checkpoint.commit_id(),
                source_graph,
                &checkpoint.source.id,
                &implementation,
                &record.manifest.limits,
            )
        })
        .map_err(crate::extensions::bindings::BindingError::from)?;
    let ticket = ledger
        .begin_acquisition(
            AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
            resource(ResourceKind::TaskJoin, &admission.invocation().id),
        )
        .map_err(|error| StateError::from(crate::extensions::wasm::WasmError::from(error)))?;
    let store_registration =
        match ledger.register(resource(ResourceKind::Store, &admission.invocation().id)) {
            Ok(registration) => registration,
            Err(error) => {
                ticket.fail();
                return Err(crate::extensions::wasm::WasmError::from(error).into());
            }
        };
    let resource_cancel = ticket.cancellation().clone();
    let store_cancel = store_registration.cancellation().clone();
    let external_cancel = cancellation.clone();
    let task_implementation = implementation.clone();
    let task_config = config.clone();
    let target_schema = request.target_schema.clone();
    let target_format = request.target_checkpoint_format.clone();
    let (send, receive) = oneshot::channel();
    let (task, _) = OwnedTask::spawn(move |task_cancel| async move {
        let work = async {
            let prepared = PreparedStateMigration::prepare(
                engine,
                task_implementation,
                task_config,
                artifact,
                artifact_limit,
                &external_cancel,
            )?;
            let control = CallControl::new(CancellationToken::new(), deadline.into_std());
            let call = prepared.migrate(input, policy, control.clone());
            tokio::pin!(call);
            let output = tokio::select! {
                biased;
                _ = external_cancel.cancelled() => { control.cancellation().cancel(); call.await },
                _ = task_cancel.cancelled() => { control.cancellation().cancel(); call.await },
                _ = resource_cancel.cancelled() => { control.cancellation().cancel(); call.await },
                _ = store_cancel.cancelled() => { control.cancellation().cancel(); call.await },
                output = &mut call => output,
            }??;
            if output.schema != target_schema
                || output.checkpoint_format != target_format
                || output.checkpoint.len() as u64 > limits.encoded_limit()? as u64
            {
                return Err(StateFailure::ShadowValidationFailed.into());
            }
            let data: StateData = serde_json::from_slice(&output.checkpoint)?;
            data.validate(limits)?;
            Ok::<_, StateError>(data)
        }
        .await;
        // The pure adapter awaits Engine::invoke, which destroys its Store with into_data
        // before reporting execution/cleanup failure; no guest host resources can outlive it.
        store_registration.finish();
        let _ = send.send(work);
    });
    let mut registration = ticket
        .complete(Box::new(
            TaskResource::new(task, |_| Ok(())).with_permit(permit),
        ))
        .registration;
    let _cancel = CancelOnDrop(registration.cancellation().clone());
    let result = receive
        .await
        .map_err(StateError::Join)
        .and_then(|result| result);
    let cleanup = registration
        .close_checked(deadline.max(Instant::now()))
        .await;
    ledger.close_admission();
    let _ = ledger.request_cancel();
    let data = match cleanup {
        Ok(()) => {
            if !matches!(
                ledger.drain_until(deadline.max(Instant::now())).await,
                Ok(crate::extensions::invocation::DrainOutcome::Drained)
            ) {
                return Err(StateError::Resource {
                    failure: result.err().map(Box::new),
                    cleanup: crate::extensions::invocation::ResourceFailure::new(
                        crate::extensions::invocation::ResourceStage::TaskJoin,
                        "state_migration_retained",
                        "migration resources have not drained",
                    ),
                });
            }
            result
        }
        Err(cleanup) => Err(StateError::Resource {
            failure: result.err().map(Box::new),
            cleanup,
        }),
    }?;
    let bytes = serde_json::to_vec(&data)?;
    let blob = checkpoint
        .content
        .prepare_blob(&mut bytes.as_slice(), None, cancellation)?;
    let binding = StateBinding {
        namespace: request.expected.namespace.clone(),
        root: StateRef {
            world: request.expected.world.clone(),
            id: request.shadow_root.clone(),
            revision: Revision(1),
        },
        schema: request.target_schema.clone(),
        writer_domain: request.expected.writer_domain.clone(),
        writer_epoch: next,
        migration: Some(request.id.clone()),
    };
    Ok(PreparedMigration {
        checkpoint,
        request,
        implementation,
        config,
        data,
        blob,
        binding,
    })
}

fn resource(kind: ResourceKind, invocation: &InvocationId) -> ResourceSpec {
    ResourceSpec {
        token: ResourceToken::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
        kind,
        parent: None,
        invocation: Some(invocation.clone()),
    }
}
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
