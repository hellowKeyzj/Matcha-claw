use std::collections::BTreeMap;

use crate::{
    authorization::{self, Admission, OnlineOracleBinding},
    learning::investigation::ObservedResolution,
    owner::{self, ExecutionContext},
    store::{StoreFuture, WorldTransaction},
};
use world_protocol::{
    api::{ResolveTaskRequest, WorldCommand},
    evaluation::TestRevision,
    failure::{Failure, FailureStage, FieldPath, Recovery},
    ids::*,
    learning::{
        Case, CaseInconclusive, CaseOutcome, LearningFailure, OracleSpec, TaskContract, TestCase,
    },
    query::QueryPage,
    time::Timestamp,
    value::{Cell, Value},
};

use super::{ConstraintFailure, Error, records};

mod content;
mod program;
pub(crate) use program::online_oracle_retention_roots;

/// Expected bytes never leave this owner or enter the native execution request.
pub(crate) struct OnlineOraclePlan {
    request: ResolveTaskRequest,
    binding: OnlineOracleBinding,
    task: TaskContract,
    test: TestCase,
    fixture: Vec<u8>,
    expected: Vec<u8>,
}

pub(crate) struct OnlineOracleResult {
    pub outcome: CaseOutcome,
    proof: OnlineProof,
}

struct OnlineProof {
    plan: OnlineOraclePlan,
    page: QueryPage,
    outcome: CaseOutcome,
    program: Option<program::ProgramProof>,
    strategy: Option<crate::abstraction::strategy::StrategyExecution>,
}

impl OnlineOracleResult {
    pub(crate) fn validate_case(&self, case: &Case) -> Result<(), owner::Error> {
        let binding = &self.proof.plan.binding;
        if case.world != binding.task.world
            || case.id != binding.case_id
            || case.task_id != binding.task.id
            || case.task_revision != binding.task.revision
            || case.release_id != binding.release_id
            || case.activation_lock_id != binding.activation_lock_id
            || case.input != self.proof.plan.request.input
            || case.outcome != self.proof.outcome
            || self.outcome != self.proof.outcome
            || !case.read_receipts.contains(&self.proof.page.receipt)
        {
            return Err(changed().into());
        }
        Ok(())
    }
}

pub(crate) async fn read_online_test(
    tx: &WorldTransaction<'_>,
    reference: &TestRevision,
) -> Result<TestCase, owner::Error> {
    records::tests(tx, std::slice::from_ref(reference))
        .await?
        .pop()
        .ok_or_else(|| changed().into())
}

pub(crate) fn prepare_online<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    binding: &'a OnlineOracleBinding,
) -> StoreFuture<'a, OnlineOraclePlan, owner::Error> {
    Box::pin(async move {
        let authority = ctx.evaluation_authority()?;
        if !authority.same_root(&ctx.authority) || authority.world() != &ctx.operation.world {
            return Err(changed().into());
        }
        let saved = request.clone();
        let exact = binding.clone();
        let (task, test) = ctx.transact(
            &format!("online.prepare.{}", ctx.admission.invocation().id),
            records::digest(&(request, binding))?,
            &["learning", "authorization"],
            move |tx, admission, operation, run| Box::pin(async move {
                if !matches!(operation.input.command()?, WorldCommand::ResolveTask(actual) if actual == &saved)
                    || run.id != exact.run_id
                    || run.operation.operation_id != exact.operation_id
                    || run.release_id.as_ref() != Some(&exact.release_id)
                    || run.activation_lock_id.as_ref() != Some(&exact.activation_lock_id)
                    || saved.task != exact.task
                    || saved.test != exact.test
                    || records::digest(&saved.input)? != exact.input_digest
                {
                    return Err(changed().into());
                }
                let task = records::task(tx, &exact.task.id, exact.task.revision).await?;
                let test = read_online_test(tx, &exact.test).await?;
                require_test(&task, &test)?;
                records::authorize(tx, &admission, &task.scope, vec![
                    ResourceRef::Task { id: task.id.clone() },
                    ResourceRef::TestCase { id: test.id.clone() },
                ], world_protocol::authorization::AccessMode::Read, Vec::new(), &tx.now().await?).await?;
                Ok((task, test))
            }),
        ).await?.value;
        let fixture = content::read_test_blob(ctx, binding, &test, &test.fixture, "fixture").await?;
        let input: Value =
            world_protocol::wire::decode(&fixture, maximum(&task)).map_err(program::wire_failure)?;
        crate::definitions::validate_value(&task.input_type, false, &input)
            .map_err(|failure| Error::Constraint(ConstraintFailure::Definition { failure }))?;
        if input != request.input {
            return Err(Error::from(super::invalid("oracle.fixture.input")).into());
        }
        let expected = content::read_test_blob(ctx, binding, &test, &test.expected, "expected").await?;
        if matches!(test.oracle, OracleSpec::Program { .. }) {
            super::oracle::expected_counts(&expected, &task.world, maximum(&task))
                .map_err(program::oracle_failure)?;
        }
        Ok(OnlineOraclePlan {
            request: request.clone(),
            binding: binding.clone(),
            task,
            test,
            fixture,
            expected,
        })
    })
}

