use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionFailure, Assurance, BindingTarget, Fallback},
    compiler::{DefinitionIr, ExpressionAnnotation},
    definitions::{Definition, DefinitionBody, Scope},
    expression::{BinaryOperator, Effect, ExpressionIr, Parameter, UnaryOperator},
    failure::FieldPath,
    ids::{Digest, ParameterId, RunId, StepId},
    learning::{CaseOutcome, StrategyOperation, TaskContract},
    time::Timestamp,
    value::{Cell, UnknownReason, Value, ValueType},
};

use crate::{extensions::invocation::CallBudget, query::{EvalContext, EvalRow}};
use super::{Error, strategy::{self, OperationExecution, StepOutput, StrategyBackend, StrategyExecution, StrategyFuture, StrategyPlan}};

const DOMAIN: &str = "world.abstraction.BooleanPlanEquivalenceV1";

/// An owner-minted exhaustive certificate, not a candidate author's assertion or finite test report.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VerifiedBooleanPlan {
    domain: String,
    basis: Digest,
    assignments: u64,
    observations: Digest,
}

/// Checks the entire declared Boolean domain, including the actual concrete mapping and its inverse.
/// A missing preimage is unsupported; assigning fixture cells cannot manufacture a concrete input.
pub(crate) async fn verify_boolean_plan(
    contract: &AbstractionContract, task: &TaskContract,
    definitions: &[Definition<DefinitionBody>], scopes: &[Scope],
    budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp,
) -> Result<VerifiedBooleanPlan, Error> {
    crate::evaluation::validate_task(task).map_err(crate::evaluation::Error::from)?;
    if task.world != contract.world || task.id != contract.task_id || task.revision != contract.task_revision
        || task.scope != contract.scope || !contract.applicable_actions.is_empty()
        || !contract.read_dependencies.is_empty() || task.allowed_effects.iter().any(|effect| *effect != Effect::Pure) {
        return Err(unsupported());
    }
    parameters(&contract.parameters)?;
    let ValueType::Record { fields } = &task.input_type else { return Err(unsupported()); };
    if fields.len() != contract.parameters.len() || fields.iter().any(|field| {
        field.value_type != ValueType::Boolean || field.nullable || field.optional
            || !contract.parameters.iter().any(|parameter| parameter.id.as_str() == field.name)
    }) { return Err(unsupported()); }
    let checked = super::check::contract(contract, definitions, scopes)?;
    let original = contract.strategy.as_ref().ok_or_else(unsupported)?;
    let Fallback::ExpandConcrete { concrete_strategy } = &contract.fallback else { return Err(unsupported()); };
    if concrete_strategy != original || !contract.original_definitions.contains(original) { return Err(unsupported()); }
    let concrete = super::concrete_strategy(contract, definitions, scopes)?.ok_or_else(unsupported)?;
    let owner = definitions.iter().find(|definition| definition.reference == *original).ok_or_else(unsupported)?;
    let DefinitionBody::Strategy(original) = &owner.body else { return Err(unsupported()); };
    if original.fallback.is_some() { return Err(unsupported()); }
    budget.restrict(&task.budget, at).map_err(|_| AbstractionFailure::BudgetExceeded)?;
    budget.restrict(&concrete.budget, at).map_err(|_| AbstractionFailure::BudgetExceeded)?;
    let mut domain = Domain { functions: &checked.functions, visited: BTreeSet::new(), remaining: 65_536 };
    for expression in std::iter::once(&contract.guard).chain(&contract.assumptions)
        .chain(&contract.preserved_invariants).chain(&task.hard_constraints).chain(&task.stop_conditions)
        .chain(std::iter::once(&original.guard)) {
        domain.expression(expression, &contract.parameters)?;
    }
    for steps in [&contract.forward_plan, &original.steps] {
        for step in steps {
            domain.expression(&step.guard, &contract.parameters)?;
            match &step.operation {
                StrategyOperation::Function { function, arguments } => domain.expression(
                    &ExpressionIr::Call { function: function.clone(), arguments: arguments.clone() }, &contract.parameters,
                )?,
                StrategyOperation::Stop { .. } => {},
                _ => return Err(unsupported()),
            }
        }
    }
    for binding in &contract.binding_map.bindings {
        let slot = contract.slots.iter().find(|slot| slot.id == binding.slot_id).ok_or_else(unsupported)?;
        if slot.value_type != ValueType::Boolean || slot.cardinality.minimum != 1 || slot.cardinality.maximum != Some(1)
            || !binding.dependencies.is_empty() || !binding.evidence.is_empty()
            || binding.transform.is_some() != binding.inverse_transform.is_some() {
            return Err(unsupported());
        }
        let BindingTarget::Expression { expression } = &binding.target else { return Err(unsupported()); };
        domain.expression(expression, &contract.parameters)?;
        for expression in binding.guard.iter().chain(&binding.transform).chain(&binding.inverse_transform) {
            domain.expression(expression, &contract.parameters)?;
        }
    }
    let count = u32::try_from(contract.parameters.len()).ok().and_then(|bits| 1_u64.checked_shl(bits)).ok_or_else(unsupported)?;
    if count > budget.remaining(world_protocol::budget::BudgetDimension::Steps).map_err(|_| AbstractionFailure::BudgetExceeded)? {
        return Err(AbstractionFailure::BudgetExceeded.into());
    }
    let mut annotations = checked.annotations.clone();
    let mut concrete_annotations = concrete.annotations.clone();
    for (name, expressions) in [("hardConstraints", &task.hard_constraints), ("stopConditions", &task.stop_conditions)] {
        for (index, expression) in expressions.iter().enumerate() {
            let path = FieldPath(vec![name.into(), index.to_string()]);
            let checked = crate::compiler::check_guard(expression, owner, definitions, scopes, &contract.parameters, &path)?;
            annotations.extend(checked.clone()); concrete_annotations.extend(checked);
        }
    }
    let basis = basis(contract, task, definitions, scopes)?;
    let run = RunId::try_new(format!("boolean-{}", &basis.as_str()[7..])).map_err(|_| AbstractionFailure::InternalFault)?;
    let step = StepId::try_new("boolean-plan-equivalence").map_err(|_| AbstractionFailure::InternalFault)?;
    let mut transcript = basis.clone();
    let mut applicable = false;
    for assignment in 0..count {
        if cancel.is_cancelled() { return Err(AbstractionFailure::Cancelled.into()); }
        budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|_| AbstractionFailure::BudgetExceeded)?;
        let parameters = contract.parameters.iter().enumerate().map(|(index, parameter)| {
            (parameter.id.clone(), Cell::Known { value: Value::Boolean { value: assignment & (1_u64 << index) != 0 } })
        }).collect::<BTreeMap<_, _>>();
        let mut backend = Backend { parameters: parameters.clone(), functions: &checked.functions, annotations: &annotations, at, budget, cancel };
        let mut mapped = contract.parameters.iter().map(|parameter| (parameter.id.clone(), Cell::Unknown { reason: UnknownReason::NotObserved })).collect::<BTreeMap<_, _>>();
        let mut originals = Vec::new();
        for id in &checked.parameter_order {
            let bindings = contract.binding_map.bindings.iter().enumerate().filter(|(_, binding)| binding.parameter_id.as_ref() == Some(id)).collect::<Vec<_>>();
            let [(index, binding)] = bindings.as_slice() else { return Err(unsupported()); };
            let BindingTarget::Expression { expression } = &binding.target else { return Err(unsupported()); };
            backend.parameters = mapped.clone();
            let cell = backend.boolean(expression, &["bindingMap".into(), "bindings".into(), index.to_string(), "target".into(), "expression".into()])?;
            if parameters.get(id) != Some(&cell) { return Err(unsupported()); }
            mapped.insert(id.clone(), cell);
        }
        backend.parameters = mapped.clone();
        let mut use_forward = true;
        for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
            let BindingTarget::Expression { expression } = &binding.target else { return Err(unsupported()); };
            originals.push(backend.boolean(expression, &["bindingMap".into(), "bindings".into(), index.to_string(), "target".into(), "expression".into()])?);
            if let Some(guard) = &binding.guard {
                use_forward &= backend.truth(guard, &["bindingMap".into(), "bindings".into(), index.to_string(), "guard".into()])?;
            }
        }
        let mut transformed = originals.clone();
        if use_forward {
            for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
                if let Some(transform) = &binding.transform {
                    transformed[index] = backend.boolean(transform, &["bindingMap".into(), "bindings".into(), index.to_string(), "transform".into()])?;
                }
            }
            for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
                if let Some(id) = &binding.parameter_id { mapped.insert(id.clone(), transformed[index].clone()); }
            }
            backend.parameters = mapped.clone();
            for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
                if let Some(inverse) = &binding.inverse_transform {
                    if backend.boolean(inverse, &["bindingMap".into(), "bindings".into(), index.to_string(), "inverseTransform".into()])? != originals[index] {
                        return Err(unsupported());
                    }
                }
            }
            for (name, expressions) in [("guard", std::slice::from_ref(&contract.guard)), ("assumptions", contract.assumptions.as_slice()), ("preservedInvariants", contract.preserved_invariants.as_slice())] {
                for (index, expression) in expressions.iter().enumerate() {
                    let path = if name == "guard" { vec![name.into()] } else { vec![name.into(), index.to_string()] };
                    use_forward &= backend.truth(expression, &path)?;
                }
            }
        }
        applicable |= use_forward;
        let mut concrete_backend = Backend { parameters: parameters.clone(), functions: &checked.functions, annotations: &concrete_annotations, at, budget, cancel };
        let original = strategy::execute(&mut concrete_backend, StrategyPlan {
            steps: &concrete.steps, guards: &concrete.guards, hard_constraints: &task.hard_constraints,
            stop_conditions: &task.stop_conditions, invariants: &contract.preserved_invariants, run_id: &run, step_id: &step,
        }, StrategyExecution::new(Vec::new()), budget, cancel).await?;
        let simplified = if use_forward {
            let mut guards = vec![(contract.guard.clone(), vec!["guard".into()])];
            guards.extend(contract.assumptions.iter().enumerate().map(|(index, expression)| (expression.clone(), vec!["assumptions".into(), index.to_string()])));
            strategy::execute(&mut backend, StrategyPlan {
                steps: &contract.forward_plan, guards: &guards, hard_constraints: &task.hard_constraints,
                stop_conditions: &task.stop_conditions, invariants: &contract.preserved_invariants, run_id: &run, step_id: &step,
            }, StrategyExecution::new(Vec::new()), budget, cancel).await?
        } else {
            concrete_backend.parameters = parameters;
            strategy::execute(&mut concrete_backend, StrategyPlan {
                steps: &concrete.steps, guards: &concrete.guards, hard_constraints: &task.hard_constraints,
                stop_conditions: &task.stop_conditions, invariants: &contract.preserved_invariants, run_id: &run, step_id: &step,
            }, StrategyExecution::new(Vec::new()), budget, cancel).await?
        };
        let original = observable(&original)?;
        let simplified = observable(&simplified)?;
        if original != simplified { return Err(unsupported()); }
        transcript = crate::definitions::canonical_digest(&(DOMAIN, &transcript, assignment, &mapped, &original)).map_err(crate::definitions::DefinitionError::from)?;
    }
    if !applicable { return Err(unsupported()); }
    Ok(VerifiedBooleanPlan { domain: DOMAIN.into(), basis, assignments: count, observations: transcript })
}

