use super::{Error, records, run};
use crate::{
    definitions,
    store::{RetentionRoots, WorldTransaction},
};
use world_protocol::{
    evaluation::{BranchBasis, EvaluationArm, EvaluationReport, FrozenSuite, PlanReference},
    ids::ResourceRef,
    learning::{
        Case, CaseInconclusive, CaseOrigin, CaseOutcome, OracleSpec, TaskContract, TestCase,
    },
    query::ReadReceipt,
};

pub(crate) async fn world_deletion_roots(
    tx: &WorldTransaction<'_>,
) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    // These are the retained typed revision tables, not archive-replaced business heads.
    for (table, sql) in [
        (
            "world_task_revision",
            "SELECT task_id AS id,revision,content_digest,body FROM world_task_revision WHERE tenant_id=$1 AND world_id=$2 AND (task_id,revision)>($3,$4) ORDER BY task_id,revision LIMIT 256",
        ),
        (
            "world_case_revision",
            "SELECT case_id AS id,revision,content_digest,body FROM world_case_revision WHERE tenant_id=$1 AND world_id=$2 AND (case_id,revision)>($3,$4) ORDER BY case_id,revision LIMIT 256",
        ),
        (
            "world_test_case_revision",
            "SELECT test_case_id AS id,revision,content_digest,body FROM world_test_case_revision WHERE tenant_id=$1 AND world_id=$2 AND (test_case_id,revision)>($3,$4) ORDER BY test_case_id,revision LIMIT 256",
        ),
        (
            "world_suite_revision",
            "SELECT suite_id AS id,revision,content_digest,body FROM world_suite_revision WHERE tenant_id=$1 AND world_id=$2 AND (suite_id,revision)>($3,$4) ORDER BY suite_id,revision LIMIT 256",
        ),
        (
            "world_evaluation_report",
            "SELECT evaluation_id AS id,revision,content_digest,body FROM world_evaluation_report WHERE tenant_id=$1 AND world_id=$2 AND (evaluation_id,revision)>($3,$4) ORDER BY evaluation_id,revision LIMIT 256",
        ),
    ] {
        let mut after = String::new();
        let mut version = 0i64;
        loop {
            let rows = tx
                .query(
                    sql,
                    &[
                        &tx.world().tenant_id.as_str(),
                        &tx.world().world_id.as_str(),
                        &after,
                        &version,
                    ],
                )
                .await?;
            let done = rows.len() < 256;
            for row in rows {
                after = row.get("id");
                version = row.get("revision");
                let body: serde_json::Value = row.get("body");
                if records::digest(&body)?.as_str() != row.get::<_, String>("content_digest") {
                    return Err(super::ConstraintFailure::VersionMismatch.into());
                }
                match table {
                    "world_task_revision" => {
                        let task: TaskContract = records::decode(body)?;
                        if task.world != *tx.world()
                            || task.id.as_str() != after
                            || records::revision(task.revision)? != version
                        {
                            return Err(super::ConstraintFailure::VersionMismatch.into());
                        }
                        retain_task(&mut roots, &task);
                    }
                    "world_case_revision" => {
                        let case: Case = records::decode(body)?;
                        if case.world != *tx.world() || case.id.as_str() != after || version != 1 {
                            return Err(super::ConstraintFailure::VersionMismatch.into());
                        }
                        let inline = case_inline_definitions(tx, &case, None).await?;
                        retain_case(&mut roots, &case, &inline)?;
                    }
                    "world_test_case_revision" => {
                        let test: TestCase = records::decode(body)?;
                        if test.world != *tx.world()
                            || test.id.as_str() != after
                            || records::revision(test.revision)? != version
                        {
                            return Err(super::ConstraintFailure::VersionMismatch.into());
                        }
                        retain_test(&mut roots, &test);
                    }
                    "world_suite_revision" => {
                        let suite: FrozenSuite = records::decode(body)?;
                        if suite.world != *tx.world()
                            || suite.id.as_str() != after
                            || records::revision(suite.revision)? != version
                        {
                            return Err(super::ConstraintFailure::VersionMismatch.into());
                        }
                        retain_suite(&mut roots, &suite);
                    }
                    "world_evaluation_report" => {
                        let report: EvaluationReport = records::decode(body)?;
                        if report.world != *tx.world() || report.id.as_str() != after {
                            return Err(super::ConstraintFailure::VersionMismatch.into());
                        }
                        retain_report(&mut roots, &report)?;
                    }
                    _ => unreachable!("checked-in typed tables"),
                }
            }
            if done {
                break;
            }
        }
    }
    let mut after = String::new();
    loop {
        let rows = tx.query("SELECT evaluation_id,body FROM world_evaluation_run WHERE tenant_id=$1 AND world_id=$2 AND evaluation_id>$3 ORDER BY evaluation_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("evaluation_id");
            let state: run::EvaluationRun = records::decode(row.get("body"))?;
            if state.request.world != *tx.world()
                || state.request.id.as_str() != after
                || state.report.world != *tx.world()
                || state.report.id != state.request.id
                || state.submitted_branch.world != *tx.world()
                || state.branch.world != *tx.world()
            {
                return Err(super::ConstraintFailure::VersionMismatch.into());
            }
            run::read_report(tx, &state.request.id).await?;
            roots
                .branches
                .extend([state.submitted_branch.clone(), state.branch.clone()]);
            retain_basis(&mut roots, &state.request.basis);
            retain_suite(&mut roots, &state.request.suite);
            oracle(&mut roots, &state.request.oracle);
            retain_report(&mut roots, &state.report)?;
            for result in run::results(tx, &state.request.id).await? {
                if let Some(case) = &result.case {
                    let inline = case_inline_definitions(tx, case, Some(&result)).await?;
                    retain_case(&mut roots, case, &inline)?;
                }
                retain_arm(&mut roots, &result.evaluation.arm);
                for check in &result.hard_checks {
                    roots.evidence.extend(check.evidence.iter().cloned());
                }
            }
        }
        if done {
            break;
        }
    }
    roots.scopes.sort();
    roots.scopes.dedup();
    roots.resources.sort();
    roots.resources.dedup();
    roots.definitions.sort();
    roots.definitions.dedup();
    roots.evidence.sort();
    roots.evidence.dedup();
    roots.releases.sort();
    roots.releases.dedup();
    Ok(roots)
}

