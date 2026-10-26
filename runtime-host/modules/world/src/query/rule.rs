use world_protocol::{
    definitions::{DefinitionBody, RuleConclusion}, expression::{ExpressionIr, TruthValue},
    facts::{AssertionOrigin, AttributeClaim, Claim, RelationClaim, RoleBinding}, identity::SubjectRef,
    ids::*, provenance::{PremiseRef, ProvenanceFailure, ReadDependency, SupportSet, SupportStatus},
    time::Timestamp, value::{Cell, DirtyState, Value},
};
use crate::{authorization::{self, Admission}, facts::assertions, store::WorldTransaction};
use super::{QueryError, current, error::invalid, truth_value};

/// A real evaluation is bound to this exact transaction and complete proposed support group.
pub(crate) struct RuleEvaluationProof {
    transaction: String, world: WorldRef, proposed: Digest, support: SupportSet,
    dependencies: Vec<ReadDependency>, decision: DecisionId,
}
impl RuleEvaluationProof {
    pub(crate) fn support(&self) -> &SupportSet { &self.support }
    pub(crate) fn dependencies(&self) -> &[ReadDependency] { &self.dependencies }
    pub(crate) async fn consume(self, tx: &WorldTransaction<'_>, proposed: &SupportSet) -> Result<SupportSet, QueryError> {
        let transaction = transaction_id(tx).await?;
        let digest = crate::definitions::canonical_digest(proposed).map_err(|_| invalid("support"))?;
        if self.world != *tx.world() || self.transaction != transaction || self.proposed != digest {
            return Err(ProvenanceFailure::MissingPremise.into());
        }
        Ok(self.support)
    }
}

pub(crate) async fn lock_rule_ranges(tx: &WorldTransaction<'_>, supports: &[SupportSet]) -> Result<(), QueryError> {
    crate::facts::support::lock_ranges(tx, &rule_ranges(tx, supports).await?, &[]).await?;
    Ok(())
}
pub(crate) async fn rule_ranges(tx: &WorldTransaction<'_>, supports: &[SupportSet]) -> Result<Vec<DefinitionId>, QueryError> {
    let mut datasets = std::collections::BTreeSet::new();
    for support in supports {
        let release = current::release(tx, &support.release_id, support.branch_id.as_ref()).await?;
        let definition = release.definitions.iter().find(|item| item.reference == support.rule).ok_or_else(|| invalid("support.rule"))?;
        let DefinitionBody::Rule(rule) = &definition.body else { return Err(invalid("support.rule")); };
        for parameter in &rule.parameters { if let world_protocol::value::ValueType::Object { type_id } | world_protocol::value::ValueType::Relation { type_id } = &parameter.value_type { datasets.insert(type_id.clone()); } }
        let mut expressions = vec![&rule.condition];
        match &rule.conclusion {
            RuleConclusion::Attribute { subject, value, .. } => expressions.extend([subject, value]),
            RuleConclusion::Relation { relation, roles, .. } => { expressions.push(relation); expressions.extend(roles.iter().map(|role| &role.object)); },
        }
        datasets.extend(current::collection_ranges(&rule.parameters, &expressions, &release)?.into_keys());
    }
    Ok(datasets.into_iter().collect())
}

