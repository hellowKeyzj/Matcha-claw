use std::{collections::{BTreeMap, BTreeSet}, future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension, expression::{ExpressionIr, TruthValue},
    failure::{Failure, FailureStage, FieldPath, Recovery}, ids::{DefinitionRef, RunId, StepId},
    learning::{CaseInconclusive, CaseOutcome, LearningFailure, StopReason, StrategyStep},
    query::{QueryPage, ReadReceipt}, value::{Cell, Value},
};
use crate::{evaluation::{Error, ConstraintFailure}, extensions::invocation::CallBudget};

pub(crate) type StrategyFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send + 'a>>;

/// Operation owners supply actual reads/effects; this is the one finite and online step scheduler.
pub(crate) trait StrategyBackend {
    fn value(&mut self, expression: &ExpressionIr, path: &FieldPath) -> Result<Cell, Error>;
    fn current(&mut self) -> StrategyFuture<'_, Vec<ReadReceipt>>;
    fn operation<'a>(&'a mut self, index: usize, step: &'a StrategyStep) -> StrategyFuture<'a, OperationExecution>;
    fn checkpoint<'a>(&'a mut self, _execution: &'a StrategyExecution) -> StrategyFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

pub(crate) struct StrategyPlan<'a> {
    pub steps: &'a [StrategyStep],
    pub guards: &'a [(ExpressionIr, Vec<String>)],
    pub hard_constraints: &'a [ExpressionIr],
    pub stop_conditions: &'a [ExpressionIr],
    pub invariants: &'a [ExpressionIr],
    pub run_id: &'a RunId,
    pub step_id: &'a StepId,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StrategyExecution {
    pub steps: Vec<StepObservation>,
    pub constraints: Vec<(FieldPath, TruthValue)>,
    pub stop: Option<StopReason>,
    pub read_receipts: Vec<ReadReceipt>,
    pub hard_checks: Vec<world_protocol::evaluation::HardCheck>,
    pub used_definitions: BTreeSet<DefinitionRef>,
    pub complete: BTreeSet<StepId>,
    pub inflight: Option<StepId>,
    pub outcome: Option<CaseOutcome>,
}