pub(crate) fn retain_task(roots: &mut RetentionRoots, task: &TaskContract) {
    roots.scopes.push(task.scope.clone());
    roots.resources.push(ResourceRef::Task {
        id: task.id.clone(),
    });
    roots.resources.extend(
        task.required_suites
            .iter()
            .cloned()
            .map(|id| ResourceRef::Suite { id }),
    );
    oracle(roots, &task.success_oracle);
    for expression in task.hard_constraints.iter().chain(&task.stop_conditions) {
        crate::learning::retain_expression(roots, expression);
    }
    value_type(roots, &task.input_type);
}

pub(crate) fn retain_test(roots: &mut RetentionRoots, test: &TestCase) {
    roots.scopes.push(test.scope.clone());
    roots.resources.push(ResourceRef::Task {
        id: test.task_id.clone(),
    });
    roots.resources.extend(
        test.case_id
            .iter()
            .cloned()
            .map(|id| ResourceRef::Case { id }),
    );
    roots.evidence.extend(test.evidence.iter().cloned());
    oracle(roots, &test.oracle);
}

pub(crate) fn retain_freeze(
    roots: &mut RetentionRoots,
    input: &world_protocol::evaluation::FreezeSuite,
) {
    roots.branches.push(input.branch.clone());
    roots.resources.push(ResourceRef::Task {
        id: input.task_id.clone(),
    });
    roots.resources.extend(
        input
            .tests
            .iter()
            .chain(&input.protected_counterexamples)
            .map(|test| ResourceRef::TestCase {
                id: test.id.clone(),
            }),
    );
    for arm in &input.arms {
        retain_arm(roots, arm);
    }
    for selected in &input.plans {
        retain_arm(roots, &selected.arm);
        retain_plan(roots, &selected.plan);
    }
}

