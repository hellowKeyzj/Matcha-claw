use std::collections::{BTreeMap, BTreeSet};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::{AccessMode, AccessScope}, compiler::{DefinitionIr, ExpressionAnnotation},
    definitions::{Definition, DefinitionBody}, expression::{Effect, ExpressionIr, Parameter},
    facts::{Assertion, AssertionOrigin, AssertionStatus, Claim, Polarity}, failure::FieldPath,
    identity::{IdentityRecord, SubjectRef}, ids::*, provenance::{ConclusionSupport, ReadDependency},
    query::{QueryArgument, QueryColumn, QueryFailure, QueryIr, QueryNode}, releases::Release, time::{Timestamp, ValidTime},
    value::{Cell, DirtyState, UnknownReason, Value, ValueType},
};
use crate::{authorization::{self, Admission, VerifiedInvocation}, extensions::invocation::CallBudget, facts::assertions, store::WorldTransaction};

#[derive(Clone, Copy)]
pub(super) enum ReadAuthority<'a> { Verified(&'a VerifiedInvocation), Admitted(&'a Admission) }
impl<'a> ReadAuthority<'a> {
    pub(super) fn verified(self) -> &'a VerifiedInvocation { match self { Self::Verified(value) => value, Self::Admitted(value) => value.verified() } }
    pub(super) async fn check(self, tx: &WorldTransaction<'_>, impact: &world_protocol::authorization::ActualImpact, now: &Timestamp) -> Result<(), QueryError> {
        match self {
            Self::Verified(verified) => authorization::check_impact_read(tx, verified, impact, now).await?,
            Self::Admitted(admission) => { authorization::recheck(tx, admission, now).await?; admission.require_access(impact)?; },
        }
        Ok(())
    }
}

use super::{QueryError, EvalCollection, EvalContext, EvalRow, engine, error::invalid, projection};

/// Canonical expressions, typed parameters and current authorized facts are the only inputs.
#[derive(Clone)]
pub(crate) struct CurrentEvaluation {
    pub parameters: BTreeMap<ParameterId, Cell>, pub row: EvalRow,
    pub collections: BTreeMap<SymbolId, EvalCollection>, pub ranges: BTreeMap<DefinitionId, (SymbolId, EvalCollection)>, pub functions: BTreeMap<DefinitionRef, DefinitionIr>,
    pub annotations: Vec<ExpressionAnnotation>, pub dependencies: Vec<ReadDependency>,
    pub incomplete: bool, pub range_incomplete: bool, pub budget: CallBudget, pub cancel: CancellationToken,
    pub read_receipt: Option<world_protocol::query::ReadReceipt>,
}
impl CurrentEvaluation {
    pub fn value(&self, expression: &ExpressionIr, path: &[String], at: &Timestamp) -> Result<Cell, QueryError> {
        self.budget.check().map_err(super::execution::budget_error)?;
        Ok(super::evaluate::evaluate_metered(expression, &EvalContext { parameters: &self.parameters, row: &self.row,
            collections: &self.collections, ranges: Some(&self.ranges), functions: &self.functions, annotations: &self.annotations,
            at, max_evaluations: self.budget.limit().max_steps.saturating_sub(self.budget.usage().steps), cancellation: &self.cancel }, &FieldPath(path.to_vec()), &self.budget)?)
    }
}

pub(crate) async fn release(tx: &WorldTransaction<'_>, id: &ReleaseId, branch: Option<&BranchId>) -> Result<Release, QueryError> {
    let mut release = crate::releases::read_release(tx, id).await?.ok_or_else(|| invalid("releaseId"))?;
    release.source_branch = None;
    if let Some(id) = branch {
        let branch = crate::releases::read_branch(tx, id).await?.ok_or_else(|| invalid("branchId"))?;
        if branch.basis.release_id != release.id { return Err(QueryFailure::BasisChanged.into()); }
        let reference = world_protocol::releases::BranchRef { world: branch.world, id: branch.id, revision: branch.revision };
        return Ok(super::branch::model(tx, &reference, &world_protocol::evaluation::EvaluationArm::Candidate).await?.1);
    }
    Ok(release)
}

pub(crate) async fn release_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, id: &ReleaseId, branch: Option<&BranchId>) -> Result<Release, QueryError> {
    let mut release = crate::releases::read_release_snapshot(snapshot, id).await?.ok_or_else(|| invalid("releaseId"))?;
    release.source_branch = None;
    if let Some(id) = branch {
        let branch = crate::releases::read_branch_snapshot(snapshot, id).await?.ok_or_else(|| invalid("branchId"))?;
        if branch.basis.release_id != release.id { return Err(QueryFailure::BasisChanged.into()); }
        let reference = world_protocol::releases::BranchRef { world: branch.world, id: branch.id, revision: branch.revision };
        return Ok(super::branch::model_snapshot(snapshot, &reference, &world_protocol::evaluation::EvaluationArm::Candidate).await?.1);
    }
    Ok(release)
}

