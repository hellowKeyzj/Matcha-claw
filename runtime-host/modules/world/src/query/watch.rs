use world_protocol::{
    definitions::{Definition, DefinitionBody}, expression::{ExpressionIr, Parameter, TimeWindow},
    ids::*, provenance::{ProvenanceFailure, QueryWatch, ReadDependency, WatchCoverage, WatchPurpose},
    query::{QueryColumn, QueryIr, QueryNode}, releases::Release, time::{Timestamp, ValidTime}, value::ValueType,
};
use crate::{authorization::{self, Admission}, store::WorldTransaction};
use super::{QueryError, current::CurrentEvaluation, error::invalid, rule::transaction_id};

/// Bound to the actual canonical read, range guards, admission and database transaction.
pub(crate) struct WatchProof { world: WorldRef, transaction: String, watch: Digest, decision: DecisionId }
impl WatchProof {
    pub(crate) async fn consume(self, tx: &WorldTransaction<'_>, watch: &QueryWatch, admission: &Admission) -> Result<(), QueryError> {
        if self.world != *tx.world() || self.transaction != transaction_id(tx).await?
            || self.watch != crate::definitions::canonical_digest(watch)? || self.decision != admission.decision().id {
            return Err(ProvenanceFailure::UnclosedRange { watch_id: watch.id.clone() }.into());
        }
        authorization::recheck(tx, admission, &tx.now().await?).await?;
        Ok(())
    }
}