fn retain_plan(roots: &mut RetentionRoots, plan: &PlanReference) {
    match plan {
        PlanReference::Strategy(reference) => roots.definitions.push(reference.clone()),
        PlanReference::Abstraction { .. } => {}
        PlanReference::Frozen(plan) => {
            // Suite-owned definitions live in this immutable body, not canonical definition rows.
            for definition in &plan.definitions {
                roots.scopes.push(definition.scope.clone());
                roots.evidence.extend(definition.evidence.iter().cloned());
                roots.resources.extend(definitions::definition_resources(&definition.body).into_iter()
                    .filter(|resource| !matches!(resource, ResourceRef::Definition { id } if plan.definitions.iter().any(|model| &model.reference.id == id))));
                if let world_protocol::definitions::DefinitionBody::SourceBinding(source) = &definition.body {
                    roots.schemas.push(source.schema.clone());
                    roots.mappings.push(source.mapping.clone());
                }
            }
            for scope in &plan.scopes {
                roots.scopes.push(scope.id.clone());
                roots.resources.extend(definitions::expression_resources(&scope.predicate).into_iter()
                    .filter(|resource| !matches!(resource, ResourceRef::Definition { id } if plan.definitions.iter().any(|model| &model.reference.id == id))));
            }
            match &plan.knowledge {
                world_protocol::evaluation::FrozenKnowledge::ToolMemory { snapshot, .. } => roots.source_versions.push(snapshot.clone()),
                world_protocol::evaluation::FrozenKnowledge::StaticOntology { release_id } => roots.releases.push(release_id.clone()),
                world_protocol::evaluation::FrozenKnowledge::AppendOnly { anchor_release, changes } => {
                    roots.releases.push(anchor_release.clone());
                    for change in changes {
                        roots.resources.push(ResourceRef::ChangeSet { id: change.id.clone() });
                        roots.evidence.extend(change.evidence.iter().cloned());
                        roots.resources.extend(change.cases.iter().cloned().map(|id| ResourceRef::Case { id }));
                    }
                }
            }
        }
    }
}

