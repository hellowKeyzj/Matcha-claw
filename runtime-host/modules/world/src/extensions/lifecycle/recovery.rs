use std::{collections::BTreeMap, sync::Arc};

use world_protocol::{
    api::{ConfigValue, PackageConfigView},
    bindings::{BindingChannel, BindingFailure, BindingHead},
    ids::*,
    package::InstalledRecord,
};

use super::LifecycleError;
use crate::{
    extensions::bindings::{self, BindingError, BindingGraph},
    store::{StoreError, WorldStore},
};

pub(crate) struct RecoveryInstall {
    pub record: InstalledRecord,
    pub revision: Revision,
    pub desired_enabled: bool,
    pub pending_removal: bool,
    pub config_revision: Option<Revision>,
    pub config_digest: Option<Digest>,
    pub config: Option<PackageConfigView>,
    pub trust_revision: Option<Revision>,
    pub trusted: bool,
    pub quarantined: bool,
}

pub(crate) struct UnsettledOperation {
    pub id: OperationId,
    pub revision: Revision,
    pub phase: String,
}

/// Durable facts only. New generation IDs and execution resources are never read
/// from storage, and installed/disabled computations do not instantiate a Store.
pub(crate) struct RecoveryInventory {
    pub installs: BTreeMap<InstallId, RecoveryInstall>,
    pub graphs: BTreeMap<
        ActivationLockId,
        Result<Arc<BindingGraph>, world_protocol::bindings::BindingFailure>,
    >,
    pub heads: Vec<BindingHead>,
    pub channels: Vec<BindingChannel>,
    pub blocked_heads: BTreeMap<String, BindingFailure>,
    pub blocked_channels: BTreeMap<String, BindingFailure>,
    pub blocked_installs: BTreeMap<InstallId, RecoveryBlock>,
    pub operations: Vec<UnsettledOperation>,
    pub retirements: Vec<(ActivationLockId, Revision, CommitId)>,
    pub blocked_retirements: BTreeMap<String, BindingFailure>,
}

pub(crate) async fn load_recovery(
    store: &WorldStore,
    world: WorldRef,
) -> Result<RecoveryInventory, LifecycleError> {
    store.snapshot(world, |snapshot| Box::pin(async move {
        let mut installs = BTreeMap::new();
        let mut blocked_installs = BTreeMap::new();
        for row in snapshot.query(
            "SELECT i.install_id,i.revision,i.desired_enabled,i.pending_removal,i.body,c.revision AS config_revision,c.config_digest,c.body AS config_body,t.revision AS trust_revision,t.trusted,t.quarantined FROM world_package_install i LEFT JOIN world_extension_config_head h USING(tenant_id,world_id,install_id) LEFT JOIN world_extension_config_revision c ON c.tenant_id=i.tenant_id AND c.world_id=i.world_id AND c.install_id=i.install_id AND c.revision=h.revision LEFT JOIN world_extension_trust t ON t.tenant_id=i.tenant_id AND t.world_id=i.world_id AND t.package_digest=i.package_digest WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.phase='installed' ORDER BY i.install_id",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()],
        ).await? {
            let id = InstallId::try_new(row.try_get::<_, String>("install_id").map_err(read_error)?).map_err(invalid)?;
            let record: InstalledRecord = match decode(row.try_get("body").map_err(read_error)?) {
                Ok(record) => record,
                Err(_) => { blocked_installs.insert(id, RecoveryBlock::InvalidInventory); continue; }
            };
            if record.install_id != id || &record.world != snapshot.world() {
                blocked_installs.insert(id, RecoveryBlock::InvalidInventory); continue;
            }
            let config_revision = row.try_get::<_, Option<i64>>("config_revision").map_err(read_error)?.map(revision).transpose()?;
            let config_digest = row.try_get::<_, Option<String>>("config_digest").map_err(read_error)?
                .map(Digest::try_new).transpose().map_err(invalid)?;
            let config = match (config_revision, config_digest.as_ref(), row.try_get::<_, Option<serde_json::Value>>("config_body").map_err(read_error)?) {
                (Some(revision), Some(digest), Some(body)) => {
                    match decode::<Vec<ConfigValue>>(body) {
                        Ok(fields) if world_protocol::api::package_config_digest(&fields).ok().as_ref() == Some(digest) => {
                            Some(PackageConfigView { install_id: id.clone(), revision, digest: digest.clone(), fields })
                        }
                        _ => None,
                    }
                }
                _ => None,
            };
            let install = RecoveryInstall {
                record,
                revision: revision(row.try_get("revision").map_err(read_error)?)?,
                desired_enabled: row.try_get("desired_enabled").map_err(read_error)?,
                pending_removal: row.try_get("pending_removal").map_err(read_error)?,
                config_revision, config_digest, config,
                trust_revision: row.try_get::<_, Option<i64>>("trust_revision").map_err(read_error)?.map(revision).transpose()?,
                trusted: row.try_get::<_, Option<bool>>("trusted").map_err(read_error)?.unwrap_or(false),
                quarantined: row.try_get::<_, Option<bool>>("quarantined").map_err(read_error)?.unwrap_or(false),
            };
            installs.insert(id, install);
        }
        let mut graphs = BTreeMap::new();
        for row in snapshot.query(
            "SELECT a.activation_lock_id,l.state FROM world_activation_lock a LEFT JOIN world_activation_lifecycle l USING(tenant_id,world_id,activation_lock_id) WHERE a.tenant_id=$1 AND a.world_id=$2 ORDER BY a.activation_lock_id",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()],
        ).await? {
            let id = ActivationLockId::try_new(row.try_get::<_, String>("activation_lock_id").map_err(read_error)?).map_err(invalid)?;
            if row.try_get::<_, Option<String>>("state").map_err(read_error)?.as_deref() != Some("active") {
                graphs.insert(id.clone(), Err(BindingFailure::LockRetiring { activation_lock_id: id }));
                continue;
            }
            let graph = match bindings::read_graph(snapshot, &id).await {
                Ok(graph) => Ok(Arc::new(graph)),
                Err(BindingError::Store(error)) => return Err(error),
                Err(BindingError::Binding(failure)) => Err(failure),
                Err(_) => Err(BindingFailure::InternalFault),
            };
            graphs.insert(id, graph);
        }
        let mut heads = Vec::new();
        let mut blocked_heads = BTreeMap::new();
        for (key, head) in bindings::read_heads(snapshot).await.map_err(binding_read_error)? {
            match head { Ok(head) => heads.push(head), Err(failure) => { blocked_heads.insert(key, failure); } }
        }
        let mut channels = Vec::new();
        let mut blocked_channels = BTreeMap::new();
        for (key, channel) in bindings::read_channels(snapshot).await.map_err(binding_read_error)? {
            match channel { Ok(channel) => channels.push(channel), Err(failure) => { blocked_channels.insert(key, failure); } }
        }
        let mut operations = Vec::new();
        for row in snapshot.query(
            "SELECT operation_id,revision,phase FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND terminal_at IS NULL ORDER BY operation_id",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()],
        ).await? {
            operations.push(UnsettledOperation {
                id: OperationId::try_new(row.try_get::<_, String>("operation_id").map_err(read_error)?).map_err(invalid)?,
                revision: revision(row.try_get("revision").map_err(read_error)?)?,
                phase: row.try_get("phase").map_err(read_error)?,
            });
        }
        let mut retirements = Vec::new();
        let mut blocked_retirements = BTreeMap::new();
        for (key, retirement) in bindings::read_retirements(snapshot).await.map_err(binding_read_error)? {
            match retirement {
                Ok(retirement) => retirements.push(retirement),
                Err(failure) => { blocked_retirements.insert(key, failure); }
            }
        }
        Ok(RecoveryInventory { installs, graphs, heads, channels, blocked_heads, blocked_channels, blocked_installs,
            operations, retirements, blocked_retirements })
    })).await.map_err(LifecycleError::Store)
}

