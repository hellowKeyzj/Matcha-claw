use tokio_util::sync::CancellationToken;
use world_protocol::{definitions::DefinitionBody, expression::TruthValue, identity::SubjectRef, ids::*, provenance::ReadDependency, query::{QueryArgument, QueryFailure}, time::Timestamp, value::{Cell, Value}};
use crate::{authorization::Admission, extensions::invocation::CallBudget, store::WorldTransaction};
use super::{QueryError, current, error::invalid, truth_value};

/// Resolved only from the canonical compensation and current authorized facts.
pub(crate) struct CompensationEvaluation {
    contract: DefinitionRef, source_arguments: Vec<QueryArgument>, action: DefinitionRef, arguments: Vec<QueryArgument>, targets: Vec<SubjectRef>,
    preconditions: Vec<TruthValue>, dependencies: Vec<ReadDependency>,
}
impl CompensationEvaluation {
    pub(crate) fn contract(&self) -> &DefinitionRef { &self.contract }
    pub(crate) fn source_arguments(&self) -> &[QueryArgument] { &self.source_arguments }
    pub(crate) fn action(&self) -> &DefinitionRef { &self.action }
    pub(crate) fn arguments(&self) -> &[QueryArgument] { &self.arguments }
    pub(crate) fn targets(&self) -> &[SubjectRef] { &self.targets }
    pub(crate) fn preconditions(&self) -> &[TruthValue] { &self.preconditions }
    pub(crate) fn dependencies(&self) -> &[ReadDependency] { &self.dependencies }
}
pub(crate) async fn evaluate_compensation(
    tx: &WorldTransaction<'_>, admission: &Admission, contract: &DefinitionRef,
    release: &ReleaseId, branch: Option<&BranchId>, arguments: &[QueryArgument], scope: &ScopeId,
    budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp,
) -> Result<CompensationEvaluation, QueryError> {
    let release = current::release(tx, release, branch).await?;
    let owner = release.definitions.iter().find(|item| item.reference == *contract).ok_or_else(|| invalid("contract"))?;
    let DefinitionBody::ActionContract(action) = &owner.body else { return Err(invalid("contract")); };
    let ir = crate::compiler::check_action(owner, &release.definitions, &release.scopes)?;
    let compensation = action.compensation.as_ref().ok_or_else(|| invalid("compensation"))?;
    let target = release.definitions.iter().find(|item| item.reference == compensation.action).ok_or(QueryFailure::BasisChanged)?;
    let DefinitionBody::ActionContract(target_action) = &target.body else { return Err(invalid("compensation.action")); };
    crate::definitions::validate_applicability(target, scope, &super::projection::point(at)?, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
    let expressions: Vec<_> = compensation.preconditions.iter().chain(compensation.arguments.iter().map(|item| &item.expression)).collect();
    let evaluation = current::prepare(tx, admission, owner, &release, &action.parameters, arguments,
        &expressions, ir.annotations, scope, &super::projection::point(at)?, budget, cancel, at).await?;
    let preconditions = compensation.preconditions.iter().enumerate().map(|(index, expression)| {
        Ok(truth_value(&evaluation.value(expression, &["compensation".into(), "preconditions".into(), index.to_string()], at)?)?)
    }).collect::<Result<Vec<_>, QueryError>>()?;
    let mut resolved = Vec::new();
    for (index, argument) in compensation.arguments.iter().enumerate() {
        let parameter = target_action.parameters.iter().find(|parameter| parameter.id.as_str() == argument.name).ok_or_else(|| invalid("compensation.arguments"))?;
        let cell = evaluation.value(&argument.expression, &["compensation".into(), "arguments".into(), index.to_string(), "expression".into()], at)?;
        let Cell::Known { value } = cell else { return Err(QueryFailure::BasisChanged.into()); };
        resolved.push(QueryArgument { parameter_id: parameter.id.clone(), value });
    }
    super::engine::parameters(&target_action.parameters, &resolved)?;
    let mut targets = Vec::new();
    for target in &target_action.targets {
        let argument = resolved.iter().find(|argument| argument.parameter_id == target.parameter_id).ok_or_else(|| invalid("compensation.targets"))?;
        let subject = match &argument.value {
            Value::Object { id } => SubjectRef::Object { id: id.clone() }, Value::Relation { id } => SubjectRef::Relation { id: id.clone() },
            _ => return Err(invalid("compensation.targets")),
        };
        if !targets.contains(&subject) { targets.push(subject); }
    }
    targets.sort();
    Ok(CompensationEvaluation { contract: contract.clone(), source_arguments: arguments.to_vec(), action: compensation.action.clone(), arguments: resolved, targets, preconditions, dependencies: evaluation.dependencies })
}