async fn case_inline_definitions(tx: &WorldTransaction<'_>, case: &Case, expected: Option<&run::AcceptedResult>) -> Result<Vec<world_protocol::ids::DefinitionRef>, Error> {
    use world_protocol::{evaluation::EvaluationFailure, operation::OperationPhase};
    let rows = tx.query(
        "SELECT evaluation_id FROM world_evaluation_result WHERE tenant_id=$1 AND world_id=$2 AND body->'case'->>'id'=$3 LIMIT 2",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &case.id.as_str()],
    ).await?;
    let Some(row) = rows.first() else { return Ok(Vec::new()); };
    if rows.len() != 1 { return Err(EvaluationFailure::BasisChanged.into()); }
    let id = world_protocol::ids::EvaluationId::try_new(row.get::<_, String>("evaluation_id"))
        .map_err(|_| EvaluationFailure::BasisChanged)?;
    let state = run::load(tx, &id).await?.ok_or(EvaluationFailure::BasisChanged)?;
    run::read_report(tx, &id).await?;
    let accepted = run::results(tx, &id).await?;
    let result = accepted.iter().find(|result| result.case.as_ref().is_some_and(|stored| stored.id == case.id))
        .ok_or(EvaluationFailure::BasisChanged)?;
    if let Some(expected) = expected {
        if records::digest(expected)? != records::digest(result)? { return Err(EvaluationFailure::BasisChanged.into()); }
    }
    if result.case.as_ref() != Some(case) || records::load_case(tx, &case.id).await?.as_ref() != Some(case)
        || result.evaluation.case_id.as_ref() != Some(&case.id)
        || result.evaluation.observed.as_ref() != Some(&case.observable_trace)
        || case.id != super::execution_case_id(tx.world(), &id, &result.evaluation.test, &result.evaluation.arm)?
    { return Err(EvaluationFailure::BasisChanged.into()); }
    let task = records::task(tx, &state.request.suite.task_id, state.request.suite.task_revision).await?;
    let tests = records::tests(tx, &state.request.suite.tests).await?;
    let test_index = tests.iter().position(|test| test.id == result.evaluation.test.id && test.revision == result.evaluation.test.revision)
        .ok_or(EvaluationFailure::BasisChanged)?;
    let arm_index = state.request.suite.arms.iter().position(|arm| arm == &result.evaluation.arm)
        .ok_or(EvaluationFailure::BasisChanged)?;
    let ordinal = test_index.checked_mul(state.request.suite.arms.len()).and_then(|value| value.checked_add(arm_index))
        .and_then(|value| u32::try_from(value).ok()).ok_or(EvaluationFailure::InternalFault)?;
    let input_digest = records::digest(&(&id, ordinal, &tests[test_index], &result.evaluation.arm, &state.report.basis_digest))?;
    let step_id = world_protocol::ids::StepId::try_new(format!("eval-{}", &input_digest.as_str()[7..]))
        .map_err(|_| EvaluationFailure::InternalFault)?;
    let step = crate::owner::read_step(tx, &state.run.id, &step_id).await?.ok_or(EvaluationFailure::BasisChanged)?;
    if step.phase != OperationPhase::Completed || step.run_id != state.run.id || step.ordinal != ordinal
        || step.kind != "world.evaluation.case" || step.input_digest != input_digest
        || step.result.as_ref() != Some(&records::encode(result)?)
    { return Err(EvaluationFailure::BasisChanged.into()); }
    let plan = super::frozen_arm_plan(tx, &id, &state.branch, &result.evaluation.arm).await?;
    result.witness.require_frozen_plan(&plan)?;
    result.witness.validate(&super::CandidateInput::new(&state, &step, &task, &tests[test_index], &case.input),
        &state.request.basis, &result.evaluation.arm, &case.observable_trace, case)?;
    super::frozen_inline_definitions(tx, &plan).await
}

