use std::{collections::BTreeMap, sync::{Arc, Mutex}};

use serde::{Deserialize, Serialize};
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionFailure}, api::{ResolveTaskRequest, WorldCommand},
    compiler::ExpressionAnnotation, definitions::DefinitionBody, expression::{ExpressionIr, Parameter},
    failure::{FailureStage, FieldPath}, ids::*, learning::{CaseOutcome, StrategyOperation, StrategyStep, TaskContract},
    query::{PageRequest, QueryArgument, QueryPage, QueryRequest, ReadReceipt}, time::Timestamp, value::Cell,
};
use crate::{
    authorization::{self, OnlineOracleBinding}, evaluation, owner::{self, ExecutionContext, StepRecord},
    query::{self, SourceBrokers}, store::{RetentionRoots, WorldTransaction},
};
use super::{basis, check, strategy::{self, OperationExecution, StepOutput, StrategyBackend, StrategyExecution, StrategyFuture, StrategyPlan}, ConcreteTask, ConcreteWitness, Resolution};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    contract: AbstractionContract,
    task: TaskContract,
    owner: DefinitionRef,
    parameters: BTreeMap<ParameterId, Cell>,
    concrete: QueryPage,
    declarations: Vec<Parameter>,
    steps: Vec<StrategyStep>,
    guards: Vec<(ExpressionIr, Vec<String>)>,
    annotations: Vec<ExpressionAnnotation>,
    expansion: Option<ConcreteWitness>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    request: ResolveTaskRequest,
    plan: Plan,
    plan_digest: Digest,
    execution: StrategyExecution,
}

/// Resolution is an in-process result of the real abstraction commit, never caller proof.
/// Recovery loads the original typed plan from its claimed step; `saved` only checks continuity.
pub(crate) async fn execute_online(
    ctx: &ExecutionContext, request: &ResolveTaskRequest, resolution: Option<Resolution>,
    brokers: &SourceBrokers, saved: Option<StrategyExecution>,
) -> Result<StrategyExecution, owner::Error> {
    let id = step_id(&ctx.operation.world, &ctx.run.id)?;
    let exact = request.clone();
    let current = ctx.clone();
    let claimed_id = id.clone();
    let step = if resolution.is_none() { parent_step(ctx, &id).await? } else { ctx.transact(
        &format!("strategy.claim.{}", ctx.admission.invocation().id), command_digest(request)?,
        &["learning", "query", "authorization"],
        move |tx, admission, operation, run| Box::pin(async move {
            if !matches!(operation.input.command()?, WorldCommand::ResolveTask(actual) if actual == &exact) {
                return Err(changed());
            }
            if let Some(step) = owner::read_step(tx, &run.id, &claimed_id).await? {
                let state = checked(&step)?;
                if state.request != exact || step.input_digest != command_digest(&exact)? { return Err(changed()); }
                return Ok(step);
            }
            prepare_online_strategy(tx, &current, &admission, &run, &exact, resolution.ok_or_else(changed)?).await?;
            owner::read_step(tx, &run.id, &claimed_id).await?.ok_or_else(changed)
        }),
    ).await?.value };
    let state = checked(&step)?;
    if let Some(saved) = &saved { if digest(saved)? != digest(&state.execution)? { return Err(changed()); } }
    let mut backend = OnlineBackend { ctx, request, brokers, step_id: id, plan: state.plan.clone(), context: None, at: None };
    let plan = StrategyPlan {
        steps: &state.plan.steps, guards: &state.plan.guards, hard_constraints: &state.plan.task.hard_constraints,
        stop_conditions: &state.plan.task.stop_conditions, invariants: &state.plan.contract.preserved_invariants,
        run_id: &ctx.run.id, step_id: &step.id,
    };
    strategy::execute(&mut backend, plan, state.execution, &ctx.budget, &ctx.cancellation).await.map_err(Into::into)
}

