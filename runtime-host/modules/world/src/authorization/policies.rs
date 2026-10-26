use serde::Serialize;
use world_protocol::{
    authorization::{AccessMode, AccessScope, AuthorizationFailure},
    ids::*,
    materials::AccessPolicyRef,
    sources::RetentionPolicy,
    time::Timestamp,
};

use super::read::AuthorityRead;
use super::{
    AccessGrant, Admission, AuthError, AuthorityRoot, PolicyRule, VerifiedInvocation, active,
    actor_id, actual_impact, admit, check_output, decode, encode, recheck,
};
use crate::store::{WorldSnapshot, WorldTransaction};

/// Explicit trusted configuration, never a document role or a deserializable grant.
#[derive(Serialize)]
pub struct InitialPolicy {
    pub rule: PolicyRule,
    pub scope: ScopeId,
    pub mandatory: bool,
    pub available: bool,
}
#[derive(Serialize)]
pub struct InitialRetention {
    pub scope: ScopeId,
    pub policy: RetentionPolicy,
}

impl AuthorityRoot {
    pub(crate) async fn initialize_policy(
        &self,
        tx: &WorldTransaction<'_>,
        input: &InitialPolicy,
    ) -> Result<(), AuthError> {
        tx.require_provision()?;
        require_scope(tx, &input.scope).await?;
        if input.rule.reference.revision != Revision(1) {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        let world = tx.world();
        if tx.query_opt(
            "SELECT 1 FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &input.rule.reference.policy_id.as_str()],
        ).await?.is_some() {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        super::authority::write_policy(
            tx,
            &input.rule,
            &input.scope,
            input.mandatory,
            input.available,
        )
        .await
    }

    pub(crate) async fn initialize_retention(
        &self,
        tx: &WorldTransaction<'_>,
        input: &InitialRetention,
    ) -> Result<(), AuthError> {
        tx.require_provision()?;
        if input.policy.revision != Revision(1) {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        register_retention(tx, input).await
    }
}

pub(crate) struct MaterialPolicies {
    pub access: Vec<AccessPolicyRef>,
    pub retention: Vec<RetentionPolicy>,
}

/// Directory basis grants no item visibility; each item still needs its exact labels and Source.
pub(crate) async fn source_directory_impact(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    now: &Timestamp,
) -> Result<world_protocol::authorization::ActualImpact, AuthError> {
    let mut access = Vec::new();
    for candidate in current_candidates(tx, invocation, now).await? {
        for mut scope in candidate.access {
            if !scope.modes.contains(&AccessMode::Read) {
                continue;
            }
            require_scope(tx, &scope.scope).await?;
            scope.modes = vec![AccessMode::Read];
            access.push(scope);
        }
    }
    if access.is_empty() {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    actual_impact(access, Vec::new(), Vec::new(), Vec::new(), Vec::new())
}

/// Candidate scopes come from actual source grants, never a WorldHead metadata grant.
pub(crate) async fn material_scopes(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    now: &Timestamp,
) -> Result<Vec<ScopeId>, AuthError> {
    let candidates = current_candidates(tx, invocation, now).await?;
    let mut scopes = Vec::new();
    for candidate in candidates {
        if scopes.contains(&candidate.access[0].scope) {
            continue;
        }
        require_scope(tx, &candidate.access[0].scope).await?;
        let impact = actual_impact(
            candidate.access,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )?;
        match super::check_impact_read(tx, invocation, &impact, now).await {
            Ok(()) => scopes.push(impact.access[0].scope.clone()),
            Err(AuthError::Denied(AuthorizationFailure::InsufficientScope)) => continue,
            Err(error) => return Err(error),
        }
    }
    if scopes.is_empty() {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    scopes.sort();
    Ok(scopes)
}

/// Finite resource/field/time intersections are reauthorized before exposing each reference.
pub(crate) async fn material_policies(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    scope: &ScopeId,
    now: &Timestamp,
) -> Result<MaterialPolicies, AuthError> {
    require_scope(tx, scope).await?;
    let candidates = current_candidates(tx, invocation, now)
        .await?
        .into_iter()
        .filter(|grant| &grant.access[0].scope == scope)
        .collect::<Vec<_>>();
    let candidate = candidates
        .first()
        .ok_or(AuthorizationFailure::InsufficientScope)?;
    // Authenticate even when this authorized scope has no configured policies.
    let basis = actual_impact(
        candidate.access.clone(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    let basis_admission = admit(tx, invocation, &basis, &[], None, now).await?;
    check_output(tx, invocation, &basis_admission, &basis, 1, now).await?;
    let world = tx.world();
    let rows = tx.query(
        "SELECT policy_id,revision,policy,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND scope_id=$3 ORDER BY policy_id FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &scope.as_str()],
    ).await?;
    let mut access = Vec::new();
    for row in rows {
        if !row.get::<_, bool>("active") {
            continue;
        }
        let rule = checked_policy(&row)?;
        let visible = candidates
            .iter()
            .filter(|candidate| {
                rule.labels
                    .iter()
                    .all(|label| candidate.labels.contains(label))
            })
            .find_map(|candidate| {
                rule.access
                    .iter()
                    .find_map(|policy_access| intersection(&candidate.access[0], policy_access))
            });
        let Some(candidate) = visible else { continue };
        let impact = actual_impact(
            vec![candidate],
            Vec::new(),
            rule.labels.clone(),
            Vec::new(),
            Vec::new(),
        )?;
        // Mandatory unavailability and explicit deny remain typed refusals, not empty choices.
        let admission = admit(
            tx,
            invocation,
            &impact,
            std::slice::from_ref(&rule.reference),
            None,
            now,
        )
        .await?;
        check_output(tx, invocation, &admission, &impact, 1, now).await?;
        access.push(AccessPolicyRef {
            policy_id: rule.reference.policy_id,
            revision: rule.reference.revision,
            labels: rule.labels,
        });
    }
    let rows = tx.query(
        "SELECT policy_id,revision,record FROM world_auth_retention_policy WHERE tenant_id=$1 AND world_id=$2 AND scope_id=$3 ORDER BY policy_id,revision FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &scope.as_str()],
    ).await?;
    let mut retention = Vec::new();
    for row in rows {
        let policy: RetentionPolicy = decode(row.get("record"))?;
        if policy.policy_id.as_str() != row.get::<_, String>("policy_id")
            || i64::try_from(policy.revision.0).ok() != Some(row.get::<_, i64>("revision"))
        {
            return Err(AuthorizationFailure::InternalFault.into());
        }
        check_output(tx, invocation, &basis_admission, &basis, 1, now).await?;
        retention.push(policy);
    }
    Ok(MaterialPolicies { access, retention })
}

/// The producer supplies the actual Source identity, not just another admitted scope.
pub(crate) async fn require_material_policies(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    source: &SourceId,
    access: &AccessPolicyRef,
    retention: &RetentionPolicy,
    now: &Timestamp,
) -> Result<(), AuthError> {
    recheck(tx, admission, now).await?;
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT policy_id,revision,policy,scope_id,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &access.policy_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
    if !row.get::<_, bool>("active") {
        return Err(AuthorizationFailure::Revoked.into());
    }
    let rule = checked_policy(&row)?;
    if access.policy_id != rule.reference.policy_id
        || access.revision != rule.reference.revision
        || access.labels != rule.labels
    {
        return Err(AuthorizationFailure::PolicyContractMismatch {
            contract_id: rule.reference.contract.id,
        }
        .into());
    }
    let scope = ScopeId::try_new(row.get::<_, String>("scope_id"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    require_scope(tx, &scope).await?;
    let impact = source_impact(admission, &scope, source, &access.labels)?;
    if !super::scope::permits(
        &AccessGrant {
            access: rule.access.clone(),
            labels: rule.labels.clone(),
            effects: rule.effects.clone(),
        },
        &impact,
    ) {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let selected = admit(
        tx,
        admission.verified(),
        &impact,
        &[rule.reference],
        None,
        now,
    )
    .await?;
    recheck(tx, &selected, now).await?;
    require_retention(tx, &scope, retention).await
}

/// A new evaluation case uses its own exact resource, not an invented Source identity.
pub(crate) async fn require_case_policies(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    case: &CaseId,
    scope: &ScopeId,
    access: &AccessPolicyRef,
    retention: &RetentionPolicy,
    now: &Timestamp,
) -> Result<(), AuthError> {
    recheck(tx, admission, now).await?;
    require_scope(tx, scope).await?;
    let (rule, current_scope) = case_policy(tx, access, retention).await?;
    if &current_scope != scope {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let impact = actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::Case { id: case.clone() }],
            fields: Vec::new(),
            modes: vec![AccessMode::Write],
            scope: scope.clone(),
            valid_time: None,
        }],
        Vec::new(),
        access.labels.clone(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    if !super::scope::permits(
        &AccessGrant {
            access: rule.access.clone(),
            labels: rule.labels.clone(),
            effects: rule.effects.clone(),
        },
        &impact,
    ) {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let selected = admit(
        tx,
        admission.verified(),
        &impact,
        &[rule.reference],
        None,
        now,
    )
    .await?;
    recheck(tx, &selected, now).await?;
    require_retention(tx, scope, retention).await
}

/// Resolve capture requirements before admission; this creates no grant or admission.
pub(crate) async fn source_capture_impact(
    tx: &WorldTransaction<'_>,
    scope: &ScopeId,
    source: &SourceId,
    retention: &RetentionPolicy,
    valid_time: &world_protocol::time::ValidTime,
) -> Result<world_protocol::authorization::ActualImpact, AuthError> {
    require_scope(tx, scope).await?;
    require_retention(tx, scope, retention).await?;
    let world = tx.world();
    let rows = tx.query(
        "SELECT policy_id,revision,policy,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND scope_id=$3 ORDER BY policy_id FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &scope.as_str()],
    ).await?;
    let mut matched = None;
    for row in rows {
        if !row.get::<_, bool>("active") {
            continue;
        }
        let rule = checked_policy(&row)?;
        let impact = actual_impact(
            vec![AccessScope {
                scope: scope.clone(),
                resources: vec![ResourceRef::Source { id: source.clone() }],
                fields: Vec::new(),
                modes: vec![AccessMode::Write],
                valid_time: Some(valid_time.clone()),
            }],
            Vec::new(),
            rule.labels.clone(),
            Vec::new(),
            vec![source.clone()],
        )?;
        if !super::scope::permits(
            &AccessGrant {
                access: rule.access,
                labels: rule.labels,
                effects: rule.effects,
            },
            &impact,
        ) {
            continue;
        }
        if !row.get::<_, bool>("available") {
            return Err(AuthorizationFailure::RequiredPolicyUnavailable {
                policy_id: rule.reference.policy_id,
            }
            .into());
        }
        if matched.is_some() {
            return Err(AuthorizationFailure::ObligationUnsatisfied.into());
        }
        matched = Some(impact);
    }
    matched.ok_or_else(|| AuthorizationFailure::InsufficientScope.into())
}

/// Capture has no policy selector in SourceBinding: only an unambiguous current match is valid.
pub(crate) async fn source_capture_policy(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    scope: &ScopeId,
    source: &SourceId,
    retention: &RetentionPolicy,
    now: &Timestamp,
) -> Result<AccessPolicyRef, AuthError> {
    recheck(tx, admission, now).await?;
    require_scope(tx, scope).await?;
    require_retention(tx, scope, retention).await?;
    let world = tx.world();
    let rows = tx.query(
        "SELECT policy_id,revision,policy,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND scope_id=$3 ORDER BY policy_id FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &scope.as_str()],
    ).await?;
    let mut matched = None;
    for row in rows {
        if !row.get::<_, bool>("active") {
            continue;
        }
        let rule = checked_policy(&row)?;
        if !rule
            .labels
            .iter()
            .all(|label| admission.impact().labels.contains(label))
        {
            continue;
        }
        let impact = source_impact(admission, scope, source, &rule.labels)?;
        if !super::scope::permits(
            &AccessGrant {
                access: rule.access.clone(),
                labels: rule.labels.clone(),
                effects: rule.effects.clone(),
            },
            &impact,
        ) {
            continue;
        }
        let current = admit(
            tx,
            admission.verified(),
            &impact,
            std::slice::from_ref(&rule.reference),
            None,
            now,
        )
        .await?;
        recheck(tx, &current, now).await?;
        if matched.is_some() {
            return Err(AuthorizationFailure::ObligationUnsatisfied.into());
        }
        matched = Some(AccessPolicyRef {
            policy_id: rule.reference.policy_id,
            revision: rule.reference.revision,
            labels: rule.labels,
        });
    }
    matched.ok_or_else(|| AuthorizationFailure::InsufficientScope.into())
}

fn source_impact(
    admission: &Admission,
    scope: &ScopeId,
    source: &SourceId,
    labels: &[String],
) -> Result<world_protocol::authorization::ActualImpact, AuthError> {
    let resource = ResourceRef::Source { id: source.clone() };
    let access = admission
        .impact()
        .access
        .iter()
        .filter(|access| {
            &access.scope == scope
                && access.modes.contains(&AccessMode::Write)
                && (access.resources.is_empty() || access.resources.contains(&resource))
        })
        .map(|access| AccessScope {
            scope: scope.clone(),
            resources: vec![resource.clone()],
            fields: Vec::new(),
            modes: vec![AccessMode::Write],
            valid_time: access.valid_time.clone(),
        })
        .collect();
    let impact = actual_impact(
        access,
        Vec::new(),
        labels.to_vec(),
        Vec::new(),
        vec![source.clone()],
    )?;
    admission.require_access(&impact)?;
    Ok(impact)
}

async fn current_candidates(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    now: &Timestamp,
) -> Result<Vec<AccessGrant>, AuthError> {
    let world = tx.world();
    if &invocation.invocation().world != world {
        return Err(AuthorizationFailure::InvalidPrincipal.into());
    }
    let mut candidates =
        actor_candidates(tx, actor_id(&invocation.invocation().actor), now).await?;
    let mut restrictions = Vec::new();
    if let Some(id) = &invocation.invocation().delegation {
        let row = tx.query_opt(
            "SELECT restriction,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_delegation WHERE tenant_id=$1 AND world_id=$2 AND delegation_id=$3 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
        ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
        active(&row, now, AuthorizationFailure::InvalidDelegation)?;
        restrictions.push(decode::<AccessGrant>(row.get("restriction"))?);
    }
    if let Some((id, _)) = &invocation.execution {
        let row = tx.query_opt(
            "SELECT restriction,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_execution WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
        ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
        active(&row, now, AuthorizationFailure::Revoked)?;
        restrictions.push(decode::<AccessGrant>(row.get("restriction"))?);
    }
    if let Some(child) = &invocation.investigation {
        candidates = child.restrict_candidates(candidates);
    }
    for restriction in restrictions {
        candidates = restrict_candidates(candidates, &restriction);
        if candidates.is_empty() {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
    }
    Ok(candidates)
}

pub(super) async fn actor_candidates(
    tx: &WorldTransaction<'_>,
    actor: &ActorId,
    now: &Timestamp,
) -> Result<Vec<AccessGrant>, AuthError> {
    let world = tx.world();
    let rows = tx.query(
        "SELECT \"grant\",active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_grant WHERE tenant_id=$1 AND world_id=$2 AND actor_id=$3 ORDER BY grant_id FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &actor.as_str()],
    ).await?;
    let mut candidates = Vec::new();
    let mut revoked = false;
    for row in rows {
        let grant: AccessGrant = decode(row.get("grant"))?;
        match active(&row, now, AuthorizationFailure::Revoked) {
            Ok(_) => {}
            Err(AuthError::Denied(AuthorizationFailure::Revoked)) => {
                revoked = true;
                continue;
            }
            Err(error) => return Err(error),
        }
        for access in grant.access {
            let resources = access
                .resources
                .iter()
                .filter(|resource| matches!(resource, ResourceRef::Source { .. }))
                .cloned()
                .collect::<Vec<_>>();
            if !access.resources.is_empty() && resources.is_empty() {
                continue;
            }
            for mode in &access.modes {
                if !matches!(mode, AccessMode::Read | AccessMode::Write) {
                    continue;
                }
                candidates.push(AccessGrant {
                    access: vec![AccessScope {
                        resources: resources.clone(),
                        modes: vec![*mode],
                        ..access.clone()
                    }],
                    labels: grant.labels.clone(),
                    effects: grant.effects.clone(),
                });
            }
        }
    }
    if candidates.is_empty() {
        return Err(if revoked {
            AuthorizationFailure::Revoked
        } else {
            AuthorizationFailure::InsufficientScope
        }
        .into());
    }
    Ok(candidates)
}

pub(super) fn restrict_candidates(
    candidates: Vec<AccessGrant>,
    restriction: &AccessGrant,
) -> Vec<AccessGrant> {
    candidates
        .into_iter()
        .flat_map(|candidate| {
            restriction
                .access
                .iter()
                .filter_map(|limit| {
                    intersection(&candidate.access[0], limit).map(|access| AccessGrant {
                        access: vec![access],
                        labels: common(&candidate.labels, &restriction.labels),
                        effects: common(&candidate.effects, &restriction.effects),
                    })
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn intersection(left: &AccessScope, right: &AccessScope) -> Option<AccessScope> {
    if left.scope != right.scope {
        return None;
    }
    let modes = common(&left.modes, &right.modes);
    if modes.is_empty() {
        return None;
    }
    let resources = intersect(&left.resources, &right.resources)?;
    let fields = intersect(&left.fields, &right.fields)?;
    let valid_time = match (&left.valid_time, &right.valid_time) {
        (None, value) | (value, None) => value.clone(),
        (Some(a), Some(b)) => Some(
            world_protocol::time::ValidTime::try_new(
                a.from.clone().max(b.from.clone()),
                match (&a.to, &b.to) {
                    (None, value) | (value, None) => value.clone(),
                    (Some(a), Some(b)) => Some(a.clone().min(b.clone())),
                },
            )
            .ok()?,
        ),
    };
    Some(AccessScope {
        resources,
        fields,
        modes,
        scope: left.scope.clone(),
        valid_time,
    })
}
fn common<T: Clone + PartialEq>(left: &[T], right: &[T]) -> Vec<T> {
    left.iter()
        .filter(|value| right.contains(value))
        .cloned()
        .collect()
}
fn intersect<T: Clone + PartialEq>(left: &[T], right: &[T]) -> Option<Vec<T>> {
    if left.is_empty() {
        return Some(right.to_vec());
    }
    if right.is_empty() {
        return Some(left.to_vec());
    }
    let common = common(left, right);
    (!common.is_empty()).then_some(common)
}

pub(crate) async fn material_read_impact(
    tx: &WorldTransaction<'_>,
    source: &world_protocol::materials::SourceVersion,
) -> Result<world_protocol::authorization::ActualImpact, AuthError> {
    let (_, impact) = read_basis(AuthorityRead::Transaction(tx), source).await?;
    Ok(impact)
}

pub(crate) async fn material_read(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    source: &world_protocol::materials::SourceVersion,
    now: &Timestamp,
) -> Result<Admission, AuthError> {
    let (rule, impact) = read_basis(AuthorityRead::Transaction(tx), source).await?;
    admit(tx, invocation, &impact, &[rule.reference], None, now).await
}

pub(crate) async fn material_read_impact_snapshot(
    snapshot: &WorldSnapshot<'_>,
    source: &world_protocol::materials::SourceVersion,
) -> Result<world_protocol::authorization::ActualImpact, AuthError> {
    let (_, impact) = read_basis(AuthorityRead::Snapshot(snapshot), source).await?;
    Ok(impact)
}

pub(crate) async fn case_read_impact(
    tx: &WorldTransaction<'_>,
    case: &world_protocol::learning::Case,
) -> Result<world_protocol::authorization::ActualImpact, AuthError> {
    let (_, impact) = captured_read_basis(
        AuthorityRead::Transaction(tx),
        &case.world,
        &case.access,
        &case.retention,
        ResourceRef::Case {
            id: case.id.clone(),
        },
        Vec::new(),
    )
    .await?;
    Ok(impact)
}

async fn read_basis(
    tx: AuthorityRead<'_, '_>,
    source: &world_protocol::materials::SourceVersion,
) -> Result<(PolicyRule, world_protocol::authorization::ActualImpact), AuthError> {
    captured_read_basis(
        tx,
        &source.reference.world,
        &source.access,
        &source.retention,
        ResourceRef::Source {
            id: source.reference.source_id.clone(),
        },
        vec![source.reference.source_id.clone()],
    )
    .await
}

pub(crate) async fn policy_reference(
    tx: &WorldTransaction<'_>,
    id: &PolicyId,
    revision: Revision,
) -> Result<world_protocol::authorization::PolicyRef, AuthError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT policy_id,revision,policy,scope_id,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| AuthorizationFailure::RequiredPolicyUnavailable { policy_id: id.clone() })?;
    if !row.get::<_, bool>("active") {
        return Err(AuthorizationFailure::Revoked.into());
    }
    if !row.get::<_, bool>("available") {
        return Err(AuthorizationFailure::RequiredPolicyUnavailable {
            policy_id: id.clone(),
        }
        .into());
    }
    let rule = checked_policy(&row)?;
    if rule.reference.revision != revision {
        return Err(AuthorizationFailure::PolicyContractMismatch {
            contract_id: rule.reference.contract.id,
        }
        .into());
    }
    let scope = ScopeId::try_new(row.get::<_, String>("scope_id"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    require_scope(tx, &scope).await?;
    Ok(rule.reference)
}

pub(super) async fn case_policy(
    tx: &WorldTransaction<'_>,
    access: &AccessPolicyRef,
    retention: &RetentionPolicy,
) -> Result<(PolicyRule, ScopeId), AuthError> {
    let (rule, scope) = current_policy(AuthorityRead::Transaction(tx), access, retention).await?;
    if access.revision != rule.reference.revision || access.labels != rule.labels {
        return Err(AuthorizationFailure::PolicyContractMismatch {
            contract_id: rule.reference.contract.id,
        }
        .into());
    }
    Ok((rule, scope))
}

async fn current_policy(
    tx: AuthorityRead<'_, '_>,
    access: &AccessPolicyRef,
    retention: &RetentionPolicy,
) -> Result<(PolicyRule, ScopeId), AuthError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT policy_id,revision,policy,scope_id,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 FOR SHARE",
        "SELECT policy_id,revision,policy,scope_id,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &access.policy_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
    if !row.get::<_, bool>("active") {
        return Err(AuthorizationFailure::Revoked.into());
    }
    if !row.get::<_, bool>("available") {
        return Err(AuthorizationFailure::RequiredPolicyUnavailable {
            policy_id: access.policy_id.clone(),
        }
        .into());
    }
    let rule = checked_policy(&row)?;
    let scope = ScopeId::try_new(row.get::<_, String>("scope_id"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    require_scope_read(tx, &scope).await?;
    require_retention_read(tx, &scope, retention).await?;
    if access.revision.0 == 0 || access.revision > rule.reference.revision {
        return Err(AuthorizationFailure::PolicyContractMismatch {
            contract_id: rule.reference.contract.id,
        }
        .into());
    }
    Ok((rule, scope))
}

async fn captured_read_basis(
    tx: AuthorityRead<'_, '_>,
    world: &WorldRef,
    access: &AccessPolicyRef,
    retention: &RetentionPolicy,
    resource: ResourceRef,
    source_ids: Vec<SourceId>,
) -> Result<(PolicyRule, world_protocol::authorization::ActualImpact), AuthError> {
    if world != tx.world() {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let (rule, scope) = current_policy(tx, access, retention).await?;
    // Captured policy pins cannot freeze revocation or remove newly required labels.
    let mut labels = access.labels.clone();
    labels.extend(rule.labels.clone());
    let impact = actual_impact(
        vec![AccessScope {
            resources: vec![resource],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope,
            valid_time: None,
        }],
        Vec::new(),
        labels,
        Vec::new(),
        source_ids,
    )?;
    if !super::scope::permits(
        &AccessGrant {
            access: rule.access.clone(),
            labels: impact.labels.clone(),
            effects: rule.effects.clone(),
        },
        &impact,
    ) {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    Ok((rule, impact))
}

fn checked_policy(row: &tokio_postgres::Row) -> Result<PolicyRule, AuthError> {
    let rule: PolicyRule = decode(row.get("policy"))?;
    if rule.reference.policy_id.as_str() != row.get::<_, String>("policy_id")
        || i64::try_from(rule.reference.revision.0).ok() != Some(row.get::<_, i64>("revision"))
    {
        return Err(AuthorizationFailure::InternalFault.into());
    }
    Ok(rule)
}

async fn require_retention(
    tx: &WorldTransaction<'_>,
    scope: &ScopeId,
    policy: &RetentionPolicy,
) -> Result<(), AuthError> {
    require_retention_read(AuthorityRead::Transaction(tx), scope, policy).await
}

async fn require_retention_read(
    tx: AuthorityRead<'_, '_>,
    scope: &ScopeId,
    policy: &RetentionPolicy,
) -> Result<(), AuthError> {
    let revision = i64::try_from(policy.revision.0)
        .ok()
        .filter(|revision| *revision > 0)
        .ok_or(AuthorizationFailure::InsufficientScope)?;
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT scope_id,record FROM world_auth_retention_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 AND revision=$4 FOR SHARE",
        "SELECT scope_id,record FROM world_auth_retention_policy WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &policy.policy_id.as_str(), &revision],
    ).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
    let current: RetentionPolicy = decode(row.get("record"))?;
    if current != *policy || row.get::<_, String>("scope_id") != scope.as_str() {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    Ok(())
}

pub(super) async fn register_retention(
    tx: &WorldTransaction<'_>,
    input: &InitialRetention,
) -> Result<(), AuthError> {
    require_scope(tx, &input.scope).await?;
    let revision = i64::try_from(input.policy.revision.0)
        .ok()
        .filter(|revision| *revision > 0)
        .ok_or(AuthorizationFailure::InsufficientScope)?;
    super::authority::lock(tx).await?;
    let world = tx.world();
    tx.execute(
        "INSERT INTO world_auth_retention_policy(tenant_id,world_id,policy_id,revision,scope_id,record) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &input.policy.policy_id.as_str(), &revision, &input.scope.as_str(), &encode(&input.policy)?],
    ).await?;
    require_retention(tx, &input.scope, &input.policy).await
}

pub(super) async fn require_scope(
    tx: &WorldTransaction<'_>,
    scope: &ScopeId,
) -> Result<(), AuthError> {
    require_scope_read(AuthorityRead::Transaction(tx), scope).await
}

async fn require_scope_read(tx: AuthorityRead<'_, '_>, scope: &ScopeId) -> Result<(), AuthError> {
    let scopes = match tx {
        AuthorityRead::Transaction(tx) => {
            crate::definitions::read_scopes(tx, std::slice::from_ref(scope)).await?
        }
        AuthorityRead::Snapshot(snapshot) => {
            crate::definitions::read_scopes_snapshot(snapshot, std::slice::from_ref(scope)).await?
        }
    };
    if scopes.is_empty()
        || scopes
            .iter()
            .any(|value| value.world != *tx.world() || &value.id != scope)
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    Ok(())
}
