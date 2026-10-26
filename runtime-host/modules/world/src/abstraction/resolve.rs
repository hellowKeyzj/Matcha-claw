use std::collections::{BTreeMap, BTreeSet};
use serde::{Deserialize, Serialize};
use foundation::pipeline::PipelineContext;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionFailure, BindingTarget, Fallback},
    definitions::{Definition, DefinitionBody}, expression::{ExpressionIr, TruthValue},
    failure::FieldPath, identity::{IdentityRecord, SubjectRef}, ids::{AbstractionId, DefinitionRef, ParameterId, Revision, SymbolId},
    provenance::ReadDependency, query::{QueryPage, QueryRequest}, value::{Cell, DirtyState, UnknownReason, Value},
};
use crate::{authorization::{self, Admission}, content::Content, extensions::invocation::CallBudget,
    query::{EvalContext, EvalRow, SourceBrokers}, store::{StoreFuture, WorldStore, WorldTransaction}};
use super::{Error, basis::{self, Basis}, check::{self, Checked}};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ConcreteStrategy {
    pub owner: DefinitionRef,
    pub parameters: Vec<world_protocol::expression::Parameter>,
    pub steps: Vec<world_protocol::learning::StrategyStep>,
    pub guards: Vec<(ExpressionIr, Vec<String>)>,
    pub annotations: Vec<world_protocol::compiler::ExpressionAnnotation>,
    pub budget: world_protocol::budget::Budget,
    pub digest: world_protocol::ids::Digest,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConcreteWitness {
    pub strategy: DefinitionRef,
    pub plan_digest: world_protocol::ids::Digest,
    pub reason: TruthValue,
    pub task_digest: world_protocol::ids::Digest,
    pub facts_digest: world_protocol::ids::Digest,
    pub read_receipts: Vec<world_protocol::query::ReadReceipt>,
}

pub(crate) struct ConcreteTask<'a> {
    pub reference: world_protocol::learning::TaskRef,
    pub goal: &'a str,
    pub input_type: &'a world_protocol::value::ValueType,
    pub hard_constraints: &'a [ExpressionIr],
    pub allowed_effects: &'a [world_protocol::expression::Effect],
    pub stop_conditions: &'a [ExpressionIr],
    pub budget: &'a world_protocol::budget::Budget,
}

pub(crate) struct CheckedConcretePlan {
    pub strategy: ConcreteStrategy,
    pub witness: ConcreteWitness,
}

/// ExpandConcrete names one exact executable strategy, never the generic strategy fallback.
pub(crate) fn concrete_strategy(
    contract: &AbstractionContract, definitions: &[Definition<DefinitionBody>], scopes: &[world_protocol::definitions::Scope],
) -> Result<Option<ConcreteStrategy>, Error> {
    let Fallback::ExpandConcrete { concrete_strategy } = &contract.fallback else { return Ok(None); };
    let owner = definitions.iter().find(|definition| definition.reference == *concrete_strategy).ok_or(AbstractionFailure::BasisChanged)?;
    let DefinitionBody::Strategy(strategy) = &owner.body else { return Err(AbstractionFailure::BasisChanged.into()); };
    let mut ids = BTreeSet::new();
    if owner.reference.world != contract.world
        || !crate::definitions::scope_contains(&contract.world, &owner.scope, &contract.scope, scopes).map_err(crate::definitions::DefinitionError::from)?
        || strategy.parameters.len() != contract.parameters.len()
        || strategy.parameters.iter().any(|parameter| !ids.insert(&parameter.id) || !contract.parameters.contains(parameter)) {
        return Err(AbstractionFailure::BasisChanged.into());
    }
    let mut guards = vec![(strategy.guard.clone(), vec!["concreteStrategy".into(), "guard".into()])];
    guards.extend(contract.preserved_invariants.iter().enumerate().map(|(index, expression)| (expression.clone(), vec!["preservedInvariants".into(), index.to_string()])));
    let mut annotations = crate::compiler::check_plan(&strategy.steps, owner, definitions, scopes, &strategy.parameters)?;
    for (guard, path) in &guards {
        annotations.extend(crate::compiler::check_guard(guard, owner, definitions, scopes, &strategy.parameters, &FieldPath(path.clone()))?);
    }
    let digest = crate::definitions::canonical_digest(&("world.strategy.execution-plan.v1", &owner.reference, &owner.content_digest, &owner.body)).map_err(crate::definitions::DefinitionError::from)?;
    Ok(Some(ConcreteStrategy { owner: owner.reference.clone(), parameters: strategy.parameters.clone(), steps: strategy.steps.clone(), guards,
        annotations, budget: strategy.budget.clone(), digest }))
}

