use super::{ConstraintFailure, Error, records};
use crate::{
    authorization::{self, Admission, EvaluationAuthority, VerifiedInvocation},
    owner,
    store::WorldTransaction,
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    definitions::DefinitionBody,
    evaluation::{
        FreezeSuite, FrozenSuite, SuiteCreationContext, SuiteRef, SuiteSummary, TestRevision,
    },
    failure::{FailureStage, FieldPath, Recovery},
    ids::{ResourceRef, Revision, ScopeId, SuiteId, TestCaseId, WorldRef},
    learning::{TaskContract, TaskRef, TestCase},
    query::{Page, PageRequest, QueryFailure, TruncationReason},
    releases::{BranchRef, WorldBranch},
};

pub(crate) async fn suite_creation_context(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    authority: &EvaluationAuthority,
    reference: &BranchRef,
) -> Result<SuiteCreationContext, owner::Error> {
    let branch = suite_branch(tx, reference).await?;
    let task = records::task(tx, &branch.task_id, branch.task_revision).await?;
    let impact = crate::learning::candidate_read_impact(tx, &branch.candidate_id).await?;
    let admission = manager(tx, verified, authority, &impact, 1).await?;
    let mut strategies = Vec::new();
    for (index, definition) in branch.compile.definitions.iter().enumerate() {
        deadline(tx, verified).await?;
        scanned_limit(index + 1)?;
        if !matches!(&definition.body, DefinitionBody::Strategy(_)) {
            continue;
        }
        let actual = crate::releases::model_impact(
            tx,
            std::slice::from_ref(definition),
            Vec::new(),
            &[AccessMode::Read],
        )
        .await?;
        let readable = match authorization::admit(tx, verified, &actual, &[], None, &tx.now().await?).await {
            Ok(readable) => readable,
            Err(authorization::AuthError::Denied(_)) => continue,
            Err(error) => return Err(error.into()),
        };
        authorization::check_admitted_output(
            tx,
            &readable,
            &actual,
            (strategies.len() + 1) as u64,
            &tx.now().await?,
        )
        .await?;
        strategies.push(definition.reference.clone());
    }
    authorization::check_admitted_output(tx, &admission, &impact, 1, &tx.now().await?).await?;
    Ok(SuiteCreationContext {
        branch: reference.clone(),
        task,
        strategies,
        policy_epoch: admission.decision().policy_epoch,
        grant_epoch: admission.decision().grant_epoch,
        tool_lock: branch.basis.activation_lock_id.clone(),
        data_digest: super::data_digest(&branch.basis)?,
    })
}

async fn suite_branch(
    tx: &WorldTransaction<'_>,
    reference: &BranchRef,
) -> Result<WorldBranch, Error> {
    if reference.world != *tx.world() {
        return Err(ConstraintFailure::CrossWorld.into());
    }
    let branch = crate::releases::read_branch_revision(tx, reference)
        .await?
        .ok_or(ConstraintFailure::VersionMismatch)?;
    if crate::releases::read_branch(tx, &branch.id).await?.as_ref() != Some(&branch)
        || !matches!(
            branch.status,
            world_protocol::learning::ChangeStatus::Validated
                | world_protocol::learning::ChangeStatus::Testing
                | world_protocol::learning::ChangeStatus::Ready
                | world_protocol::learning::ChangeStatus::Published
        )
        || branch.basis.activation_lock_id != branch.compile.activation_lock.id
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    Ok(branch)
}

pub(crate) async fn branch_for_freeze(
    tx: &WorldTransaction<'_>,
    input: &FreezeSuite,
) -> Result<(WorldBranch, TaskContract), Error> {
    if input.world != *tx.world() {
        return Err(ConstraintFailure::CrossWorld.into());
    }
    let branch = suite_branch(tx, &input.branch).await?;
    if input.task_id != branch.task_id || input.task_revision != branch.task_revision {
        return Err(ConstraintFailure::TaskMismatch.into());
    }
    if input.conditions.tool_lock != branch.basis.activation_lock_id
        || input.conditions.data_digest != super::data_digest(&branch.basis)?
    {
        return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into());
    }
    let task = records::task(tx, &branch.task_id, branch.task_revision).await?;
    Ok((branch, task))
}