pub(crate) async fn rule_impact(tx: &WorldTransaction<'_>, support: &SupportSet) -> Result<world_protocol::authorization::ActualImpact, QueryError> {
    if support.reference.world != *tx.world() || support.conclusion.world != *tx.world() || support.rule.world != *tx.world() { return Err(ProvenanceFailure::CrossScope.into()); }
    let release = current::release(tx, &support.release_id, support.branch_id.as_ref()).await?;
    let definition = release.definitions.iter().find(|item| item.reference == support.rule).ok_or_else(|| invalid("support.rule"))?;
    let DefinitionBody::Rule(rule) = &definition.body else { return Err(invalid("support.rule")); };
    crate::compiler::check_rule(definition, &release.definitions, &release.scopes)?;
    let mut expressions = vec![&rule.condition];
    match &rule.conclusion {
        RuleConclusion::Attribute { subject, value, .. } => expressions.extend([subject, value]),
        RuleConclusion::Relation { relation, roles, .. } => { expressions.push(relation); expressions.extend(roles.iter().map(|role| &role.object)); },
    }
    let mut impact = current::rule_impact(tx, definition, &release, &rule.parameters, &support.arguments, &expressions, &support.scope).await?;
    let ranges = current::evaluation_ranges(definition, &rule.parameters, &expressions, &release)?.into_keys().collect::<Vec<_>>();
    let conclusion = assertions::read_assertion(tx, &support.conclusion).await?.ok_or(ProvenanceFailure::MissingPremise)?;
    if conclusion.scope != support.scope || !crate::definitions::valid_time_contains(&conclusion.valid_time, &support.valid_time) { return Err(ProvenanceFailure::CrossScope.into()); }
    if let Some(id) = super::watch::rule_id(definition, &release, &rule.parameters, &rule.condition, &super::engine::parameters(&rule.parameters, &support.arguments)?, &ranges, &support.scope, &conclusion.valid_time)? {
        impact.access.push(world_protocol::authorization::AccessScope { resources: vec![ResourceRef::Watch { id }], fields: Vec::new(), modes: vec![world_protocol::authorization::AccessMode::Read, world_protocol::authorization::AccessMode::Write], scope: support.scope.clone(), valid_time: Some(conclusion.valid_time.clone()) });
    }
    Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
}

pub(crate) async fn evaluate_rules(
    tx: &WorldTransaction<'_>, admission: &Admission, supports: &[SupportSet],
    budget: &crate::extensions::invocation::CallBudget, cancel: &tokio_util::sync::CancellationToken, at: &Timestamp,
) -> Result<Vec<RuleEvaluationProof>, QueryError> {
    evaluate_batch(tx, admission, supports, budget, cancel, at).await
}