/// Called in the same transaction as abstraction::commit and the Resolve context checkpoint.
pub(crate) async fn prepare_online_strategy(
    tx: &mut WorldTransaction<'_>, ctx: &ExecutionContext, admission: &authorization::Admission,
    run: &owner::RunRecord, request: &ResolveTaskRequest, resolution: Resolution,
) -> Result<StrategyExecution, owner::Error> {
    let id = step_id(tx.world(), &run.id)?;
    if run.id != ctx.run.id || run.operation.operation_id != ctx.operation.operation_id { return Err(changed()); }
    if let Some(step) = owner::read_step(tx, &run.id, &id).await? {
        let state = checked(&step)?;
        if state.request != *request { return Err(changed()); }
        return Ok(state.execution);
    }
    let (plan, execution) = plan(tx, ctx, admission, request, resolution).await?;
    let now = tx.now().await?;
    let step = owner::claim_step(tx, admission, run, id, 2, "learning.strategy", command_digest(request)?, &now).await?;
    let state = Checkpoint { request: request.clone(), plan_digest: digest(&plan)?, plan, execution: execution.clone() };
    let mut next = step.clone();
    next.checkpoint = encode(&state)?;
    owner::checkpoint_step(tx, &step, next).await?;
    Ok(execution)
}

async fn plan(
    tx: &WorldTransaction<'_>, ctx: &ExecutionContext, admission: &authorization::Admission,
    request: &ResolveTaskRequest, resolution: Resolution,
) -> Result<(Plan, StrategyExecution), owner::Error> {
    let (contract, parameters, page, expanded) = match resolution {
        Resolution::Applicable { contract, parameters, concrete } => (contract, parameters, concrete, None),
        Resolution::Expanded { contract, parameters, strategy, reason, concrete, .. } => (contract, parameters, concrete, Some((strategy, reason))),
        _ => return Err(changed()),
    };
    if request.task.world != contract.world || request.task.id != contract.task_id || request.task.revision != contract.task_revision
        || request.abstraction_id != contract.id || request.abstraction_revision != contract.revision
        || request.query.release_id.as_ref() != Some(&contract.base_release)
        || request.query.branch_id.as_ref() != contract.branch.as_ref().map(|branch| &branch.id)
        || super::read(tx, &contract.id, contract.revision).await?.as_ref() != Some(&contract)
        || query::read_receipt(tx, &page.receipt.id).await? != page.receipt {
        return Err(changed());
    }
    let basis = basis::load(tx, &ctx.resources.content, admission, &contract, false).await?;
    crate::definitions::validate_value(&basis.task.input_type, false, &request.input).map_err(crate::definitions::DefinitionError::from).map_err(super::Error::from)?;
    let checked = check::contract(&contract, &basis.definitions, &basis.scopes)?;
    let mut guards = vec![(contract.guard.clone(), vec!["guard".into()])];
    guards.extend(contract.assumptions.iter().enumerate().map(|(index, expression)| (expression.clone(), vec!["assumptions".into(), index.to_string()])));
    let (owner, declarations, steps, annotations) = if let Some((strategy, _)) = &expanded {
        (strategy.owner.clone(), strategy.parameters.clone(), strategy.steps.clone(), strategy.annotations.clone())
    } else {
        (checked.owner, contract.parameters.clone(), contract.forward_plan.clone(), checked.annotations)
    };
    if let Some((strategy, _)) = &expanded { guards = strategy.guards.clone(); }
    let mut plan = Plan { contract, task: basis.task, owner, parameters, concrete: page.clone(), declarations, steps, guards, annotations, expansion: None };
    let definition = basis.definitions.iter().find(|definition| definition.reference == plan.owner).ok_or_else(changed)?;
    for (name, expressions) in [("hardConstraints", &plan.task.hard_constraints), ("stopConditions", &plan.task.stop_conditions)] {
        for (index, expression) in expressions.iter().enumerate() {
            plan.annotations.extend(crate::compiler::check_guard(expression, definition, &basis.definitions, &basis.scopes, &plan.declarations, &FieldPath(vec![name.into(), index.to_string()]))
                .map_err(super::Error::from)?);
        }
    }
    for annotation in &plan.annotations {
        if let Some(effect) = annotation.effects.iter().find(|effect| !plan.task.allowed_effects.contains(effect)) {
            return Err(super::Error::from(world_protocol::compiler::CompileFailure::EffectViolation { definition: plan.owner.clone(), field: annotation.field.clone(), effect: *effect }).into());
        }
    }
    for step in &plan.steps {
        if let StrategyOperation::Action { action, .. } = &step.operation {
            let target = basis.definitions.iter().find(|definition| definition.reference == *action).ok_or_else(changed)?;
            let DefinitionBody::ActionContract(body) = &target.body else { return Err(changed()); };
            if let Some(effect) = body.effects.iter().find(|effect| !plan.task.allowed_effects.contains(effect)) {
                return Err(super::Error::from(world_protocol::compiler::CompileFailure::EffectViolation { definition: action.clone(), field: FieldPath(vec!["effects".into()]), effect: *effect }).into());
            }
        }
    }
    let now = tx.now().await?;
    ctx.budget.restrict(&plan.task.budget, &now).map_err(budget_error)?;
    if let DefinitionBody::Strategy(strategy) = &definition.body { ctx.budget.restrict(&strategy.budget, &now).map_err(budget_error)?; }
    let mut execution = StrategyExecution::new(vec![page.receipt]);
    execution.used_definitions.insert(plan.owner.clone());
    if let Some((_, reason)) = expanded {
        let expressions = expressions(&plan.task, &plan.contract, &plan.steps, &plan.guards);
        let references = expressions.iter().collect::<Vec<_>>();
        let mut context = query::strategy_expression_context_cells(tx, admission, &plan.owner, &plan.contract.base_release, plan.contract.branch.as_ref(),
            &plan.declarations, &plan.parameters, &references, &plan.task.scope, &ctx.budget, &ctx.cancellation, &now, &request.query.read_mode, None).await?;
        context.annotations = plan.annotations.clone();
        let receipts: Vec<_> = context.read_receipt.clone().into_iter().collect();
        let checked = super::replan_concrete(&plan.contract, &ConcreteTask {
            reference: request.task.clone(), goal: &plan.task.goal, input_type: &plan.task.input_type,
            hard_constraints: &plan.task.hard_constraints, allowed_effects: &plan.task.allowed_effects,
            stop_conditions: &plan.task.stop_conditions, budget: &plan.task.budget,
        }, &basis.definitions, &basis.scopes, &context, receipts.clone(), reason, &now, &ctx.budget, &ctx.cancellation).map_err(owner::Error::from)?;
        plan.expansion = Some(checked.witness);
        execution.read_receipts.extend(receipts);
    }
    Ok((plan, execution))
}