pub(crate) async fn test_impact(
    tx: &WorldTransaction<'_>,
    test: &TestCase,
) -> Result<ActualImpact, Error> {
    let task = records::task(tx, &test.task_id, test.task_revision).await?;
    super::validate_test(&task, test)?;
    let mut access = vec![scope(
        ResourceRef::TestCase {
            id: test.id.clone(),
        },
        &task.scope,
        AccessMode::Manage,
    )];
    let mut labels = Vec::new();
    let mut sources = Vec::new();
    for reference in &test.evidence {
        let evidence = crate::facts::assertions::read_evidence(tx, reference)
            .await
            .map_err(Error::Fact)?
            .ok_or(world_protocol::evaluation::EvaluationFailure::OracleUnavailable)?;
        let version = crate::content::read_source_version_in_transaction(
            tx,
            &evidence.locator.source_version,
        )
        .await?;
        let actual = authorization::material_read_impact(tx, &version).await?;
        access.extend(actual.access);
        access.push(scope(
            ResourceRef::Evidence {
                id: reference.id.clone(),
            },
            &task.scope,
            AccessMode::Read,
        ));
        labels.extend(evidence.access.labels);
        labels.extend(actual.labels);
        sources.extend(actual.source_ids);
    }
    if let Some(id) = &test.case_id {
        let case =
            records::load_case(tx, id)
                .await?
                .ok_or_else(|| ConstraintFailure::MissingParent {
                    case_id: id.clone(),
                })?;
        if case.task_id != task.id
            || case.task_revision != task.revision
            || case.origin_family != test.origin_family
        {
            return Err(ConstraintFailure::TaskMismatch.into());
        }
        let actual = authorization::case_read_impact(tx, &case).await?;
        access.extend(actual.access);
        labels.extend(actual.labels);
        sources.extend(actual.source_ids);
    }
    Ok(authorization::actual_impact(
        access,
        Vec::new(),
        labels,
        Vec::new(),
        sources,
    )?)
}