pub(super) async fn register_rule(
    tx: &WorldTransaction<'_>, admission: &Admission, owner: &Definition<DefinitionBody>,
    release: &Release, declarations: &[Parameter], selector: &ExpressionIr,
    evaluation: &mut CurrentEvaluation, scope: &ScopeId, interval: &ValidTime, at: &Timestamp,
) -> Result<Option<QueryWatch>, QueryError> {
    let ranges = evaluation.ranges.keys().cloned().collect::<Vec<_>>();
    let (query, arguments, datasets, predicate_digest, id) = rule_inputs(owner, release, declarations, selector, &evaluation.parameters, &ranges, scope, interval)?;
    let Some(id) = id else { return Ok(None); };
    let ids: Vec<_> = datasets.iter().map(|dataset| dataset.id.clone()).collect();
    let locked = crate::facts::support::lock_ranges(tx, &ids, &[]).await?;
    let generation = tx.query_opt("SELECT generation FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3 FOR UPDATE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?.map_or(Generation(1), |row| Generation(row.get::<_, i64>("generation") as u64));
    let closed = !evaluation.range_incomplete;
    let purpose = if closed && contains_missing(selector) { WatchPurpose::MissingField } else { WatchPurpose::Membership };
    let watch = QueryWatch { world: tx.world().clone(), id: id.clone(), scope: scope.clone(), selector: selector.clone(), predicate_digest,
        purpose, window: Some(TimeWindow::Fixed { interval: interval.clone() }), generation,
        coverage: if closed { WatchCoverage::CompleteAuthorizedRange } else { WatchCoverage::Partial }, query, arguments, datasets,
        partitions: Vec::new(), visibility_digest: admission.impact().digest.clone(), policy_epoch: admission.decision().policy_epoch,
        grant_epoch: admission.decision().grant_epoch, next_boundary: interval.to.as_ref().filter(|boundary| *boundary > at).cloned() };
    let proof = WatchProof { world: tx.world().clone(), transaction: transaction_id(tx).await?, watch: crate::definitions::canonical_digest(&watch)?, decision: admission.decision().id.clone() };
    crate::facts::support::register_watch(tx, &locked, &watch, admission, Some(proof), at).await?;
    evaluation.dependencies.push(ReadDependency::Watch { id, generation });
    if let Some(at) = &interval.to { let dependency = ReadDependency::TimeBoundary { at: at.clone() }; if !evaluation.dependencies.contains(&dependency) { evaluation.dependencies.push(dependency); } }
    Ok(Some(watch))
}
pub(super) async fn observe_rule(
    tx: &WorldTransaction<'_>, authority: super::current::ReadAuthority<'_>, owner: &Definition<DefinitionBody>,
    release: &Release, declarations: &[Parameter], selector: &ExpressionIr, evaluation: &mut CurrentEvaluation,
    scope: &ScopeId, interval: &ValidTime, now: &Timestamp,
) -> Result<(Digest, Option<world_protocol::authorization::ActualImpact>, Option<(WatchId, Option<QueryWatch>)>), QueryError> {
    let ranges = evaluation.ranges.keys().cloned().collect::<Vec<_>>();
    let inputs = rule_inputs(owner, release, declarations, selector, &evaluation.parameters, &ranges, scope, interval)?;
    let Some(id) = &inputs.4 else { return Ok((crate::definitions::canonical_digest(&inputs)?, None, None)); };
    let impact = authorization::actual_impact(vec![world_protocol::authorization::AccessScope { resources: vec![ResourceRef::Watch { id: id.clone() }], fields: Vec::new(), modes: vec![world_protocol::authorization::AccessMode::Read], scope: scope.clone(), valid_time: Some(interval.clone()) }], vec![world_protocol::expression::Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
    authority.check(tx, &impact, now).await?;
    let watch = tx.query_opt("SELECT generation,body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3 FOR SHARE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?.map(|row| {
        let watch: QueryWatch = super::error::decode(row.get("body"))?;
        if watch.world != *tx.world() || watch.id != *id || watch.generation.0 != row.get::<_, i64>("generation") as u64 { return Err(QueryError::from(world_protocol::query::QueryFailure::BasisChanged)); }
        Ok(watch)
    }).transpose()?;
    let closed = !evaluation.range_incomplete;
    let purpose = if closed && contains_missing(selector) { WatchPurpose::MissingField } else { WatchPurpose::Membership };
    if let Some(at) = &interval.to {
        let dependency = ReadDependency::TimeBoundary { at: at.clone() };
        if !evaluation.dependencies.contains(&dependency) { evaluation.dependencies.push(dependency); }
    }
    Ok((crate::definitions::canonical_digest(&(&inputs, &watch, closed, purpose))?, Some(impact), Some((id.clone(), watch))))
}

pub(super) fn rule_id(
    owner: &Definition<DefinitionBody>, release: &Release, declarations: &[Parameter], selector: &ExpressionIr,
    parameters: &std::collections::BTreeMap<ParameterId, world_protocol::value::Cell>, ranges: &[DefinitionId], scope: &ScopeId, interval: &ValidTime,
) -> Result<Option<WatchId>, QueryError> { Ok(rule_inputs(owner, release, declarations, selector, parameters, ranges, scope, interval)?.4) }
fn rule_inputs(
    owner: &Definition<DefinitionBody>, release: &Release, declarations: &[Parameter], selector: &ExpressionIr,
    parameters: &std::collections::BTreeMap<ParameterId, world_protocol::value::Cell>, ranges: &[DefinitionId], scope: &ScopeId, interval: &ValidTime,
) -> Result<(QueryIr, Vec<world_protocol::query::QueryArgument>, Vec<DefinitionRef>, Digest, Option<WatchId>), QueryError> {
    let mut datasets = Vec::new(); let mut roots = Vec::new();
    for parameter in declarations {
        let (id, object) = match &parameter.value_type { ValueType::Object { type_id } => (type_id, true), ValueType::Relation { type_id } => (type_id, false), _ => continue };
        let definition = release.definitions.iter().find(|item| item.reference.id == *id).ok_or_else(|| invalid("watch.dataset"))?;
        datasets.push(definition.reference.clone());
        let symbol = SymbolId::try_new(parameter.id.as_str()).map_err(|_| invalid("watch.symbol"))?;
        roots.push(if object { QueryNode::Objects { type_ref: definition.reference.clone(), symbol } } else { QueryNode::Relations { type_ref: definition.reference.clone(), symbol } });
    }
    for id in ranges {
        let definition = release.definitions.iter().find(|item| item.reference.id == *id).ok_or_else(|| invalid("watch.dataset"))?;
        if datasets.contains(&definition.reference) { continue; }
        let symbol = SymbolId::try_new(format!("range_{}_collection", roots.len())).map_err(|_| invalid("watch.symbol"))?;
        roots.push(match &definition.body {
            DefinitionBody::ObjectType(_) => QueryNode::Objects { type_ref: definition.reference.clone(), symbol },
            DefinitionBody::RelationType(_) => QueryNode::Relations { type_ref: definition.reference.clone(), symbol },
            _ => return Err(invalid("watch.dataset")),
        });
        datasets.push(definition.reference.clone());
    }
    datasets.sort(); datasets.dedup();
    let query = QueryIr { root: if roots.len() == 1 { roots.remove(0) } else { QueryNode::Union { inputs: roots } }, parameters: declarations.to_vec(), output: vec![QueryColumn { name: "condition".into(), expression: selector.clone() }], limit: 1 };
    let arguments = declarations.iter().filter_map(|parameter| match parameters.get(&parameter.id) {
        Some(world_protocol::value::Cell::Known { value }) => Some(world_protocol::query::QueryArgument { parameter_id: parameter.id.clone(), value: value.clone() }), _ => None,
    }).collect::<Vec<_>>();
    let predicate_digest = crate::definitions::canonical_digest(&("world.rule.watch.v1", &owner.reference, &release.id, &release.source_branch, scope, interval, selector, &arguments, &datasets))?;
    let id = if datasets.is_empty() { None } else { Some(WatchId::try_new(format!("rule-{}", &predicate_digest.as_str()[7..])).map_err(|_| invalid("watch.id"))?) };
    Ok((query, arguments, datasets, predicate_digest, id))
}
pub(super) async fn register_query(
    tx: &WorldTransaction<'_>, admission: &Admission, prepared: &super::PreparedQuery,
    read: &mut super::receipt::StoredRead, now: &Timestamp,
) -> Result<(), QueryError> {
    if prepared.ranges.is_empty() { return Ok(()); }
    let locked = crate::facts::support::recheck_ranges(tx, &prepared.ranges).await?;
    let (plan, output, _) = prepared.evaluation.as_ref().ok_or(world_protocol::query::QueryFailure::BasisChanged)?;
    if plan.datasets.iter().map(|dataset| &dataset.id).ne(prepared.ranges.iter().map(|(id, _)| id)) { return Err(world_protocol::query::QueryFailure::BasisChanged.into()); }
    let predicate_digest = crate::definitions::canonical_digest(&("world.query.watch.v1", &read.receipt.id, &read.receipt.query_digest, &read.receipt.evaluated_scope_digest))?;
    let id = WatchId::try_new(format!("query-{}", &predicate_digest.as_str()[7..])).map_err(|_| invalid("watch.id"))?;
    let closed = !output.incomplete && read.receipt.dirty.is_empty();
    let next_boundary = read.receipt.actual_dependencies.iter().filter_map(|dependency| match dependency { ReadDependency::TimeBoundary { at } => Some(at.clone()), _ => None }).min();
    let watch = QueryWatch { world: tx.world().clone(), id: id.clone(), scope: read.context.scope.clone(),
        selector: ExpressionIr::Literal { value: world_protocol::value::Value::Boolean { value: true } }, predicate_digest,
        purpose: if closed { query_purpose(&prepared.request.query.root) } else { WatchPurpose::Membership },
        window: Some(TimeWindow::Fixed { interval: read.context.valid_time.clone() }), generation: Generation(1),
        coverage: if closed { WatchCoverage::CompleteAuthorizedRange } else { WatchCoverage::Partial },
        query: prepared.request.query.clone(), arguments: prepared.request.arguments.clone(), datasets: plan.datasets.iter().cloned().collect(),
        partitions: Vec::new(), visibility_digest: admission.impact().digest.clone(), policy_epoch: admission.decision().policy_epoch,
        grant_epoch: admission.decision().grant_epoch, next_boundary };
    let proof = WatchProof { world: tx.world().clone(), transaction: transaction_id(tx).await?, watch: crate::definitions::canonical_digest(&watch)?, decision: admission.decision().id.clone() };
    crate::facts::support::register_watch(tx, &locked, &watch, admission, Some(proof), now).await?;
    read.receipt.actual_dependencies.push(ReadDependency::Watch { id, generation: watch.generation });
    Ok(())
}
fn query_purpose(node: &QueryNode) -> WatchPurpose {
    match node {
        QueryNode::NotExists { .. } => WatchPurpose::NotExists,
        QueryNode::Aggregate { .. } => WatchPurpose::Aggregate,
        QueryNode::Limit { .. } | QueryNode::Sort { .. } => WatchPurpose::TopK,
        QueryNode::Filter { input, .. } | QueryNode::Project { input, .. } | QueryNode::Traverse { input, .. } | QueryNode::Distinct { input } => query_purpose(input),
        QueryNode::Join { left, right, .. } => { let purpose = query_purpose(left); if purpose == WatchPurpose::Membership { query_purpose(right) } else { purpose } },
        QueryNode::Union { inputs } => inputs.iter().map(query_purpose).find(|purpose| *purpose != WatchPurpose::Membership).unwrap_or(WatchPurpose::Membership),
        _ => WatchPurpose::Membership,
    }
}

pub(super) fn time_boundary(plan: &super::plan::CheckedPlan, projection: &super::projection::Projection, at: &Timestamp) -> Result<Option<Timestamp>, QueryError> {
    let mut expressions: Vec<_> = plan.query.output.iter().map(|column| &column.expression).collect();
    let mut nodes = vec![&plan.query.root];
    while let Some(node) = nodes.pop() {
        match node {
            QueryNode::Filter { input, predicate } => { nodes.push(input); expressions.push(predicate); },
            QueryNode::Join { left, right, on, .. } => { nodes.extend([left.as_ref(), right.as_ref()]); expressions.push(on); },
            QueryNode::NotExists { input, correlated, predicate } => { nodes.extend([input.as_ref(), correlated.as_ref()]); expressions.push(predicate); },
            QueryNode::Project { input, columns } => { nodes.push(input); expressions.extend(columns.iter().map(|column| &column.expression)); },
            QueryNode::Aggregate { input, group_by, aggregates } => { nodes.push(input); expressions.extend(group_by.iter().map(|column| &column.expression)); expressions.extend(aggregates.iter().map(|aggregate| &aggregate.expression)); },
            QueryNode::Sort { input, order } => { nodes.push(input); expressions.extend(order.iter().map(|order| &order.expression)); },
            QueryNode::Traverse { input, .. } | QueryNode::Distinct { input } | QueryNode::Limit { input, .. } => nodes.push(input),
            QueryNode::Union { inputs } => nodes.extend(inputs), _ => {},
        }
    }
    for function in plan.functions.values() { if let DefinitionBody::Function(function) = &function.body { expressions.push(&function.expression); } }
    let mut windows = Vec::new();
    while let Some(expression) = expressions.pop() {
        match expression {
            ExpressionIr::Aggregate { expression, window, .. } => { expressions.push(expression); if let Some(TimeWindow::Sliding { width, timestamp_property }) = window { if !windows.contains(&(width, timestamp_property)) { windows.push((width, timestamp_property)); } } },
            ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => expressions.push(operand),
            ExpressionIr::Binary { left, right, .. } => expressions.extend([left.as_ref(), right.as_ref()]),
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => expressions.extend(terms),
            ExpressionIr::If { condition, then_value, else_value } => expressions.extend([condition.as_ref(), then_value.as_ref(), else_value.as_ref()]),
            ExpressionIr::Call { arguments, .. } => expressions.extend(arguments), _ => {},
        }
    }
    let mut boundary = None;
    for (width, property) in windows {
        let width = chrono::TimeDelta::milliseconds(i64::try_from(width.0).map_err(|_| invalid("window.width"))?);
        for subject in projection.subjects.values() {
            let Some(world_protocol::query::FieldCell { cell: world_protocol::value::Cell::Known { value: world_protocol::value::Value::Timestamp { value } }, .. }) = subject.fields.get(property) else { continue; };
            let timestamp = chrono::DateTime::parse_from_rfc3339(value.as_str()).map_err(|_| invalid("window.timestamp"))?;
            let end = timestamp.checked_add_signed(width).ok_or_else(|| invalid("window.width"))?;
            for change in [timestamp, end] {
                let change = change.checked_add_signed(chrono::TimeDelta::nanoseconds(1)).ok_or_else(|| invalid("window.timestamp"))?;
                let change = Timestamp::try_new(change.to_rfc3339()).map_err(|_| invalid("window.timestamp"))?;
                if &change > at && boundary.as_ref().is_none_or(|previous| &change < previous) { boundary = Some(change); }
            }
        }
    }
    Ok(boundary)
}

fn contains_missing(expression: &ExpressionIr) -> bool {
    match expression {
        ExpressionIr::IsKnown { .. } => true,
        ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } => contains_missing(operand),
        ExpressionIr::Binary { left, right, .. } => contains_missing(left) || contains_missing(right),
        ExpressionIr::All { terms } | ExpressionIr::Any { terms } => terms.iter().any(contains_missing),
        ExpressionIr::If { condition, then_value, else_value } => contains_missing(condition) || contains_missing(then_value) || contains_missing(else_value),
        ExpressionIr::Call { arguments, .. } => arguments.iter().any(contains_missing),
        ExpressionIr::Aggregate { expression, .. } => contains_missing(expression), _ => false,
    }
}
