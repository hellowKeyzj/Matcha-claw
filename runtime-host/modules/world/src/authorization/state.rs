use super::{Admission, AuthError, actual_impact, read::AuthorityRead};
use world_protocol::{
    authorization::{ActualImpact, AuthorizationFailure},
    ids::*,
};

/// Captured with admission so a data revision cannot hide a schema/namespace/epoch change.
#[derive(Clone)]
pub(super) struct StateBasis {
    root: StateRef,
    namespace: String,
    schema: String,
    domain: String,
    writer_epoch: i64,
    state_epoch: i64,
}

pub(super) async fn capture(
    read: AuthorityRead<'_, '_>,
    roots: &[StateRef],
) -> Result<Vec<StateBasis>, AuthError> {
    let mut basis = Vec::with_capacity(roots.len());
    for root in roots {
        if &root.world != read.world() {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        let world = read.world();
        let row = read.query_opt(
            "SELECT n.namespace_id,n.schema_digest,n.writer_domain,n.writer_epoch,n.state_epoch,r.namespace_id AS root_namespace,r.schema_digest AS root_schema,r.state_epoch AS root_epoch,g.mode,g.writer_epoch AS gate_epoch FROM world_state_namespace n JOIN world_state_root r ON r.tenant_id=n.tenant_id AND r.world_id=n.world_id AND r.state_root_id=n.state_root_id AND r.revision=n.state_root_revision JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain WHERE n.tenant_id=$1 AND n.world_id=$2 AND n.state_root_id=$3 AND n.state_root_revision=$4 FOR SHARE OF n,r,g",
            "SELECT n.namespace_id,n.schema_digest,n.writer_domain,n.writer_epoch,n.state_epoch,r.namespace_id AS root_namespace,r.schema_digest AS root_schema,r.state_epoch AS root_epoch,g.mode,g.writer_epoch AS gate_epoch FROM world_state_namespace n JOIN world_state_root r ON r.tenant_id=n.tenant_id AND r.world_id=n.world_id AND r.state_root_id=n.state_root_id AND r.revision=n.state_root_revision JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain WHERE n.tenant_id=$1 AND n.world_id=$2 AND n.state_root_id=$3 AND n.state_root_revision=$4",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &root.id.as_str(), &i64::try_from(root.revision.0).map_err(|_| AuthorizationFailure::InsufficientScope)?],
        ).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
        let value = StateBasis {
            root: root.clone(),
            namespace: row.get("namespace_id"),
            schema: row.get("schema_digest"),
            domain: row.get("writer_domain"),
            writer_epoch: row.get("writer_epoch"),
            state_epoch: row.get("state_epoch"),
        };
        if row.get::<_, String>("root_namespace") != value.namespace
            || row.get::<_, String>("root_schema") != value.schema
            || row.get::<_, i64>("root_epoch") != value.state_epoch
            || row.get::<_, String>("mode") != "active"
            || row.get::<_, i64>("gate_epoch") != value.writer_epoch
        {
            return Err(AuthorizationFailure::Revoked.into());
        }
        basis.push(value);
    }
    Ok(basis)
}

pub(super) async fn require_current(
    read: AuthorityRead<'_, '_>,
    admission: &Admission,
    impact: &ActualImpact,
) -> Result<(), AuthError> {
    super::scope::validate_impact(impact)?;
    if impact.state.is_empty() || read.world() != &admission.invocation().world {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let mut previous = Vec::with_capacity(impact.state.len());
    for root in &impact.state {
        let basis = admission
            .state_basis
            .iter()
            .find(|basis| basis.root.world == root.world && basis.root.id == root.id)
            .ok_or(AuthorizationFailure::InsufficientScope)?;
        if root.revision < basis.root.revision {
            return Err(AuthorizationFailure::Revoked.into());
        }
        if root != &basis.root && admission.approval().is_some() {
            return Err(AuthorizationFailure::ApprovalDigestMismatch.into());
        }
        previous.push(basis.root.clone());
    }
    let restricted = actual_impact(
        impact.access.clone(),
        impact.effects.clone(),
        impact.labels.clone(),
        previous,
        impact.source_ids.clone(),
    )?;
    admission.require_access(&restricted)?;
    for current in capture(read, &impact.state).await? {
        let basis = admission
            .state_basis
            .iter()
            .find(|basis| {
                basis.root.world == current.root.world && basis.root.id == current.root.id
            })
            .ok_or(AuthorizationFailure::InsufficientScope)?;
        if current.namespace != basis.namespace
            || current.schema != basis.schema
            || current.domain != basis.domain
            || current.writer_epoch != basis.writer_epoch
            || current.state_epoch != basis.state_epoch
        {
            return Err(AuthorizationFailure::Revoked.into());
        }
    }
    Ok(())
}