/// The authorized caller supplies freshly read raw cells and facts under the original task.
/// This checker emits only the existing Strategy IR for the shared finite/online executor.
pub(crate) fn replan_concrete(
    contract: &AbstractionContract, task: &ConcreteTask<'_>, definitions: &[Definition<DefinitionBody>], scopes: &[world_protocol::definitions::Scope],
    facts: &crate::query::BranchExpressionContext, read_receipts: Vec<world_protocol::query::ReadReceipt>, reason: TruthValue,
    at: &world_protocol::time::Timestamp, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<CheckedConcretePlan, Error> {
    if cancel.is_cancelled() { return Err(AbstractionFailure::Cancelled.into()); }
    budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|_| AbstractionFailure::BudgetExceeded)?;
    budget.restrict(task.budget, at).map_err(|_| AbstractionFailure::BudgetExceeded)?;
    if reason == TruthValue::True || task.reference.world != contract.world || task.reference.id != contract.task_id || task.reference.revision != contract.task_revision {
        return Err(AbstractionFailure::BasisChanged.into());
    }
    let mut strategy = concrete_strategy(contract, definitions, scopes)?.ok_or(AbstractionFailure::BasisChanged)?;
    let owner = definitions.iter().find(|definition| definition.reference == strategy.owner).ok_or(AbstractionFailure::BasisChanged)?;
    crate::definitions::validate_applicability(owner, &contract.scope, facts.row.valid_time.as_ref().ok_or(AbstractionFailure::BasisChanged)?, scopes).map_err(crate::definitions::DefinitionError::from)?;
    if facts.parameters.len() != strategy.parameters.len() { return Err(AbstractionFailure::BasisChanged.into()); }
    for parameter in &strategy.parameters {
        let cell = facts.parameters.get(&parameter.id).ok_or(AbstractionFailure::BasisChanged)?;
        if let Cell::Known { value } = cell { crate::definitions::validate_value(&parameter.value_type, parameter.nullable, value).map_err(crate::definitions::DefinitionError::from)?; }
        if let world_protocol::value::ValueType::Record { fields } = task.input_type {
            if let Some(field) = fields.iter().find(|field| field.name == parameter.id.as_str()) {
                if field.value_type != parameter.value_type || field.nullable != parameter.nullable || field.optional != parameter.optional {
                    return Err(AbstractionFailure::BasisChanged.into());
                }
            }
        }
    }
    for (name, expressions) in [("hardConstraints", task.hard_constraints), ("stopConditions", task.stop_conditions)] {
        for (index, expression) in expressions.iter().enumerate() {
            strategy.annotations.extend(crate::compiler::check_guard(expression, owner, definitions, scopes, &strategy.parameters, &FieldPath(vec![name.into(), index.to_string()]))?);
        }
    }
    for annotation in &strategy.annotations {
        if let Some(effect) = annotation.effects.iter().find(|effect| !task.allowed_effects.contains(effect)) {
            return Err(world_protocol::compiler::CompileFailure::EffectViolation { definition: strategy.owner.clone(), field: annotation.field.clone(), effect: *effect }.into());
        }
    }
    for step in &strategy.steps {
        if let world_protocol::learning::StrategyOperation::Action { action, .. } = &step.operation {
            let target = definitions.iter().find(|definition| definition.reference == *action).ok_or(AbstractionFailure::BasisChanged)?;
            let DefinitionBody::ActionContract(body) = &target.body else { return Err(AbstractionFailure::BasisChanged.into()); };
            if let Some(effect) = body.effects.iter().find(|effect| !task.allowed_effects.contains(effect)) {
                return Err(world_protocol::compiler::CompileFailure::EffectViolation { definition: action.clone(), field: FieldPath(vec!["effects".into()]), effect: *effect }.into());
            }
        }
    }
    budget.restrict(&strategy.budget, at).map_err(|_| AbstractionFailure::BudgetExceeded)?;
    let task_digest = crate::definitions::canonical_digest(&(&task.reference, task.goal, task.input_type, task.hard_constraints, task.allowed_effects, task.stop_conditions, task.budget)).map_err(crate::definitions::DefinitionError::from)?;
    fn row(row: &EvalRow) -> impl Serialize + '_ { (&row.subjects, row.fields.iter().collect::<Vec<_>>(), row.roles.iter().collect::<Vec<_>>(), &row.valid_time) }
    let facts_digest = crate::definitions::canonical_digest(&(
        &facts.parameters, row(&facts.row),
        facts.collections.iter().map(|(symbol, collection)| (symbol, collection.rows.iter().map(row).collect::<Vec<_>>(), &collection.incomplete)).collect::<Vec<_>>(),
        facts.ranges.iter().map(|(id, (symbol, collection))| (id, symbol, collection.rows.iter().map(row).collect::<Vec<_>>(), &collection.incomplete)).collect::<Vec<_>>(),
        &facts.dependencies, facts.incomplete, facts.range_incomplete, &read_receipts,
    )).map_err(crate::definitions::DefinitionError::from)?;
    let witness = ConcreteWitness { strategy: strategy.owner.clone(), plan_digest: strategy.digest.clone(), reason, task_digest, facts_digest, read_receipts };
    Ok(CheckedConcretePlan { strategy, witness })
}