struct OnlineBackend<'a> {
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    brokers: &'a SourceBrokers,
    step_id: StepId,
    plan: Plan,
    context: Option<query::BranchExpressionContext>,
    at: Option<Timestamp>,
}

impl StrategyBackend for OnlineBackend<'_> {
    fn value(&mut self, expression: &ExpressionIr, path: &FieldPath) -> Result<Cell, evaluation::Error> {
        Ok(self.context.as_ref().ok_or(world_protocol::evaluation::EvaluationFailure::InternalFault)?
            .value(expression, &path.0, self.at.as_ref().ok_or(world_protocol::evaluation::EvaluationFailure::InternalFault)?)?)
    }

    fn current(&mut self) -> StrategyFuture<'_, Vec<ReadReceipt>> {
        Box::pin(async move {
            let parent = parent_step(self.ctx, &self.step_id).await?;
            let revision = parent.revision;
            let step_id = self.step_id.clone();
            let plan = self.plan.clone();
            let request = self.request.clone();
            let content = self.ctx.resources.content.clone();
            let budget = self.ctx.budget.clone();
            let cancel = self.ctx.cancellation.clone();
            let handoff = Arc::new(Mutex::new(None));
            let produced = handoff.clone();
            self.ctx.transact(&format!("strategy.current.{}.{}", self.ctx.admission.invocation().id, revision.0), digest(&(&self.step_id, revision, &plan))?,
                &["learning", "query", "authorization"], move |tx, admission, _, run| Box::pin(async move {
                    let step = owner::read_step(tx, &run.id, &step_id).await?.ok_or_else(changed)?;
                    if step.revision != revision { return Err(changed()); }
                    let mut state = checked(&step)?;
                    let now = tx.now().await?;
                    let basis = basis::load(tx, &content, &admission, &plan.contract, false).await?;
                    if basis.task != plan.task { return Err(changed()); }
                    query::recheck_page_in_transaction(tx, &admission, &request.query, &plan.task.scope, &plan.concrete).await?;
                    let checked = check::contract(&plan.contract, &basis.definitions, &basis.scopes)?;
                    let (mapped, raw, reason) = super::resolve::mapped_parameters(tx, &plan.contract, &basis, &checked, &plan.concrete,
                        basis.current, &now, None, &cancel).await?;
                    let parameters = if let Some(witness) = &plan.expansion {
                        if reason == world_protocol::expression::TruthValue::True || reason != witness.reason { return Err(changed()); }
                        raw
                    } else {
                        if reason != world_protocol::expression::TruthValue::True { return Err(changed()); }
                        mapped
                    };
                    if parameters != plan.parameters { return Err(changed()); }
                    let expressions = expressions(&plan.task, &plan.contract, &plan.steps, &plan.guards);
                    let references = expressions.iter().collect::<Vec<_>>();
                    let mut context = query::strategy_expression_context_cells(tx, &admission, &plan.owner, &plan.contract.base_release, plan.contract.branch.as_ref(),
                        &plan.declarations, &plan.parameters, &references, &plan.task.scope, &budget, &cancel, &now, &request.query.read_mode, None).await?;
                    context.annotations = plan.annotations;
                    state.execution.read_receipts.extend(context.read_receipt.clone());
                    let mut next = step.clone();
                    next.checkpoint = encode(&state)?;
                    owner::checkpoint_step(tx, &step, next).await?;
                    *produced.lock().expect("strategy context handoff poisoned") = Some((context, now));
                    Ok(())
                }),
            ).await?;
            let (context, at) = handoff.lock().expect("strategy context handoff poisoned").take().ok_or_else(changed)?;
            let receipts = context.read_receipt.clone().into_iter().collect();
            self.context = Some(context);
            self.at = Some(at);
            Ok(receipts)
        })
    }

    fn operation<'a>(&'a mut self, index: usize, step: &'a StrategyStep) -> StrategyFuture<'a, OperationExecution> {
        Box::pin(async move {
            let mut read_receipts = Vec::new();
            let mut used_definitions = Vec::new();
            let (output, completed) = match &step.operation {
                StrategyOperation::Function { function, arguments } => {
                    let expression = ExpressionIr::Call { function: function.clone(), arguments: arguments.clone() };
                    used_definitions.extend(crate::definitions::expression_references(&expression));
                    (StepOutput::Function(self.value(&expression, &FieldPath(vec!["steps".into(), index.to_string(), "operation".into()]))?), true)
                }
                StrategyOperation::Stop { reason } => (StepOutput::Stop(*reason), true),
                StrategyOperation::Query { query } => {
                    let arguments = query_arguments(query, &self.plan.declarations, &self.plan.parameters)?;
                    let request = QueryRequest { world: self.request.query.world.clone(), branch_id: self.request.query.branch_id.clone(),
                        release_id: self.request.query.release_id.clone(), query: query.clone(), arguments, read_mode: self.request.query.read_mode.clone(),
                        valid_at: None, known_at: None, page: PageRequest { limit: query.limit.min(world_protocol::api::MAX_PAGE_ITEMS), cursor: None } };
                    let prepared = query::execute(&self.ctx.store, &self.ctx.resources.content, Some(self.brokers), &self.ctx.admission, &request,
                        &self.plan.task.scope, &self.ctx.pipeline, &self.ctx.budget, &self.ctx.cancellation, self.ctx.deadline).await?;
                    let page = self.ctx.transact(&format!("strategy.query.{}", step.id), digest(&(&self.step_id, &request))?, &["learning", "query", "authorization"],
                        move |tx, admission, _, _| Box::pin(async move { Ok(query::commit_read(tx, &admission, prepared).await?) }),
                    ).await?.value;
                    used_definitions.extend(crate::definitions::query_references(query));
                    read_receipts.push(page.receipt.clone());
                    (StepOutput::Query(page), true)
                }
                StrategyOperation::Action { action, arguments } => {
                    let parent = parent_step(self.ctx, &self.step_id).await?;
                    let basis = checked(&parent)?.execution.read_receipts;
                    let result = owner::execute_strategy_action(self.ctx, &parent, &step.id, action, arguments, &basis).await?;
                    let completed = result.completed();
                    used_definitions.push(action.clone());
                    (StepOutput::Action(result), completed)
                }
            };
            Ok(OperationExecution { output, read_receipts, used_definitions, outcome: None, completed })
        })
    }

    fn checkpoint<'a>(&'a mut self, execution: &'a StrategyExecution) -> StrategyFuture<'a, ()> {
        Box::pin(async move {
            let id = self.step_id.clone();
            let execution = execution.clone();
            let input = digest(&(&id, &execution))?;
            self.ctx.transact(&format!("strategy.checkpoint.{}", input.as_str()), input, &["learning", "authorization"],
                move |tx, _, _, run| Box::pin(async move {
                    let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                    let mut state = checked(&step)?;
                    if !state.execution.complete.is_subset(&execution.complete) { return Err(changed()); }
                    state.execution = execution;
                    let mut next = step.clone();
                    next.checkpoint = encode(&state)?;
                    if state.execution.outcome.is_some() {
                        next.phase = world_protocol::operation::OperationPhase::Completed;
                        next.result = Some(encode(&state.execution)?);
                    }
                    owner::checkpoint_step(tx, &step, next).await?;
                    Ok(())
                }),
            ).await?;
            Ok(())
        })
    }
}

