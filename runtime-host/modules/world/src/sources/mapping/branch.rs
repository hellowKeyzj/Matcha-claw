use super::{MappingError, persistence::revision};
use crate::{
    authorization::{self, Admission},
    extensions::invocation::CallBudget,
    store::{StoreError, WorldSnapshot, WorldTransaction},
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::BranchSourceAuthorityState,
    authorization::{AccessMode, AccessScope, ActualImpact},
    budget::BudgetDimension,
    commit::CommitFailure,
    definitions::{Definition, DefinitionBody},
    facts::{AuthorityOwnership, SourceAuthority},
    failure::FailureStage,
    ids::*,
    releases::{BranchRef, WorldBranch},
    sources::{AuthorityRef, MappingFailure, SourceBinding},
    time::Timestamp,
};

fn binding(
    branch: &WorldBranch,
    reference: &DefinitionRef,
) -> Result<Definition<SourceBinding>, MappingError> {
    let d = branch
        .compile
        .definitions
        .iter()
        .find(|d| d.reference == *reference)
        .ok_or(MappingFailure::AuthorityMismatch)?;
    let DefinitionBody::SourceBinding(body) = &d.body else {
        return Err(MappingFailure::AuthorityMismatch.into());
    };
    Ok(Definition {
        reference: d.reference.clone(),
        scope: d.scope.clone(),
        valid_time: d.valid_time.clone(),
        body: body.clone(),
        content_digest: d.content_digest.clone(),
        dependencies: d.dependencies.clone(),
        evidence: d.evidence.clone(),
        previous_ref: d.previous_ref.clone(),
        lifecycle: d.lifecycle.clone(),
    })
}

fn check(branch: &WorldBranch, authority: &SourceAuthority) -> Result<Vec<String>, MappingError> {
    check_inner(branch, authority, None)
}

fn check_inner(
    branch: &WorldBranch,
    authority: &SourceAuthority,
    bounded: Option<(&CallBudget, &CancellationToken)>,
) -> Result<Vec<String>, MappingError> {
    if let Some((budget, cancel)) = bounded {
        super::authoring::context_step(budget, cancel)?;
    }
    if let Some((budget, _)) = bounded {
        budget.charge(BudgetDimension::Steps, branch.compile.definitions.len() as u64)
            .map_err(|error| MappingFailure::BudgetExceeded { dimension: error.dimension })?;
    }
    let binding = binding(branch, &authority.binding)?;
    if binding.reference.world != authority.world
        || branch.world != authority.world
        || binding.scope != authority.scope
        || binding.body.scope != authority.scope
        || binding.body.source_id != authority.source_id
        || binding.body.incarnation != authority.incarnation
        || binding.body.authority != authority.authority
        || authority.incarnation.is_empty()
        || authority.authority.revision.0 == 0
        || !crate::definitions::valid_time_contains(&binding.valid_time, &authority.valid_time)
        || !super::persistence::valid_ownership(authority)
    {
        return Err(MappingFailure::AuthorityMismatch.into());
    }
    let fields = match &authority.ownership {
        AuthorityOwnership::Properties { properties } => properties.clone(),
        AuthorityOwnership::RelationRoles { relation_type, .. } => vec![relation_type.clone()],
    };
    let mut labels = Vec::new();
    for reference in &fields {
        let mut definition = None;
        for candidate in &branch.compile.definitions {
            if let Some((budget, cancel)) = bounded { super::authoring::context_step(budget, cancel)?; }
            if candidate.reference == *reference {
                definition = Some(candidate);
                break;
            }
        }
        let definition = definition.ok_or(MappingFailure::AuthorityMismatch)?;
        if definition.scope != authority.scope
            || !crate::definitions::valid_time_contains(
                &definition.valid_time,
                &authority.valid_time,
            )
        {
            return Err(MappingFailure::AuthorityMismatch.into());
        }
        match (&authority.ownership, &definition.body) {
            (AuthorityOwnership::Properties { .. }, DefinitionBody::Property(property)) => {
                if let Some((budget, cancel)) = bounded { super::authoring::context_rows(budget, cancel, property.access_labels.len())?; }
                labels.extend(property.access_labels.clone());
            }
            (
                AuthorityOwnership::RelationRoles { roles, .. },
                DefinitionBody::RelationType(relation),
            ) => {
                for role in roles {
                    let mut found = false;
                    for candidate in &relation.roles {
                        if let Some((budget, cancel)) = bounded { super::authoring::context_step(budget, cancel)?; }
                        if candidate.id == *role { found = true; break; }
                    }
                    if !found { return Err(MappingFailure::AuthorityMismatch.into()); }
                }
            }
            _ => return Err(MappingFailure::AuthorityMismatch.into()),
        }
    }
    Ok(labels)
}