pub(crate) fn check_online<'a>(
    ctx: &'a ExecutionContext,
    plan: OnlineOraclePlan,
    observed: &'a ObservedResolution,
) -> StoreFuture<'a, Option<OnlineOracleResult>, owner::Error> {
    Box::pin(async move {
        let page = observed.page();
        if plan.binding.run_id != ctx.run.id
            || page.receipt.world != plan.binding.task.world
            || page.receipt.release_id != plan.binding.release_id
            || page.receipt.activation_lock_id != plan.binding.activation_lock_id
        {
            return Err(changed().into());
        }
        crate::query::recheck_page(
            &ctx.store,
            &ctx.resources.content,
            &ctx.admission,
            &plan.request.query,
            &plan.task.scope,
            page,
            &ctx.budget,
            &ctx.cancellation,
        )
        .await?;
        let strategy = observed.strategy().cloned();
        if let Some(execution) = &strategy {
            let exact = execution.clone();
            let binding = plan.binding.clone();
            let request = plan.request.clone();
            ctx.transact(
                &format!("online.strategy.{}", ctx.admission.invocation().id),
                records::digest(&(&binding, &exact))?,
                &["learning", "authorization"],
                move |tx, _, _, _| {
                    Box::pin(async move {
                        crate::abstraction::require_online_strategy(tx, &binding, &request, &exact)
                            .await
                    })
                },
            )
            .await?;
        }
        let queries = observations(&plan.binding, page, strategy.as_ref())?;
        let (outcome, proof) = match &plan.test.oracle {
            OracleSpec::Program { .. } => {
                let Some(checked) = program::check(ctx, &plan, page, &queries).await? else {
                    return Ok(None);
                };
                let outcome = if !checked.result.passed {
                    failed(
                        &plan.binding,
                        FieldPath(vec!["oracle".into(), "expected".into()]),
                    )
                } else if let Some(execution) = &strategy {
                    execution.outcome.clone().ok_or_else(changed)?
                } else if !plan.task.hard_constraints.is_empty()
                    || !plan.task.stop_conditions.is_empty()
                {
                    unavailable()
                } else {
                    result_value(page)
                        .map_or_else(unavailable, |result| CaseOutcome::Succeeded { result })
                };
                (outcome, Some(checked))
            }
            // Neither a source verifier nor an independent human verdict is present in this observation.
            OracleSpec::SourceReceipt { .. } | OracleSpec::Human { .. } => (unavailable(), None),
        };
        Ok(Some(OnlineOracleResult {
            outcome: outcome.clone(),
            proof: OnlineProof {
                plan,
                page: page.clone(),
                outcome,
                program: proof,
                strategy,
            },
        }))
    })
}

pub(crate) async fn recheck_online(
    tx: &WorldTransaction<'_>,
    caller: &Admission,
    checked: &OnlineOracleResult,
    now: &Timestamp,
) -> Result<(), owner::Error> {
    if checked.outcome != checked.proof.outcome {
        return Err(changed().into());
    }
    let plan = &checked.proof.plan;
    let run = owner::require_run_invocation(tx, caller, &plan.binding.run_id).await?;
    let operation = owner::read_operation_record(tx, &plan.binding.operation_id).await?;
    if run.operation.operation_id != plan.binding.operation_id
        || !matches!(operation.input.command()?, WorldCommand::ResolveTask(actual) if actual == &plan.request)
        || records::task(tx, &plan.task.id, plan.task.revision).await? != plan.task
        || read_online_test(tx, &plan.binding.test).await? != plan.test
        || crate::query::read_receipt(tx, &checked.proof.page.receipt.id).await?
            != checked.proof.page.receipt
    {
        return Err(changed().into());
    }
    require_test(&plan.task, &plan.test)?;
    if let Some(execution) = &checked.proof.strategy {
        crate::abstraction::require_online_strategy(tx, &plan.binding, &plan.request, execution)
            .await?;
    }
    let queries = observations(
        &plan.binding,
        &checked.proof.page,
        checked.proof.strategy.as_ref(),
    )?;
    if let Some(proof) = &checked.proof.program {
        program::recheck(tx, plan, &checked.proof.page, &queries, proof, now).await?;
    } else if !matches!(
        checked.outcome,
        CaseOutcome::Inconclusive {
            reason: CaseInconclusive::OracleUnavailable
        }
    ) {
        return Err(changed().into());
    }
    authorization::recheck(tx, caller, now).await?;
    Ok(())
}