/// Only immutable owner storage supplies this certificate; recovery checks its entire exact basis.
pub(super) fn check_exact(
    certificate: &VerifiedBooleanPlan, contract: &AbstractionContract, task: &TaskContract,
    definitions: &[Definition<DefinitionBody>], scopes: &[Scope],
) -> Result<(), Error> {
    let count = u32::try_from(contract.parameters.len()).ok().and_then(|bits| 1_u64.checked_shl(bits)).ok_or_else(unsupported)?;
    if certificate.domain != DOMAIN || certificate.assignments != count
        || certificate.basis != basis(contract, task, definitions, scopes)? {
        return Err(unsupported());
    }
    Ok(())
}

fn basis(contract: &AbstractionContract, task: &TaskContract, definitions: &[Definition<DefinitionBody>], scopes: &[Scope]) -> Result<Digest, Error> {
    let mut definitions = definitions.iter().collect::<Vec<_>>();
    definitions.sort_by(|left, right| left.reference.cmp(&right.reference));
    let mut scopes = scopes.iter().collect::<Vec<_>>();
    scopes.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(crate::definitions::canonical_digest(&(DOMAIN, crate::evaluation::abstraction_plan_digest(contract)?, task, definitions, scopes))
        .map_err(crate::definitions::DefinitionError::from)?)
}