fn checked(
    row: tokio_postgres::Row,
    model: &WorldBranch,
    binding: &DefinitionRef,
    reference: &AuthorityRef,
) -> Result<SourceAuthority, MappingError> {
    checked_inner(row, model, binding, reference, None)
}

fn checked_inner(
    row: tokio_postgres::Row,
    model: &WorldBranch,
    binding: &DefinitionRef,
    reference: &AuthorityRef,
    bounded: Option<(&CallBudget, &CancellationToken)>,
) -> Result<SourceAuthority, MappingError> {
    let authority: SourceAuthority = serde_json::from_value(row.get("body")).map_err(|cause| {
        StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Decode, cause)
    })?;
    if row.get::<_, String>("binding_id") != binding.id.as_str()
        || row.get::<_, i64>("binding_revision") != revision(binding.revision)?
        || &authority.binding != binding
        || &authority.authority != reference
    {
        return Err(MappingFailure::AuthorityMismatch.into());
    }
    if let Some((budget, cancel)) = bounded { authority_rows(&authority, budget, cancel)?; }
    check_inner(model, &authority, bounded)?;
    Ok(authority)
}

fn check_current(
    current: Option<tokio_postgres::Row>,
    authority: &AuthorityRef,
) -> Result<(), MappingError> {
    if let Some(current) = current {
        let revision = current.get::<_, i64>("revision");
        if current.get::<_, String>("status") != "approved"
            || revision > self::revision(authority.revision)?
        {
            return Err(MappingFailure::AuthorityMismatch.into());
        }
    }
    Ok(())
}

pub(crate) async fn read_branch_authority(
    tx: &WorldTransaction<'_>,
    branch: &BranchRef,
    binding: &DefinitionRef,
    authority: &AuthorityRef,
) -> Result<Option<SourceAuthority>, MappingError> {
    if &branch.world != tx.world() || binding.world != branch.world {
        return Err(MappingFailure::CrossWorld.into());
    }
    let model = crate::releases::read_branch_revision(tx, branch)
        .await?
        .ok_or(MappingFailure::AuthorityMismatch)?;
    read_branch_authority_inner(tx, branch, binding, authority, &model, None).await
}