fn observations(
    binding: &OnlineOracleBinding,
    page: &QueryPage,
    strategy: Option<&crate::abstraction::strategy::StrategyExecution>,
) -> Result<Vec<world_protocol::slots::OracleQueryObservation>, Error> {
    use crate::abstraction::strategy::StepOutput;
    use world_protocol::slots::OracleQueryObservation;
    let mut queries: Vec<_> = strategy
        .into_iter()
        .flat_map(|execution| &execution.steps)
        .filter_map(|step| match &step.output {
            Some(StepOutput::Query(page)) => Some(OracleQueryObservation {
                step_id: step.id.clone(),
                page: page.clone(),
            }),
            _ => None,
        })
        .collect();
    queries.push(OracleQueryObservation {
        step_id: binding.step_id.clone(),
        page: page.clone(),
    });
    let mut unique = std::collections::BTreeSet::new();
    if queries.iter().any(|query| !unique.insert(&query.step_id)) {
        return Err(program::oracle_failure(
            world_protocol::slots::OracleFailure::SchemaMismatch,
        ));
    }
    Ok(queries)
}

fn require_test(task: &TaskContract, test: &TestCase) -> Result<(), Error> {
    super::validate_test(task, test)?;
    if !test.protected || test.oracle != task.success_oracle {
        return Err(ConstraintFailure::OracleUnverified.into());
    }
    Ok(())
}

fn result_value(page: &QueryPage) -> Option<Value> {
    if !page.receipt.coverage.complete
        || !page.receipt.coverage.missing_sources.is_empty()
        || !page.receipt.coverage.missing_fields.is_empty()
        || !page.receipt.coverage.gap_sources.is_empty()
        || page.receipt.basis.iter().any(|basis| basis.gap.is_some())
        || !page.receipt.dirty.is_empty()
        || page
            .receipt
            .freshness
            .iter()
            .any(|source| !source.satisfied)
        || page.receipt.truncation.is_some()
        || page.rows.next_cursor.is_some()
    {
        return None;
    }
    let mut items = Vec::with_capacity(page.rows.items.len());
    for row in &page.rows.items {
        let mut fields = BTreeMap::new();
        for column in &row.columns {
            let Cell::Known { value } = &column.cell else {
                return None;
            };
            if fields.insert(column.name.clone(), value.clone()).is_some() {
                return None;
            }
        }
        items.push(Value::Record { fields });
    }
    Some(Value::List { items })
}

fn failed(binding: &OnlineOracleBinding, field: FieldPath) -> CaseOutcome {
    CaseOutcome::Failed {
        failure: Failure {
            code: "world.evaluation.constraint_violated".into(),
            stage: FailureStage::Verify,
            message: "独立核验结果不满足任务。".into(),
            diagnostic_id: DiagnosticId::try_new(uuid::Uuid::new_v4().to_string())
                .expect("UUID identifier"),
            operation_id: Some(binding.operation_id.clone()),
            run_id: Some(binding.run_id.clone()),
            step_id: Some(binding.step_id.clone()),
            details: LearningFailure::ConstraintViolated { field },
            recovery: Recovery::None,
        },
    }
}

fn unavailable() -> CaseOutcome {
    CaseOutcome::Inconclusive {
        reason: CaseInconclusive::OracleUnavailable,
    }
}
fn changed() -> Error {
    world_protocol::evaluation::EvaluationFailure::BasisChanged.into()
}
fn maximum(task: &TaskContract) -> usize {
    task.budget.max_bytes.min(usize::MAX as u64) as usize
}