fn retain_case(roots: &mut RetentionRoots, case: &Case, inline: &[world_protocol::ids::DefinitionRef]) -> Result<(), Error> {
    roots.releases.push(case.release_id.clone());
    roots
        .definitions
        .extend(case.used_definitions.iter().filter(|reference| !inline.contains(reference)).cloned());
    roots.evidence.extend(case.evidence.iter().cloned());
    definitions::value_resources(&case.input, &mut roots.resources);
    for receipt in &case.read_receipts {
        read_in_model(roots, receipt, inline);
    }
    for receipt in &case.source_receipts {
        roots.resources.push(ResourceRef::Source {
            id: receipt.source_id.clone(),
        });
        roots.evidence.extend(receipt.evidence.iter().cloned());
        if let Some(value) = &receipt.result {
            definitions::value_resources(value, &mut roots.resources);
        }
    }
    match &case.origin {
        CaseOrigin::Replay {
            parent_case_id,
            basis,
        } => {
            roots.resources.push(ResourceRef::Case {
                id: parent_case_id.clone(),
            });
            retain_basis(roots, basis);
        }
        CaseOrigin::Synthetic { assumptions, .. } => {
            for expression in assumptions {
                crate::learning::retain_expression(roots, expression);
            }
        }
        CaseOrigin::Recorded | CaseOrigin::Fixture => {}
    }
    match &case.outcome {
        CaseOutcome::Succeeded { result } => {
            definitions::value_resources(result, &mut roots.resources)
        }
        CaseOutcome::Inconclusive {
            reason: CaseInconclusive::EvidenceMissing { evidence },
        } => roots.evidence.extend(evidence.iter().cloned()),
        CaseOutcome::Inconclusive {
            reason: CaseInconclusive::ResultUnavailable { cell, .. },
        } => {
            match cell {
                world_protocol::value::Cell::Known { value } => {
                    definitions::value_resources(value, &mut roots.resources)
                }
                world_protocol::value::Cell::Conflicted { assertions } => roots
                    .dependencies
                    .extend(assertions.iter().cloned().map(|reference| {
                        world_protocol::provenance::ReadDependency::Assertion { reference }
                    })),
                world_protocol::value::Cell::SourceUnavailable { source_id, .. } => {
                    roots.resources.push(ResourceRef::Source {
                        id: source_id.clone(),
                    })
                }
                world_protocol::value::Cell::Unknown { .. } => {}
            }
        }
        CaseOutcome::Failed { failure } => crate::owner::operation_failure_roots(
            &case.world,
            &world_protocol::operation::OperationFailure::Learning(failure.details.clone()),
            roots,
        )?,
        CaseOutcome::Inconclusive {
            reason: CaseInconclusive::IncompleteBasis { sources },
        } => roots
            .resources
            .extend(sources.iter().cloned().map(|id| ResourceRef::Source { id })),
        _ => {}
    }
    if let CaseOutcome::Inconclusive {
        reason:
            CaseInconclusive::ResultUnavailable {
                cell: world_protocol::value::Cell::SourceUnavailable { failure, .. },
                ..
            },
    } = &case.outcome
    {
        crate::owner::operation_failure_roots(
            &case.world,
            &world_protocol::operation::OperationFailure::Source(failure.clone()),
            roots,
        )?;
    }
    Ok(())
}
fn retain_suite(roots: &mut RetentionRoots, suite: &FrozenSuite) {
    roots.resources.push(ResourceRef::Task {
        id: suite.task_id.clone(),
    });
    roots.resources.extend(
        suite
            .tests
            .iter()
            .chain(&suite.protected_counterexamples)
            .map(|test| ResourceRef::TestCase {
                id: test.id.clone(),
            }),
    );
    for arm in &suite.arms {
        retain_arm(roots, arm);
    }
    for selected in &suite.plans {
        retain_arm(roots, &selected.arm);
        retain_plan(roots, &selected.plan);
    }
}
pub(crate) fn retain_report(
    roots: &mut RetentionRoots,
    report: &EvaluationReport,
) -> Result<(), Error> {
    for case in &report.cases {
        retain_case_evaluation(&report.world, roots, case)?;
    }
    for check in &report.hard_checks {
        roots.evidence.extend(check.evidence.iter().cloned());
    }
    roots.resources.extend(
        report
            .counterexamples
            .iter()
            .chain(&report.coverage.missing_tests)
            .map(|test| ResourceRef::TestCase {
                id: test.id.clone(),
            }),
    );
    roots.resources.extend(
        report
            .coverage
            .missing_sources
            .iter()
            .cloned()
            .map(|id| ResourceRef::Source { id }),
    );
    for arm in &report.arms {
        retain_arm(roots, &arm.arm);
    }
    if let world_protocol::evaluation::EvaluationExecution::Failed { failure } = &report.execution {
        crate::owner::operation_failure_roots(&report.world, &failure.details, roots)?;
    }
    Ok(())
}
pub(crate) async fn case_step_retention_roots(
    tx: &WorldTransaction<'_>,
    step: &crate::owner::StepRecord,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    let world = tx.world();
    if step.kind != "world.evaluation.case" {
        return Err(super::invalid("retention.step.kind").into());
    }
    if let Some(body) = &step.result {
        let accepted: run::AcceptedResult = records::decode(body.clone())?;
        if let Some(case) = &accepted.case {
            if case.world != *world {
                return Err(super::ConstraintFailure::CrossWorld.into());
            }
            let inline = case_inline_definitions(tx, case, Some(&accepted)).await?;
            retain_case(roots, case, &inline)?;
        }
        retain_case_evaluation(world, roots, &accepted.evaluation)?;
        for check in &accepted.hard_checks {
            roots.evidence.extend(check.evidence.iter().cloned());
        }
    }
    if !step.checkpoint.is_null() {
        let evaluation: world_protocol::evaluation::CaseEvaluation =
            records::decode(step.checkpoint.clone())?;
        retain_case_evaluation(world, roots, &evaluation)?;
    }
    Ok(())
}

