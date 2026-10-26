use std::collections::{BTreeMap, BTreeSet};

use crate::{
    authorization::{self, Admission},
    content::{Content, BlobPin},
    definitions,
    store::{Committed, WorldStore, WorldTransaction},
};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    definitions::{Definition, DefinitionBody, Scope},
    evaluation::{EvaluationArm, EvaluationFailure, FrozenKnowledge, FrozenPlan, PlanReference, PlanSelection},
    expression::{Effect, ExpressionIr},
    ids::{DefinitionRef, ResourceRef, ScopeId, WorldRef},
    learning::{ChangeSet, SemanticOperation, StrategyOperation, TaskContract},
    materials::{BlobRef, SourceVersionRef},
    value::Value,
};
use super::{Error, records};

type Model = Definition<DefinitionBody>;

/// Bytes come only from Content's confirmed, digest-checked read, not a caller Value.
pub(crate) struct SuiteMemory {
    reference: SourceVersionRef,
    blob: BlobRef,
    value: Value,
    pin: BlobPin,
}
impl SuiteMemory {
    pub(crate) fn pin(&self) -> &BlobPin { &self.pin }
}
pub(crate) async fn load_suite_memory(content: &Content, store: &WorldStore, reference: SourceVersionRef, committed: &Committed<BlobPin>) -> Result<SuiteMemory, Error> {
    let bytes = content.read_pinned(store, committed).await?;
    let value = serde_json::from_slice(&bytes).map_err(|_| super::invalid("plans.knowledge.snapshot"))?;
    Ok(SuiteMemory { reference, blob: committed.value.reference().clone(), value, pin: committed.value.clone() })
}

pub(super) fn validate_shape(world: &WorldRef, arm: &EvaluationArm, plan: &FrozenPlan) -> Result<(), Error> {
    if plan.strategy.world != *world || plan.strategy.revision.0 == 0
        || plan.definitions.is_empty() || plan.definitions.len() > 4096 || plan.scopes.len() > 4096
        || !matches!((arm, &plan.knowledge),
            (EvaluationArm::ToolMemory, FrozenKnowledge::ToolMemory { .. })
            | (EvaluationArm::StaticOntology, FrozenKnowledge::StaticOntology { .. })
            | (EvaluationArm::AppendOnly, FrozenKnowledge::AppendOnly { .. }))
    { return Err(EvaluationFailure::BasisChanged.into()); }
    let validator = definitions::DefinitionValidator::new(&plan.definitions, &plan.scopes)
        .map_err(|failure| Error::Compile(world_protocol::compiler::CompileFailure::Definition { failure }))?;
    let mut ids = BTreeSet::new();
    let mut scopes = BTreeSet::new();
    for scope in &plan.scopes {
        if scope.world != *world || !scopes.insert(&scope.id) { return Err(EvaluationFailure::BasisChanged.into()); }
    }
    for definition in &plan.definitions {
        if definition.reference.world != *world || !ids.insert(&definition.reference.id) {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        validator.validate(definition).map_err(|failure| Error::Compile(world_protocol::compiler::CompileFailure::Definition { failure }))?;
    }
    let owner = exact(&plan.definitions, &plan.strategy)?;
    let DefinitionBody::Strategy(strategy) = &owner.body else { return Err(EvaluationFailure::BasisChanged.into()); };
    crate::compiler::check_plan(&strategy.steps, owner, &plan.definitions, &plan.scopes, &strategy.parameters).map_err(Error::Compile)?;
    crate::compiler::check_guard(&strategy.guard, owner, &plan.definitions, &plan.scopes, &strategy.parameters,
        &world_protocol::failure::FieldPath(vec!["guard".into()])).map_err(Error::Compile)?;
    let mut tools = BTreeSet::new();
    for reference in &plan.tools {
        if !tools.insert(reference) { return Err(EvaluationFailure::BasisChanged.into()); }
        exact(&plan.definitions, reference)?;
    }
    if let FrozenKnowledge::ToolMemory { snapshot, memory_function } = &plan.knowledge {
        if snapshot.world != *world { return Err(EvaluationFailure::BasisChanged.into()); }
        let memory = exact(&plan.definitions, memory_function)?;
        let DefinitionBody::Function(function) = &memory.body else { return Err(EvaluationFailure::BasisChanged.into()); };
        if !function.parameters.is_empty() || function.effects != [Effect::Pure]
            || !matches!(function.expression, ExpressionIr::Literal { .. })
            || !strategy.steps.iter().any(|step| matches!(&step.operation, StrategyOperation::Function { function, .. } if function == memory_function))
        { return Err(super::invalid("plans.knowledge.memoryFunction").into()); }
    }
    Ok(())
}

fn exact<'a>(definitions: &'a [Model], reference: &DefinitionRef) -> Result<&'a Model, Error> {
    definitions.iter().find(|definition| &definition.reference == reference).ok_or_else(|| EvaluationFailure::BasisChanged.into())
}