async fn read_branch_authority_inner(
    tx: &WorldTransaction<'_>,
    branch: &BranchRef,
    binding: &DefinitionRef,
    authority: &AuthorityRef,
    model: &WorldBranch,
    bounded: Option<(&CallBudget, &CancellationToken)>,
) -> Result<Option<SourceAuthority>, MappingError> {
    let limit = if let Some((budget, cancel)) = bounded {
        super::authoring::context_step(budget, cancel)?;
        Some(i64::try_from(budget.remaining(BudgetDimension::Rows)
            .map_err(|error| MappingFailure::BudgetExceeded { dimension: error.dimension })?
            .min(4096).saturating_add(1)).map_err(|_| MappingFailure::InternalFault)?)
    } else { None };
    let current = tx.query_opt("SELECT h.revision,r.status FROM world_source_authority_head h JOIN world_source_authority_revision r USING(tenant_id,world_id,policy_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.policy_id=$3 FOR SHARE OF h,r", &[&branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &authority.policy_id.as_str()]).await?;
    check_current(current, authority)?;
    if let Some((budget, cancel)) = bounded { super::authoring::context_step(budget, cancel)?; }
    let rows = tx.query("SELECT branch_revision,binding_id,binding_revision,body FROM world_source_branch_authority WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND branch_revision<=$4 AND policy_id=$5 AND authority_revision=$6 ORDER BY branch_revision DESC LIMIT $7", &[
        &branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &branch.id.as_str(),
        &revision(branch.revision)?, &authority.policy_id.as_str(), &revision(authority.revision)?, &limit,
    ]).await?;
    if let Some((budget, cancel)) = bounded { super::authoring::context_rows(budget, cancel, rows.len())?; }
    let mut selected = None;
    for row in rows {
        if let Some((budget, cancel)) = bounded { super::authoring::context_step(budget, cancel)?; }
        let original = BranchRef {
            world: branch.world.clone(),
            id: branch.id.clone(),
            revision: Revision(
                u64::try_from(row.get::<_, i64>("branch_revision"))
                    .map_err(|_| MappingFailure::AuthorityMismatch)?,
            ),
        };
        let original_model = crate::releases::read_branch_revision(tx, &original)
            .await?
            .ok_or(MappingFailure::AuthorityMismatch)?;
        if let Some((budget, cancel)) = bounded {
            history_model_rows(&original_model, budget, cancel)?;
        }
        if !crate::sources::sync::same_branch_model(&original_model, model) {
            continue;
        }
        let value = checked_inner(row, model, binding, authority, bounded)?;
        if selected.as_ref().is_some_and(|previous| previous != &value) {
            return Err(MappingFailure::AuthorityMismatch.into());
        }
        selected = Some(value);
    }
    Ok(selected)
}