async fn evaluate_batch(
    tx: &WorldTransaction<'_>, admission: &Admission, supports: &[SupportSet],
    budget: &crate::extensions::invocation::CallBudget, cancel: &tokio_util::sync::CancellationToken, at: &Timestamp,
) -> Result<Vec<RuleEvaluationProof>, QueryError> {
    authorization::recheck(tx, admission, at).await?;
    let transaction = transaction_id(tx).await?;
    let mut groups = std::collections::BTreeMap::<Digest, Vec<usize>>::new();
    for (index, support) in supports.iter().enumerate() {
        checkpoint(budget, cancel)?;
        if support.reference.world != *tx.world() || support.conclusion.world != *tx.world() || support.rule.world != *tx.world() {
            return Err(ProvenanceFailure::CrossScope.into());
        }
        let mut arguments = support.arguments.clone(); arguments.sort_by(|a, b| a.parameter_id.cmp(&b.parameter_id));
        let key = crate::definitions::canonical_digest(&(&support.conclusion, &support.rule, arguments, &support.scope, &support.release_id, &support.branch_id))?;
        groups.entry(key).or_default().push(index);
    }
    let mut proofs = std::collections::BTreeMap::new();
    for indices in groups.into_values() {
        checkpoint(budget, cancel)?;
        let first = &supports[indices[0]];
        let release = current::release(tx, &first.release_id, first.branch_id.as_ref()).await?;
        let definition = release.definitions.iter().find(|item| item.reference == first.rule).ok_or_else(|| invalid("support.rule"))?;
        let DefinitionBody::Rule(rule) = &definition.body else { return Err(invalid("support.rule")); };
        let ir = crate::compiler::check_rule(definition, &release.definitions, &release.scopes)?;
        let conclusion = assertions::read_assertion(tx, &first.conclusion).await?.ok_or(ProvenanceFailure::MissingPremise)?;
        if !matches!(&conclusion.origin, AssertionOrigin::Derived {}) || conclusion.scope != first.scope
            || indices.iter().any(|index| !crate::definitions::valid_time_contains(&conclusion.valid_time, &supports[*index].valid_time)) {
            return Err(ProvenanceFailure::CrossScope.into());
        }
        let evaluations = prepare_evaluations(tx, current::ReadAuthority::Admitted(admission), definition, &release, rule,
            &first.arguments, &expressions(rule), ir.annotations, &first.scope, &conclusion.valid_time, budget, cancel).await?.0;
        let mut whole = whole_evaluation(&evaluations, &conclusion.valid_time)?;
        if whole.dependencies.iter().any(|dependency| matches!(dependency, ReadDependency::Assertion { reference } if reference == &first.conclusion)) {
            return Err(ProvenanceFailure::CyclicSupport { assertions: vec![first.conclusion.clone()] }.into());
        }
        let watch = super::watch::register_rule(tx, admission, definition, &release, &rule.parameters, &rule.condition,
            &mut whole, &first.scope, &conclusion.valid_time, at).await?;
        let boundary = conclusion.valid_time.to.as_ref().map(|at| ReadDependency::TimeBoundary { at: at.clone() });
        let registered = watch.as_ref().map(|watch| ReadDependency::Watch { id: watch.id.clone(), generation: watch.generation });
        for index in indices {
            checkpoint(budget, cancel)?;
            let support = &supports[index];
            let mut actual = support.clone(); let mut dependencies = Vec::new();
            let mut status = SupportStatus::Valid; let mut pieces = 0;
            for (interval, evaluation) in &evaluations {
                checkpoint(budget, cancel)?;
                if interval.to.as_ref().is_some_and(|to| to <= &support.valid_time.from)
                    || support.valid_time.to.as_ref().is_some_and(|to| to <= &interval.from) { continue; }
                pieces += 1;
                let piece = world_protocol::time::ValidTime::try_new(interval.from.clone().max(support.valid_time.from.clone()), match (&interval.to, &support.valid_time.to) {
                    (Some(a), Some(b)) => Some(a.min(b).clone()), (a, b) => a.as_ref().or(b.as_ref()).cloned(),
                }).map_err(|_| invalid("support.validTime"))?;
                let (state, derived) = evaluate_interval(evaluation, rule, &piece)?;
                let state = match (state, derived) {
                    (SupportStatus::Valid, Some((claim, polarity))) if same_claim(&claim, &conclusion.claim) && polarity == conclusion.polarity => SupportStatus::Valid,
                    (SupportStatus::Valid | SupportStatus::Invalid, _) => SupportStatus::Invalid,
                    _ => SupportStatus::Pending,
                };
                if state == SupportStatus::Invalid { status = SupportStatus::Invalid; }
                else if state == SupportStatus::Pending && status != SupportStatus::Invalid { status = SupportStatus::Pending; }
                for dependency in &evaluation.dependencies { if !dependencies.contains(dependency) { dependencies.push(dependency.clone()); } }
            }
            if pieces == 0 { return Err(ProvenanceFailure::MissingPremise.into()); }
            if pieces == 1 {
                actual.premises = dependencies.iter().map(premise).collect();
            } else {
                // A cross-cut edge keeps its durable original AND; accept validates it independently.
                let row = tx.query_opt("SELECT r.body FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id=$3 FOR SHARE OF h", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.reference.id.as_str()]).await?.ok_or(ProvenanceFailure::InvalidInterval)?;
                let old: SupportSet = super::error::decode(row.get("body"))?;
                if old.conclusion != support.conclusion || old.rule != support.rule || old.arguments != support.arguments || old.scope != support.scope
                    || old.valid_time != support.valid_time || old.release_id != support.release_id || old.branch_id != support.branch_id {
                    return Err(ProvenanceFailure::CrossScope.into());
                }
                actual.premises = old.premises;
                actual.premises.retain(|premise| !matches!(premise, PremiseRef::Read(ReadDependency::Watch { id, .. }) if watch.as_ref().is_some_and(|watch| &watch.id == id))
                    && !matches!(premise, PremiseRef::Read(ReadDependency::TimeBoundary { at }) if conclusion.valid_time.to.as_ref() == Some(at)));
            }
            for dependency in registered.iter().chain(boundary.iter()) {
                let premise = premise(dependency);
                if !actual.premises.contains(&premise) { actual.premises.push(premise); }
                if !dependencies.contains(dependency) { dependencies.push(dependency.clone()); }
            }
            dependencies.retain(|dependency| actual.premises.contains(&premise(dependency)));
            actual.status = status; actual.dirty = DirtyState::Clean;
            proofs.insert(index, RuleEvaluationProof { transaction: transaction.clone(), world: tx.world().clone(),
                proposed: crate::definitions::canonical_digest(support).map_err(|_| invalid("support"))?, support: actual,
                dependencies, decision: admission.decision().id.clone() });
        }
    }
    (0..supports.len()).map(|index| proofs.remove(&index).ok_or_else(|| ProvenanceFailure::MissingPremise.into())).collect()
}