fn parameters(parameters: &[Parameter]) -> Result<(), Error> {
    if parameters.iter().any(|parameter| parameter.value_type != ValueType::Boolean || parameter.nullable || parameter.optional) { return Err(unsupported()); }
    Ok(())
}

struct Domain<'a> {
    functions: &'a BTreeMap<world_protocol::ids::DefinitionRef, DefinitionIr>,
    visited: BTreeSet<world_protocol::ids::DefinitionRef>,
    remaining: usize,
}
impl Domain<'_> {
    fn expression(&mut self, expression: &ExpressionIr, parameters: &[Parameter]) -> Result<(), Error> {
        if self.remaining == 0 { return Err(unsupported()); }
        self.remaining -= 1;
        match expression {
            ExpressionIr::Literal { value: Value::Boolean { .. } } => {},
            ExpressionIr::Parameter { id } if parameters.iter().any(|parameter| parameter.id == *id) => {},
            ExpressionIr::Unary { operator: UnaryOperator::Not, operand } | ExpressionIr::IsKnown { operand } | ExpressionIr::IsNull { operand } => self.expression(operand, parameters)?,
            ExpressionIr::Binary { operator: BinaryOperator::Equal | BinaryOperator::NotEqual, left, right } => {
                self.expression(left, parameters)?; self.expression(right, parameters)?;
            },
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => for term in terms { self.expression(term, parameters)?; },
            ExpressionIr::If { condition, then_value, else_value } => for term in [condition.as_ref(), then_value.as_ref(), else_value.as_ref()] { self.expression(term, parameters)?; },
            ExpressionIr::Call { function, arguments } => {
                let functions = self.functions;
                let definition = functions.get(function).ok_or_else(unsupported)?;
                let DefinitionBody::Function(body) = &definition.body else { return Err(unsupported()); };
                parameters_check(body, arguments)?;
                for argument in arguments { self.expression(argument, parameters)?; }
                if self.visited.insert(function.clone()) { self.expression(&body.expression, &body.parameters)?; }
            },
            _ => return Err(unsupported()),
        }
        Ok(())
    }
}
fn parameters_check(body: &world_protocol::definitions::Function, arguments: &[ExpressionIr]) -> Result<(), Error> {
    parameters(&body.parameters)?;
    if body.result_type != ValueType::Boolean || body.effects.iter().any(|effect| *effect != Effect::Pure) || body.parameters.len() != arguments.len() { return Err(unsupported()); }
    Ok(())
}