impl StrategyExecution {
    pub(crate) fn new(read_receipts: Vec<ReadReceipt>) -> Self {
        Self { steps: Vec::new(), constraints: Vec::new(), stop: None, read_receipts,
            hard_checks: Vec::new(), used_definitions: BTreeSet::new(), complete: BTreeSet::new(), inflight: None, outcome: None }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StepObservation {
    pub id: StepId,
    pub guard: TruthValue,
    pub output: Option<StepOutput>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "result", rename_all = "snake_case")]
pub(crate) enum StepOutput {
    Function(Cell),
    Query(QueryPage),
    ActionDryRun(ActionPreview),
    Action(crate::owner::StrategyAction),
    Stop(StopReason),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionPreview {
    pub action: DefinitionRef,
    pub operation: world_protocol::actions::SourceOperation,
    pub preconditions: Vec<TruthValue>,
    pub keys: Vec<(world_protocol::ids::SourceFieldId, Value)>,
    pub values: Vec<(world_protocol::ids::SourceFieldId, Value)>,
    pub expected: Vec<(world_protocol::ids::SourceFieldId, Value)>,
}

pub(crate) struct OperationExecution {
    pub output: StepOutput,
    pub read_receipts: Vec<ReadReceipt>,
    pub used_definitions: Vec<DefinitionRef>,
    pub outcome: Option<CaseOutcome>,
    pub completed: bool,
}

pub(crate) async fn execute(
    backend: &mut impl StrategyBackend, plan: StrategyPlan<'_>, mut execution: StrategyExecution,
    budget: &CallBudget, cancellation: &CancellationToken,
) -> Result<StrategyExecution, Error> {
    if execution.outcome.is_some() { return Ok(execution); }
    while execution.outcome.is_none() && execution.complete.len() < plan.steps.len() {
        let (index, step) = plan.steps.iter().enumerate().find(|(_, step)| !execution.complete.contains(&step.id)
            && step.depends_on.iter().all(|dependency| execution.complete.contains(dependency)))
            .ok_or_else(|| invalid("plan.steps.dependsOn"))?;
        let recovering_action = execution.inflight.as_ref() == Some(&step.id)
            && matches!(step.operation, world_protocol::learning::StrategyOperation::Action { .. });
        let guard = if recovering_action {
            execution.steps.iter().find(|observation| observation.id == step.id).ok_or_else(|| invalid("trace.inflight"))?.guard
        } else {
            if cancellation.is_cancelled() { return Err(world_protocol::evaluation::EvaluationFailure::Cancelled.into()); }
            budget.check().map_err(budget_failure)?;
            execution.read_receipts.extend(backend.current().await?);
            if !constraints(backend, &plan, &mut execution, plan.guards)?
                || stop_conditions(backend, &plan, &mut execution)? { break; }
            let path = FieldPath(vec!["steps".into(), index.to_string(), "guard".into()]);
            let guard = crate::query::truth_value(&value(backend, &mut execution, &step.guard, &path)?)?;
            if let Some(outcome) = constraint_outcome(&plan, path, guard) {
                execution.steps.push(StepObservation { id: step.id.clone(), guard, output: None });
                execution.outcome = Some(outcome); break;
            }
            budget.charge(BudgetDimension::Steps, 1).map_err(budget_failure)?;
            execution.inflight = Some(step.id.clone());
            execution.steps.retain(|observation| observation.id != step.id);
            execution.steps.push(StepObservation { id: step.id.clone(), guard, output: None });
            backend.checkpoint(&execution).await?;
            guard
        };
        let path = FieldPath(vec!["steps".into(), index.to_string(), "operation".into()]);
        let produced = backend.operation(index, step).await?;
        execution.read_receipts.extend(produced.read_receipts);
        execution.used_definitions.extend(produced.used_definitions);
        execution.outcome = produced.outcome;
        match &produced.output {
            StepOutput::Function(cell) if !matches!(cell, Cell::Known { .. }) => execution.outcome = Some(CaseOutcome::Inconclusive {
                reason: CaseInconclusive::ResultUnavailable { field: path.clone(), cell: cell.clone() },
            }),
            StepOutput::Stop(reason) => {
                execution.stop = Some(*reason);
                if *reason != StopReason::GoalSatisfied { execution.outcome = Some(CaseOutcome::Inconclusive {
                    reason: CaseInconclusive::Stopped { field: path.clone(), reason: *reason },
                }); }
            }
            StepOutput::ActionDryRun(preview) => {
                for (index, truth) in preview.preconditions.iter().enumerate() {
                    let mut field = path.0.clone(); field.extend(["preconditions".into(), index.to_string()]);
                    if let Some(outcome) = constraint_outcome(&plan, FieldPath(field), *truth) { execution.outcome = Some(outcome); break; }
                }
            }
            _ => {}
        }
        let stopped = matches!(produced.output, StepOutput::Stop(_));
        execution.steps.retain(|observation| observation.id != step.id);
        execution.steps.push(StepObservation { id: step.id.clone(), guard, output: Some(produced.output) });
        if produced.completed { execution.complete.insert(step.id.clone()); execution.inflight = None; }
        if cancellation.is_cancelled() && recovering_action { return Ok(execution); }
        if execution.outcome.is_none() && !stopped || !produced.completed { backend.checkpoint(&execution).await?; }
        if !produced.completed { return Ok(execution); }
        if stopped { break; }
    }
    if execution.outcome.is_none() {
        execution.read_receipts.extend(backend.current().await?);
        let guards = if plan.steps.is_empty() { plan.guards } else { &[] };
        constraints(backend, &plan, &mut execution, guards)?;
    }
    if execution.outcome.is_none() { stop_conditions(backend, &plan, &mut execution)?; }
    if execution.outcome.is_none() {
        let fields = execution.steps.iter().filter_map(|step| match &step.output {
            Some(StepOutput::Function(Cell::Known { value })) => Some((step.id.to_string(), value.clone())), _ => None,
        }).collect::<BTreeMap<_, _>>();
        execution.outcome = Some(CaseOutcome::Succeeded { result: Value::Record { fields } });
    }
    backend.checkpoint(&execution).await?;
    Ok(execution)
}

fn value(backend: &mut impl StrategyBackend, execution: &mut StrategyExecution, expression: &ExpressionIr, path: &FieldPath) -> Result<Cell, Error> {
    execution.used_definitions.extend(crate::definitions::expression_references(expression));
    backend.value(expression, path)
}
fn truth(backend: &mut impl StrategyBackend, execution: &mut StrategyExecution, expression: &ExpressionIr, path: &FieldPath) -> Result<TruthValue, Error> {
    let truth = crate::query::truth_value(&value(backend, execution, expression, path)?)?;
    execution.constraints.push((path.clone(), truth));
    Ok(truth)
}
fn constraints(
    backend: &mut impl StrategyBackend, plan: &StrategyPlan<'_>, execution: &mut StrategyExecution,
    guards: &[(ExpressionIr, Vec<String>)],
) -> Result<bool, Error> {
    for (name, expressions) in [("hardConstraints", plan.hard_constraints), ("preservedInvariants", plan.invariants)] {
        for (index, expression) in expressions.iter().enumerate() {
            let path = FieldPath(vec![name.into(), index.to_string()]);
            let truth = truth(backend, execution, expression, &path)?;
            if name == "hardConstraints" {
                let name = format!("hard_constraint_{index}");
                if matches!(truth, TruthValue::True | TruthValue::False) {
                    if let Some(check) = execution.hard_checks.iter_mut().find(|check| check.name == name) {
                        check.passed = truth == TruthValue::True;
                    } else {
                        execution.hard_checks.push(world_protocol::evaluation::HardCheck {
                            name, passed: truth == TruthValue::True, evidence: Vec::new(),
                        });
                    }
                } else {
                    execution.hard_checks.retain(|check| check.name != name);
                }
            }
            if let Some(outcome) = constraint_outcome(plan, path, truth) {
                execution.outcome = Some(outcome); return Ok(false);
            }
        }
    }
    for (expression, path) in guards {
        let path = FieldPath(path.clone());
        let truth = truth(backend, execution, expression, &path)?;
        if let Some(outcome) = constraint_outcome(plan, path, truth) {
            execution.outcome = Some(outcome); return Ok(false);
        }
    }
    Ok(true)
}
fn stop_conditions(backend: &mut impl StrategyBackend, plan: &StrategyPlan<'_>, execution: &mut StrategyExecution) -> Result<bool, Error> {
    for (index, expression) in plan.stop_conditions.iter().enumerate() {
        let path = FieldPath(vec!["stopConditions".into(), index.to_string()]);
        let truth = truth(backend, execution, expression, &path)?;
        if truth != TruthValue::False {
            execution.outcome = Some(CaseOutcome::Inconclusive { reason: if truth == TruthValue::True {
                CaseInconclusive::StopConditionSatisfied { field: path }
            } else { CaseInconclusive::GuardNotSatisfied { field: path, truth } } });
            return Ok(true);
        }
    }
    Ok(false)
}
fn constraint_outcome(plan: &StrategyPlan<'_>, field: FieldPath, truth: TruthValue) -> Option<CaseOutcome> {
    match truth {
        TruthValue::True => None,
        TruthValue::False => Some(CaseOutcome::Failed { failure: Failure {
            code: "world.evaluation.constraint_violated".into(), stage: FailureStage::Execute, message: "执行约束不成立。".into(),
            diagnostic_id: world_protocol::ids::DiagnosticId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
            operation_id: None, run_id: Some(plan.run_id.clone()), step_id: Some(plan.step_id.clone()),
            details: LearningFailure::ConstraintViolated { field }, recovery: Recovery::None,
        } }),
        truth => Some(CaseOutcome::Inconclusive { reason: CaseInconclusive::GuardNotSatisfied { field, truth } }),
    }
}
fn invalid(field: &str) -> Error { ConstraintFailure::Invalid { field: FieldPath(field.split('.').map(str::to_owned).collect()) }.into() }
fn budget_failure(error: crate::extensions::invocation::BudgetFailure) -> Error {
    world_protocol::evaluation::EvaluationFailure::BudgetExhausted { dimension: error.dimension }.into()
}