/// Finite admission ceiling from the durable checked plans and their literal typed Action arguments.
pub(crate) async fn online_impact(
    tx: &WorldTransaction<'_>, request: &ResolveTaskRequest,
) -> Result<world_protocol::authorization::ActualImpact, owner::Error> {
    let contract = super::read(tx, &request.abstraction_id, request.abstraction_revision).await?.ok_or_else(changed)?;
    let task = crate::evaluation::read_task(tx, &request.task.id, request.task.revision).await?;
    if request.task.world != *tx.world() || contract.world != *tx.world() || task.world != *tx.world()
        || task.id != contract.task_id || task.revision != contract.task_revision || task.scope != contract.scope
        || request.query.release_id.as_ref() != Some(&contract.base_release)
        || request.query.branch_id.as_ref() != contract.branch.as_ref().map(|branch| &branch.id) { return Err(changed()); }
    crate::definitions::validate_value(&task.input_type, false, &request.input).map_err(crate::definitions::DefinitionError::from).map_err(super::Error::from)?;
    let release = crate::releases::read_release(tx, &contract.base_release).await?.ok_or_else(changed)?;
    let (definitions, scopes) = if let Some(reference) = &contract.branch {
        let branch = crate::releases::read_branch_revision(tx, reference).await?.ok_or_else(changed)?;
        if branch.basis.release_id != contract.base_release { return Err(changed()); }
        (branch.compile.definitions, branch.compile.scopes)
    } else { (release.definitions, release.scopes) };
    let checked = check::contract(&contract, &definitions, &scopes)?;
    let mut parameters = contract.parameters.iter().map(|parameter| (parameter.id.clone(), Cell::Unknown { reason: world_protocol::value::UnknownReason::NotObserved })).collect::<BTreeMap<_, _>>();
    for parameter in &contract.parameters {
        let bindings = contract.binding_map.bindings.iter().filter(|binding| binding.parameter_id.as_ref() == Some(&parameter.id)).collect::<Vec<_>>();
        let cell = match bindings.as_slice() {
            [binding] if binding.transform.is_none() => match &binding.target {
                world_protocol::abstraction::BindingTarget::Object { id } => Some(Cell::Known { value: world_protocol::value::Value::Object { id: id.clone() } }),
                world_protocol::abstraction::BindingTarget::Relation { id } => Some(Cell::Known { value: world_protocol::value::Value::Relation { id: id.clone() } }),
                _ => None,
            },
            _ => None,
        };
        if let Some(cell) = cell { parameters.insert(parameter.id.clone(), cell); }
    }
    let mut plans = vec![(checked.owner, contract.parameters.clone(), contract.forward_plan.clone(),
        vec![(contract.guard.clone(), vec!["guard".into()])], checked.annotations)];
    if let Some(strategy) = super::concrete_strategy(&contract, &definitions, &scopes)? {
        plans.push((strategy.owner, strategy.parameters, strategy.steps, strategy.guards, strategy.annotations));
    }
    let mut impact = query::impact_in_transaction(tx, &request.query, &task.scope).await?;
    if let Some(assurance) = evaluation::abstraction_assurance_impact(tx, &contract).await? { merge(&mut impact, assurance); }
    for (owner, declarations, steps, guards, annotations) in plans {
        if annotations.iter().flat_map(|annotation| &annotation.effects).any(|effect| !task.allowed_effects.contains(effect)) { return Err(changed()); }
        let mut expressions = expressions(&task, &contract, &steps, &guards);
        expressions.extend(contract.assumptions.clone());
        expressions.extend(super::binding_expressions(&contract).into_iter().cloned());
        let expressions = expressions.iter().collect::<Vec<_>>();
        merge(&mut impact, query::strategy_expression_impact_cells(tx, &owner, &contract.base_release, contract.branch.as_ref(),
            &declarations, &parameters, &expressions, &task.scope).await?);
        for step in &steps {
            match &step.operation {
                StrategyOperation::Action { action, arguments } => {
                    let target = definitions.iter().find(|definition| definition.reference == *action).ok_or_else(changed)?;
                    let DefinitionBody::ActionContract(body) = &target.body else { return Err(changed()); };
                    if body.effects.iter().any(|effect| !task.allowed_effects.contains(effect)) { return Err(changed()); }
                    let proposal = world_protocol::actions::ActionProposalRequest { world: tx.world().clone(), branch_id: request.query.branch_id.clone(),
                        action: action.clone(), arguments: arguments.clone(), targets: crate::actions::targets(tx, action, arguments).await?, basis: Vec::new() };
                    merge(&mut impact, crate::actions::impact(tx, &WorldCommand::ActionPropose(proposal)).await?);
                }
                StrategyOperation::Query { query } => {
                    let query = QueryRequest { world: tx.world().clone(), branch_id: request.query.branch_id.clone(), release_id: request.query.release_id.clone(),
                        query: query.clone(), arguments: Vec::new(), read_mode: request.query.read_mode.clone(), valid_at: None, known_at: None,
                        page: PageRequest { limit: query.limit.min(world_protocol::api::MAX_PAGE_ITEMS), cursor: None } };
                    merge(&mut impact, query::impact_in_transaction(tx, &query, &task.scope).await?);
                }
                _ => {},
            }
        }
    }
    authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids).map_err(Into::into)
}

