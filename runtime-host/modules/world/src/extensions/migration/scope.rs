use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact, AuthorizationFailure},
    bindings::BindingNode,
    ids::*,
    package::{PackageManifest, RequestedAccess},
    state::{StateEpoch, StateFailure, KV_CHECKPOINT_FORMAT},
};

use crate::{authorization::{self, Admission}, extensions::invocation::InvocationLease};
use super::{StateError, data::{StateData, StateLimits}};

pub(super) const READ_ROOT: &str = "SELECT n.install_id,n.state_root_id,n.state_root_revision,n.schema_digest,n.writer_domain,n.writer_epoch,n.state_epoch,r.namespace_id AS root_namespace,r.schema_digest AS root_schema,r.state_epoch AS root_epoch,r.content_digest,CASE WHEN octet_length(r.body::text)::bigint <= $4 THEN r.body ELSE NULL END AS body,i.package_digest,i.phase,i.desired_enabled,i.pending_removal,p.manifest,t.trusted,t.quarantined,g.mode AS writer_mode,g.writer_epoch AS gate_epoch,h.mode AS storage_mode,h.writer_epoch AS storage_epoch,w.management_scope_id,w.status FROM world_state_namespace n JOIN world_state_root r ON r.tenant_id=n.tenant_id AND r.world_id=n.world_id AND r.state_root_id=n.state_root_id AND r.revision=n.state_root_revision JOIN world_package_install i ON i.tenant_id=n.tenant_id AND i.world_id=n.world_id AND i.install_id=n.install_id JOIN world_package p ON p.tenant_id=i.tenant_id AND p.world_id=i.world_id AND p.package_digest=i.package_digest JOIN world_extension_trust t ON t.tenant_id=p.tenant_id AND t.world_id=p.world_id AND t.package_digest=p.package_digest JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain JOIN world_storage_head h ON h.tenant_id=n.tenant_id AND h.world_id=n.world_id JOIN world_runtime_head w ON w.tenant_id=n.tenant_id AND w.world_id=n.world_id WHERE n.tenant_id=$1 AND n.world_id=$2 AND n.namespace_id=$3";
pub(super) const WRITE_ROOT: &str = "SELECT n.install_id,n.state_root_id,n.state_root_revision,n.schema_digest,n.writer_domain,n.writer_epoch,n.state_epoch,r.namespace_id AS root_namespace,r.schema_digest AS root_schema,r.state_epoch AS root_epoch,r.content_digest,CASE WHEN octet_length(r.body::text)::bigint <= $4 THEN r.body ELSE NULL END AS body,i.package_digest,i.phase,i.desired_enabled,i.pending_removal,p.manifest,t.trusted,t.quarantined,g.mode AS writer_mode,g.writer_epoch AS gate_epoch,h.mode AS storage_mode,h.writer_epoch AS storage_epoch,w.management_scope_id,w.status FROM world_state_namespace n JOIN world_state_root r ON r.tenant_id=n.tenant_id AND r.world_id=n.world_id AND r.state_root_id=n.state_root_id AND r.revision=n.state_root_revision JOIN world_package_install i ON i.tenant_id=n.tenant_id AND i.world_id=n.world_id AND i.install_id=n.install_id JOIN world_package p ON p.tenant_id=i.tenant_id AND p.world_id=i.world_id AND p.package_digest=i.package_digest JOIN world_extension_trust t ON t.tenant_id=p.tenant_id AND t.world_id=p.world_id AND t.package_digest=p.package_digest JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain JOIN world_storage_head h ON h.tenant_id=n.tenant_id AND h.world_id=n.world_id JOIN world_runtime_head w ON w.tenant_id=n.tenant_id AND w.world_id=n.world_id WHERE n.tenant_id=$1 AND n.world_id=$2 AND n.namespace_id=$3 FOR UPDATE OF n FOR SHARE OF i,t,g,h,w";

pub(super) struct CurrentState {
    pub epoch: StateEpoch,
    pub state_epoch: i64,
    pub storage_epoch: WriterEpoch,
    pub data: StateData,
    pub limits: StateLimits,
    pub scope: ScopeId,
}