impl RecoveryInventory {
    /// Failures are local to the exact node; no search for a newer implementation.
    pub fn blocked_node(&self, graph: &BindingGraph, node: &NodeId) -> Option<RecoveryBlock> {
        let Ok(node) = graph.node(node) else {
            return Some(RecoveryBlock::MissingNode);
        };
        if let Some(block) = self.blocked_installs.get(&node.implementation.install_id) {
            return Some(*block);
        }
        let Some(install) = self.installs.get(&node.implementation.install_id) else {
            return Some(RecoveryBlock::MissingPackage);
        };
        if !install.desired_enabled {
            return Some(RecoveryBlock::Disabled);
        }
        if install.pending_removal {
            return Some(RecoveryBlock::PendingRemoval);
        }
        if install.quarantined {
            return Some(RecoveryBlock::Quarantined);
        }
        if !install.trusted {
            return Some(RecoveryBlock::Untrusted);
        }
        if install.record.package_digest != node.implementation.package_digest {
            return Some(RecoveryBlock::MissingPackage);
        }
        if install
            .config
            .as_ref()
            .is_none_or(|config| config.digest != node.implementation.config_digest)
        {
            return Some(RecoveryBlock::Configuration);
        }
        None
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RecoveryBlock {
    MissingNode,
    MissingPackage,
    Disabled,
    PendingRemoval,
    Quarantined,
    Untrusted,
    Configuration,
    InvalidInventory,
}

fn binding_read_error(error: BindingError) -> StoreError {
    match error {
        BindingError::Store(error) => error,
        _ => invalid_state(),
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T, StoreError> {
    serde_json::from_value(value).map_err(|cause| {
        StoreError::caused_by(
            world_protocol::commit::CommitFailure::InternalFault,
            world_protocol::failure::FailureStage::Recover,
            cause,
        )
    })
}
fn revision(value: i64) -> Result<Revision, StoreError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .map(Revision)
        .ok_or_else(invalid_state)
}
fn invalid(cause: impl std::error::Error + Send + Sync + 'static) -> StoreError {
    StoreError::caused_by(
        world_protocol::commit::CommitFailure::InternalFault,
        world_protocol::failure::FailureStage::Recover,
        cause,
    )
}
fn invalid_state() -> StoreError {
    StoreError::new(
        world_protocol::commit::CommitFailure::InternalFault,
        world_protocol::failure::FailureStage::Recover,
    )
}
fn read_error(cause: tokio_postgres::Error) -> StoreError {
    StoreError::database(cause, world_protocol::failure::FailureStage::Recover)
}
