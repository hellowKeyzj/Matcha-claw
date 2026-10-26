use super::MappingError;
use crate::{
    authorization::{self, Admission},
    extensions::invocation::CallBudget,
    store::WorldTransaction,
};
use std::collections::{BTreeMap, BTreeSet};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{BranchSourceContext, BranchSourceContextEntry, BranchSourceContextQuery, SetBranchMapping},
    authorization::{AccessMode, AccessScope, ActualImpact},
    budget::BudgetDimension,
    definitions::{Definition, DefinitionBody},
    ids::*,
    learning::ChangeStatus,
    releases::{BranchRef, WorldBranch},
    sources::{MappingFailure, SourceBinding},
    time::Timestamp,
};

pub(crate) async fn authoring_branch(
    tx: &WorldTransaction<'_>,
    reference: &BranchRef,
) -> Result<WorldBranch, MappingError> {
    if &reference.world != tx.world() {
        return Err(MappingFailure::CrossWorld.into());
    }
    let branch = crate::releases::read_branch(tx, &reference.id)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    if branch.revision != reference.revision || branch.status != ChangeStatus::Proposed {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    Ok(branch)
}

pub(crate) fn context_step(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), MappingError> {
    if cancel.is_cancelled() {
        return Err(MappingFailure::Cancelled.into());
    }
    budget
        .charge(BudgetDimension::Steps, 1)
        .map_err(|error| MappingFailure::BudgetExceeded { dimension: error.dimension })?;
    Ok(())
}

pub(crate) fn context_rows(
    budget: &CallBudget,
    cancel: &CancellationToken,
    count: usize,
) -> Result<(), MappingError> {
    context_step(budget, cancel)?;
    budget
        .charge(BudgetDimension::Rows, count as u64)
        .map_err(|error| MappingFailure::BudgetExceeded { dimension: error.dimension })?;
    budget
        .charge(BudgetDimension::Steps, count as u64)
        .map_err(|error| MappingFailure::BudgetExceeded { dimension: error.dimension })?;
    if count > 4096 {
        return Err(MappingFailure::BudgetExceeded { dimension: BudgetDimension::Rows }.into());
    }
    Ok(())
}

fn context_value_type(
    value: &world_protocol::value::ValueType,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<(), MappingError> {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        context_step(budget, cancel)?;
        match value {
            world_protocol::value::ValueType::List { element, .. } => pending.push(element),
            world_protocol::value::ValueType::Record { fields } => {
                context_rows(budget, cancel, fields.len())?;
                pending.extend(fields.iter().map(|field| &field.value_type));
            }
            _ => {}
        }
    }
    Ok(())
}

async fn context_model(
    tx: &WorldTransaction<'_>,
    request: &BranchSourceContextQuery,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<
    (WorldBranch, Vec<(Definition<SourceBinding>, Vec<Definition<DefinitionBody>>)>),
    MappingError,
> {
    context_step(budget, cancel)?;
    let model = authoring_branch(tx, &request.branch).await?;
    context_rows(budget, cancel, model.compile.definitions.len())?;
    let mut definitions = BTreeMap::new();
    for definition in &model.compile.definitions {
        context_step(budget, cancel)?;
        if definition.reference.world != model.world
            || definition.reference.revision.0 == 0
            || definitions.insert(&definition.reference.id, definition).is_some()
        {
            return Err(MappingFailure::RevisionMismatch.into());
        }
    }
    let mut entries = Vec::new();
    for definition in definitions.values() {
        let DefinitionBody::SourceBinding(body) = &definition.body else { continue; };
        context_step(budget, cancel)?;
        for count in [
            body.selected_fields.len(), body.field_modes.len(), body.identity_mapping.key_fields.len(),
            body.field_mapping.len(), body.role_mapping.len(), body.authority.fields.len(),
            body.authority.roles.len(),
        ] {
            context_rows(budget, cancel, count)?;
        }
        if body.schema.world != model.world || body.mapping.world != model.world || body.identity_rule.world != model.world {
            return Err(MappingFailure::CrossWorld.into());
        }
        budget.charge(BudgetDimension::Steps, model.compile.definitions.len() as u64)
            .map_err(|error| MappingFailure::BudgetExceeded { dimension: error.dimension })?;
        let binding = super::branch_plan::source_binding(&model, &definition.reference)?;
        let target = definitions.get(&body.identity_mapping.type_id).copied().ok_or(MappingFailure::RevisionMismatch)?;
        if binding.scope != body.scope || target.scope != binding.scope
            || !matches!(&target.body, DefinitionBody::ObjectType(_) | DefinitionBody::RelationType(_))
        {
            return Err(MappingFailure::RevisionMismatch.into());
        }
        if body.authority.fields.iter().collect::<BTreeSet<_>>().len() != body.authority.fields.len()
            || body.authority.roles.iter().collect::<BTreeSet<_>>().len() != body.authority.roles.len()
            || (body.authority.fields.is_empty() == body.authority.roles.is_empty())
        {
            return Err(MappingFailure::AuthorityMismatch.into());
        }
        let mut targets = BTreeMap::from([(target.reference.clone(), target.clone())]);
        for reference in body.field_mapping.iter().map(|field| &field.property) {
            context_step(budget, cancel)?;
            let property = definitions.get(&reference.id).copied().ok_or(MappingFailure::RevisionMismatch)?;
            if let DefinitionBody::Property(property) = &property.body { context_rows(budget, cancel, property.domain.len())?; }
            if property.reference != *reference || property.scope != binding.scope || !matches!(&property.body, DefinitionBody::Property(property) if property.domain.contains(&body.identity_mapping.type_id))
                || !body.authority.fields.contains(&reference.id)
            {
                return Err(MappingFailure::RevisionMismatch.into());
            }
            targets.insert(property.reference.clone(), property.clone());
        }
        for id in &body.authority.fields {
            context_step(budget, cancel)?;
            let property = definitions.get(id).copied().ok_or(MappingFailure::AuthorityMismatch)?;
            if property.scope != binding.scope || !matches!(&property.body, DefinitionBody::Property(_)) {
                return Err(MappingFailure::AuthorityMismatch.into());
            }
            targets.insert(property.reference.clone(), property.clone());
        }
        if let DefinitionBody::RelationType(relation) = &target.body {
            context_rows(budget, cancel, relation.roles.len())?;
            let mut roles = BTreeMap::new();
            for role in &relation.roles {
                context_step(budget, cancel)?;
                if roles.insert(&role.id, role).is_some() { return Err(MappingFailure::AuthorityMismatch.into()); }
            }
            if body.role_mapping.iter().any(|role| !body.authority.roles.contains(&role.role)) { return Err(MappingFailure::AuthorityMismatch.into()); }
            for id in body.role_mapping.iter().map(|role| &role.role).chain(body.authority.roles.iter()) {
                context_step(budget, cancel)?;
                let role = roles.get(id).copied().ok_or(MappingFailure::AuthorityMismatch)?;
                let object = definitions.get(&role.target_type.id).copied().ok_or(MappingFailure::RevisionMismatch)?;
                if object.reference != role.target_type || object.scope != binding.scope
                    || !matches!(&object.body, DefinitionBody::ObjectType(_))
                {
                    return Err(MappingFailure::RevisionMismatch.into());
                }
                targets.insert(object.reference.clone(), object.clone());
            }
        } else if !body.role_mapping.is_empty() || !body.authority.roles.is_empty() {
            return Err(MappingFailure::AuthorityMismatch.into());
        }
        context_rows(budget, cancel, targets.len())?;
        entries.push((binding, targets.into_values().collect::<Vec<_>>()));
    }
    entries.sort_by(|left, right| left.0.reference.cmp(&right.0.reference));
    Ok((model, entries))
}

async fn context_impact(
    tx: &WorldTransaction<'_>,
    request: &BranchSourceContextQuery,
    model: &WorldBranch,
    entries: &[(Definition<SourceBinding>, Vec<Definition<DefinitionBody>>)],
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<(ActualImpact, Vec<SourceId>), MappingError> {
    let mut definitions = BTreeMap::new();
    let mut sources = BTreeSet::new();
    for (binding, targets) in entries {
        context_step(budget, cancel)?;
        let mut definition = None;
        for candidate in &model.compile.definitions {
            context_step(budget, cancel)?;
            if candidate.reference == binding.reference { definition = Some(candidate); break; }
        }
        let definition = definition.ok_or(MappingFailure::RevisionMismatch)?;
        definitions.insert(definition.reference.clone(), definition.clone());
        for target in targets {
            context_step(budget, cancel)?;
            definitions.insert(target.reference.clone(), target.clone());
        }
        sources.insert(binding.body.source_id.clone());
    }
    for definition in definitions.values() {
        context_rows(budget, cancel, definition.evidence.len())?;
        context_rows(budget, cancel, definition.dependencies.len())?;
        if let world_protocol::definitions::DefinitionLifecycle::Deprecated { replacements, .. }
            | world_protocol::definitions::DefinitionLifecycle::Split { replacements, .. } = &definition.lifecycle
        { context_rows(budget, cancel, replacements.len())?; }
        match &definition.body {
            DefinitionBody::Property(property) => { context_rows(budget, cancel, property.access_labels.len())?; context_rows(budget, cancel, property.domain.len())?; context_value_type(&property.value_type, budget, cancel)?; }
            DefinitionBody::SourceBinding(binding) => { for field in &binding.field_mapping { context_value_type(&field.source_type, budget, cancel)?; } }
            DefinitionBody::ObjectType(object) => { context_rows(budget, cancel, object.properties.len())?; context_rows(budget, cancel, object.interfaces.len())?; context_rows(budget, cancel, object.source_bindings.len())?; }
            DefinitionBody::RelationType(relation) => { context_rows(budget, cancel, relation.roles.len())?; context_rows(budget, cancel, relation.properties.len())?; }
            _ => {}
        }
    }
    context_step(budget, cancel)?;
    let task = crate::evaluation::read_task(tx, &model.task_id, model.task_revision).await.map_err(crate::releases::Error::from)?;
    let impact = crate::releases::model_impact(tx, &definitions.into_values().collect::<Vec<_>>(), vec![AccessScope {
        resources: vec![ResourceRef::Branch { id: request.branch.id.clone() }], fields: Vec::new(),
        modes: vec![AccessMode::Read], scope: task.scope, valid_time: None,
    }], &[AccessMode::Read]).await?;
    context_rows(budget, cancel, impact.access.len())?;
    context_rows(budget, cancel, impact.labels.len())?;
    context_step(budget, cancel)?;
    Ok((impact, sources.into_iter().collect()))
}

pub(crate) async fn branch_source_context_impact(
    tx: &WorldTransaction<'_>,
    request: &BranchSourceContextQuery,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<(ActualImpact, Vec<SourceId>), MappingError> {
    let (model, entries) = context_model(tx, request, budget, cancel).await?;
    context_impact(tx, request, &model, &entries, budget, cancel).await
}

pub(crate) async fn branch_source_context(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &BranchSourceContextQuery,
    now: &Timestamp,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<BranchSourceContext, MappingError> {
    let (model, entries) = context_model(tx, request, budget, cancel).await?;
    let (impact, _) = context_impact(tx, request, &model, &entries, budget, cancel).await?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, now).await?;
    let mut bindings = Vec::new();
    for (binding, targets) in entries {
        context_step(budget, cancel)?;
        let body = &binding.body;
        let schema = super::read_schema(tx, &body.schema).await?.ok_or_else(|| MappingFailure::SchemaMissing { reference: body.schema.clone() })?;
        if schema.source_id != body.source_id || schema.incarnation != body.incarnation || schema.namespace != body.namespace {
            return Err(MappingFailure::RevisionMismatch.into());
        }
        context_rows(budget, cancel, schema.fields.len())?;
        context_rows(budget, cancel, schema.keys.len())?;
        for field in &schema.fields { context_value_type(&field.value_type, budget, cancel)?; }
        for key in &schema.keys { context_rows(budget, cancel, key.fields.len())?; }
        context_step(budget, cancel)?;
        let mapping = super::persistence::read_authoring_mapping(tx, &binding).await?;
        if let Some(mapping) = &mapping {
            context_rows(budget, cancel, mapping.key_fields.len())?;
            context_rows(budget, cancel, mapping.fields.len())?;
            context_rows(budget, cancel, mapping.relations.len())?;
            for relation in &mapping.relations { context_rows(budget, cancel, relation.roles.len())?; }
            super::compile::validate_mapping(&binding, &schema, mapping)?;
            if !targets.iter().any(|target| target.reference == mapping.type_ref && target.reference.id == body.identity_mapping.type_id)
                || mapping.fields.iter().any(|field| !targets.iter().any(|target| target.reference == field.property && matches!(&target.body, DefinitionBody::Property(_))))
                || mapping.relations.iter().any(|relation| relation.relation_type != mapping.type_ref)
            {
                return Err(MappingFailure::RevisionMismatch.into());
            }
        }
        let authority = super::branch::authoring_authority(tx, &request.branch, &model, &binding, budget, cancel).await?;
        let authority_body = match &authority {
            world_protocol::api::BranchSourceAuthorityState::Draft(authority)
            | world_protocol::api::BranchSourceAuthorityState::Approved(authority) => authority,
        };
        if let world_protocol::facts::AuthorityOwnership::RelationRoles { relation_type, .. } = &authority_body.ownership {
            context_step(budget, cancel)?;
            if !targets.iter().any(|target| target.reference == *relation_type
                && target.reference.id == body.identity_mapping.type_id
                && matches!(&target.body, DefinitionBody::RelationType(_)))
            {
                return Err(MappingFailure::AuthorityMismatch.into());
            }
        }
        bindings.push(BranchSourceContextEntry { binding, targets, schema, mapping, authority });
    }
    context_step(budget, cancel)?;
    Ok(BranchSourceContext { branch: request.branch.clone(), status: model.status, bindings })
}

pub(crate) async fn branch_mapping_impact(
    tx: &WorldTransaction<'_>,
    request: &SetBranchMapping,
) -> Result<ActualImpact, MappingError> {
    let model = authoring_branch(tx, &request.branch).await?;
    let binding = super::branch_plan::source_binding(&model, &request.binding)?;
    let schema = super::read_schema(tx, &binding.body.schema)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    super::compile::validate_mapping(&binding, &schema, &request.mapping)?;
    let fields: Vec<_> = request
        .mapping
        .fields
        .iter()
        .map(|field| field.property.clone())
        .chain(
            request
                .mapping
                .relations
                .iter()
                .map(|relation| relation.relation_type.clone()),
        )
        .collect();
    let mut labels = Vec::new();
    for reference in &fields {
        let definition = model
            .compile
            .definitions
            .iter()
            .find(|definition| definition.reference == *reference)
            .ok_or(MappingFailure::RevisionMismatch)?;
        if definition.scope != binding.scope {
            return Err(MappingFailure::RevisionMismatch.into());
        }
        match &definition.body {
            DefinitionBody::Property(property) => labels.extend(property.access_labels.clone()),
            DefinitionBody::RelationType(_) => {}
            _ => return Err(MappingFailure::RevisionMismatch.into()),
        }
    }
    if !model.compile.definitions.iter().any(|definition| {
        definition.reference == request.mapping.type_ref
            && definition.scope == binding.scope
            && matches!(
                &definition.body,
                DefinitionBody::ObjectType(_) | DefinitionBody::RelationType(_)
            )
    }) {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    Ok(authorization::actual_impact(
        vec![AccessScope {
            resources: vec![
                ResourceRef::Source {
                    id: binding.body.source_id.clone(),
                },
                ResourceRef::Definition {
                    id: binding.reference.id,
                },
                ResourceRef::Branch {
                    id: request.branch.id.clone(),
                },
            ],
            fields,
            modes: vec![AccessMode::Manage],
            scope: binding.scope,
            valid_time: Some(binding.valid_time),
        }],
        Vec::new(),
        labels,
        Vec::new(),
        vec![binding.body.source_id],
    )?)
}

pub(crate) async fn set_branch_mapping(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &SetBranchMapping,
    now: &Timestamp,
) -> Result<(), MappingError> {
    let impact = branch_mapping_impact(tx, request).await?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, now).await?;
    let model = authoring_branch(tx, &request.branch).await?;
    let binding = super::branch_plan::source_binding(&model, &request.binding)?;
    super::persistence::persist_mapping(
        tx,
        &request.mapping,
        &binding.body.source_id,
        &binding.scope,
    )
    .await
}