fn closure<'a>(definitions: &'a [Model], roots: &[DefinitionRef]) -> Result<BTreeMap<DefinitionRef, &'a Model>, Error> {
    let mut pending = roots.to_vec();
    let mut result = BTreeMap::new();
    while let Some(reference) = pending.pop() {
        if result.contains_key(&reference) { continue; }
        let definition = exact(definitions, &reference)?;
        pending.extend(definition.dependencies.iter().cloned());
        pending.extend(definitions::definition_references(&definition.body));
        for resource in definitions::definition_resources(&definition.body) {
            if let ResourceRef::Definition { id } = resource {
                let target = definitions.iter().find(|definition| definition.reference.id == id)
                    .ok_or(EvaluationFailure::BasisChanged)?;
                pending.push(target.reference.clone());
            }
        }
        result.insert(reference, definition);
    }
    Ok(result)
}

pub(super) fn require_common_tools(plans: &[PlanSelection], candidate: &world_protocol::compiler::CompileRequest) -> Result<(), Error> {
    use world_protocol::compiler::ExternalContractKind;
    let mut roots: Vec<_> = candidate.external_contracts.iter().filter_map(|external| match &external.kind {
        ExternalContractKind::Function { reference } => Some(reference.clone()),
        ExternalContractKind::Source { binding, .. } => Some(binding.clone()),
        _ => None,
    }).collect();
    let bindings = roots.clone();
    for definition in &candidate.definitions {
        if matches!(&definition.body, DefinitionBody::ActionContract(action) if bindings.contains(&action.source_operation.binding)) {
            roots.push(definition.reference.clone());
        }
    }
    let expected = closure(&candidate.definitions, &roots)?;
    for selected in plans {
        let PlanReference::Frozen(plan) = &selected.plan else { continue; };
        if closure(&plan.definitions, &plan.tools)? != expected { return Err(EvaluationFailure::BasisChanged.into()); }
        for model in expected.values() {
            let scope = candidate.scopes.iter().find(|scope| scope.id == model.scope).ok_or(EvaluationFailure::BasisChanged)?;
            if !plan.scopes.contains(scope) { return Err(EvaluationFailure::BasisChanged.into()); }
        }
    }
    Ok(())
}