pub(super) fn pinned_node(admission: &Admission, lease: &InvocationLease, node: &NodeId) -> Result<BindingNode, StateError> {
    if admission.invocation().id != *lease.invocation() || admission.invocation().world != lease.graph().lock().world
        || lease.ledger(node).is_none() || lease.cancellation(node).is_none_or(|token| token.is_cancelled()) {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let node = lease.graph().node(node).map_err(crate::extensions::bindings::BindingError::from)?.clone();
    if node.state.is_none() { return Err(StateFailure::Fenced.into()); }
    Ok(node)
}

pub(super) fn decode_current(world: &WorldRef, node: &BindingNode, row: &tokio_postgres::Row, ceilings: StateLimits, mode: AccessMode) -> Result<CurrentState, StateError> {
    let basis = node.state.as_ref().ok_or(StateFailure::Fenced)?;
    let invalid = || StateError::from(StateFailure::ShadowValidationFailed);
    let root = StateRef {
        world: world.clone(), id: StateRootId::try_new(row.get::<_, String>("state_root_id")).map_err(|_| invalid())?,
        revision: Revision(positive(row.get("state_root_revision"))?),
    };
    if basis.root.world != *world || root.id != basis.root.id || root.revision < basis.root.revision {
        return Err(StateFailure::RootConflict { expected: basis.root.clone(), actual: root }.into());
    }
    if row.get::<_, String>("install_id") != node.implementation.install_id.as_str()
        || row.get::<_, String>("package_digest") != node.implementation.package_digest.as_str()
        || row.get::<_, String>("phase") != "installed" || !row.get::<_, bool>("desired_enabled")
        || row.get::<_, bool>("pending_removal") || !row.get::<_, bool>("trusted") || row.get::<_, bool>("quarantined")
        || row.get::<_, String>("writer_mode") != "active" || row.get::<_, String>("storage_mode") != "active"
        || row.get::<_, String>("status") != "ready" || row.get::<_, String>("writer_domain") != basis.writer_domain.as_str() {
        return Err(StateFailure::Fenced.into());
    }
    let epoch = WriterEpoch(positive(row.get("writer_epoch"))?);
    if epoch != basis.writer_epoch || positive(row.get("gate_epoch"))? != epoch.0 {
        return Err(StateFailure::EpochStale { expected: basis.writer_epoch, actual: epoch }.into());
    }
    let schema = Digest::try_new(row.get::<_, String>("schema_digest")).map_err(|_| invalid())?;
    if schema != basis.schema { return Err(StateFailure::SchemaMismatch { expected: basis.schema.clone(), actual: schema }.into()); }
    if row.get::<_, String>("root_namespace") != basis.namespace.as_str()
        || row.get::<_, String>("root_schema") != basis.schema.as_str()
        || row.get::<_, i64>("root_epoch") != row.get::<_, i64>("state_epoch") { return Err(invalid()); }
    let manifest: PackageManifest = serde_json::from_value(row.get("manifest"))?;
    let declared = manifest.state.iter().find(|state| state.namespace == basis.namespace && state.schema_digest == basis.schema)
        .ok_or(StateFailure::Fenced)?;
    if declared.checkpoint_format.as_str() != KV_CHECKPOINT_FORMAT
        || node.implementation.checkpoint_format.as_ref() != Some(&declared.checkpoint_format) {
        return Err(StateFailure::CheckpointIncompatible { format: declared.checkpoint_format.clone() }.into());
    }
    let requested = manifest.requested_access.iter().any(|request| match request {
        RequestedAccess::StateRead { namespace } if mode == AccessMode::Read => namespace == &basis.namespace,
        RequestedAccess::StateWrite { namespace } if mode == AccessMode::Write => namespace == &basis.namespace,
        _ => false,
    });
    if !requested { return Err(AuthorizationFailure::InsufficientScope.into()); }
    let limits = StateLimits {
        maximum_keys: ceilings.maximum_keys.min(manifest.limits.budget.max_rows),
        maximum_bytes: ceilings.maximum_bytes.min(manifest.limits.budget.max_bytes).min(manifest.limits.memory_bytes),
    };
    let body: serde_json::Value = row.get::<_, Option<serde_json::Value>>("body").ok_or(StateFailure::SizeLimit)?;
    let data: StateData = serde_json::from_value(body)?;
    data.validate(limits)?;
    if data.digest()?.as_str() != row.get::<_, String>("content_digest") { return Err(invalid()); }
    Ok(CurrentState {
        epoch: StateEpoch { world: world.clone(), namespace: basis.namespace.clone(), root,
            writer_domain: basis.writer_domain.clone(), writer_epoch: epoch, schema: basis.schema.clone(),
            checkpoint_format: declared.checkpoint_format.clone() },
        state_epoch: row.get("state_epoch"), storage_epoch: WriterEpoch(positive(row.get("storage_epoch"))?), data, limits,
        scope: ScopeId::try_new(row.get::<_, String>("management_scope_id")).map_err(|_| invalid())?,
    })
}

impl CurrentState {
    pub(super) fn impact(&self, mode: AccessMode) -> Result<ActualImpact, StateError> {
        Ok(authorization::actual_impact(vec![AccessScope {
            resources: vec![ResourceRef::State { id: self.epoch.root.id.clone() }], fields: Vec::new(),
            modes: vec![mode], scope: self.scope.clone(), valid_time: None,
        }], Vec::new(), Vec::new(), vec![self.epoch.root.clone()], Vec::new())?)
    }
}

fn positive(value: i64) -> Result<u64, StateError> {
    u64::try_from(value).ok().filter(|value| *value > 0).ok_or_else(|| StateFailure::ShadowValidationFailed.into())
}