pub(crate) struct ResolutionPlan { contract: AbstractionContract, query: QueryRequest, basis: Basis, checked: Checked }
pub(crate) struct PreparedResolution { plan: ResolutionPlan, query: crate::query::PreparedQuery, budget: CallBudget, cancel: CancellationToken }
pub(crate) enum Resolution {
    Applicable { contract: AbstractionContract, parameters: BTreeMap<ParameterId, Cell>, concrete: QueryPage },
    Expanded { contract: AbstractionContract, parameters: BTreeMap<ParameterId, Cell>, originals: Vec<DefinitionRef>, bindings: world_protocol::abstraction::BindingMap, strategy: ConcreteStrategy, reason: TruthValue, concrete: QueryPage },
    EvidenceRequired { contract: AbstractionContract, evidence: Vec<world_protocol::ids::EvidenceRef>, reason: TruthValue, concrete: QueryPage },
    Stopped { reason: TruthValue },
}

/// A durable contract plus an explicit typed concrete-read plan, never a caller-supplied receipt.
pub(crate) async fn prepare(
    tx: &WorldTransaction<'_>, content: &Content, admission: &Admission,
    id: &AbstractionId, revision: Revision, query: &QueryRequest,
) -> Result<ResolutionPlan, Error> {
    let contract = super::read(tx, id, revision).await?.ok_or(AbstractionFailure::BasisChanged)?;
    let basis = basis::load(tx, content, admission, &contract, false).await?;
    if query.world != contract.world || query.release_id.as_ref() != Some(&contract.base_release)
        || query.branch_id.as_ref() != contract.branch.as_ref().map(|branch| &branch.id)
        || query.known_at.is_some() || query.valid_at.is_some() || query.page.cursor.is_some() {
        return Err(AbstractionFailure::BasisChanged.into());
    }
    let mut originals = contract.original_definitions.clone();
    let mut cursor = 0;
    while cursor < originals.len() {
        let definition = basis.definitions.iter().find(|definition| definition.reference == originals[cursor]).ok_or(AbstractionFailure::BasisChanged)?;
        let references = crate::definitions::definition_references(&definition.body);
        for dependency in definition.dependencies.iter().chain(&references) { if !originals.contains(dependency) { originals.push(dependency.clone()); } }
        cursor += 1;
    }
    if crate::definitions::query_references(&query.query).iter().any(|reference| !originals.contains(reference)) { return Err(AbstractionFailure::BasisChanged.into()); }
    let checked = check::contract(&contract, &basis.definitions, &basis.scopes)?;
    Ok(ResolutionPlan { contract, query: query.clone(), basis, checked })
}

pub(crate) fn execute<'a>(
    store: &'a WorldStore, content: &'a Content, broker: Option<&'a SourceBrokers>, admission: &'a Admission, plan: ResolutionPlan,
    pipeline: &'a PipelineContext, budget: &'a CallBudget, cancel: &'a CancellationToken, deadline: Instant,
) -> StoreFuture<'a, PreparedResolution, Error> {
    Box::pin(async move {
        let now = world_protocol::time::Timestamp::try_new(chrono::Utc::now().to_rfc3339()).map_err(|_| AbstractionFailure::InternalFault)?;
        budget.restrict(&plan.basis.task.budget, &now).map_err(|_| AbstractionFailure::BudgetExceeded)?;
        if cancel.is_cancelled() { return Err(AbstractionFailure::Cancelled.into()); }
        let query = crate::query::execute(store, content, broker, admission, &plan.query, &plan.contract.scope, pipeline, budget, cancel, deadline.min(budget.deadline())).await?;
        Ok(PreparedResolution { plan, query, budget: budget.clone(), cancel: cancel.clone() })
    })
}

