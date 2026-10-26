use std::collections::BTreeSet;

use world_protocol::{ids::{ActivationLockId, StateRef}, state::StateFailure};

use crate::{extensions::bindings::read_graph_in_transaction, store::{WorldSnapshot, WorldTransaction}};
use super::StateError;

/// Identity evidence only. The caller must still apply its current labels and authorization.
pub(crate) async fn read_exact_state(snapshot: &WorldSnapshot<'_>, reference: &StateRef) -> Result<bool, StateError> {
    if &reference.world != snapshot.world() || reference.revision.0 == 0 || reference.revision.0 > i64::MAX as u64 {
        return Err(StateFailure::Fenced.into());
    }
    Ok(snapshot.query_opt(
        "SELECT 1 FROM world_state_root r JOIN world_state_namespace n ON n.tenant_id=r.tenant_id AND n.world_id=r.world_id AND n.namespace_id=r.namespace_id AND n.state_root_id=r.state_root_id AND n.state_root_revision>=r.revision AND n.schema_digest=r.schema_digest AND n.state_epoch=r.state_epoch JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain AND g.writer_epoch=n.writer_epoch AND g.mode='active' WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.state_root_id=$3 AND r.revision=$4",
        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &reference.id.as_str(), &(reference.revision.0 as i64)],
    ).await?.is_some())
}

pub(crate) async fn read_exact_state_in_transaction(tx: &WorldTransaction<'_>, reference: &StateRef) -> Result<bool, StateError> {
    if &reference.world != tx.world() || reference.revision.0 == 0 || reference.revision.0 > i64::MAX as u64 {
        return Err(StateFailure::Fenced.into());
    }
    Ok(tx.query_opt(
        "SELECT 1 FROM world_state_root r JOIN world_state_namespace n ON n.tenant_id=r.tenant_id AND n.world_id=r.world_id AND n.namespace_id=r.namespace_id AND n.state_root_id=r.state_root_id AND n.state_root_revision>=r.revision AND n.schema_digest=r.schema_digest AND n.state_epoch=r.state_epoch JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain AND g.writer_epoch=n.writer_epoch AND g.mode='active' WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.state_root_id=$3 AND r.revision=$4 FOR SHARE OF n,g",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &(reference.revision.0 as i64)],
    ).await?.is_some())
}

/// Called while the binding owner holds the activation lifecycle row for retirement.
pub(crate) async fn has_activation_references(
    tx: &WorldTransaction<'_>, id: &ActivationLockId,
) -> Result<bool, StateError> {
    let world = tx.world();
    Ok(tx.query_opt(
        "SELECT 1 FROM world_state_activation_ref WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 AND released_at IS NULL LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.is_some())
}

/// Reads the real immutable graph under the same lifecycle lock as package pins.
pub(crate) async fn retain_activation_references(
    tx: &WorldTransaction<'_>, id: &ActivationLockId,
) -> Result<(), StateError> {
    let graph = read_graph_in_transaction(tx, id).await?;
    let world = tx.world();
    let mut seen = BTreeSet::new();
    for state in graph.lock().nodes.iter().filter_map(|node| node.state.as_ref()) {
        if !seen.insert(state.root.clone()) { continue; }
        let revision = i64::try_from(state.root.revision.0).map_err(|_| StateFailure::ShadowValidationFailed)?;
        let row = tx.query_opt(
            "SELECT namespace_id,schema_digest FROM world_state_root WHERE tenant_id=$1 AND world_id=$2 AND state_root_id=$3 AND revision=$4 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &state.root.id.as_str(), &revision],
        ).await?.ok_or(StateFailure::ShadowValidationFailed)?;
        if row.get::<_, String>("namespace_id") != state.namespace.as_str()
            || row.get::<_, String>("schema_digest") != state.schema.as_str() {
            return Err(StateFailure::ShadowValidationFailed.into());
        }
        let migration = state.migration.as_ref().map(|id| id.as_str());
        tx.execute(
            "INSERT INTO world_state_activation_ref(tenant_id,world_id,activation_lock_id,state_root_id,root_revision,migration_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &state.root.id.as_str(), &revision, &migration],
        ).await?;
        let row = tx.query_opt(
            "SELECT migration_id,released_at IS NULL AS live FROM world_state_activation_ref WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 AND state_root_id=$4 AND root_revision=$5 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &state.root.id.as_str(), &revision],
        ).await?.ok_or(StateFailure::ShadowValidationFailed)?;
        if !row.get::<_, bool>("live") || row.get::<_, Option<String>>("migration_id").as_deref() != migration {
            return Err(StateFailure::ShadowValidationFailed.into());
        }
    }
    Ok(())
}