fn premise(dependency: &ReadDependency) -> PremiseRef {
    match dependency { ReadDependency::Assertion { reference } => PremiseRef::Assertion(reference.clone()),
        ReadDependency::Evidence { reference } => PremiseRef::Evidence(reference.clone()), other => PremiseRef::Read(other.clone()) }
}
fn checkpoint(budget: &crate::extensions::invocation::CallBudget, cancel: &tokio_util::sync::CancellationToken) -> Result<(), QueryError> {
    if cancel.is_cancelled() { return Err(world_protocol::query::QueryFailure::Cancelled.into()); }
    budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)
}

pub(super) fn whole_evaluation(evaluations: &[(world_protocol::time::ValidTime, current::CurrentEvaluation)], whole: &world_protocol::time::ValidTime) -> Result<current::CurrentEvaluation, QueryError> {
    let mut result = evaluations.first().ok_or(ProvenanceFailure::MissingPremise)?.1.clone();
    result.row.valid_time = Some(whole.clone());
    result.dependencies.clear();
    for (_, evaluation) in evaluations {
        result.incomplete |= evaluation.incomplete; result.range_incomplete |= evaluation.range_incomplete;
        for dependency in &evaluation.dependencies { if !result.dependencies.contains(dependency) { result.dependencies.push(dependency.clone()); } }
    }
    Ok(result)
}

pub(super) async fn prepare_evaluations(
    tx: &WorldTransaction<'_>, authority: current::ReadAuthority<'_>, owner: &world_protocol::definitions::Definition<DefinitionBody>, release: &world_protocol::releases::Release,
    rule: &world_protocol::definitions::Rule, arguments: &[world_protocol::query::QueryArgument], expressions: &[&ExpressionIr], annotations: Vec<world_protocol::compiler::ExpressionAnnotation>,
    scope: &ScopeId, whole: &world_protocol::time::ValidTime, budget: &crate::extensions::invocation::CallBudget, cancel: &tokio_util::sync::CancellationToken,
) -> Result<(Vec<(world_protocol::time::ValidTime, current::CurrentEvaluation)>, world_protocol::authorization::ActualImpact, Digest, Vec<(AssertionRef, Digest)>), QueryError> {
    let (evaluations, impact, basis, branch_inputs) = current::prepare_rule_read(tx, authority, owner, release, &rule.parameters, arguments, expressions, annotations, scope, whole, budget, cancel).await?;
    let mut result = Vec::new();
    for (interval, evaluation) in evaluations {
        let points = interval_points(&evaluation, rule, &interval)?;
        for (index, from) in points.iter().enumerate() {
            checkpoint(budget, cancel)?;
            let interval = world_protocol::time::ValidTime::try_new(from.clone(), points.get(index + 1).cloned().or_else(|| interval.to.clone())).map_err(|_| invalid("validTime"))?;
            let mut evaluation = evaluation.clone(); evaluation.row.valid_time = Some(interval.clone());
            if result.len() == world_protocol::api::MAX_QUERY_NODES { return Err(ProvenanceFailure::LimitExceeded { resource: world_protocol::provenance::ProvenanceLimit::ProposalItems, limit: world_protocol::api::MAX_QUERY_NODES as u64 }.into()); }
            result.push((interval, evaluation));
        }
    }
    Ok((result, impact, basis, branch_inputs))
}