pub(crate) async fn commit(
    tx: &mut WorldTransaction<'_>, content: &Content, admission: &Admission, prepared: PreparedResolution,
) -> Result<Resolution, Error> {
    if prepared.cancel.is_cancelled() { return Err(AbstractionFailure::Cancelled.into()); }
    prepared.budget.check().map_err(|_| AbstractionFailure::BudgetExceeded)?;
    let contract = prepared.plan.contract;
    let current = basis::load(tx, content, admission, &contract, false).await?;
    if current.task != prepared.plan.basis.task || current.definitions != prepared.plan.basis.definitions || current.scopes != prepared.plan.basis.scopes {
        return Err(AbstractionFailure::BasisChanged.into());
    }
    let query_impact = prepared.query.impact();
    let impact = authorization::actual_impact(current.impact.access.iter().chain(&query_impact.access).cloned().collect(),
        current.impact.effects.iter().chain(&query_impact.effects).copied().collect(), current.impact.labels.iter().chain(&query_impact.labels).cloned().collect(),
        current.impact.state.iter().chain(&query_impact.state).cloned().collect(), current.impact.source_ids.iter().chain(&query_impact.source_ids).cloned().collect())?;
    admission.require_access(&impact)?;
    let page = crate::query::commit_read(tx, admission, prepared.query).await?;
    let now = tx.now().await?;
    let interval = crate::query::point_interval(&now)?;
    let mut basis_current = current.current;
    for (dependencies, scope) in std::iter::once((contract.read_dependencies.clone(), &contract.scope)).chain(
        contract.binding_map.bindings.iter().map(|binding| (binding.dependencies.iter().cloned()
            .chain(binding.evidence.iter().cloned().map(|reference| ReadDependency::Evidence { reference })).collect(), &binding.inverse_scope)),
    ) {
        if let Err(error) = crate::facts::support::recheck_dependencies_in_model(tx, &dependencies, &current.model, scope, &interval, &now).await {
            if matches!(crate::facts::support::provenance_failure(&error), world_protocol::provenance::ProvenanceFailure::Commit { .. }) { return Err(error.into()); }
            basis_current = false;
        }
    }
    let (parameters, raw_parameters, reason) = mapped_parameters(tx, &contract, &current, &prepared.plan.checked, &page, basis_current, &now, Some(&prepared.budget), &prepared.cancel).await?;
    authorization::check_admitted_output(tx, admission, &impact, (page.rows.items.len() + page.objects.len() + page.relations.len()) as u64, &tx.now().await?).await?;
    if reason == TruthValue::True { return Ok(Resolution::Applicable { contract, parameters, concrete: page }); }
    Ok(match &contract.fallback {
        Fallback::ExpandConcrete { .. } => Resolution::Expanded { originals: contract.original_definitions.clone(), bindings: contract.binding_map.clone(), strategy: concrete_strategy(&contract, &current.definitions, &current.scopes)?.ok_or(AbstractionFailure::BasisChanged)?, contract, parameters: raw_parameters, reason, concrete: page },
        Fallback::RequestEvidence { evidence } => Resolution::EvidenceRequired { evidence: evidence.clone(), reason, contract, concrete: page },
        Fallback::Stop => Resolution::Stopped { reason },
    })
}