fn merge(into: &mut world_protocol::authorization::ActualImpact, other: world_protocol::authorization::ActualImpact) {
    into.access.extend(other.access); into.effects.extend(other.effects); into.labels.extend(other.labels);
    into.state.extend(other.state); into.source_ids.extend(other.source_ids);
}

pub(crate) async fn require_online_action(
    tx: &WorldTransaction<'_>, parent: &StepRecord, strategy_step: &StepId,
    action: &DefinitionRef, arguments: &[QueryArgument],
) -> Result<(), owner::Error> {
    let step = owner::read_step(tx, &parent.run_id, &parent.id).await?.ok_or_else(changed)?;
    let state = checked(&step)?;
    if parent.input_digest != step.input_digest || parent.kind != step.kind
        || step.id != step_id(tx.world(), &step.run_id)? || state.execution.outcome.is_some()
        || state.execution.complete.contains(strategy_step) || state.execution.inflight.as_ref() != Some(strategy_step)
        || !state.execution.steps.iter().any(|step| &step.id == strategy_step && step.guard == world_protocol::expression::TruthValue::True)
        || !state.plan.steps.iter().any(|step| &step.id == strategy_step
            && step.depends_on.iter().all(|id| state.execution.complete.contains(id))
            && matches!(&step.operation, StrategyOperation::Action { action: actual, arguments: args } if actual == action && args == arguments)) {
        return Err(changed());
    }
    Ok(())
}

