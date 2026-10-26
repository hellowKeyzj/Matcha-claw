use world_protocol::{actions::{SourceMutation, SourceOperation}, definitions::DefinitionBody, expression::TruthValue, ids::*, provenance::ReadDependency, query::{QueryArgument, QueryFailure}, time::Timestamp, value::{Cell, Value}};
use crate::{authorization::{self, Admission}, extensions::invocation::CallBudget, store::{WorldSnapshot, WorldTransaction}};
use tokio_util::sync::CancellationToken;
use serde::{Deserialize, Serialize};
use super::{QueryError, current, error::invalid, truth_value};

/// Only actual canonical contract evaluation can construct resolved source values.
pub(crate) struct ActionEvaluation {
    contract: DefinitionRef, arguments: Vec<QueryArgument>, release: ReleaseId, scope: ScopeId, at: Timestamp,
    branch: Option<world_protocol::releases::BranchRef>, activation_lock: ActivationLockId, decision: DecisionId,
    operation: SourceOperation, preconditions: Vec<TruthValue>, keys: Vec<(SourceFieldId, Value)>,
    values: Vec<(SourceFieldId, Value)>, expected: Vec<(SourceFieldId, Value)>, dependencies: Vec<ReadDependency>,
}
impl ActionEvaluation {
    pub(crate) fn contract(&self) -> &DefinitionRef { &self.contract }
    pub(crate) fn arguments(&self) -> &[QueryArgument] { &self.arguments }
    pub(crate) fn release(&self) -> &ReleaseId { &self.release }
    pub(crate) fn scope(&self) -> &ScopeId { &self.scope }
    pub(crate) fn at(&self) -> &Timestamp { &self.at }
    pub(crate) fn operation(&self) -> &SourceOperation { &self.operation }
    pub(crate) fn preconditions(&self) -> &[TruthValue] { &self.preconditions }
    pub(crate) fn keys(&self) -> &[(SourceFieldId, Value)] { &self.keys }
    pub(crate) fn values(&self) -> &[(SourceFieldId, Value)] { &self.values }
    pub(crate) fn expected(&self) -> &[(SourceFieldId, Value)] { &self.expected }
    pub(crate) fn dependencies(&self) -> &[ReadDependency] { &self.dependencies }
    pub(crate) fn matches_retained(&self, value: &serde_json::Value) -> Result<bool, QueryError> {
        let retained: RetainedEvaluation = super::error::decode(value.clone())?;
        Ok(self.contract == retained.contract && self.arguments == retained.arguments && self.release == retained.release
            && self.branch == retained.branch && self.activation_lock == retained.activation_lock && self.decision == retained.decision
            && self.scope == retained.scope && self.operation == retained.operation
            && self.keys == retained.keys && self.values == retained.values && self.expected == retained.expected)
    }
    pub(crate) fn retained(&self) -> Result<serde_json::Value, QueryError> {
        super::error::encode(&RetainedEvaluation { contract: self.contract.clone(), arguments: self.arguments.clone(), release: self.release.clone(), branch: self.branch.clone(), activation_lock: self.activation_lock.clone(), decision: self.decision.clone(), scope: self.scope.clone(), at: self.at.clone(), operation: self.operation.clone(), preconditions: self.preconditions.clone(), keys: self.keys.clone(), values: self.values.clone(), expected: self.expected.clone(), dependencies: self.dependencies.clone() })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetainedEvaluation {
    contract: DefinitionRef, arguments: Vec<QueryArgument>, release: ReleaseId, branch: Option<world_protocol::releases::BranchRef>,
    activation_lock: ActivationLockId, decision: DecisionId, scope: ScopeId, at: Timestamp, operation: SourceOperation,
    preconditions: Vec<TruthValue>, keys: Vec<(SourceFieldId, Value)>, values: Vec<(SourceFieldId, Value)>, expected: Vec<(SourceFieldId, Value)>, dependencies: Vec<ReadDependency>,
}
pub(crate) fn retained_action_dependencies(value: &serde_json::Value) -> Result<Vec<ReadDependency>, QueryError> {
    let retained: RetainedEvaluation = super::error::decode(value.clone())?;
    Ok(retained.dependencies)
}
pub(crate) fn retained_action_roots(value: &serde_json::Value) -> Result<crate::store::RetentionRoots, QueryError> {
    let retained: RetainedEvaluation = super::error::decode(value.clone())?;
    let mut roots = crate::store::RetentionRoots::default();
    roots.scopes.push(retained.scope); roots.releases.push(retained.release); roots.definitions.extend([retained.contract, retained.operation.binding]);
    roots.branches.extend(retained.branch); roots.dependencies.extend(retained.dependencies);
    for value in retained.arguments.into_iter().map(|argument| argument.value).chain(retained.keys.into_iter().chain(retained.values).chain(retained.expected).map(|(_, value)| value)) {
        super::receipt::retain_cell(&mut roots, Cell::Known { value });
    }
    Ok(roots)
}
pub(crate) async fn restore_action_evaluation(snapshot: &WorldSnapshot<'_>, admission: &Admission, intent: &world_protocol::actions::EffectIntent) -> Result<ActionEvaluation, QueryError> {
    let now = snapshot.now().await?;
    authorization::recheck_read(snapshot, admission, &now).await?;
    let row = snapshot.query_opt("SELECT record,execution,actor_id,decision_id,activation_lock_id FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &intent.id.as_str()]).await?.ok_or(QueryFailure::BasisChanged)?;
    let durable: world_protocol::actions::EffectIntent = super::error::decode(row.get("record"))?;
    let execution: serde_json::Value = row.get("execution");
    let retained: RetainedEvaluation = super::error::decode(execution.get("evaluation").cloned().ok_or(QueryFailure::BasisChanged)?)?;
    let actor = match &admission.invocation().actor { world_protocol::authorization::Actor::Human { id } | world_protocol::authorization::Actor::Service { id } => id };
    if durable != *intent || durable.action.world != *snapshot.world() || retained.contract != durable.action || retained.arguments != durable.argument_values
        || retained.operation != durable.source_operation || retained.activation_lock != durable.activation_lock_id || retained.decision != durable.decision_id
        || row.get::<_, String>("decision_id") != durable.decision_id.as_str() || row.get::<_, String>("activation_lock_id") != durable.activation_lock_id.as_str()
        || row.get::<_, String>("actor_id") != actor.as_str() || retained.branch.is_some() || admission.invocation().branch_id.is_some() {
        return Err(QueryFailure::BasisChanged.into());
    }
    let release = crate::releases::read_release_snapshot(snapshot, &retained.release).await?.ok_or(QueryFailure::BasisChanged)?;
    if release.artifact.activation_lock_id != retained.activation_lock { return Err(QueryFailure::BasisChanged.into()); }
    let definition = release.definitions.iter().find(|item| item.reference == retained.contract).ok_or(QueryFailure::BasisChanged)?;
    let DefinitionBody::ActionContract(contract) = &definition.body else { return Err(invalid("contract")); };
    if contract.source_operation != retained.operation { return Err(QueryFailure::BasisChanged.into()); }
    let context = execution.get("context").ok_or(QueryFailure::BasisChanged)?;
    if context.get("releaseId").and_then(serde_json::Value::as_str) != Some(retained.release.as_str())
        || context.get("scope").and_then(serde_json::Value::as_str) != Some(retained.scope.as_str())
        || context.get("at").and_then(serde_json::Value::as_str) != Some(retained.at.as_str()) { return Err(QueryFailure::BasisChanged.into()); }
    crate::facts::support::recheck_dependencies_snapshot_in_model(snapshot, &retained.dependencies, &release, &retained.scope, &super::projection::point(&retained.at)?, &now).await?;
    let (fields, _) = current::expression_closure(&contract.preconditions.iter().chain(std::iter::once(&contract.expected_effect)).collect::<Vec<_>>(), &release)?;
    let plan = super::plan::CheckedPlan { query: contract.verifier.query.clone(), datasets: Default::default(), fields, annotations: Vec::new(), functions: Default::default() };
    let impact = super::metadata::impact_for(snapshot, &plan, &release, &retained.scope).await?;
    admission.require_access(&impact)?;
    if let Some(dependencies) = crate::facts::support::dependency_impact_snapshot(snapshot, &retained.dependencies, &release, &retained.scope, &super::projection::point(&retained.at)?).await? {
        admission.require_access(&dependencies)?;
        authorization::check_admitted_output_read(snapshot, admission, &dependencies, 0, &now).await?;
    }
    let evidence: Vec<_> = retained.dependencies.iter().filter_map(|dependency| match dependency { ReadDependency::Evidence { reference } => Some(reference.clone()), _ => None }).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    crate::facts::assertions::require_evidence_snapshot(snapshot, admission, &evidence, &retained.scope, Some(&super::projection::point(&retained.at)?), &now).await?;
    Ok(ActionEvaluation { contract: retained.contract, arguments: retained.arguments, release: retained.release, branch: retained.branch,
        activation_lock: retained.activation_lock, decision: retained.decision, scope: retained.scope, at: retained.at, operation: retained.operation,
        preconditions: retained.preconditions, keys: retained.keys, values: retained.values, expected: retained.expected, dependencies: retained.dependencies })
}

pub(crate) async fn action_impact(
    tx: &WorldTransaction<'_>, contract: &DefinitionRef, release: &ReleaseId, branch: Option<&BranchId>,
    arguments: &[QueryArgument], scope: &ScopeId, _at: &Timestamp,
) -> Result<world_protocol::authorization::ActualImpact, QueryError> {
    let release = current::release(tx, release, branch).await?;
    let definition = release.definitions.iter().find(|item| &item.reference == contract).ok_or_else(|| invalid("contract"))?;
    let DefinitionBody::ActionContract(action) = &definition.body else { return Err(invalid("contract")); };
    crate::compiler::check_action(definition, &release.definitions, &release.scopes)?;
    let mut expressions: Vec<_> = action.preconditions.iter().collect();
    expressions.push(&action.expected_effect);
    match &action.source_operation.mutation {
        SourceMutation::Insert { values } => expressions.extend(values.iter().map(|field| &field.expression)),
        SourceMutation::Update { keys, values, expected } => expressions.extend(keys.iter().chain(values).chain(expected).map(|field| &field.expression)),
        SourceMutation::Delete { keys, expected } => expressions.extend(keys.iter().chain(expected).map(|field| &field.expression)),
    }
    if let Some(compensation) = &action.compensation { expressions.extend(compensation.preconditions.iter()); expressions.extend(compensation.arguments.iter().map(|argument| &argument.expression)); }
    current::impact(tx, definition, &release, &action.parameters, arguments, &expressions, scope).await
}

pub(crate) async fn evaluate_action(
    tx: &WorldTransaction<'_>, admission: &Admission, contract: &DefinitionRef,
    release: &ReleaseId, branch: Option<&BranchId>, arguments: &[QueryArgument], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp,
) -> Result<ActionEvaluation, QueryError> {
    let release = current::release(tx, release, branch).await?;
    let definition = release.definitions.iter().find(|item| &item.reference == contract).ok_or_else(|| invalid("contract"))?;
    let DefinitionBody::ActionContract(action) = &definition.body else { return Err(invalid("contract")); };
    let ir = crate::compiler::check_action(definition, &release.definitions, &release.scopes)?;
    let mut expressions: Vec<_> = action.preconditions.iter().collect();
    let groups: Vec<(&str, &[world_protocol::actions::SourceFieldExpression])> = match &action.source_operation.mutation {
        SourceMutation::Insert { values } => vec![("values", values)],
        SourceMutation::Update { keys, values, expected } => vec![("keys", keys), ("values", values), ("expected", expected)],
        SourceMutation::Delete { keys, expected } => vec![("keys", keys), ("expected", expected)],
    };
    expressions.extend(groups.iter().flat_map(|(_, fields)| fields.iter().map(|field| &field.expression)));
    let evaluation = current::prepare(tx, admission, definition, &release, &action.parameters, arguments,
        &expressions, ir.annotations, scope, &super::projection::point(at)?, budget, cancel, at).await?;
    let preconditions = action.preconditions.iter().enumerate().map(|(index, expression)| Ok(truth_value(&evaluation.value(expression, &["preconditions".into(), index.to_string()], at)?)?)).collect::<Result<Vec<_>, QueryError>>()?;
    let mut result = ActionEvaluation { contract: contract.clone(), arguments: arguments.to_vec(), release: release.id.clone(), scope: scope.clone(), at: at.clone(),
        branch: release.source_branch.clone(), activation_lock: release.artifact.activation_lock_id.clone(), decision: admission.decision().id.clone(),
        operation: action.source_operation.clone(), preconditions, keys: Vec::new(), values: Vec::new(), expected: Vec::new(), dependencies: evaluation.dependencies.clone() };
    for (name, fields) in groups {
        let target = match name { "keys" => &mut result.keys, "values" => &mut result.values, _ => &mut result.expected };
        for (index, field) in fields.iter().enumerate() {
            let cell = evaluation.value(&field.expression, &["sourceOperation".into(), "mutation".into(), name.into(), index.to_string(), "expression".into()], at)?;
            let Cell::Known { value } = cell else { return Err(QueryFailure::BasisChanged.into()); };
            target.push((field.field.clone(), value));
        }
    }
    Ok(result)
}