pub(crate) async fn plans_impact(tx: &WorldTransaction<'_>, task: &TaskContract, plans: &[PlanSelection]) -> Result<ActualImpact, Error> {
    let mut access = Vec::new();
    let mut labels = Vec::new();
    let mut sources = Vec::new();
    let current = crate::releases::read_active_model(tx).await?;
    for selected in plans {
        match &selected.plan {
            PlanReference::Frozen(plan) => {
                validate_shape(tx.world(), &selected.arm, plan)?;
                for definition in &plan.definitions {
                    access.push(read(ResourceRef::Definition { id: definition.reference.id.clone() }, &definition.scope));
                    if let DefinitionBody::Property(property) = &definition.body { labels.extend(property.access_labels.clone()); }
                    if let Some(current) = current.as_ref().and_then(|release| release.definitions.iter().find(|model| model.reference.id == definition.reference.id)) {
                        access.push(read(ResourceRef::Definition { id: current.reference.id.clone() }, &current.scope));
                        if let DefinitionBody::Property(property) = &current.body { labels.extend(property.access_labels.clone()); }
                    }
                    for reference in &definition.evidence {
                        let evidence = crate::facts::assertions::read_evidence(tx, reference).await.map_err(Error::Fact)?.ok_or(EvaluationFailure::BasisChanged)?;
                        access.push(read(ResourceRef::Evidence { id: reference.id.clone() }, &definition.scope));
                        let version = crate::content::read_source_version_in_transaction(tx, &evidence.locator.source_version).await?;
                        let actual = authorization::material_read_impact(tx, &version).await?;
                        access.extend(actual.access); labels.extend(actual.labels); labels.extend(evidence.access.labels); sources.extend(actual.source_ids);
                    }
                }
                let release_id = match &plan.knowledge {
                    FrozenKnowledge::StaticOntology { release_id } => Some(release_id),
                    FrozenKnowledge::AppendOnly { anchor_release, .. } => Some(anchor_release),
                    FrozenKnowledge::ToolMemory { .. } => None,
                };
                if let Some(release_id) = release_id {
                    let release = crate::releases::read_release(tx, release_id).await?.ok_or(EvaluationFailure::BasisChanged)?;
                    let actual = crate::releases::model_impact(tx, &release.definitions, Vec::new(), &[AccessMode::Read]).await?;
                    access.extend(actual.access); labels.extend(actual.labels); sources.extend(actual.source_ids);
                    for definition in &release.definitions {
                        if let Some(current) = current.as_ref().and_then(|release| release.definitions.iter().find(|model| model.reference.id == definition.reference.id)) {
                            access.push(read(ResourceRef::Definition { id: current.reference.id.clone() }, &current.scope));
                            if let DefinitionBody::Property(property) = &current.body { labels.extend(property.access_labels.clone()); }
                        }
                    }
                }
                match &plan.knowledge {
                    FrozenKnowledge::ToolMemory { snapshot, .. } => {
                        let version = crate::content::read_source_version_in_transaction(tx, snapshot).await?;
                        let actual = authorization::material_read_impact(tx, &version).await?;
                        access.extend(actual.access); labels.extend(actual.labels); sources.extend(actual.source_ids);
                    }
                    FrozenKnowledge::StaticOntology { .. } => {}
                    FrozenKnowledge::AppendOnly { changes, .. } => {
                        for change in changes {
                            access.push(read(ResourceRef::ChangeSet { id: change.id.clone() }, &task.scope));
                            for reference in &change.evidence {
                                let evidence = crate::facts::assertions::read_evidence(tx, reference).await.map_err(Error::Fact)?.ok_or(EvaluationFailure::BasisChanged)?;
                                access.push(read(ResourceRef::Evidence { id: reference.id.clone() }, &task.scope));
                                let version = crate::content::read_source_version_in_transaction(tx, &evidence.locator.source_version).await?;
                                let actual = authorization::material_read_impact(tx, &version).await?;
                                access.extend(actual.access); labels.extend(actual.labels); labels.extend(evidence.access.labels); sources.extend(actual.source_ids);
                            }
                        }
                    }
                }
            }
            PlanReference::Strategy(reference) => access.push(read(ResourceRef::Definition { id: reference.id.clone() }, &task.scope)),
            PlanReference::Abstraction { .. } => {}
        }
    }
    Ok(authorization::actual_impact(access, Vec::new(), labels, Vec::new(), sources)?)
}
fn read(resource: ResourceRef, scope: &ScopeId) -> AccessScope {
    AccessScope { resources: vec![resource], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None }
}