/// Checks the original committed executor record, not a serialized completion assertion.
pub(crate) async fn require_online_strategy(
    tx: &WorldTransaction<'_>, binding: &OnlineOracleBinding, request: &ResolveTaskRequest, execution: &StrategyExecution,
) -> Result<(), owner::Error> {
    let id = step_id(tx.world(), &binding.run_id)?;
    let step = owner::read_step(tx, &binding.run_id, &id).await?.ok_or_else(changed)?;
    let state = checked(&step)?;
    let run = owner::read_run(tx, &binding.run_id).await?;
    let operation = owner::read_operation_record(tx, &binding.operation_id).await?;
    if state.request != *request || step.input_digest != command_digest(request)?
        || digest(&state.execution)? != digest(execution)? || binding.task != request.task
        || run.operation.operation_id != binding.operation_id || run.release_id.as_ref() != Some(&binding.release_id)
        || run.activation_lock_id.as_ref() != Some(&binding.activation_lock_id)
        || !matches!(operation.input.command()?, WorldCommand::ResolveTask(actual) if actual == request)
        || operation.receipt.progress.run_id.as_ref() != Some(&binding.run_id)
        || !matches!(execution.outcome, Some(CaseOutcome::Succeeded { .. })) || execution.inflight.is_some()
        || step.phase != world_protocol::operation::OperationPhase::Completed
        || step.result.as_ref() != Some(&encode(execution)?)
        || crate::evaluation::read_task(tx, &request.task.id, request.task.revision).await? != state.plan.task
        || execution.steps.iter().any(|step| matches!(step.output, Some(StepOutput::ActionDryRun(_)))) {
        return Err(changed());
    }
    for receipt in &execution.read_receipts {
        if receipt.world != *tx.world() || receipt.release_id != binding.release_id || receipt.activation_lock_id != binding.activation_lock_id
            || query::read_receipt(tx, &receipt.id).await? != *receipt { return Err(changed()); }
    }
    Ok(())
}