pub(super) async fn prepare(
    tx: &WorldTransaction<'_>, admission: &Admission, owner: &Definition<DefinitionBody>,
    release: &Release, declarations: &[Parameter], arguments: &[QueryArgument],
    expressions: &[&ExpressionIr], annotations: Vec<ExpressionAnnotation>, scope: &ScopeId,
    interval: &ValidTime, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp,
) -> Result<CurrentEvaluation, QueryError> {
    Ok(prepare_cells(tx, admission, owner, release, declarations, &engine::parameters(declarations, arguments)?, expressions, annotations, scope, interval, budget, cancel, at).await?.0)
}
async fn prepare_cells(
    tx: &WorldTransaction<'_>, admission: &Admission, owner: &Definition<DefinitionBody>,
    release: &Release, declarations: &[Parameter], parameters: &BTreeMap<ParameterId, Cell>,
    expressions: &[&ExpressionIr], annotations: Vec<ExpressionAnnotation>, scope: &ScopeId,
    interval: &ValidTime, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp,
) -> Result<(CurrentEvaluation, world_protocol::authorization::ActualImpact), QueryError> {
    validate_parameters(declarations, parameters)?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    if owner.reference.world != *tx.world() || release.world != *tx.world()
        || !crate::definitions::scope_contains(tx.world(), &owner.scope, scope, &release.scopes).map_err(|_| invalid("scope"))? {
        return Err(invalid("scope"));
    }
    if !release.definitions.iter().any(|definition| definition == owner) { return Err(QueryFailure::BasisChanged.into()); }
    crate::definitions::validate_applicability(owner, scope, interval, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
    let current = crate::releases::read_active_model(tx).await?.ok_or(QueryFailure::BasisChanged)?;
    let parameters = parameters.clone();
    let (fields, functions) = expression_closure(expressions, release)?;
    let ranges = evaluation_ranges(owner, declarations, expressions, release)?;
    let mut datasets: BTreeSet<_> = ranges.keys().cloned().collect();
    for parameter in declarations {
        if let ValueType::Object { type_id } | ValueType::Relation { type_id } = &parameter.value_type { datasets.insert(type_id.clone()); }
    }
    // Membership/absence races use the same dataset guards as facts and identity writers.
    crate::facts::support::lock_ranges(tx, &datasets.iter().cloned().collect::<Vec<_>>(), &[]).await?;
    let impact = impact_cells(tx, owner, release, declarations, &parameters, expressions, scope, &ranges).await?;
    admission.require_access(&impact)?;
    let mut result = CurrentEvaluation { parameters, row: EvalRow { valid_time: Some(interval.clone()), ..Default::default() },
        collections: BTreeMap::new(), ranges: BTreeMap::new(), functions, annotations, dependencies: vec![ReadDependency::Definition { reference: owner.reference.clone() }], incomplete: false, range_incomplete: false, budget: budget.clone(), cancel: cancel.clone(), read_receipt: None };
    let bindings: Vec<_> = release.definitions.iter().filter_map(|definition| match &definition.body {
        DefinitionBody::SourceBinding(binding) if datasets.contains(&binding.identity_mapping.type_id) => Some(definition.reference.clone()), _ => None,
    }).collect();
    if !crate::sources::sync::bindings_projection_ready(tx, &bindings, budget, cancel).await? { result.range_incomplete = true; }
    for reference in fields.iter().chain(result.functions.keys()) {
        let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
        crate::definitions::validate_applicability(definition, scope, interval, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
        result.dependencies.push(ReadDependency::Definition { reference: reference.clone() });
    }
    for parameter in declarations {
        let type_id = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => continue };
        let symbol = SymbolId::try_new(parameter.id.as_str()).map_err(|_| QueryFailure::InternalFault)?;
        let cell = result.parameters.get(&parameter.id).ok_or_else(|| invalid("arguments"))?.clone();
        let subject = match &cell {
            Cell::Known { value: Value::Object { id } } => Some(SubjectRef::Object { id: id.clone() }),
            Cell::Known { value: Value::Relation { id } } => Some(SubjectRef::Relation { id: id.clone() }),
            _ => None,
        };
        let Some(subject) = subject else {
            for property in &fields { result.row.fields.insert((symbol.clone(), property.clone()), cell.clone()); }
            result.incomplete |= !matches!(cell, Cell::Known { .. });
            result.range_incomplete |= !matches!(cell, Cell::Known { .. });
            continue;
        };
        let impact = authorization::actual_impact(vec![AccessScope { resources: vec![projection::resource(&subject)], fields: fields.iter().cloned().collect(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(interval.clone()) }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
        admission.require_access(&impact)?;
        let identity = crate::identity::get_in_transaction(tx, &subject).await?.ok_or(QueryFailure::BasisChanged)?;
        let actual_type = match &identity.record { IdentityRecord::Object(value) => &value.type_id, IdentityRecord::Relation(value) => &value.type_id };
        if actual_type != type_id { return Err(invalid("arguments.type")); }
        result.dependencies.push(ReadDependency::Identity { subject: subject.clone(), revision: identity.revision });
        result.row.subjects.insert(symbol.clone(), subject.clone());
        let facts = tx.query("SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND r.subject_kind=$3 AND r.subject_id=$4 ORDER BY h.assertion_id FOR SHARE OF h", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &match &subject { SubjectRef::Object { .. } => "object", SubjectRef::Relation { .. } => "relation" }, &match &subject { SubjectRef::Object { id } => id.as_str(), SubjectRef::Relation { id } => id.as_str() }]).await?;
        let mut active = Vec::new(); let mut pending: Option<Generation> = None;
        for row in facts {
            let fact: Assertion = super::error::decode(row.get("body"))?;
            if fact.status != AssertionStatus::Accepted { continue; }
            if matches!(&fact.claim, Claim::Attribute(claim) if !fields.contains(&claim.property)) { continue; }
            if !crate::definitions::scope_contains(tx.world(), &fact.scope, scope, &release.scopes).map_err(|_| invalid("scope"))? { continue; }
            if !crate::definitions::valid_time_contains(&fact.valid_time, interval) {
                if fact.valid_time.to.as_ref().is_none_or(|to| to > &interval.from) && interval.to.as_ref().is_none_or(|to| to > &fact.valid_time.from) { result.range_incomplete = true; }
                continue;
            }
            let evidence = assertions::require_evidence(tx, admission, &fact.evidence, scope, Some(interval), at).await?;
            let mut labels: Vec<_> = evidence.iter().flat_map(|item| item.access.labels.clone()).collect();
            let properties = match &fact.claim { Claim::Attribute(claim) => vec![claim.property.clone()], _ => Vec::new() };
            for property in &properties {
                let exact = release.definitions.iter().find(|definition| definition.reference == *property).ok_or(QueryFailure::BasisChanged)?;
                for definition in std::iter::once(exact).chain(current.definitions.iter().filter(|definition| definition.reference.id == property.id)) {
                    if let DefinitionBody::Property(body) = &definition.body { labels.extend(body.access_labels.clone()); } else { return Err(QueryFailure::BasisChanged.into()); }
                }
            }
            let sources = match &fact.origin { AssertionOrigin::Source { binding, .. } => release.definitions.iter().find(|item| item.reference == *binding).and_then(|item| match &item.body { DefinitionBody::SourceBinding(body) => Some(body.source_id.clone()), _ => None }).into_iter().collect(), _ => Vec::new() };
            admission.require_access(&authorization::actual_impact(vec![AccessScope { resources: vec![projection::resource(&subject)], fields: properties, modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(interval.clone()) }], vec![Effect::Pure], labels, Vec::new(), sources)?)?;
            result.dependencies.push(ReadDependency::Assertion { reference: fact.reference.clone() });
            result.dependencies.extend(fact.evidence.iter().cloned().map(|reference| ReadDependency::Evidence { reference }));
            if matches!(fact.origin, AssertionOrigin::Derived { .. }) {
                let support = crate::facts::support::resolve_transaction_interval(tx, &fact.reference, scope, &release.id, release.source_branch.as_ref().map(|branch| &branch.id), budget, cancel, interval).await?;
                match support { ConclusionSupport::Supported { .. } => {}, ConclusionSupport::Dirty { generation, .. } => { pending = Some(pending.map_or(generation, |old| old.max(generation))); continue; }, ConclusionSupport::Unsupported => continue }
            }
            active.push(fact);
        }
        for property in &fields {
            let definition = release.definitions.iter().find(|item| item.reference == *property).ok_or_else(|| invalid("property"))?;
            let DefinitionBody::Property(body) = &definition.body else { return Err(invalid("property")); };
            if !body.domain.contains(type_id) { continue; }
            let field = projection::field_cell(&subject, property, body, &active, pending, at);
            result.incomplete |= !matches!(field.cell, Cell::Known { .. }) || field.dirty != DirtyState::Clean;
            result.range_incomplete |= field.dirty != DirtyState::Clean || matches!(field.cell, Cell::SourceUnavailable { .. });
            result.row.fields.insert((symbol.clone(), property.clone()), field.cell);
        }
        if matches!(subject, SubjectRef::Relation { .. }) {
            let claims: Vec<_> = active.iter().filter(|item| matches!(item.claim, Claim::Relation(_))).collect();
            let positive = claims.iter().find(|item| item.polarity == Polarity::Positive);
            if let Some(positive) = positive.filter(|candidate| claims.iter().all(|item| item.claim == candidate.claim && item.polarity == Polarity::Positive)) {
                let Claim::Relation(claim) = &positive.claim else { return Err(QueryFailure::InternalFault.into()); };
                let definition = release.definitions.iter().find(|item| item.reference == claim.relation_type).ok_or_else(|| invalid("relationType"))?;
                let DefinitionBody::RelationType(body) = &definition.body else { return Err(invalid("relationType")); };
                for role in &body.roles {
                    let mut objects: Vec<_> = claim.roles.iter().filter(|item| item.role == role.id).map(|item| Value::Object { id: item.object_id.clone() }).collect();
                    let value = if role.cardinality.maximum == Some(1) { objects.pop().unwrap_or(Value::Null) } else { Value::List { items: objects } };
                    result.row.roles.insert((symbol.clone(), role.id.clone()), Cell::Known { value });
                }
            } else { result.incomplete = true; }
        }
    }
    for (type_id, reference) in &ranges {
        let (symbol, plan) = collection_plan(reference, release, &fields)?;
        let mut projection = projection::read_transaction(tx, &plan, release, scope, interval, admission, budget.limit().max_rows, budget, cancel).await?;
        projection.incomplete |= result.range_incomplete;
        let mut output = engine::run(&plan, release, &projection, &[], at, budget, cancel)?;
        result.range_incomplete |= output.incomplete || output.truncated;
        result.incomplete |= output.incomplete || output.truncated;
        result.dependencies.extend(projection.dependencies);
        result.dependencies.push(ReadDependency::Definition { reference: reference.clone() });
        let mut collection = output.collections.remove(&symbol).ok_or(QueryFailure::InternalFault)?;
        for row in &mut collection.rows { row.valid_time.get_or_insert_with(|| interval.clone()); }
        if output.truncated { collection.incomplete = Some(Cell::Unknown { reason: UnknownReason::IncompleteCoverage }); }
        result.ranges.insert(type_id.clone(), (symbol, collection));
    }
    for parameter in declarations {
        let type_id = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => continue };
        let Some((source, range)) = result.ranges.get(type_id) else { continue; };
        let symbol = SymbolId::try_new(parameter.id.as_str()).map_err(|_| QueryFailure::InternalFault)?;
        let mut collection = range.rebind(source, &symbol);
        for row in &mut collection.rows {
            if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
            budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
            let mut bound = result.row.clone();
            bound.subjects.extend(row.subjects.clone()); bound.fields.extend(row.fields.clone()); bound.roles.extend(row.roles.clone()); bound.valid_time = row.valid_time.clone(); *row = bound;
        }
        result.collections.insert(symbol, collection);
    }
    authorization::check_admitted_output(tx, admission, &impact, result.ranges.values().map(|(_, collection)| collection.rows.len() as u64).sum(), &tx.now().await?).await?;
    Ok((result, impact))
}

pub(super) async fn prepare_rule_read(
    tx: &WorldTransaction<'_>, authority: ReadAuthority<'_>, owner: &Definition<DefinitionBody>, release: &Release,
    declarations: &[Parameter], arguments: &[QueryArgument], expressions: &[&ExpressionIr], annotations: Vec<ExpressionAnnotation>,
    scope: &ScopeId, interval: &ValidTime, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<(Vec<(ValidTime, CurrentEvaluation)>, world_protocol::authorization::ActualImpact, Digest, Vec<(AssertionRef, Digest)>), QueryError> {
    let parameters = engine::parameters(declarations, arguments)?;
    validate_parameters(declarations, &parameters)?;
    let now = tx.now().await?;
    if owner.reference.world != *tx.world() || release.world != *tx.world() { return Err(QueryFailure::BasisChanged.into()); }
    crate::definitions::validate_applicability(owner, scope, interval, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
    let (fields, functions) = expression_closure(expressions, release)?;
    let ranges = evaluation_ranges(owner, declarations, expressions, release)?;
    let mut impacts = Vec::new();
    let mut dependencies = Vec::new();
    for reference in std::iter::once(&owner.reference).chain(fields.iter()).chain(functions.keys()).chain(ranges.values()) {
        let definition = release.definitions.iter().find(|item| item.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
        let labels = match &definition.body { DefinitionBody::Property(body) => body.access_labels.clone(), _ => Vec::new() };
        let impact = authorization::actual_impact(vec![AccessScope { resources: vec![ResourceRef::Definition { id: reference.id.clone() }], fields: if fields.contains(reference) { vec![reference.clone()] } else { Vec::new() }, modes: vec![AccessMode::Read], scope: definition.scope.clone(), valid_time: None }], vec![Effect::Pure], labels, Vec::new(), Vec::new())?;
        authority.check(tx, &impact, &now).await?; impacts.push(impact);
        crate::definitions::validate_applicability(definition, scope, interval, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
        let dependency = ReadDependency::Definition { reference: reference.clone() };
        if !dependencies.contains(&dependency) { dependencies.push(dependency); }
    }
    let bindings: Vec<_> = release.definitions.iter().filter_map(|definition| match &definition.body {
        DefinitionBody::SourceBinding(binding) if ranges.contains_key(&binding.identity_mapping.type_id) => Some((definition, binding)), _ => None,
    }).collect();
    for (definition, binding) in &bindings {
        let impact = authorization::actual_impact(vec![AccessScope { resources: vec![ResourceRef::Definition { id: definition.reference.id.clone() }, ResourceRef::Source { id: binding.source_id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: binding.scope.clone(), valid_time: None }], vec![Effect::Pure], Vec::new(), Vec::new(), vec![binding.source_id.clone()])?;
        authority.check(tx, &impact, &now).await?; impacts.push(impact);
        dependencies.push(ReadDependency::Definition { reference: definition.reference.clone() });
    }
    let (ready, source_basis) = if let Some(branch) = &release.source_branch {
        (true, crate::definitions::canonical_digest(branch)?)
    } else {
        crate::sources::sync::bindings_projection_basis(tx, &bindings.iter().map(|(definition, _)| definition.reference.clone()).collect::<Vec<_>>(), budget, cancel).await?
    };
    let raw = projection::read_rule(tx, authority, &ranges.values().cloned().collect::<Vec<_>>(), &fields, release, scope, interval, budget.limit().max_rows, budget, cancel).await?;
    if let Some(impact) = raw.impact() { impacts.push(impact.clone()); }
    let plans = ranges.iter().map(|(id, reference)| Ok((id.clone(), collection_plan(reference, release, &fields)?))).collect::<Result<Vec<_>, QueryError>>()?;
    let mut results = Vec::new();
    let mut delivered = 0u64;
    for (index, from) in raw.cuts().iter().enumerate() {
        if interval.to.as_ref().is_some_and(|to| from >= to) { break; }
        if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
        budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
        let segment = ValidTime::try_new(from.clone(), raw.cuts().get(index + 1).cloned().or_else(|| interval.to.clone())).map_err(|_| invalid("validTime"))?;
        let mut result = CurrentEvaluation { parameters: parameters.clone(), row: EvalRow { valid_time: Some(segment.clone()), ..Default::default() }, collections: BTreeMap::new(), ranges: BTreeMap::new(), functions: functions.clone(), annotations: annotations.clone(),
            dependencies: dependencies.clone(), incomplete: false, range_incomplete: !ready, budget: budget.clone(), cancel: cancel.clone(), read_receipt: None };
        for (type_id, (symbol, plan)) in &plans {
            let mut projected = raw.materialize(plan, release, &segment, &now, budget, cancel)?;
            for parameter in declarations {
                let parameter_type = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => continue };
                if parameter_type != type_id { continue; }
                let subject = match result.parameters.get(&parameter.id) {
                    Some(Cell::Known { value: Value::Object { id } }) => SubjectRef::Object { id: id.clone() },
                    Some(Cell::Known { value: Value::Relation { id } }) => SubjectRef::Relation { id: id.clone() }, _ => return Err(invalid("arguments")),
                };
                let projected = projected.subjects.get(&subject).ok_or(QueryFailure::BasisChanged)?;
                let bound = SymbolId::try_new(parameter.id.as_str()).map_err(|_| invalid("arguments"))?;
                result.row.subjects.insert(bound.clone(), subject);
                for (property, field) in &projected.fields { result.row.fields.insert((bound.clone(), property.clone()), field.cell.clone()); }
                if let Some(relation) = &projected.relation { for (role, cell) in &relation.cells { result.row.roles.insert((bound.clone(), role.clone()), cell.clone()); } }
            }
            projected.incomplete |= result.range_incomplete;
            let mut output = engine::run(plan, release, &projected, &[], &segment.from, budget, cancel)?;
            result.range_incomplete |= output.incomplete || output.truncated;
            result.incomplete |= output.incomplete || output.truncated;
            result.dependencies.extend(projected.dependencies);
            let mut collection = output.collections.remove(symbol).ok_or(QueryFailure::InternalFault)?;
            for row in &mut collection.rows { row.valid_time.get_or_insert_with(|| segment.clone()); }
            if output.truncated { collection.incomplete = Some(Cell::Unknown { reason: UnknownReason::IncompleteCoverage }); }
            budget.charge(world_protocol::budget::BudgetDimension::Rows, collection.rows.len() as u64).map_err(super::execution::budget_error)?;
            delivered = delivered.checked_add(collection.rows.len() as u64).ok_or(QueryFailure::InternalFault)?;
            result.ranges.insert(type_id.clone(), (symbol.clone(), collection));
        }
        for parameter in declarations {
            let type_id = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => continue };
            let Some((source, range)) = result.ranges.get(type_id) else { continue; };
            let symbol = SymbolId::try_new(parameter.id.as_str()).map_err(|_| invalid("arguments"))?;
            let mut collection = range.rebind(source, &symbol);
            for row in &mut collection.rows {
                if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
                budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
                let mut bound = result.row.clone(); bound.subjects.extend(row.subjects.clone()); bound.fields.extend(row.fields.clone()); bound.roles.extend(row.roles.clone()); bound.valid_time = row.valid_time.clone(); *row = bound;
            }
            result.collections.insert(symbol, collection);
        }
        results.push((segment, result));
    }
    let mut access = Vec::new(); let mut effects = Vec::new(); let mut labels = Vec::new(); let mut state = Vec::new(); let mut sources = Vec::new();
    for impact in impacts { access.extend(impact.access); effects.extend(impact.effects); labels.extend(impact.labels); state.extend(impact.state); sources.extend(impact.source_ids); }
    let impact = authorization::actual_impact(access, effects, labels, state, sources)?;
    match authority {
        ReadAuthority::Verified(verified) => authorization::check_impact_read_output(tx, verified, &impact, delivered, &tx.now().await?).await?,
        ReadAuthority::Admitted(admission) => { authorization::check_admitted_output(tx, admission, &impact, delivered, &tx.now().await?).await?; }
    }
    Ok((results, impact, crate::definitions::canonical_digest(&(source_basis, raw.fingerprint(), raw.cuts()))?, raw.branch_inputs()?))
}

pub(crate) async fn strategy_expression_impact_cells(
    tx: &WorldTransaction<'_>, owner: &DefinitionRef, release_id: &ReleaseId,
    branch: Option<&world_protocol::releases::BranchRef>, declarations: &[Parameter], parameters: &BTreeMap<ParameterId, Cell>,
    expressions: &[&ExpressionIr], scope: &ScopeId,
) -> Result<world_protocol::authorization::ActualImpact, QueryError> {
    validate_parameters(declarations, parameters)?;
    let model = match branch {
        Some(branch) => super::branch::model(tx, branch, &world_protocol::evaluation::EvaluationArm::Candidate).await?.1,
        None => release(tx, release_id, None).await?,
    };
    if &model.id != release_id || model.world != *tx.world() || owner.world != *tx.world() { return Err(QueryFailure::BasisChanged.into()); }
    let definition = model.definitions.iter().find(|definition| &definition.reference == owner).ok_or(QueryFailure::BasisChanged)?;
    if !crate::definitions::scope_contains(tx.world(), &definition.scope, scope, &model.scopes).map_err(|_| invalid("scope"))? { return Err(invalid("scope")); }
    let mut impact = match branch {
        Some(branch) => super::branch::branch_expression_impact(tx, branch, &world_protocol::evaluation::EvaluationArm::Candidate, declarations, expressions, scope).await?,
        None => impact_cells(tx, definition, &model, declarations, parameters, expressions, scope, &evaluation_ranges(definition, declarations, expressions, &model)?).await?,
    };
    impact.access.push(AccessScope { resources: vec![ResourceRef::Definition { id: owner.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None });
    Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
}

pub(crate) async fn strategy_expression_context_cells(
    tx: &WorldTransaction<'_>, admission: &Admission, owner: &DefinitionRef, release_id: &ReleaseId,
    branch: Option<&world_protocol::releases::BranchRef>, declarations: &[Parameter], parameters: &BTreeMap<ParameterId, Cell>,
    expressions: &[&ExpressionIr], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken,
    at: &Timestamp, read_mode: &world_protocol::query::ReadMode, known_at: Option<&Timestamp>,
) -> Result<CurrentEvaluation, QueryError> {
    budget.check().map_err(super::execution::budget_error)?;
    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
    validate_parameters(declarations, parameters)?;
    let interval = projection::point(at)?;
    if let Some(branch) = branch {
        let (_, model) = super::branch::model(tx, branch, &world_protocol::evaluation::EvaluationArm::Candidate).await?;
        if &model.id != release_id { return Err(QueryFailure::BasisChanged.into()); }
        let definition = model.definitions.iter().find(|definition| &definition.reference == owner).ok_or(QueryFailure::BasisChanged)?;
        crate::definitions::validate_applicability(definition, scope, &interval, &model.scopes).map_err(crate::definitions::DefinitionError::from)?;
        return super::branch::expression_context_cells(tx, admission, branch, &world_protocol::evaluation::EvaluationArm::Candidate, Some(owner), declarations, parameters, expressions, scope, budget, cancel, at, read_mode, known_at).await;
    }
    if known_at.is_some() { return Err(QueryFailure::GuaranteeUnsatisfied { mode: read_mode.clone(), source_id: None }.into()); }
    let model = release(tx, release_id, None).await?;
    let definition = model.definitions.iter().find(|definition| &definition.reference == owner).ok_or(QueryFailure::BasisChanged)?;
    let mut datasets: BTreeSet<_> = collection_ranges(declarations, expressions, &model)?.into_keys().collect();
    datasets.extend(declarations.iter().filter_map(|parameter| match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => Some(type_id.clone()), _ => None }));
    let bindings: Vec<_> = model.definitions.iter().filter_map(|definition| match &definition.body { DefinitionBody::SourceBinding(binding) if datasets.contains(&binding.identity_mapping.type_id) => Some(definition.reference.clone()), _ => None }).collect();
    if matches!(read_mode, world_protocol::query::ReadMode::Authoritative) && !bindings.is_empty() {
        return Err(QueryFailure::GuaranteeUnsatisfied { mode: read_mode.clone(), source_id: None }.into());
    }
    let now = tx.now().await?;
    if let world_protocol::query::ReadMode::Projected { max_lag } = read_mode {
        for binding in &bindings { crate::sources::sync::require_projected_transaction(tx, binding, max_lag, &now).await?; }
    }
    let basis = crate::sources::sync::require_bindings_ready(tx, &bindings).await?;
    for basis in &basis { crate::sources::sync::recheck_basis(tx, basis).await?; }
    if let world_protocol::query::ReadMode::After { receipt_id } = read_mode {
        let previous = super::receipt::read_transaction(tx, receipt_id).await?;
        super::receipt::require_current(&previous, admission, &now)?;
        for basis in &previous.receipt.basis {
            let position = basis.position.as_ref().ok_or_else(|| QueryError::from(QueryFailure::GuaranteeUnsatisfied { mode: read_mode.clone(), source_id: Some(basis.source_id.clone()) }))?;
            crate::sources::sync::require_after_transaction(tx, &basis.binding, position).await?;
        }
    }
    let (mut evaluation, mut impact) = prepare_cells(tx, admission, definition, &model, declarations, parameters, expressions, Vec::new(), scope, &interval, budget, cancel, at).await?;
    impact.access.push(AccessScope { resources: vec![ResourceRef::Definition { id: owner.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None });
    impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
    admission.require_access(&impact)?;
    let context = super::receipt::ReadContext { scope: scope.clone(), valid_time: interval, known_at: None, branch_model: None, frozen_model: None, captures: Vec::new(), capture_selection: super::receipt::CaptureSelection::Selected, derivations: Vec::new() };
    let scope_digest = super::execution::evaluated_scope_digest(&context, &model, &impact)?;
    let receipt = world_protocol::query::ReadReceipt { world: model.world.clone(), id: ReadReceiptId::try_new(uuid::Uuid::new_v4().to_string()).map_err(|_| QueryFailure::InternalFault)?, branch_id: None,
        release_id: model.id.clone(), activation_lock_id: model.artifact.activation_lock_id.clone(), query_digest: crate::definitions::canonical_digest(&("world.current.expression.v1", &model.world, &model.id, declarations, parameters, expressions, at, read_mode, known_at))?,
        evaluated_scope_digest: scope_digest.clone(), decision_id: admission.decision().id.clone(), policy_epoch: admission.decision().policy_epoch, grant_epoch: admission.decision().grant_epoch,
        observed_at: now, expires_at: admission.decision().expires_at.clone(), requested_mode: read_mode.clone(), basis, projection_generation: None, actual_dependencies: evaluation.dependencies.clone(),
        coverage: world_protocol::query::QueryCoverage { scope_digest, complete: !evaluation.range_incomplete && !evaluation.incomplete, missing_sources: Vec::new(), missing_fields: Vec::new(), gap_sources: Vec::new() }, freshness: Vec::new(), dirty: Vec::new(), truncation: None, consistency: world_protocol::query::ConsistencyBasis::PerSource };
    let columns = evaluation.row.fields.iter().map(|((symbol, property), cell)| world_protocol::query::NamedCell { name: format!("field.{}.{}", symbol.as_str(), property.id.as_str()), cell: cell.clone() })
        .chain(evaluation.row.roles.iter().map(|((symbol, role), cell)| world_protocol::query::NamedCell { name: format!("role.{}.{}", symbol.as_str(), role.as_str()), cell: cell.clone() }))
        .chain(parameters.iter().map(|(id, cell)| world_protocol::query::NamedCell { name: format!("parameter.{}", id.as_str()), cell: cell.clone() })).collect();
    let actor = match &admission.invocation().actor { world_protocol::authorization::Actor::Human { id } | world_protocol::authorization::Actor::Service { id } => id.clone() };
    let stored = super::receipt::StoredRead { receipt: receipt.clone(), rows: vec![world_protocol::query::QueryRow { columns }], row_subjects: vec![evaluation.row.subjects.values().cloned().collect()], objects: Vec::new(), relations: Vec::new(), impact, actor, context,
        input: super::receipt::ReadInput::Expression { declarations: declarations.to_vec(), parameters: parameters.clone(), expressions: expressions.iter().map(|expression| (*expression).clone()).collect(), at: at.clone(), read_mode: read_mode.clone(), known_at: None }, origin: None };
    super::receipt::recheck_output(tx, admission, &stored, &tx.now().await?).await?;
    super::receipt::persist(tx, admission, &stored).await?;
    evaluation.read_receipt = Some(receipt);
    Ok(evaluation)
}

fn validate_parameters(declarations: &[Parameter], parameters: &BTreeMap<ParameterId, Cell>) -> Result<(), QueryError> {
    if parameters.len() != declarations.len() { return Err(invalid("arguments")); }
    for parameter in declarations {
        if let Cell::Known { value } = parameters.get(&parameter.id).ok_or_else(|| invalid("arguments"))? {
            crate::definitions::validate_value(&parameter.value_type, parameter.nullable, value).map_err(|_| invalid("arguments"))?;
        }
    }
    Ok(())
}

pub(super) async fn impact(
    tx: &WorldTransaction<'_>, owner: &Definition<DefinitionBody>, release: &Release, declarations: &[Parameter], arguments: &[QueryArgument],
    expressions: &[&ExpressionIr], scope: &ScopeId,
) -> Result<world_protocol::authorization::ActualImpact, QueryError> {
    impact_cells(tx, owner, release, declarations, &engine::parameters(declarations, arguments)?, expressions, scope, &collection_ranges(declarations, expressions, release)?).await
}
pub(super) async fn rule_impact(
    tx: &WorldTransaction<'_>, owner: &Definition<DefinitionBody>, release: &Release, declarations: &[Parameter], arguments: &[QueryArgument],
    expressions: &[&ExpressionIr], scope: &ScopeId,
) -> Result<world_protocol::authorization::ActualImpact, QueryError> {
    impact_cells(tx, owner, release, declarations, &engine::parameters(declarations, arguments)?, expressions, scope, &evaluation_ranges(owner, declarations, expressions, release)?).await
}
async fn impact_cells(
    tx: &WorldTransaction<'_>, owner: &Definition<DefinitionBody>, release: &Release, declarations: &[Parameter], parameters: &BTreeMap<ParameterId, Cell>,
    expressions: &[&ExpressionIr], scope: &ScopeId, ranges: &BTreeMap<DefinitionId, DefinitionRef>,
) -> Result<world_protocol::authorization::ActualImpact, QueryError> {
    let (fields, functions) = expression_closure(expressions, release)?;
    let resources = std::iter::once(&owner.reference).chain(fields.iter()).chain(functions.keys()).chain(ranges.values()).map(|reference| ResourceRef::Definition { id: reference.id.clone() }).collect();
    let mut access = vec![AccessScope { resources, fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None }]; let mut labels = Vec::new(); let mut sources = Vec::new(); let mut effects = vec![Effect::Pure]; let mut state = Vec::new();
    let current = crate::releases::read_active_model(tx).await?.ok_or(QueryFailure::BasisChanged)?;
    for property in &fields {
        let exact = release.definitions.iter().find(|definition| definition.reference == *property).ok_or(QueryFailure::BasisChanged)?;
        for definition in std::iter::once(exact).chain(current.definitions.iter().filter(|definition| definition.reference.id == property.id)) {
            let DefinitionBody::Property(body) = &definition.body else { return Err(invalid("property")); };
            labels.extend(body.access_labels.clone());
            access.push(AccessScope { resources: vec![ResourceRef::Definition { id: property.id.clone() }], fields: vec![property.clone()], modes: vec![AccessMode::Read], scope: definition.scope.clone(), valid_time: None });
        }
    }
    for parameter in declarations {
        let type_id = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => continue };
        access.push(AccessScope { resources: vec![ResourceRef::Definition { id: type_id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None });
        let subject = match parameters.get(&parameter.id) {
            Some(Cell::Known { value: Value::Object { id } }) => SubjectRef::Object { id: id.clone() },
            Some(Cell::Known { value: Value::Relation { id } }) => SubjectRef::Relation { id: id.clone() }, _ => continue,
        };
        access.push(AccessScope { resources: vec![projection::resource(&subject)], fields: if matches!(subject, SubjectRef::Relation { .. }) { Vec::new() } else { fields.iter().cloned().collect() }, modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None });
        let (kind, id) = match &subject { SubjectRef::Object { id } => ("object", id.as_str()), SubjectRef::Relation { id } => ("relation", id.as_str()) };
        let rows = tx.query("SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND r.subject_kind=$3 AND r.subject_id=$4", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &kind, &id]).await?;
        for row in rows {
            let fact: Assertion = super::error::decode(row.get("body"))?;
            if matches!(&fact.claim, Claim::Attribute(claim) if !fields.contains(&claim.property)) { continue; }
            if !crate::definitions::scope_contains(tx.world(), &fact.scope, scope, &release.scopes).map_err(|_| invalid("scope"))? { continue; }
            access.push(AccessScope { resources: vec![ResourceRef::Assertion { id: fact.reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(fact.valid_time.clone()) });
            let evidence: Vec<_> = fact.evidence.into_iter().map(|reference| ReadDependency::Evidence { reference }).collect();
            if let Some(material) = crate::facts::support::dependency_impact(tx, &evidence, release, scope, &fact.valid_time).await? {
                access.extend(material.access); labels.extend(material.labels); sources.extend(material.source_ids); effects.extend(material.effects); state.extend(material.state);
            }
            if let AssertionOrigin::Source { binding, .. } = fact.origin {
                if let Some(definition) = release.definitions.iter().find(|item| item.reference == binding) { if let DefinitionBody::SourceBinding(body) = &definition.body { sources.push(body.source_id.clone()); } }
            }
        }
    }
    for reference in ranges.values() {
        let (_, plan) = collection_plan(reference, release, &fields)?;
        let material = super::metadata::impact_for_transaction(tx, &plan, release, scope).await?;
        access.extend(material.access); effects.extend(material.effects); labels.extend(material.labels); state.extend(material.state); sources.extend(material.source_ids);
    }
    for source in &sources { access.push(AccessScope { resources: vec![ResourceRef::Source { id: source.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None }); }
    Ok(authorization::actual_impact(access, effects, labels, state, sources)?)
}

pub(super) fn evaluation_ranges(owner: &Definition<DefinitionBody>, declarations: &[Parameter], expressions: &[&ExpressionIr], release: &Release) -> Result<BTreeMap<DefinitionId, DefinitionRef>, QueryError> {
    let mut ranges = collection_ranges(declarations, expressions, release)?;
    if matches!(&owner.body, DefinitionBody::Rule(_)) {
        for parameter in declarations {
            if let ValueType::Object { type_id } | ValueType::Relation { type_id } = &parameter.value_type {
                let definition = release.definitions.iter().find(|definition| definition.reference.id == *type_id).ok_or(QueryFailure::BasisChanged)?;
                ranges.insert(type_id.clone(), definition.reference.clone());
            }
        }
    }
    Ok(ranges)
}

pub(super) fn collection_ranges(declarations: &[Parameter], expressions: &[&ExpressionIr], release: &Release) -> Result<BTreeMap<DefinitionId, DefinitionRef>, QueryError> {
    let mut todo: Vec<_> = expressions.iter().map(|expression| (declarations, *expression)).collect();
    let mut called = BTreeSet::new(); let mut ranges = BTreeMap::new();
    while let Some((parameters, expression)) = todo.pop() {
        match expression {
            ExpressionIr::Aggregate { collection, expression, .. } => {
                let parameter = parameters.iter().find(|parameter| parameter.id.as_str() == collection.as_str()).ok_or_else(|| invalid("aggregate.collection"))?;
                let (type_id, object) = match &parameter.value_type { ValueType::Object { type_id } => (type_id, true), ValueType::Relation { type_id } => (type_id, false), _ => return Err(invalid("aggregate.collection")) };
                let definition = release.definitions.iter().find(|definition| definition.reference.id == *type_id).ok_or(QueryFailure::BasisChanged)?;
                if !matches!((&definition.body, object), (DefinitionBody::ObjectType(_), true) | (DefinitionBody::RelationType(_), false)) { return Err(QueryFailure::BasisChanged.into()); }
                ranges.insert(type_id.clone(), definition.reference.clone()); todo.push((parameters, expression));
            }
            ExpressionIr::Call { function, arguments } => {
                todo.extend(arguments.iter().map(|argument| (parameters, argument)));
                if called.insert(function.clone()) {
                    let definition = release.definitions.iter().find(|definition| definition.reference == *function).ok_or(QueryFailure::BasisChanged)?;
                    let DefinitionBody::Function(body) = &definition.body else { return Err(invalid("function")); };
                    todo.push((&body.parameters, &body.expression));
                }
            }
            ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => todo.push((parameters, operand)),
            ExpressionIr::Binary { left, right, .. } => todo.extend([(parameters, left.as_ref()), (parameters, right.as_ref())]),
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => todo.extend(terms.iter().map(|term| (parameters, term))),
            ExpressionIr::If { condition, then_value, else_value } => todo.extend([(parameters, condition.as_ref()), (parameters, then_value.as_ref()), (parameters, else_value.as_ref())]),
            _ => {},
        }
    }
    Ok(ranges)
}

pub(super) fn collection_plan(reference: &DefinitionRef, release: &Release, fields: &BTreeSet<DefinitionRef>) -> Result<(SymbolId, super::plan::CheckedPlan), QueryError> {
    let symbol = SymbolId::try_new("collection").map_err(|_| QueryFailure::InternalFault)?;
    let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
    let root = match &definition.body {
        DefinitionBody::ObjectType(_) => QueryNode::Objects { type_ref: reference.clone(), symbol: symbol.clone() },
        DefinitionBody::RelationType(_) => QueryNode::Relations { type_ref: reference.clone(), symbol: symbol.clone() },
        _ => return Err(invalid("aggregate.collection")),
    };
    let query = QueryIr { root, parameters: Vec::new(), output: vec![QueryColumn { name: "member".into(), expression: ExpressionIr::Literal { value: Value::Boolean { value: true } } }], limit: u32::MAX };
    let mut plan = super::plan::check(&query, release)?; plan.fields.extend(fields.iter().cloned());
    Ok((symbol, plan))
}

pub(super) fn expression_closure(expressions: &[&ExpressionIr], release: &Release) -> Result<(BTreeSet<DefinitionRef>, BTreeMap<DefinitionRef, DefinitionIr>), QueryError> {
    let mut todo = expressions.to_vec(); let mut fields = BTreeSet::new(); let mut functions = BTreeMap::new();
    while let Some(expression) = todo.pop() {
        match expression {
            ExpressionIr::Field { property, .. } => { fields.insert(property.clone()); },
            ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => todo.push(operand),
            ExpressionIr::Binary { left, right, .. } => todo.extend([left.as_ref(), right.as_ref()]),
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => todo.extend(terms),
            ExpressionIr::If { condition, then_value, else_value } => todo.extend([condition.as_ref(), then_value.as_ref(), else_value.as_ref()]),
            ExpressionIr::Call { function, arguments } => {
                todo.extend(arguments);
                if !functions.contains_key(function) {
                    let definition = release.definitions.iter().find(|item| item.reference == *function).ok_or_else(|| invalid("function"))?;
                    let DefinitionBody::Function(body) = &definition.body else { return Err(invalid("function")); };
                    let annotations = crate::compiler::check_value(&body.expression, &body.result_type, definition, &release.definitions, &release.scopes, &body.parameters, &FieldPath(vec!["expression".into()]))?;
                    functions.insert(function.clone(), DefinitionIr { reference: definition.reference.clone(), body_hash: definition.content_digest.clone(), body: definition.body.clone(), scope: definition.scope.clone(), valid_time: definition.valid_time.clone(), annotations, policy_refs: Vec::new(), source_requirements: Vec::new() });
                    todo.push(&body.expression);
                }
            },
            ExpressionIr::Aggregate { expression, window, .. } => { todo.push(expression); if let Some(world_protocol::expression::TimeWindow::Sliding { timestamp_property, .. }) = window { fields.insert(timestamp_property.clone()); } },
            _ => {},
        }
    }
    Ok((fields, functions))
}
