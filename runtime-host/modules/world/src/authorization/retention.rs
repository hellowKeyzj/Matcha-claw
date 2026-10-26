use world_protocol::{
    authorization::{AccessScope, Decision, PolicyObligation},
    ids::*,
};

use super::{AccessGrant, ApprovalRecord, AuthError, NativeContext, PolicyRule, decode};
use crate::store::{RetentionRoots, WorldTransaction};

/// Security rows survive logical deletion, including revoked historical grants.
/// Their exact typed references must not lose the business facts they describe.
pub(crate) async fn world_deletion_roots(
    tx: &WorldTransaction<'_>,
) -> Result<RetentionRoots, AuthError> {
    let mut roots = RetentionRoots::default();
    let world = tx.world();
    let parameters: &[&(dyn tokio_postgres::types::ToSql + Sync)] =
        &[&world.tenant_id.as_str(), &world.world_id.as_str()];
    for row in tx.query(
        "SELECT \"grant\" AS body FROM world_auth_grant WHERE tenant_id=$1 AND world_id=$2 UNION ALL SELECT restriction AS body FROM world_auth_delegation WHERE tenant_id=$1 AND world_id=$2 UNION ALL SELECT restriction AS body FROM world_auth_execution WHERE tenant_id=$1 AND world_id=$2",
        parameters,
    ).await? {
        access(&mut roots, decode::<AccessGrant>(row.get("body"))?.access);
    }
    for row in tx
        .query(
            "SELECT context FROM world_auth_execution WHERE tenant_id=$1 AND world_id=$2",
            parameters,
        )
        .await?
    {
        let context: NativeContext = decode(row.get("context"))?;
        if let Some(id) = context.task_id {
            roots.resources.push(ResourceRef::Task { id });
        }
        if let Some(id) = context.branch_id {
            roots.resources.push(ResourceRef::Branch { id });
        }
    }
    for row in tx
        .query(
            "SELECT scope_id,policy FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2",
            parameters,
        )
        .await?
    {
        roots.scopes.push(scope(row.get("scope_id"))?);
        let policy: PolicyRule = decode(row.get("policy"))?;
        access(&mut roots, policy.access);
        obligations(&mut roots, policy.reference.obligations);
    }
    for row in tx
        .query(
            "SELECT scope_id FROM world_auth_retention_policy WHERE tenant_id=$1 AND world_id=$2",
            parameters,
        )
        .await?
    {
        roots.scopes.push(scope(row.get("scope_id"))?);
    }
    for row in tx
        .query(
            "SELECT binding FROM world_auth_approval WHERE tenant_id=$1 AND world_id=$2",
            parameters,
        )
        .await?
    {
        let record: ApprovalRecord = decode(row.get("binding"))?;
        roots.definitions.push(record.binding.contract);
        roots.resources.push(ResourceRef::Operation {
            id: record.operation_id,
        });
    }
    for row in tx
        .query(
            "SELECT decision FROM world_auth_decision WHERE tenant_id=$1 AND world_id=$2",
            parameters,
        )
        .await?
    {
        let decision: Decision = decode(row.get("decision"))?;
        obligations(&mut roots, decision.obligations);
    }
    if roots
        .definitions
        .iter()
        .any(|reference| &reference.world != world)
    {
        return Err(world_protocol::authorization::AuthorizationFailure::InternalFault.into());
    }
    roots.scopes.sort();
    roots.scopes.dedup();
    roots.resources.sort();
    roots.resources.dedup();
    roots.definitions.sort();
    roots.definitions.dedup();
    Ok(roots)
}

fn access(roots: &mut RetentionRoots, access: Vec<AccessScope>) {
    for scope in access {
        roots.scopes.push(scope.scope);
        roots.resources.extend(scope.resources);
        roots.definitions.extend(scope.fields);
    }
}

fn obligations(roots: &mut RetentionRoots, obligations: Vec<PolicyObligation>) {
    for obligation in obligations {
        if let PolicyObligation::Redact { fields } = obligation {
            roots
                .resources
                .extend(fields.into_iter().map(|id| ResourceRef::Definition { id }));
        }
    }
}

fn scope(value: String) -> Result<ScopeId, AuthError> {
    ScopeId::try_new(value)
        .map_err(|_| world_protocol::authorization::AuthorizationFailure::InternalFault.into())
}