pub(crate) async fn strategy_step_retention_roots(
    tx: &WorldTransaction<'_>, step: &StepRecord, roots: &mut RetentionRoots,
) -> Result<(), owner::Error> {
    let state = checked(step)?;
    if step.id != step_id(tx.world(), &step.run_id)? || state.request.task.world != *tx.world() { return Err(changed()); }
    crate::evaluation::retain_task(roots, &state.plan.task);
    query::retain_page(roots, &state.plan.concrete);
    roots.definitions.push(state.plan.owner.clone());
    roots.definitions.extend(state.plan.contract.original_definitions.clone());
    roots.dependencies.extend(state.plan.contract.read_dependencies.clone());
    roots.releases.push(state.plan.contract.base_release.clone());
    roots.branches.extend(state.plan.contract.branch.clone());
    roots.definitions.extend(state.execution.used_definitions.clone());
    for expression in expressions(&state.plan.task, &state.plan.contract, &state.plan.steps, &state.plan.guards) { roots.definitions.extend(crate::definitions::expression_references(&expression)); }
    for cell in state.plan.parameters.values() { query::retain_cell(roots, cell.clone()); }
    for receipt in &state.execution.read_receipts { query::retain_read(roots, receipt); }
    for step in &state.execution.steps {
        match &step.output {
            Some(StepOutput::Function(cell)) => query::retain_cell(roots, cell.clone()),
            Some(StepOutput::Query(page)) => query::retain_page(roots, page),
            Some(StepOutput::Action(action)) => action.retain(roots)?,
            Some(StepOutput::ActionDryRun(_)) => return Err(changed()),
            _ => {},
        }
    }
    if let Some(witness) = state.plan.expansion {
        roots.definitions.push(witness.strategy);
        for receipt in &witness.read_receipts { query::retain_read(roots, receipt); }
    }
    Ok(())
}