/// Reuses one committed concrete page; fresh checks never execute its query again.
pub(super) async fn mapped_parameters(
    tx: &WorldTransaction<'_>, contract: &AbstractionContract, current: &Basis, checked: &Checked, page: &QueryPage,
    basis_current: bool, now: &world_protocol::time::Timestamp, budget: Option<&CallBudget>, cancel: &CancellationToken,
) -> Result<(BTreeMap<ParameterId, Cell>, BTreeMap<ParameterId, Cell>, TruthValue), Error> {
    let (mut parameters, mut row, mut cells, bindings_known) = concrete_parameters(tx, contract, &current.definitions, page).await?;
    for id in &checked.parameter_order {
        let mut values = Vec::new();
        for (index, binding) in contract.binding_map.bindings.iter().enumerate().filter(|(_, binding)| binding.parameter_id.as_ref() == Some(id)) {
            if let BindingTarget::Expression { expression } = &binding.target {
                cells[index] = Some(value(expression, &parameters, &row, &checked, &now, budget, cancel,
                    vec!["bindingMap".into(), "bindings".into(), index.to_string(), "target".into(), "expression".into()])?);
            }
            values.push(cells[index].clone().ok_or(AbstractionFailure::BasisChanged)?);
        }
        let parameter = contract.parameters.iter().find(|parameter| &parameter.id == id).ok_or(AbstractionFailure::BasisChanged)?;
        if !values.is_empty() {
            let slot = contract.binding_map.bindings.iter().find(|binding| binding.parameter_id.as_ref() == Some(id)).and_then(|binding| contract.slots.iter().find(|slot| slot.id == binding.slot_id)).ok_or(AbstractionFailure::BasisChanged)?;
            let cell = if slot.cardinality.maximum == Some(1) { values.remove(0) } else { list(values) };
            if let Cell::Known { value } = &cell { crate::definitions::validate_value(&parameter.value_type, parameter.nullable, value).map_err(|_| AbstractionFailure::TypeMismatch { slot_id: slot.id.clone() })?; }
            parameters.insert(id.clone(), cell);
            bind_row(&mut row, parameter, &parameters[id], &current.definitions, &page)?;
        }
    }
    for (index, binding) in contract.binding_map.bindings.iter().enumerate().filter(|(_, binding)| binding.parameter_id.is_none()) {
        if let BindingTarget::Expression { expression } = &binding.target {
            cells[index] = Some(value(expression, &parameters, &row, &checked, &now, budget, cancel,
                vec!["bindingMap".into(), "bindings".into(), index.to_string(), "target".into(), "expression".into()])?);
        }
    }
    let raw_parameters = parameters.clone();
    let expressions_known = cells.iter().flatten().all(|cell| matches!(cell, Cell::Known { .. }));
    let mut reason = if basis_current && bindings_known && expressions_known && page.receipt.coverage.complete && page.receipt.dirty.is_empty() && page.receipt.truncation.is_none() && page.rows.next_cursor.is_none() {
        TruthValue::True
    } else { TruthValue::Unknown };
    if reason == TruthValue::True {
        // Every transform reads the same current concrete basis, not another binding's partial result.
        let originals = cells.clone();
        for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
            let root = vec!["bindingMap".into(), "bindings".into(), index.to_string()];
            if let Some(guard) = &binding.guard {
                let mut path = root.clone(); path.push("guard".into());
                let truth = crate::query::truth_value(&value(guard, &parameters, &row, &checked, &now, budget, cancel, path)?)?;
                if truth != TruthValue::True { reason = truth; break; }
            }
            if let Some(transform) = &binding.transform {
                let slot = contract.slots.iter().find(|slot| slot.id == binding.slot_id).ok_or(AbstractionFailure::BasisChanged)?;
                let mut path = root; path.push("transform".into());
                let transformed = value(transform, &parameters, &row, &checked, &now, budget, cancel, path)?;
                let Cell::Known { value: actual } = &transformed else { reason = crate::query::truth_value(&transformed).unwrap_or(TruthValue::Unknown); break; };
                crate::definitions::validate_value(&slot.value_type, true, actual).map_err(|_| AbstractionFailure::TypeMismatch { slot_id: slot.id.clone() })?;
                cells[index] = Some(transformed);
            }
        }
        if reason == TruthValue::True {
            for parameter in &contract.parameters {
                let mapped: Vec<_> = contract.binding_map.bindings.iter().enumerate().filter(|(_, binding)| binding.parameter_id.as_ref() == Some(&parameter.id)).collect();
                if mapped.is_empty() { continue; }
                let slot = contract.slots.iter().find(|slot| slot.id == mapped[0].1.slot_id).ok_or(AbstractionFailure::BasisChanged)?;
                let values: Vec<_> = mapped.into_iter().map(|(index, _)| cells[index].clone().ok_or(AbstractionFailure::BasisChanged)).collect::<Result<_, _>>()?;
                let cell = if slot.cardinality.maximum == Some(1) { values.into_iter().next().ok_or(AbstractionFailure::BasisChanged)? } else { list(values) };
                if let Cell::Known { value } = &cell { crate::definitions::validate_value(&parameter.value_type, parameter.nullable, value).map_err(|_| AbstractionFailure::TypeMismatch { slot_id: slot.id.clone() })?; }
                parameters.insert(parameter.id.clone(), cell);
                bind_row(&mut row, parameter, &parameters[&parameter.id], &current.definitions, &page)?;
            }
            for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
                if let Some(inverse) = &binding.inverse_transform {
                    let inverted = value(inverse, &parameters, &row, &checked, &now, budget, cancel,
                        vec!["bindingMap".into(), "bindings".into(), index.to_string(), "inverseTransform".into()])?;
                    if Some(inverted.clone()) != originals[index] { reason = if matches!(inverted, Cell::Known { .. }) { TruthValue::False } else { crate::query::truth_value(&inverted).unwrap_or(TruthValue::Unknown) }; break; }
                }
            }
        }
    }
    if reason == TruthValue::True {
        for (name, expressions) in [("guard", std::slice::from_ref(&contract.guard)), ("assumptions", contract.assumptions.as_slice()), ("preservedInvariants", contract.preserved_invariants.as_slice())] {
            for (index, expression) in expressions.iter().enumerate() {
                let path = if name == "guard" { vec![name.into()] } else { vec![name.into(), index.to_string()] };
                let truth = crate::query::truth_value(&value(expression, &parameters, &row, &checked, &now, budget, cancel, path)?)?;
                if truth != TruthValue::True { reason = truth; break; }
            }
            if reason != TruthValue::True { break; }
        }
    }
    Ok((parameters, raw_parameters, reason))
}