pub(super) fn expressions(rule: &world_protocol::definitions::Rule) -> Vec<&ExpressionIr> {
    let mut expressions = vec![&rule.condition];
    match &rule.conclusion {
        RuleConclusion::Attribute { subject, value, .. } => expressions.extend([subject, value]),
        RuleConclusion::Relation { relation, roles, .. } => { expressions.push(relation); expressions.extend(roles.iter().map(|role| &role.object)); },
    }
    expressions
}

fn interval_points(
    evaluation: &current::CurrentEvaluation, rule: &world_protocol::definitions::Rule, interval: &world_protocol::time::ValidTime,
) -> Result<Vec<Timestamp>, QueryError> {
    let mut points = std::collections::BTreeSet::from([interval.from.clone()]);
    let mut todo = expressions(rule);
    for function in evaluation.functions.values() { if let DefinitionBody::Function(body) = &function.body { todo.push(&body.expression); } }
    while let Some(expression) = todo.pop() {
        checkpoint(&evaluation.budget, &evaluation.cancel)?;
        match expression {
            ExpressionIr::Aggregate { expression, window, .. } => {
                todo.push(expression);
                if let Some(world_protocol::expression::TimeWindow::Sliding { width, timestamp_property }) = window {
                    let width = chrono::TimeDelta::milliseconds(i64::try_from(width.0).map_err(|_| invalid("window.width"))?);
                    for row in evaluation.ranges.values().flat_map(|(_, collection)| &collection.rows) {
                        for ((_, property), cell) in &row.fields {
                            checkpoint(&evaluation.budget, &evaluation.cancel)?;
                            if property != timestamp_property { continue; }
                            let Cell::Known { value: Value::Timestamp { value } } = cell else { continue; };
                            let timestamp = chrono::DateTime::parse_from_rfc3339(value.as_str()).map_err(|_| invalid("window.timestamp"))?;
                            let end = timestamp.checked_add_signed(width).ok_or_else(|| invalid("window.width"))?;
                            for boundary in [timestamp, end] {
                                let boundary = boundary.checked_add_signed(chrono::TimeDelta::nanoseconds(1)).ok_or_else(|| invalid("window.timestamp"))?;
                                let boundary = Timestamp::try_new(boundary.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)).map_err(|_| invalid("window.timestamp"))?;
                                if boundary > interval.from && interval.to.as_ref().is_none_or(|to| &boundary < to) {
                                    points.insert(boundary);
                                    if points.len() > world_protocol::api::MAX_QUERY_NODES { return Err(ProvenanceFailure::LimitExceeded { resource: world_protocol::provenance::ProvenanceLimit::ProposalItems, limit: world_protocol::api::MAX_QUERY_NODES as u64 }.into()); }
                                }
                            }
                        }
                    }
                }
            },
            ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => todo.push(operand),
            ExpressionIr::Binary { left, right, .. } => todo.extend([left.as_ref(), right.as_ref()]),
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => todo.extend(terms),
            ExpressionIr::If { condition, then_value, else_value } => todo.extend([condition.as_ref(), then_value.as_ref(), else_value.as_ref()]),
            ExpressionIr::Call { arguments, .. } => todo.extend(arguments), _ => {},
        }
    }
    Ok(points.into_iter().collect())
}

