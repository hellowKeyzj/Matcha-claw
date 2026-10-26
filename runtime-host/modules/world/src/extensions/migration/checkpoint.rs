use std::sync::Arc;

use world_protocol::{
    api::{PackageConfigView, package_config_digest},
    authorization::{AccessMode, AccessScope},
    bindings::BindingNode,
    ids::*,
    state::{KV_CHECKPOINT_FORMAT, StateEpoch, StateFailure, StateSnapshot},
};

use super::{
    StateError,
    data::{StateData, StateLimits},
};
use crate::{
    authorization::{self, Admission},
    content::{Content, ContentOwner, PreparedBlob},
    extensions::lifecycle::{DrainedState, LiveExtensions},
    store::{WorldStore, WorldTransaction},
};

/// Checkpoint bytes come from the immutable, exact PostgreSQL root after the real
/// old-epoch barrier. Holding this object does not publish a new root or epoch.
pub(crate) struct PreparedCheckpoint {
    pub(super) snapshot: StateSnapshot,
    pub(super) data: StateData,
    pub(super) state_epoch: i64,
    pub(super) source: BindingNode,
    pub(super) source_config: PackageConfigView,
    pub(super) drained: Arc<DrainedState>,
    pub(super) content: Arc<Content>,
    pub(super) blob: PreparedBlob,
}

impl PreparedCheckpoint {
    pub(crate) fn snapshot(&self) -> &StateSnapshot {
        &self.snapshot
    }
    pub(crate) fn commit_id(&self) -> &CommitId {
        self.drained.commit_id()
    }
    pub(crate) fn bytes(&self) -> Result<Vec<u8>, StateError> {
        Ok(serde_json::to_vec(&self.data)?)
    }
    pub(crate) fn staged_commit(
        &self,
        request: crate::store::CommitRequest,
    ) -> Result<crate::content::StagedCommit, crate::owner::Error> {
        if request.world != self.snapshot.epoch.world || &request.commit_id != self.commit_id() {
            return Err(StateError::from(StateFailure::CheckpointBarrierUnsatisfied).into());
        }
        self.content
            .stage_commit(request, &[&self.blob])
            .map_err(Into::into)
    }
    pub(crate) fn discard_prepared(&self) -> Result<(), crate::owner::Error> {
        self.content
            .discard_prepared(&self.blob)
            .map_err(Into::into)
    }
}