struct Backend<'a> {
    parameters: BTreeMap<ParameterId, Cell>, functions: &'a BTreeMap<world_protocol::ids::DefinitionRef, DefinitionIr>,
    annotations: &'a [ExpressionAnnotation], at: &'a Timestamp, budget: &'a CallBudget, cancel: &'a CancellationToken,
}
impl Backend<'_> {
    fn boolean(&mut self, expression: &ExpressionIr, path: &[String]) -> Result<Cell, Error> {
        let cell = self.value(expression, &FieldPath(path.to_vec())).map_err(Error::from)?;
        if !matches!(cell, Cell::Known { value: Value::Boolean { .. } }) { return Err(unsupported()); }
        Ok(cell)
    }
    fn truth(&mut self, expression: &ExpressionIr, path: &[String]) -> Result<bool, Error> {
        Ok(matches!(self.boolean(expression, path)?, Cell::Known { value: Value::Boolean { value: true } }))
    }
}
impl StrategyBackend for Backend<'_> {
    fn value(&mut self, expression: &ExpressionIr, path: &FieldPath) -> Result<Cell, crate::evaluation::Error> {
        Ok(crate::query::evaluate_metered(expression, &EvalContext {
            parameters: &self.parameters, row: &EvalRow::default(), collections: &BTreeMap::new(), ranges: None,
            functions: self.functions, annotations: self.annotations, at: self.at,
            max_evaluations: self.budget.remaining(world_protocol::budget::BudgetDimension::Steps)
                .map_err(|error| world_protocol::expression::ExpressionFailure::BudgetExceeded { dimension: error.dimension })?,
            cancellation: self.cancel,
        }, path, self.budget)?)
    }
    fn current(&mut self) -> StrategyFuture<'_, Vec<world_protocol::query::ReadReceipt>> { Box::pin(async { Ok(Vec::new()) }) }
    fn operation<'a>(&'a mut self, index: usize, step: &'a world_protocol::learning::StrategyStep) -> StrategyFuture<'a, OperationExecution> {
        Box::pin(async move {
            let output = match &step.operation {
                StrategyOperation::Function { function, arguments } => StepOutput::Function(self.value(
                    &ExpressionIr::Call { function: function.clone(), arguments: arguments.clone() },
                    &FieldPath(vec!["steps".into(), index.to_string(), "operation".into()]),
                )?),
                StrategyOperation::Stop { reason } => StepOutput::Stop(*reason),
                _ => return Err(unsupported().into()),
            };
            Ok(OperationExecution { output, read_receipts: Vec::new(), used_definitions: Vec::new(), outcome: None, completed: true })
        })
    }
}

fn observable(execution: &StrategyExecution) -> Result<serde_json::Value, Error> {
    let outcome = match execution.outcome.as_ref().ok_or_else(unsupported)? {
        CaseOutcome::Succeeded { result } => serde_json::to_value(("succeeded", result)),
        CaseOutcome::Failed { failure } => serde_json::to_value(("failed", &failure.code, &failure.stage, &failure.message, &failure.details, &failure.recovery)),
        CaseOutcome::Cancelled { .. } => return Err(AbstractionFailure::Cancelled.into()),
        CaseOutcome::Inconclusive { .. } => return Err(unsupported()),
    }.map_err(|_| AbstractionFailure::InternalFault)?;
    if execution.steps.iter().any(|step| matches!(&step.output, Some(StepOutput::Function(cell)) if !matches!(cell, Cell::Known { value: Value::Boolean { .. } }))) {
        return Err(unsupported());
    }
    serde_json::to_value((&execution.steps, &execution.hard_checks, execution.stop, outcome)).map_err(|_| AbstractionFailure::InternalFault.into())
}
fn unsupported() -> Error { AbstractionFailure::AssuranceUnsupported { requested: Assurance::Verified }.into() }