async fn parent_step(ctx: &ExecutionContext, id: &StepId) -> Result<StepRecord, owner::Error> {
    let id = id.clone();
    let saved = ctx.clone();
    ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
        authorization::recheck_read(snapshot, &saved.admission, &snapshot.now().await?).await?;
        let operation = owner::read_record_snapshot(snapshot, &saved.operation.operation_id).await?;
        operation.identity.require_resume(saved.admission.verified())?;
        if operation.receipt.progress.run_id.as_ref() != Some(&saved.run.id) { return Err(changed()); }
        let step = owner::read_step_snapshot(snapshot, &saved.run.id, &id).await?.ok_or_else(changed)?;
        checked(&step)?;
        Ok(step)
    })).await
}

fn checked(step: &StepRecord) -> Result<Checkpoint, owner::Error> {
    let state: Checkpoint = serde_json::from_value(step.checkpoint.clone()).map_err(|cause| changed().caused(cause))?;
    if step.kind != "learning.strategy" || step.ordinal != 2 || step.input_digest != command_digest(&state.request)?
        || state.plan_digest != digest(&state.plan)? { return Err(changed()); }
    Ok(state)
}
fn expressions(task: &TaskContract, contract: &AbstractionContract, steps: &[StrategyStep], guards: &[(ExpressionIr, Vec<String>)]) -> Vec<ExpressionIr> {
    let mut result: Vec<_> = guards.iter().map(|(expression, _)| expression.clone()).collect();
    result.extend(task.hard_constraints.clone()); result.extend(task.stop_conditions.clone());
    result.extend(contract.preserved_invariants.clone());
    for step in steps {
        result.push(step.guard.clone());
        if let StrategyOperation::Function { function, arguments } = &step.operation {
            result.push(ExpressionIr::Call { function: function.clone(), arguments: arguments.clone() });
        }
    }
    result
}
fn query_arguments(query: &world_protocol::query::QueryIr, declarations: &[Parameter], parameters: &BTreeMap<ParameterId, Cell>) -> Result<Vec<QueryArgument>, evaluation::Error> {
    let mut result = Vec::new();
    for parameter in &query.parameters {
        if !declarations.contains(parameter) { return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into()); }
        match parameters.get(&parameter.id) {
            Some(Cell::Known { value }) => result.push(QueryArgument { parameter_id: parameter.id.clone(), value: value.clone() }),
            Some(_) if parameter.optional => {},
            _ => return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into()),
        }
    }
    Ok(result)
}
fn step_id(world: &WorldRef, run: &RunId) -> Result<StepId, owner::Error> {
    let digest = digest(&("world.strategy.step.v1", world, run))?;
    StepId::try_new(format!("strategy-{}", &digest.as_str()[7..])).map_err(|_| changed())
}
fn command_digest(request: &ResolveTaskRequest) -> Result<Digest, owner::Error> { digest(&WorldCommand::ResolveTask(request.clone())) }
fn digest(value: &impl Serialize) -> Result<Digest, owner::Error> { crate::definitions::canonical_digest(value).map_err(Into::into) }
fn encode(value: &impl Serialize) -> Result<serde_json::Value, owner::Error> { serde_json::to_value(value).map_err(|cause| owner::Error::internal(FailureStage::Commit).caused(cause)) }
fn changed() -> owner::Error { super::Error::from(AbstractionFailure::BasisChanged).into() }
fn budget_error(error: crate::extensions::invocation::BudgetFailure) -> owner::Error {
    owner::Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Execute)
}