async fn concrete_parameters(
    tx: &WorldTransaction<'_>, contract: &AbstractionContract, definitions: &[Definition<DefinitionBody>], page: &QueryPage,
) -> Result<(BTreeMap<ParameterId, Cell>, EvalRow, Vec<Option<Cell>>, bool), Error> {
    let parameters = contract.parameters.iter().map(|parameter| (parameter.id.clone(), Cell::Unknown { reason: UnknownReason::NotObserved })).collect();
    let mut row = EvalRow::default();
    for parameter in &contract.parameters { bind_row(&mut row, parameter, &Cell::Unknown { reason: UnknownReason::NotObserved }, definitions, page)?; }
    let mut complete = true;
    let mut cells = Vec::with_capacity(contract.binding_map.bindings.len());
    let mut identities = BTreeMap::new();
    for binding in &contract.binding_map.bindings {
        let slot = contract.slots.iter().find(|slot| slot.id == binding.slot_id).ok_or(AbstractionFailure::BasisChanged)?;
        let target = match &binding.target {
            BindingTarget::Object { id } => Some((SubjectRef::Object { id: id.clone() }, Value::Object { id: id.clone() }, page.objects.iter().any(|view| view.object.id == *id))),
            BindingTarget::Relation { id } => Some((SubjectRef::Relation { id: id.clone() }, Value::Relation { id: id.clone() }, page.relations.iter().any(|view| view.relation.id == *id && view.claim.is_some()))),
            _ => None,
        };
        let cell = if let Some((subject, value, observed)) = target {
            let identity = crate::identity::get_in_transaction(tx, &subject).await?;
            if let Some(identity) = identity {
                let actual = match &identity.record {
                    IdentityRecord::Object(object) => world_protocol::value::ValueType::Object { type_id: object.type_id.clone() },
                    IdentityRecord::Relation(relation) => world_protocol::value::ValueType::Relation { type_id: relation.type_id.clone() },
                };
                if actual != slot.value_type { return Err(AbstractionFailure::TypeMismatch { slot_id: slot.id.clone() }.into()); }
                identities.insert(subject, identity);
                complete &= observed;
                Some(if observed { Cell::Known { value } } else { Cell::Unknown { reason: UnknownReason::NotObserved } })
            } else { complete = false; Some(Cell::Unknown { reason: UnknownReason::NotObserved }) }
        } else { None };
        cells.push(cell);
    }
    for identity in identities.values() { crate::identity::recheck_identity(tx, identity).await?; }
    Ok((parameters, row, cells, complete))
}