pub(crate) async fn prepare_checkpoint(
    store: &WorldStore,
    content: &Arc<Content>,
    live: &LiveExtensions,
    admission: &Admission,
    source: &BindingNode,
    drained: Arc<DrainedState>,
    limits: StateLimits,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<PreparedCheckpoint, StateError> {
    if let Some(failure) = drained.process_failures().first() {
        return Err(crate::owner::Error::from(
            crate::extensions::lifecycle::LifecycleError::Process(failure.clone()),
        )
        .into());
    }
    let epoch = drained.epoch().clone();
    let binding = source.state.as_ref().ok_or(StateFailure::Fenced)?;
    if !live.validate_state_drained(&drained)
        || admission.invocation().world != epoch.world
        || binding.namespace != epoch.namespace
        || binding.root.id != epoch.root.id
        || binding.root.revision > epoch.root.revision
        || binding.schema != epoch.schema
        || binding.writer_domain != epoch.writer_domain
        || binding.writer_epoch != epoch.writer_epoch
    {
        return Err(StateFailure::CheckpointBarrierUnsatisfied.into());
    }
    if epoch.checkpoint_format.as_str() != KV_CHECKPOINT_FORMAT {
        return Err(StateFailure::CheckpointIncompatible {
            format: epoch.checkpoint_format.clone(),
        }
        .into());
    }
    let current_epoch = epoch.clone();
    let current_source = source.clone();
    let admission = admission.clone();
    let (data, state_epoch, source_config, at) = store.snapshot(epoch.world.clone(), move |snapshot| Box::pin(async move {
        let maximum = limits.encoded_limit()?;
        let row = snapshot.query_opt(
            "SELECT n.install_id,n.state_root_id,n.state_root_revision,n.schema_digest,n.writer_domain,n.writer_epoch,n.state_epoch,r.namespace_id AS root_namespace,r.schema_digest AS root_schema,r.state_epoch AS root_epoch,r.content_digest,CASE WHEN octet_length(r.body::text)::bigint <= $4 THEN r.body ELSE NULL END AS body,i.phase,i.package_digest,i.desired_enabled,i.pending_removal,t.trusted,t.quarantined,h.revision AS config_revision,c.config_digest,c.body AS config_body,g.mode,g.writer_epoch AS gate_epoch,w.management_scope_id,w.status FROM world_state_namespace n JOIN world_state_root r ON r.tenant_id=n.tenant_id AND r.world_id=n.world_id AND r.state_root_id=n.state_root_id AND r.revision=n.state_root_revision JOIN world_package_install i ON i.tenant_id=n.tenant_id AND i.world_id=n.world_id AND i.install_id=n.install_id JOIN world_extension_trust t ON t.tenant_id=i.tenant_id AND t.world_id=i.world_id AND t.package_digest=i.package_digest JOIN world_extension_config_head h ON h.tenant_id=i.tenant_id AND h.world_id=i.world_id AND h.install_id=i.install_id JOIN world_extension_config_revision c ON c.tenant_id=h.tenant_id AND c.world_id=h.world_id AND c.install_id=h.install_id AND c.revision=h.revision JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain JOIN world_runtime_head w ON w.tenant_id=n.tenant_id AND w.world_id=n.world_id WHERE n.tenant_id=$1 AND n.world_id=$2 AND n.namespace_id=$3",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &current_epoch.namespace.as_str(), &maximum],
        ).await?.ok_or_else(|| StateFailure::NamespaceMissing { namespace: current_epoch.namespace.clone() })?;
        require_epoch(&row, &current_epoch)?;
        if row.get::<_, String>("install_id") != current_source.implementation.install_id.as_str()
            || row.get::<_, String>("package_digest") != current_source.implementation.package_digest.as_str()
            || row.get::<_, String>("phase") != "installed" || !row.get::<_, bool>("desired_enabled") || row.get::<_, bool>("pending_removal")
            || !row.get::<_, bool>("trusted") || row.get::<_, bool>("quarantined")
            || row.get::<_, String>("mode") != "active" || row.get::<_, String>("status") != "ready"
            || row.get::<_, i64>("gate_epoch") as u64 != current_epoch.writer_epoch.0
            || row.get::<_, String>("root_namespace") != current_epoch.namespace.as_str()
            || row.get::<_, String>("root_schema") != current_epoch.schema.as_str()
            || row.get::<_, i64>("root_epoch") != row.get::<_, i64>("state_epoch") {
            return Err(StateFailure::Fenced.into());
        }
        let config_revision = row.get::<_, i64>("config_revision");
        let config_fields: Vec<world_protocol::api::ConfigValue> = serde_json::from_value(row.get("config_body"))?;
        let config_digest = package_config_digest(&config_fields).map_err(|_| StateFailure::Fenced)?;
        if config_revision <= 0 || config_digest != current_source.implementation.config_digest
            || config_digest.as_str() != row.get::<_, String>("config_digest") {
            return Err(StateFailure::Fenced.into());
        }
        let source_config = PackageConfigView { install_id: current_source.implementation.install_id.clone(),
            revision: Revision(config_revision as u64), digest: config_digest, fields: config_fields };
        crate::extensions::package::read_package_grants(snapshot, &current_source.implementation).await?;
        let data: StateData = serde_json::from_value(row.get::<_, Option<serde_json::Value>>("body").ok_or(StateFailure::SizeLimit)?)?;
        data.validate(limits)?;
        if data.digest()?.as_str() != row.get::<_, String>("content_digest") { return Err(StateFailure::ShadowValidationFailed.into()); }
        let impact = authorization::actual_impact(vec![AccessScope {
            resources: vec![ResourceRef::State { id: current_epoch.root.id.clone() }], fields: Vec::new(),
            modes: vec![AccessMode::Manage], scope: ScopeId::try_new(row.get::<_, String>("management_scope_id")).map_err(|_| StateFailure::ShadowValidationFailed)?, valid_time: None,
        }], Vec::new(), Vec::new(), vec![current_epoch.root.clone()], Vec::new())?;
        admission.require_access(&impact)?;
        let at = snapshot.now().await?;
        authorization::check_state_output_read(snapshot, &admission, &impact, data.entries.len() as u64, &at).await?;
        Ok::<_, StateError>((data, row.get::<_, i64>("state_epoch"), source_config, at))
    })).await?;
    let bytes = serde_json::to_vec(&data)?;
    if cancellation.is_cancelled() {
        return Err(StateError::Cancelled);
    }
    let blob = content.prepare_blob(&mut bytes.as_slice(), None, cancellation)?;
    let snapshot = StateSnapshot {
        epoch,
        content: blob.reference().clone(),
        checkpoint: None,
        created_at: at,
    };
    Ok(PreparedCheckpoint {
        snapshot,
        data,
        state_epoch,
        source: source.clone(),
        source_config,
        drained,
        content: content.clone(),
        blob,
    })
}

pub(super) fn require_epoch(
    row: &tokio_postgres::Row,
    expected: &StateEpoch,
) -> Result<(), StateError> {
    if row.get::<_, String>("state_root_id") != expected.root.id.as_str()
        || row.get::<_, i64>("state_root_revision") as u64 != expected.root.revision.0
        || row.get::<_, String>("schema_digest") != expected.schema.as_str()
        || row.get::<_, String>("writer_domain") != expected.writer_domain.as_str()
        || row.get::<_, i64>("writer_epoch") as u64 != expected.writer_epoch.0
    {
        return Err(StateFailure::Fenced.into());
    }
    Ok(())
}

pub(super) async fn retain_checkpoint(
    tx: &WorldTransaction<'_>,
    checkpoint: &PreparedCheckpoint,
    migration: &MigrationId,
) -> Result<(), StateError> {
    if tx.commit_id() != checkpoint.commit_id() || tx.world() != &checkpoint.snapshot.epoch.world {
        return Err(StateFailure::CheckpointBarrierUnsatisfied.into());
    }
    checkpoint
        .content
        .retain_prepared(
            tx,
            &checkpoint.blob,
            ContentOwner::State {
                reference: checkpoint.snapshot.epoch.root.clone(),
            },
        )
        .await?;
    checkpoint
        .content
        .retain_prepared(
            tx,
            &checkpoint.blob,
            ContentOwner::Migration {
                id: migration.clone(),
            },
        )
        .await?;
    Ok(())
}