pub(crate) async fn freeze_impact(
    tx: &WorldTransaction<'_>,
    input: &FreezeSuite,
) -> Result<ActualImpact, Error> {
    let (branch, task) = branch_for_freeze(tx, input).await?;
    let mut impact = authorization::actual_impact(
        vec![scope(
            ResourceRef::Suite {
                id: input.id.clone(),
            },
            &task.scope,
            AccessMode::Manage,
        )],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    merge(
        &mut impact,
        crate::learning::candidate_read_impact(tx, &branch.candidate_id)
            .await
            .map_err(owner::Error::from)?,
    );
    for test in records::tests(tx, &input.tests).await? {
        merge(&mut impact, test_impact(tx, &test).await?);
    }
    for selected in &input.plans {
        let world_protocol::evaluation::PlanReference::Strategy(reference) = &selected.plan else {
            continue;
        };
        if let Some(definition) = branch.compile.definitions.iter().find(|definition| &definition.reference == reference) {
            merge(&mut impact, crate::releases::model_impact(
                tx,
                std::slice::from_ref(definition),
                Vec::new(),
                &[AccessMode::Read],
            ).await?);
        }
    }
    merge(&mut impact, super::plans_impact(tx, &task, &input.plans).await?);
    Ok(authorization::actual_impact(
        impact.access,
        impact.effects,
        impact.labels,
        impact.state,
        impact.source_ids,
    )?)
}

pub(crate) async fn freeze(
    tx: &WorldTransaction<'_>,
    input: FreezeSuite,
    actor: world_protocol::ids::ActorId,
    now: world_protocol::time::Timestamp,
) -> Result<FrozenSuite, Error> {
    let (branch, task) = branch_for_freeze(tx, &input).await?;
    let frozen = FrozenSuite {
        world: input.world,
        id: input.id,
        revision: input.revision,
        task_id: input.task_id,
        task_revision: input.task_revision,
        tests: input.tests,
        protected_counterexamples: input.protected_counterexamples,
        training_before: input.training_before,
        holdout_from: input.holdout_from,
        arms: input.arms,
        plans: input.plans,
        conditions: input.conditions,
        acceptance: input.acceptance,
        frozen_by: actor,
        frozen_at: now,
    };
    super::branch_execution::validate_suite_plans(tx, &branch, &frozen, &task.scope).await?;
    Ok(frozen)
}

pub(crate) async fn suite_summary(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    reference: &SuiteRef,
) -> Result<Option<SuiteSummary>, owner::Error> {
    if reference.world != *tx.world() {
        return Err(Error::from(ConstraintFailure::CrossWorld).into());
    }
    if tx.query_opt("SELECT 1 FROM world_suite_revision WHERE tenant_id=$1 AND world_id=$2 AND suite_id=$3 AND revision=$4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &records::revision(reference.revision)?]).await?.is_none()
    { return Ok(None); }
    let suite = records::suite(tx, &reference.id, reference.revision).await?;
    let impact = summary_impact(tx, &suite).await?;
    let admission =
        authorization::admit(tx, verified, &impact, &[], None, &tx.now().await?).await?;
    authorization::check_admitted_output(tx, &admission, &impact, 1, &tx.now().await?).await?;
    Ok(Some(project(&suite)))
}

pub(crate) async fn exact_test(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    authority: &EvaluationAuthority,
    reference: &TestRevision,
) -> Result<TestCase, owner::Error> {
    let test = records::tests(tx, std::slice::from_ref(reference))
        .await?
        .pop()
        .ok_or_else(|| owner::Error::internal(FailureStage::Read))?;
    let impact = test_impact(tx, &test).await?;
    let admission = manager(tx, verified, authority, &impact, 1).await?;
    authorization::check_admitted_output(tx, &admission, &impact, 1, &tx.now().await?).await?;
    Ok(test)
}

pub(crate) async fn frozen_suite(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    authority: &EvaluationAuthority,
    reference: &SuiteRef,
) -> Result<FrozenSuite, owner::Error> {
    if reference.world != *tx.world() {
        return Err(Error::from(ConstraintFailure::CrossWorld).into());
    }
    let suite = records::suite(tx, &reference.id, reference.revision).await?;
    let task = records::task(tx, &suite.task_id, suite.task_revision).await?;
    let mut impact = authorization::actual_impact(
        vec![scope(
            ResourceRef::Suite {
                id: suite.id.clone(),
            },
            &task.scope,
            AccessMode::Manage,
        )],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    for test in records::tests(tx, &suite.tests).await? {
        merge(&mut impact, test_impact(tx, &test).await?);
    }
    let impact = authorization::actual_impact(
        impact.access,
        impact.effects,
        impact.labels,
        impact.state,
        impact.source_ids,
    )?;
    manager(tx, verified, authority, &impact, 1).await?;
    Ok(suite)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    world: WorldRef,
    directory: String,
    task: Option<TaskRef>,
    id: String,
    revision: Revision,
}

pub(crate) async fn suites(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    page: &PageRequest,
) -> Result<Page<SuiteSummary>, owner::Error> {
    let mut after = cursor(tx, page, "suites", None)?;
    if !after.id.is_empty() {
        SuiteId::try_new(after.id.clone()).map_err(|_| query_error(QueryFailure::CursorInvalid))?;
    }
    let mut items: Vec<SuiteSummary> = Vec::new();
    let mut scanned = 0;
    loop {
        deadline(tx, verified).await?;
        let rows = tx.query("SELECT suite_id,revision FROM world_suite_revision WHERE tenant_id=$1 AND world_id=$2 AND (suite_id,revision)>($3,$4) ORDER BY suite_id,revision LIMIT 128",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after.id, &records::revision(after.revision)?]).await?;
        let exhausted = rows.len() < 128;
        for row in rows {
            scanned += 1;
            scanned_limit(scanned)?;
            after.id = row.get("suite_id");
            after.revision = number(row.get("revision"))?;
            let id = SuiteId::try_new(after.id.clone())
                .map_err(|_| owner::Error::internal(FailureStage::Read))?;
            let suite = records::suite(tx, &id, after.revision).await?;
            let impact = summary_impact(tx, &suite).await?;
            let admission = match authorization::admit(
                tx,
                verified,
                &impact,
                &[],
                None,
                &tx.now().await?,
            )
            .await
            {
                Ok(admission) => admission,
                Err(authorization::AuthError::Denied(_)) => continue,
                Err(error) => return Err(error.into()),
            };
            authorization::check_admitted_output(
                tx,
                &admission,
                &impact,
                (items.len() + 1).min(page.limit as usize) as u64,
                &tx.now().await?,
            )
            .await?;
            if items.len() == page.limit as usize {
                let last = &items.last().expect("nonempty page").reference;
                return Ok(Page {
                    next_cursor: Some(encode_cursor(
                        tx,
                        "suites",
                        None,
                        last.id.to_string(),
                        last.revision,
                    )?),
                    items,
                });
            }
            items.push(project(&suite));
        }
        if exhausted {
            return Ok(Page {
                items,
                next_cursor: None,
            });
        }
    }
}

pub(crate) async fn test_cases(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    authority: &EvaluationAuthority,
    input: &world_protocol::api::TestCasesQuery,
) -> Result<Page<TestRevision>, owner::Error> {
    if input.task.world != *tx.world() {
        return Err(Error::from(ConstraintFailure::CrossWorld).into());
    }
    let task = records::task(tx, &input.task.id, input.task.revision).await?;
    let mut after = cursor(tx, &input.page, "test-cases", Some(&input.task))?;
    if !after.id.is_empty() {
        TestCaseId::try_new(after.id.clone())
            .map_err(|_| query_error(QueryFailure::CursorInvalid))?;
    }
    let initial = authorization::actual_impact(
        vec![scope(
            ResourceRef::Task {
                id: task.id.clone(),
            },
            &task.scope,
            AccessMode::Read,
        )],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    manager(tx, verified, authority, &initial, 0).await?;
    let mut items: Vec<TestRevision> = Vec::new();
    let mut scanned = 0;
    loop {
        deadline(tx, verified).await?;
        let rows = tx.query("SELECT test_case_id,revision FROM world_test_case_revision WHERE tenant_id=$1 AND world_id=$2 AND body->>'taskId'=$3 AND body->>'taskRevision'=$4 AND (test_case_id,revision)>($5,$6) ORDER BY test_case_id,revision LIMIT 128",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &task.id.as_str(), &task.revision.0.to_string(), &after.id, &records::revision(after.revision)?]).await?;
        let exhausted = rows.len() < 128;
        for row in rows {
            scanned += 1;
            scanned_limit(scanned)?;
            after.id = row.get("test_case_id");
            after.revision = number(row.get("revision"))?;
            let reference = TestRevision {
                id: TestCaseId::try_new(after.id.clone())
                    .map_err(|_| owner::Error::internal(FailureStage::Read))?,
                revision: after.revision,
            };
            let test = records::tests(tx, std::slice::from_ref(&reference))
                .await?
                .pop()
                .ok_or_else(|| owner::Error::internal(FailureStage::Read))?;
            if test.task_id != task.id || test.task_revision != task.revision {
                return Err(Error::from(ConstraintFailure::TaskMismatch).into());
            }
            let impact = test_impact(tx, &test).await?;
            match manager(
                tx,
                verified,
                authority,
                &impact,
                (items.len() + 1).min(input.page.limit as usize) as u64,
            )
            .await
            {
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.safe_failure().details,
                        world_protocol::api::ApiFailure::Authorization(_)
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
            if items.len() == input.page.limit as usize {
                let last = items.last().expect("nonempty page");
                return Ok(Page {
                    next_cursor: Some(encode_cursor(
                        tx,
                        "test-cases",
                        Some(&input.task),
                        last.id.to_string(),
                        last.revision,
                    )?),
                    items,
                });
            }
            items.push(reference);
        }
        if exhausted {
            return Ok(Page {
                items,
                next_cursor: None,
            });
        }
    }
}

async fn manager(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    authority: &EvaluationAuthority,
    impact: &ActualImpact,
    delivered: u64,
) -> Result<Admission, owner::Error> {
    let admission = authorization::admit(tx, verified, impact, &[], None, &tx.now().await?).await?;
    authority
        .require_manager(tx, &admission, &tx.now().await?)
        .await?;
    authorization::check_admitted_output(tx, &admission, impact, delivered, &tx.now().await?)
        .await?;
    Ok(admission)
}
async fn summary_impact(
    tx: &WorldTransaction<'_>,
    suite: &FrozenSuite,
) -> Result<ActualImpact, Error> {
    let task = records::task(tx, &suite.task_id, suite.task_revision).await?;
    Ok(authorization::actual_impact(
        vec![scope(
            ResourceRef::Suite {
                id: suite.id.clone(),
            },
            &task.scope,
            AccessMode::Read,
        )],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?)
}
fn project(suite: &FrozenSuite) -> SuiteSummary {
    SuiteSummary {
        reference: SuiteRef {
            world: suite.world.clone(),
            id: suite.id.clone(),
            revision: suite.revision,
        },
        task: TaskRef {
            world: suite.world.clone(),
            id: suite.task_id.clone(),
            revision: suite.task_revision,
        },
        frozen_at: suite.frozen_at.clone(),
    }
}
fn scope(resource: ResourceRef, scope: &ScopeId, mode: AccessMode) -> AccessScope {
    AccessScope {
        resources: vec![resource],
        fields: Vec::new(),
        modes: vec![mode],
        scope: scope.clone(),
        valid_time: None,
    }
}
fn merge(into: &mut ActualImpact, actual: ActualImpact) {
    into.access.extend(actual.access);
    into.effects.extend(actual.effects);
    into.labels.extend(actual.labels);
    into.state.extend(actual.state);
    into.source_ids.extend(actual.source_ids);
}
fn cursor(
    tx: &WorldTransaction<'_>,
    page: &PageRequest,
    directory: &str,
    task: Option<&TaskRef>,
) -> Result<Cursor, owner::Error> {
    if page.limit == 0 || page.limit > 200 {
        return Err(query_error(QueryFailure::InvalidQuery {
            field: FieldPath(vec!["page".into()]),
        }));
    }
    let cursor = match &page.cursor {
        Some(value) => {
            serde_json::from_str(value).map_err(|_| query_error(QueryFailure::CursorInvalid))?
        }
        None => Cursor {
            world: tx.world().clone(),
            directory: directory.into(),
            task: task.cloned(),
            id: String::new(),
            revision: Revision(0),
        },
    };
    if cursor.world != *tx.world()
        || cursor.directory != directory
        || cursor.task.as_ref() != task
        || (!cursor.id.is_empty() && cursor.revision.0 == 0)
    {
        return Err(query_error(QueryFailure::CursorInvalid));
    }
    Ok(cursor)
}
fn encode_cursor(
    tx: &WorldTransaction<'_>,
    directory: &str,
    task: Option<&TaskRef>,
    id: String,
    revision: Revision,
) -> Result<String, owner::Error> {
    serde_json::to_string(&Cursor {
        world: tx.world().clone(),
        directory: directory.into(),
        task: task.cloned(),
        id,
        revision,
    })
    .map_err(|cause| owner::Error::internal(FailureStage::Read).caused(cause))
}
fn number(value: i64) -> Result<Revision, owner::Error> {
    u64::try_from(value)
        .ok()
        .filter(|v| *v > 0)
        .map(Revision)
        .ok_or_else(|| owner::Error::internal(FailureStage::Read))
}
async fn deadline(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
) -> Result<(), owner::Error> {
    if tx.now().await? >= verified.invocation().deadline {
        return Err(query_error(QueryFailure::BudgetExceeded {
            limit: TruncationReason::Deadline,
        }));
    }
    Ok(())
}
fn scanned_limit(scanned: usize) -> Result<(), owner::Error> {
    if scanned > 4096 {
        return Err(query_error(QueryFailure::BudgetExceeded {
            limit: TruncationReason::Rows,
        }));
    }
    Ok(())
}
fn query_error(reason: QueryFailure) -> owner::Error {
    owner::Error::new(
        "world.evaluation_directory_unavailable",
        FailureStage::Read,
        "评测目录读取未完成。",
        world_protocol::api::ApiFailure::Query(reason),
        Recovery::None,
    )
}