fn bind_row(
    row: &mut EvalRow, parameter: &world_protocol::expression::Parameter, cell: &Cell,
    definitions: &[Definition<DefinitionBody>], page: &QueryPage,
) -> Result<(), Error> {
    use world_protocol::value::ValueType;
    let type_id = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => return Ok(()) };
    let symbol = SymbolId::try_new(parameter.id.as_str()).map_err(|_| AbstractionFailure::InternalFault)?;
    row.subjects.remove(&symbol);
    for definition in definitions {
        if matches!(&definition.body, DefinitionBody::Property(property) if property.domain.contains(type_id)) {
            row.fields.insert((symbol.clone(), definition.reference.clone()), if matches!(cell, Cell::Known { .. }) { Cell::Unknown { reason: UnknownReason::NotObserved } } else { cell.clone() });
        }
        if definition.reference.id == *type_id {
            if let DefinitionBody::RelationType(body) = &definition.body {
                for role in &body.roles { row.roles.insert((symbol.clone(), role.id.clone()), Cell::Unknown { reason: UnknownReason::NotObserved }); }
            }
        }
    }
    let (subject, fields, relation) = match cell {
        Cell::Known { value: Value::Object { id } } => match page.objects.iter().find(|view| view.object.id == *id && view.object.type_id == *type_id) {
            Some(view) => (SubjectRef::Object { id: id.clone() }, &view.fields, None), None => return Ok(()),
        },
        Cell::Known { value: Value::Relation { id } } => match page.relations.iter().find(|view| view.relation.id == *id && view.relation.type_id == *type_id) {
            Some(view) => (SubjectRef::Relation { id: id.clone() }, &view.fields, Some(view)), None => return Ok(()),
        },
        _ => return Ok(()),
    };
    row.subjects.insert(symbol.clone(), subject);
    for field in fields { row.fields.insert((symbol.clone(), field.property.clone()), if field.dirty == DirtyState::Clean { field.cell.clone() } else { Cell::Unknown { reason: UnknownReason::PendingRecomputation } }); }
    if let Some(view) = relation.filter(|view| view.claim.is_some()) {
        if let Some(Definition { body: DefinitionBody::RelationType(body), .. }) = definitions.iter().find(|definition| definition.reference.id == *type_id) {
            for role in &body.roles {
                let items: Vec<_> = view.roles.iter().filter(|binding| binding.role == role.id).map(|binding| Value::Object { id: binding.object_id.clone() }).collect();
                let cell = if items.len() < role.cardinality.minimum as usize || role.cardinality.maximum.is_some_and(|max| items.len() > max as usize) { Cell::Unknown { reason: UnknownReason::IncompleteCoverage } }
                    else if role.cardinality.maximum == Some(1) { Cell::Known { value: items.into_iter().next().unwrap_or(Value::Null) } }
                    else { Cell::Known { value: Value::List { items } } };
                row.roles.insert((symbol.clone(), role.id.clone()), cell);
            }
        }
    }
    Ok(())
}

pub(super) fn list(cells: Vec<Cell>) -> Cell {
    if let Some(cell) = cells.iter().find(|cell| matches!(cell, Cell::SourceUnavailable { .. })) { return cell.clone(); }
    let mut assertions = std::collections::BTreeSet::new();
    let mut conflicted = false;
    for cell in &cells { if let Cell::Conflicted { assertions: refs } = cell { conflicted = true; assertions.extend(refs.iter().cloned()); } }
    if conflicted { return Cell::Conflicted { assertions: assertions.into_iter().collect() }; }
    if let Some(cell) = cells.iter().find(|cell| matches!(cell, Cell::Unknown { .. })) { return cell.clone(); }
    Cell::Known { value: Value::List { items: cells.into_iter().filter_map(|cell| if let Cell::Known { value } = cell { Some(value) } else { None }).collect() } }
}

fn value(
    expression: &ExpressionIr, parameters: &BTreeMap<ParameterId, Cell>, row: &EvalRow, checked: &Checked,
    at: &world_protocol::time::Timestamp, budget: Option<&CallBudget>, cancel: &CancellationToken, path: Vec<String>,
) -> Result<Cell, Error> {
    let collections = BTreeMap::new();
    let context = EvalContext { parameters, row, collections: &collections, ranges: None, functions: &checked.functions,
        annotations: &checked.annotations, at, max_evaluations: budget.map_or(65_536, |budget| budget.limit().max_steps.saturating_sub(budget.usage().steps)), cancellation: cancel };
    Ok(match budget {
        Some(budget) => crate::query::evaluate_metered(expression, &context, &FieldPath(path), budget)?,
        None => crate::query::evaluate_at(expression, &context, &FieldPath(path))?,
    })
}