pub(super) async fn authoring_authority(
    tx: &WorldTransaction<'_>,
    branch: &BranchRef,
    model: &WorldBranch,
    binding: &Definition<SourceBinding>,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<BranchSourceAuthorityState, MappingError> {
    let approved = read_branch_authority_inner(
        tx, branch, &binding.reference, &binding.body.authority, model, Some((budget, cancel)),
    ).await?;
    super::authoring::context_step(budget, cancel)?;
    let reference = &binding.body.authority;
    let canonical = tx.query_opt(
        "SELECT policy_id,revision,source_id,scope_id,status,binding_id,binding_revision,body FROM world_source_authority_revision WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 AND revision=$4 FOR SHARE",
        &[&branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &reference.policy_id.as_str(), &revision(reference.revision)?],
    ).await?.map(|row| {
        if row.get::<_, String>("status") != "approved"
            || row.get::<_, String>("policy_id") != reference.policy_id.as_str()
            || row.get::<_, i64>("revision") != revision(reference.revision)?
            || row.get::<_, String>("source_id") != binding.body.source_id.as_str()
            || row.get::<_, String>("scope_id") != binding.scope.as_str()
        {
            return Err(MappingError::from(MappingFailure::AuthorityMismatch));
        }
        checked_inner(row, model, &binding.reference, reference, Some((budget, cancel)))
    }).transpose()?;
    if let Some(approved) = approved {
        if canonical.as_ref().is_some_and(|body| body != &approved) {
            return Err(MappingFailure::AuthorityMismatch.into());
        }
        return Ok(BranchSourceAuthorityState::Approved(approved));
    }
    if let Some(canonical) = canonical {
        return Ok(BranchSourceAuthorityState::Draft(canonical));
    }
    let mut valid_time = binding.valid_time.clone();
    let ownership = if !reference.fields.is_empty() && reference.roles.is_empty() {
        let mut properties = Vec::new();
        for id in &reference.fields {
            super::authoring::context_step(budget, cancel)?;
            budget.charge(BudgetDimension::Steps, model.compile.definitions.len() as u64)
                .map_err(|error| MappingFailure::BudgetExceeded { dimension: error.dimension })?;
            let definition = model.compile.definitions.iter().find(|definition| &definition.reference.id == id)
                .ok_or(MappingFailure::AuthorityMismatch)?;
            intersect_authority_time(&mut valid_time, &definition.valid_time)?;
            properties.push(definition.reference.clone());
        }
        AuthorityOwnership::Properties { properties }
    } else if reference.fields.is_empty() && !reference.roles.is_empty() {
        super::authoring::context_step(budget, cancel)?;
        budget.charge(BudgetDimension::Steps, model.compile.definitions.len() as u64)
            .map_err(|error| MappingFailure::BudgetExceeded { dimension: error.dimension })?;
        let definition = model.compile.definitions.iter().find(|definition| definition.reference.id == binding.body.identity_mapping.type_id)
            .ok_or(MappingFailure::AuthorityMismatch)?;
        if !matches!(&definition.body, DefinitionBody::RelationType(_)) {
            return Err(MappingFailure::AuthorityMismatch.into());
        }
        intersect_authority_time(&mut valid_time, &definition.valid_time)?;
        AuthorityOwnership::RelationRoles { relation_type: definition.reference.clone(), roles: reference.roles.clone() }
    } else {
        return Err(MappingFailure::AuthorityMismatch.into());
    };
    super::authoring::context_step(budget, cancel)?;
    let authority = SourceAuthority {
        incarnation: binding.body.incarnation.clone(), world: branch.world.clone(),
        source_id: binding.body.source_id.clone(), binding: binding.reference.clone(),
        authority: reference.clone(), scope: binding.scope.clone(), valid_time,
        recorded_at: tx.now().await?, ownership,
    };
    authority_rows(&authority, budget, cancel)?;
    check_inner(model, &authority, Some((budget, cancel)))?;
    Ok(BranchSourceAuthorityState::Draft(authority))
}

fn history_model_rows(model: &WorldBranch, budget: &CallBudget, cancel: &CancellationToken) -> Result<(), MappingError> {
    super::authoring::context_step(budget, cancel)?;
    // The sole branch producer already validated nested model and expression limits.
    for count in [
        model.compile.definitions.len(), model.compile.scopes.len(),
        model.compile.targets.len(), model.compile.external_contracts.len(),
        model.compile.activation_lock.nodes.len(), model.compile.activation_lock.edges.len(),
        model.compile.activation_lock.compositions.len(), model.compile.activation_lock.roots.len(),
        model.compile.activation_lock.trusted_roots.len(), model.basis.overlay.len(),
        model.basis.assumptions.len(),
    ] {
        super::authoring::context_rows(budget, cancel, count)?;
    }
    Ok(())
}

fn authority_rows(authority: &SourceAuthority, budget: &CallBudget, cancel: &CancellationToken) -> Result<(), MappingError> {
    super::authoring::context_rows(budget, cancel, authority.authority.fields.len())?;
    super::authoring::context_rows(budget, cancel, authority.authority.roles.len())?;
    match &authority.ownership {
        AuthorityOwnership::Properties { properties } => super::authoring::context_rows(budget, cancel, properties.len()),
        AuthorityOwnership::RelationRoles { roles, .. } => super::authoring::context_rows(budget, cancel, roles.len()),
    }
}

fn intersect_authority_time(
    valid_time: &mut world_protocol::time::ValidTime,
    target: &world_protocol::time::ValidTime,
) -> Result<(), MappingError> {
    *valid_time = world_protocol::time::ValidTime::try_new(
        valid_time.from.clone().max(target.from.clone()),
        match (&valid_time.to, &target.to) {
            (None, value) | (value, None) => value.clone(),
            (Some(left), Some(right)) => Some(left.clone().min(right.clone())),
        },
    ).map_err(|_| MappingFailure::AuthorityMismatch)?;
    Ok(())
}

pub(crate) async fn read_branch_authority_snapshot(
    snapshot: &WorldSnapshot<'_>,
    branch: &BranchRef,
    binding: &DefinitionRef,
    authority: &AuthorityRef,
) -> Result<Option<SourceAuthority>, MappingError> {
    if &branch.world != snapshot.world() || binding.world != branch.world {
        return Err(MappingFailure::CrossWorld.into());
    }
    let model = crate::releases::read_branch_revision_snapshot(snapshot, branch)
        .await?
        .ok_or(MappingFailure::AuthorityMismatch)?;
    let current = snapshot.query_opt("SELECT h.revision,r.status FROM world_source_authority_head h JOIN world_source_authority_revision r USING(tenant_id,world_id,policy_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.policy_id=$3", &[&branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &authority.policy_id.as_str()]).await?;
    check_current(current, authority)?;
    let rows = snapshot.query("SELECT branch_revision,binding_id,binding_revision,body FROM world_source_branch_authority WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND branch_revision<=$4 AND policy_id=$5 AND authority_revision=$6 ORDER BY branch_revision DESC", &[
        &branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &branch.id.as_str(),
        &revision(branch.revision)?, &authority.policy_id.as_str(), &revision(authority.revision)?,
    ]).await?;
    let mut selected = None;
    for row in rows {
        let original = BranchRef {
            world: branch.world.clone(),
            id: branch.id.clone(),
            revision: Revision(
                u64::try_from(row.get::<_, i64>("branch_revision"))
                    .map_err(|_| MappingFailure::AuthorityMismatch)?,
            ),
        };
        let original_model = crate::releases::read_branch_revision_snapshot(snapshot, &original)
            .await?
            .ok_or(MappingFailure::AuthorityMismatch)?;
        if !crate::sources::sync::same_branch_model(&original_model, &model) {
            continue;
        }
        let value = checked(row, &model, binding, authority)?;
        if selected.as_ref().is_some_and(|previous| previous != &value) {
            return Err(MappingFailure::AuthorityMismatch.into());
        }
        selected = Some(value);
    }
    Ok(selected)
}

pub(in crate::sources) async fn promote_branch_binding(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    branch: &BranchRef,
    published_branch: &BranchRef,
    reference: &DefinitionRef,
    release_id: &ReleaseId,
    now: &Timestamp,
) -> Result<(), MappingError> {
    tx.require_domain(
        &WriterDomain::try_new("sources").map_err(|_| MappingFailure::InternalFault)?,
    )?;
    let plan = super::compile_branch_binding(tx, branch, reference).await?;
    let model = crate::releases::read_branch_revision(tx, branch)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let current = crate::releases::read_branch_revision(tx, published_branch)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let release = crate::releases::read_release(tx, release_id)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    if !crate::sources::sync::same_branch_model(&model, &current)
        || release.source_branch.as_ref() != Some(published_branch)
        || release.definitions != current.compile.definitions
        || release.scopes != current.compile.scopes
    {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    let binding = binding(&model, reference)?;
    let index = tx.query_opt("SELECT content_digest FROM world_release_definition WHERE tenant_id=$1 AND world_id=$2 AND release_id=$3 AND definition_id=$4 AND revision=$5", &[&branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &release_id.as_str(), &reference.id.as_str(), &revision(reference.revision)?]).await?.ok_or(MappingFailure::RevisionMismatch)?;
    if index.get::<_, String>("content_digest") != binding.content_digest.as_str() {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    let labels = check(&model, &plan.authority)?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![
                ResourceRef::Source {
                    id: plan.binding_body.source_id.clone(),
                },
                ResourceRef::Branch {
                    id: branch.id.clone(),
                },
                ResourceRef::Definition {
                    id: reference.id.clone(),
                },
            ],
            fields: plan
                .field_definitions
                .iter()
                .map(|d| d.reference.clone())
                .chain(
                    plan.relation_definitions
                        .iter()
                        .map(|d| d.reference.clone()),
                )
                .collect(),
            modes: vec![AccessMode::Manage, AccessMode::Approve],
            scope: plan.binding_body.scope.clone(),
            valid_time: Some(plan.authority.valid_time.clone()),
        }],
        Vec::new(),
        labels,
        Vec::new(),
        vec![plan.binding_body.source_id.clone()],
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, now).await?;
    let w = tx.world();
    let current = tx.query_opt("SELECT h.revision,r.body FROM world_source_authority_head h JOIN world_source_authority_revision r USING(tenant_id,world_id,policy_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.policy_id=$3 FOR UPDATE OF h", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &plan.authority.authority.policy_id.as_str()]).await?;
    let expected = match current {
        Some(row) => {
            let current = Revision(
                u64::try_from(row.get::<_, i64>("revision"))
                    .map_err(|_| MappingFailure::AuthorityMismatch)?,
            );
            if current == plan.authority.authority.revision {
                let body: SourceAuthority =
                    serde_json::from_value(row.get("body")).map_err(|cause| {
                        StoreError::caused_by(
                            CommitFailure::InternalFault,
                            FailureStage::Decode,
                            cause,
                        )
                    })?;
                if body != plan.authority {
                    return Err(MappingFailure::AuthorityMismatch.into());
                }
                None
            } else {
                Some(current)
            }
        }
        None => Some(Revision(0)),
    };
    if let Some(expected) = expected {
        if expected.0.checked_add(1) != Some(plan.authority.authority.revision.0) {
            return Err(MappingFailure::AuthorityMismatch.into());
        }
        super::persistence::persist_authority(tx, &plan.authority, expected).await?;
    }
    let current = tx.query_opt("SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR UPDATE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &reference.id.as_str()]).await?;
    let expected = current
        .map(|row| {
            u64::try_from(row.get::<_, i64>("revision"))
                .map(Revision)
                .map_err(|_| MappingFailure::RevisionMismatch)
        })
        .transpose()?
        .unwrap_or(Revision(0));
    if expected == reference.revision {
        return Ok(());
    }
    if expected.0 >= reference.revision.0 {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    super::persistence::persist_binding(tx, &binding, expected).await
}

pub(crate) async fn approve_branch_authority(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    branch: &BranchRef,
    authority: &SourceAuthority,
    now: &Timestamp,
) -> Result<(), MappingError> {
    tx.require_domain(
        &WriterDomain::try_new("sources").map_err(|_| MappingFailure::InternalFault)?,
    )?;
    if &branch.world != tx.world() || authority.world != branch.world {
        return Err(MappingFailure::CrossWorld.into());
    }
    let impact = branch_authority_impact(tx, branch, authority).await?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, now).await?;
    let body = serde_json::to_value(authority).map_err(|cause| {
        StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, cause)
    })?;
    tx.execute("INSERT INTO world_source_branch_authority(tenant_id,world_id,branch_id,branch_revision,policy_id,authority_revision,binding_id,binding_revision,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING", &[
        &branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &branch.id.as_str(),
        &revision(branch.revision)?, &authority.authority.policy_id.as_str(), &revision(authority.authority.revision)?,
        &authority.binding.id.as_str(), &revision(authority.binding.revision)?, &body,
    ]).await?;
    if read_branch_authority(tx, branch, &authority.binding, &authority.authority)
        .await?
        .as_ref()
        != Some(authority)
    {
        return Err(MappingFailure::AuthorityMismatch.into());
    }
    Ok(())
}

pub(crate) async fn branch_authority_impact(
    tx: &WorldTransaction<'_>,
    branch: &BranchRef,
    authority: &SourceAuthority,
) -> Result<ActualImpact, MappingError> {
    let model = super::authoring_branch(tx, branch).await?;
    let labels = check(&model, authority)?;
    let fields = match &authority.ownership {
        AuthorityOwnership::Properties { properties } => properties.clone(),
        AuthorityOwnership::RelationRoles { relation_type, .. } => vec![relation_type.clone()],
    };
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![
                ResourceRef::Source {
                    id: authority.source_id.clone(),
                },
                ResourceRef::Definition {
                    id: authority.binding.id.clone(),
                },
                ResourceRef::Branch {
                    id: branch.id.clone(),
                },
            ],
            fields,
            modes: vec![AccessMode::Approve, AccessMode::Manage],
            scope: authority.scope.clone(),
            valid_time: Some(authority.valid_time.clone()),
        }],
        Vec::new(),
        labels,
        Vec::new(),
        vec![authority.source_id.clone()],
    )?;
    Ok(impact)
}
