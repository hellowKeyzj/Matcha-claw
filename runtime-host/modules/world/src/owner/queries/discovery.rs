use world_protocol::{api::{DiscoverQuery, MaterialScope, ReadGuarantee, WorldDescription}, authorization::ActualImpact, time::Timestamp};
use crate::{authorization::{self, VerifiedInvocation}, releases, store::WorldTransaction};
use super::super::{Error, head};

pub(crate) async fn impact(tx: &WorldTransaction<'_>) -> Result<ActualImpact, Error> {
    releases::editing_context_impact(tx).await.map_err(Error::from)
}

pub(crate) async fn query(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, _request: &DiscoverQuery, now: &Timestamp,
) -> Result<WorldDescription, Error> {
    let impact = impact(tx).await?;
    let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
    let head = head::read(tx).await?;
    let editing = releases::read_editing_context_in_transaction(tx, &admission).await?;
    let mut material_scopes = Vec::new();
    for scope in authorization::material_scopes(tx, verified, now).await? {
        let policies = authorization::material_policies(tx, verified, &scope, now).await?;
        material_scopes.push(MaterialScope { scope, access: policies.access, retention: policies.retention });
    }
    authorization::check_admitted_output(tx, &admission, &impact, 1, now).await?;
    let (active_release_head, editing_context) = match editing {
        Some((head, compile)) => (Some(head), Some(compile)),
        None => (None, None),
    };
    Ok(WorldDescription {
        world: head.world, revision: head.revision, incarnation: head.generation, status: head.status,
        operations: Vec::new(), active_release: active_release_head.as_ref().map(|head| head.release_id.clone()),
        active_release_head, editing_context, material_scopes,
        read_modes: vec![ReadGuarantee::Projected, ReadGuarantee::Authoritative, ReadGuarantee::After],
    })
}