pub(super) fn evaluate_interval(
    evaluation: &current::CurrentEvaluation, rule: &world_protocol::definitions::Rule, interval: &world_protocol::time::ValidTime,
) -> Result<(SupportStatus, Option<(Claim, world_protocol::facts::Polarity)>), QueryError> {
    let mut outcome: Option<(SupportStatus, Option<(Claim, world_protocol::facts::Polarity)>)> = None;
    for at in interval_points(evaluation, rule, interval)? {
        let condition = truth_value(&evaluation.value(&rule.condition, &["condition".into()], &at)?)?;
        let conclusion = if condition == TruthValue::True { conclusion_value(evaluation, &rule.conclusion, &at)? } else { None };
        let actual = match (condition, conclusion) {
            (TruthValue::True, Some(conclusion)) => (SupportStatus::Valid, Some(conclusion)),
            (TruthValue::False, _) => (SupportStatus::Invalid, None),
            _ => (SupportStatus::Pending, None),
        };
        if outcome.as_ref().is_some_and(|previous| previous != &actual) { return Ok((SupportStatus::Pending, None)); }
        outcome = Some(actual);
    }
    if evaluation.range_incomplete { return Ok((SupportStatus::Pending, None)); }
    Ok(outcome.unwrap_or((SupportStatus::Pending, None)))
}

pub(super) fn conclusion_value(evaluation: &current::CurrentEvaluation, conclusion: &RuleConclusion, at: &Timestamp) -> Result<Option<(Claim, world_protocol::facts::Polarity)>, QueryError> {
    let value = |expression: &ExpressionIr, path: Vec<String>| -> Result<Option<Value>, QueryError> {
        Ok(match evaluation.value(expression, &path, at)? { Cell::Known { value } => Some(value), _ => None })
    };
    Ok(match conclusion {
        RuleConclusion::Attribute { subject, property, value: expression, polarity } => {
            let Some(subject) = value(subject, vec!["conclusion".into(), "subject".into()])? else { return Ok(None); };
            let subject = match subject { Value::Object { id } => SubjectRef::Object { id }, Value::Relation { id } => SubjectRef::Relation { id }, _ => return Err(invalid("conclusion.subject")) };
            let Some(value) = value(expression, vec!["conclusion".into(), "value".into()])? else { return Ok(None); };
            Some((Claim::Attribute(AttributeClaim { subject, property: property.clone(), value }), *polarity))
        },
        RuleConclusion::Relation { relation, relation_type, roles, polarity } => {
            let Some(relation) = value(relation, vec!["conclusion".into(), "relation".into()])? else { return Ok(None); };
            let Value::Relation { id } = relation else { return Err(invalid("conclusion.relation")); };
            let mut bindings = Vec::new();
            for (index, role) in roles.iter().enumerate() {
                let Some(object) = value(&role.object, vec!["conclusion".into(), "roles".into(), index.to_string(), "object".into()])? else { return Ok(None); };
                let Value::Object { id } = object else { return Err(invalid("conclusion.roles")); };
                bindings.push(RoleBinding { role: role.role.clone(), object_id: id });
            }
            bindings.sort_by(|left, right| (&left.role, &left.object_id).cmp(&(&right.role, &right.object_id)));
            Some((Claim::Relation(RelationClaim { relation_id: id, relation_type: relation_type.clone(), roles: bindings }), *polarity))
        },
    })
}
fn same_claim(left: &Claim, right: &Claim) -> bool {
    match (left, right) {
        (Claim::Relation(left), Claim::Relation(right)) => {
            let mut a = left.roles.clone(); let mut b = right.roles.clone();
            a.sort_by(|a, b| (&a.role, &a.object_id).cmp(&(&b.role, &b.object_id))); b.sort_by(|a, b| (&a.role, &a.object_id).cmp(&(&b.role, &b.object_id)));
            left.relation_id == right.relation_id && left.relation_type == right.relation_type && a == b
        },
        _ => left == right,
    }
}
pub(super) async fn transaction_id(tx: &WorldTransaction<'_>) -> Result<String, QueryError> {
    tx.query_opt("SELECT pg_current_xact_id()::text AS id", &[]).await?.map(|row| row.get("id")).ok_or_else(|| QueryError::from(ProvenanceFailure::MissingPremise))
}