pub(super) async fn validate_sources(tx: &WorldTransaction<'_>, admission: &Admission, task: &TaskContract, plans: &[PlanSelection], memories: &[SuiteMemory]) -> Result<(), Error> {
    admission.require_access(&plans_impact(tx, task, plans).await?)?;
    for selected in plans {
        let PlanReference::Frozen(plan) = &selected.plan else {
            if !matches!(selected.arm, EvaluationArm::Candidate | EvaluationArm::Ablation { .. }) { return Err(EvaluationFailure::BasisChanged.into()); }
            continue;
        };
        validate_shape(tx.world(), &selected.arm, plan)?;
        let ids: Vec<_> = plan.scopes.iter().map(|scope| scope.id.clone()).collect();
        let scopes = definitions::read_scopes(tx, &ids).await?;
        if scopes.len() != plan.scopes.len() || plan.scopes.iter().any(|scope| !scopes.contains(scope)) {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        let tools = closure(&plan.definitions, &plan.tools)?;
        if let FrozenKnowledge::ToolMemory { snapshot, memory_function } = &plan.knowledge {
            let loaded = memories.iter().find(|memory| &memory.reference == snapshot).ok_or(EvaluationFailure::BasisChanged)?;
            let version = crate::content::read_source_version_in_transaction(tx, snapshot).await?;
            if loaded.blob != version.blob { return Err(EvaluationFailure::BasisChanged.into()); }
            crate::content::validate_pin(tx, &loaded.pin).await?;
            let memory = exact(&plan.definitions, memory_function)?;
            let DefinitionBody::Function(function) = &memory.body else { return Err(EvaluationFailure::BasisChanged.into()); };
            if function.expression != (ExpressionIr::Literal { value: loaded.value.clone() }) { return Err(EvaluationFailure::BasisChanged.into()); }
            definitions::validate_value(&function.result_type, false, &loaded.value).map_err(|_| super::invalid("plans.knowledge.memoryValue"))?;
        }
        let knowledge = frozen_knowledge(tx, plan).await?;
        if let FrozenKnowledge::AppendOnly { changes, .. } = &plan.knowledge {
            for change in changes {
                crate::facts::assertions::require_evidence(tx, admission, &change.evidence, &task.scope, None, &tx.now().await?).await.map_err(Error::Fact)?;
            }
        };
        let mut roots = vec![plan.strategy.clone()];
        roots.extend(plan.tools.iter().cloned());
        for expression in task.hard_constraints.iter().chain(&task.stop_conditions) { roots.extend(definitions::expression_references(expression)); }
        let used = closure(&plan.definitions, &roots)?;
        if used.len() != plan.definitions.len() { return Err(super::invalid("plans.definitions.closure").into()); }
        for definition in &plan.definitions {
            if tools.contains_key(&definition.reference) || knowledge.get(&definition.reference) == Some(definition) { continue; }
            let memory = matches!(&plan.knowledge, FrozenKnowledge::ToolMemory { memory_function, .. } if memory_function == &definition.reference);
            let helper = definition.reference == plan.strategy || memory
                || matches!(&definition.body, DefinitionBody::Function(function) if function.effects == [Effect::Pure] && parameter_expression(&function.expression));
            if !helper { return Err(super::invalid("plans.knowledge.definition").into()); }
        }
        let knowledge_definitions: Vec<_> = knowledge.values().cloned().collect();
        let mut knowledge_roots = Vec::new();
        for definition in &plan.definitions {
            if let Some(source) = knowledge.values().find(|source| source.reference.id == definition.reference.id) {
                if *source != *definition { return Err(EvaluationFailure::BasisChanged.into()); }
                knowledge_roots.push(source.reference.clone());
            }
            crate::facts::assertions::require_evidence(tx, admission, &definition.evidence, &definition.scope, Some(&definition.valid_time), &tx.now().await?).await.map_err(Error::Fact)?;
        }
        for required in closure(&knowledge_definitions, &knowledge_roots)?.values() {
            if !plan.definitions.contains(required) { return Err(EvaluationFailure::BasisChanged.into()); }
        }
    }
    Ok(())
}
pub(crate) async fn frozen_inline_definitions(tx: &WorldTransaction<'_>, model: &super::FrozenArmPlan) -> Result<Vec<DefinitionRef>, Error> {
    let PlanReference::Frozen(plan) = model.plan() else { return Ok(Vec::new()); };
    let tools = closure(&plan.definitions, &plan.tools)?;
    let knowledge = frozen_knowledge(tx, plan).await?;
    Ok(plan.definitions.iter().filter(|definition| !tools.contains_key(&definition.reference)
        && knowledge.get(&definition.reference) != Some(*definition)).map(|definition| definition.reference.clone()).collect())
}

async fn frozen_knowledge(tx: &WorldTransaction<'_>, plan: &FrozenPlan) -> Result<BTreeMap<DefinitionRef, Model>, Error> {
    let definitions = match &plan.knowledge {
        FrozenKnowledge::ToolMemory { .. } => return Ok(BTreeMap::new()),
        FrozenKnowledge::StaticOntology { release_id } => {
            let release = crate::releases::read_release(tx, release_id).await?.ok_or(EvaluationFailure::BasisChanged)?;
            require_scopes(&plan.scopes, &release.scopes)?;
            release.definitions
        }
        FrozenKnowledge::AppendOnly { anchor_release, changes } => {
            let release = crate::releases::read_release(tx, anchor_release).await?.ok_or(EvaluationFailure::BasisChanged)?;
            require_scopes(&plan.scopes, &release.scopes)?;
            let mut definitions = release.definitions;
            let mut seen = BTreeSet::new();
            for change in changes {
                if change.world != *tx.world() || !seen.insert((&change.id, change.revision)) { return Err(EvaluationFailure::BasisChanged.into()); }
                let branch = require_change(tx, change).await?;
                for operation in &change.operations {
                    if !matches!(operation, SemanticOperation::CreateDefinition { .. } | SemanticOperation::NoOp { .. } | SemanticOperation::AttachEvidence { .. } | SemanticOperation::EnrichAnnotation { .. } | SemanticOperation::LinkExisting { .. }) {
                        return Err(super::invalid("plans.knowledge.changes.appendOnly").into());
                    }
                }
                let base = crate::releases::read_release(tx, &change.base_release).await?.ok_or(EvaluationFailure::BasisChanged)?;
                if base.definitions.len() != definitions.len() || base.definitions.iter().any(|model| !definitions.contains(model)) {
                    return Err(EvaluationFailure::BasisChanged.into());
                }
                definitions = crate::learning::materialize_frozen(tx, &branch).await
                    .map_err(|error| Error::Owner(error.into()))?.definitions().to_vec();
            }
            definitions
        }
    };
    Ok(definitions.into_iter().map(|model| (model.reference.clone(), model)).collect())
}

fn parameter_expression(expression: &ExpressionIr) -> bool {
    match expression {
        ExpressionIr::Parameter { .. } => true,
        ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => parameter_expression(operand),
        ExpressionIr::Binary { left, right, .. } => parameter_expression(left) && parameter_expression(right),
        ExpressionIr::All { terms } | ExpressionIr::Any { terms } => terms.iter().all(parameter_expression),
        ExpressionIr::If { condition, then_value, else_value } => parameter_expression(condition) && parameter_expression(then_value) && parameter_expression(else_value),
        ExpressionIr::Call { arguments, .. } => arguments.iter().all(parameter_expression),
        _ => false,
    }
}
fn require_scopes(actual: &[Scope], source: &[Scope]) -> Result<(), Error> {
    if source.iter().any(|scope| !actual.contains(scope)) { return Err(EvaluationFailure::BasisChanged.into()); }
    Ok(())
}
async fn require_change(tx: &WorldTransaction<'_>, expected: &ChangeSet) -> Result<world_protocol::releases::WorldBranch, Error> {
    let row = tx.query_opt("SELECT branch_id,branch_revision,content_digest,body FROM world_change_set WHERE tenant_id=$1 AND world_id=$2 AND change_set_id=$3 AND revision=$4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &expected.id.as_str(), &records::revision(expected.revision)?]).await?.ok_or(EvaluationFailure::BasisChanged)?;
    let change: ChangeSet = records::decode(row.get("body"))?;
    if change != *expected || records::digest(&change)?.as_str() != row.get::<_, String>("content_digest") { return Err(EvaluationFailure::BasisChanged.into()); }
    let reference = world_protocol::releases::BranchRef {
        world: tx.world().clone(),
        id: world_protocol::ids::BranchId::try_new(row.get::<_, String>("branch_id")).map_err(|_| EvaluationFailure::BasisChanged)?,
        revision: world_protocol::ids::Revision(u64::try_from(row.get::<_, i64>("branch_revision")).map_err(|_| EvaluationFailure::BasisChanged)?),
    };
    let branch = crate::releases::read_branch_revision(tx, &reference).await?.ok_or(EvaluationFailure::BasisChanged)?;
    if branch.change_set_id != change.id || branch.basis.release_id != change.base_release || branch.basis.overlay != change.operations || branch.status != change.status {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    Ok(branch)
}