fn retain_case_evaluation(
    world: &world_protocol::ids::WorldRef,
    roots: &mut RetentionRoots,
    case: &world_protocol::evaluation::CaseEvaluation,
) -> Result<(), Error> {
    retain_arm(roots, &case.arm);
    roots.resources.extend(
        case.case_id
            .iter()
            .cloned()
            .map(|id| ResourceRef::Case { id }),
    );
    roots.resources.push(ResourceRef::TestCase {
        id: case.test.id.clone(),
    });
    if let world_protocol::evaluation::CaseExecution::BusinessFailed { failure } = &case.execution {
        crate::owner::operation_failure_roots(
            world,
            &world_protocol::operation::OperationFailure::Action(failure.details.clone()),
            roots,
        )?;
    }
    Ok(())
}

fn retain_arm(roots: &mut RetentionRoots, arm: &EvaluationArm) {
    if let EvaluationArm::Ablation {
        disabled_definitions,
    } = arm
    {
        roots
            .definitions
            .extend(disabled_definitions.iter().cloned());
    }
}
fn retain_basis(roots: &mut RetentionRoots, basis: &BranchBasis) {
    roots.releases.push(basis.release_id.clone());
    roots.sources.extend(basis.sources.iter().cloned());
    roots.resources.extend(
        basis
            .missing_sources
            .iter()
            .cloned()
            .map(|id| ResourceRef::Source { id }),
    );
    for receipt in &basis.read_receipts {
        read(roots, receipt);
    }
    crate::learning::retain_operations(roots, &basis.overlay);
    for expression in &basis.assumptions {
        crate::learning::retain_expression(roots, expression);
    }
}
fn read(roots: &mut RetentionRoots, receipt: &ReadReceipt) {
    read_in_model(roots, receipt, &[]);
}
fn read_in_model(roots: &mut RetentionRoots, receipt: &ReadReceipt, inline: &[world_protocol::ids::DefinitionRef]) {
    roots.releases.push(receipt.release_id.clone());
    roots.sources.extend(receipt.basis.iter().cloned());
    roots
        .dependencies
        .extend(receipt.actual_dependencies.iter().filter(|dependency| !matches!(dependency, world_protocol::provenance::ReadDependency::Definition { reference } if inline.contains(reference))).cloned());
    roots.resources.extend(
        receipt
            .branch_id
            .iter()
            .cloned()
            .map(|id| ResourceRef::Branch { id }),
    );
    roots.resources.extend(
        receipt
            .dirty
            .iter()
            .cloned()
            .map(|id| ResourceRef::Watch { id }),
    );
    roots.resources.extend(
        receipt
            .coverage
            .missing_sources
            .iter()
            .chain(&receipt.coverage.gap_sources)
            .cloned()
            .map(|id| ResourceRef::Source { id }),
    );
    roots.resources.extend(
        receipt
            .coverage
            .missing_fields
            .iter()
            .cloned()
            .map(|id| ResourceRef::Definition { id }),
    );
}
fn oracle(roots: &mut RetentionRoots, oracle: &OracleSpec) {
    if let OracleSpec::SourceReceipt { source_id, .. } = oracle {
        roots.resources.push(ResourceRef::Source {
            id: source_id.clone(),
        });
    }
}
fn value_type(roots: &mut RetentionRoots, input: &world_protocol::value::ValueType) {
    use world_protocol::value::ValueType;
    match input {
        ValueType::Object { type_id } | ValueType::Relation { type_id } => {
            roots.resources.push(ResourceRef::Definition {
                id: type_id.clone(),
            })
        }
        ValueType::List { element, .. } => value_type(roots, element),
        ValueType::Record { fields } => {
            for field in fields {
                value_type(roots, &field.value_type);
            }
        }
        _ => {}
    }
}
