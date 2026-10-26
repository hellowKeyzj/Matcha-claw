use crate::{
    authorization::{self, VerifiedInvocation},
    owner,
    store::WorldTransaction,
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::ActualImpact,
    evaluation::EvaluationReport,
    failure::{FailureStage, FieldPath, Recovery},
    ids::{EvaluationId, WorldRef},
    query::{Page, PageRequest, QueryFailure, TruncationReason},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    world: WorldRef,
    after: EvaluationId,
}

pub(crate) async fn report(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    id: &EvaluationId,
) -> Result<EvaluationReport, owner::Error> {
    let impact = super::report_impact(tx, id, true).await?;
    let now = tx.now().await?;
    let admission = authorization::admit(tx, verified, &impact, &[], None, &now).await?;
    Ok(super::full_report(tx, &admission, id, &tx.now().await?).await?)
}

pub(crate) async fn reports(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    page: &PageRequest,
) -> Result<Page<EvaluationReport>, owner::Error> {
    if page.limit == 0 || page.limit > 200 {
        return Err(query_error(QueryFailure::InvalidQuery {
            field: FieldPath(vec!["page".into()]),
        }));
    }
    let mut after = match &page.cursor {
        Some(value) => {
            let cursor: Cursor = serde_json::from_str(value)
                .map_err(|_| query_error(QueryFailure::CursorInvalid))?;
            if cursor.world != *tx.world() {
                return Err(query_error(QueryFailure::CursorInvalid));
            }
            cursor.after.to_string()
        }
        None => String::new(),
    };
    let mut items = Vec::new();
    let mut scanned = 0usize;
    loop {
        if tx.now().await? >= verified.invocation().deadline {
            return Err(query_error(QueryFailure::BudgetExceeded {
                limit: TruncationReason::Deadline,
            }));
        }
        let rows = tx.query("SELECT evaluation_id FROM world_evaluation_run WHERE tenant_id=$1 AND world_id=$2 AND evaluation_id>$3 ORDER BY evaluation_id LIMIT 128",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
        let exhausted = rows.len() < 128;
        for row in rows {
            scanned += 1;
            if scanned > 4096 {
                return Err(query_error(QueryFailure::BudgetExceeded {
                    limit: TruncationReason::Rows,
                }));
            }
            after = row.get("evaluation_id");
            let id = EvaluationId::try_new(after.clone())
                .map_err(|_| owner::Error::internal(FailureStage::Read))?;
            let impact = super::report_impact(tx, &id, true).await?;
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
                let last: &EvaluationReport = items
                    .last()
                    .ok_or_else(|| owner::Error::internal(FailureStage::Read))?;
                let cursor = serde_json::to_string(&Cursor {
                    world: tx.world().clone(),
                    after: last.id.clone(),
                })
                .map_err(|cause| owner::Error::internal(FailureStage::Read).caused(cause))?;
                return Ok(Page {
                    items,
                    next_cursor: Some(cursor),
                });
            }
            items.push(super::full_report(tx, &admission, &id, &tx.now().await?).await?);
        }
        if exhausted {
            return Ok(Page {
                items,
                next_cursor: None,
            });
        }
    }
}

pub(crate) async fn execution_impact(
    tx: &WorldTransaction<'_>,
    request: &world_protocol::evaluation::EvaluationRequest,
) -> Result<ActualImpact, owner::Error> {
    let (branch, candidate) = crate::releases::read_candidate(tx, &request.candidate_id)
        .await?
        .ok_or(world_protocol::learning::LearningFailure::BasisChanged)
        .map_err(crate::learning::Error::from)?;
    let task = super::read_task(tx, &branch.task_id, branch.task_revision).await?;
    let suite = super::read_suite(tx, &request.suite.id, request.suite.revision).await?;
    super::validate_request(request, &task, &suite).map_err(super::Error::from)?;
    if request.world != branch.world
        || request.branch_id != branch.id
        || request.basis != branch.basis
    {
        return Err(crate::learning::Error::from(
            world_protocol::learning::LearningFailure::BasisChanged,
        )
        .into());
    }
    let write = crate::learning::candidate_impact(
        tx,
        &candidate,
        &branch,
        world_protocol::authorization::AccessMode::Write,
    )
    .await?;
    let read = crate::learning::candidate_impact(
        tx,
        &candidate,
        &branch,
        world_protocol::authorization::AccessMode::Read,
    )
    .await?;
    let mut report = super::disclosure::creation_impact(tx, request).await?;
    let plans = super::plans_impact(tx, &task, &suite.plans).await?;
    report.access.extend(plans.access);
    report.effects.extend(plans.effects);
    report.labels.extend(plans.labels);
    report.state.extend(plans.state);
    report.source_ids.extend(plans.source_ids);
    for (previous, result) in super::reports_for_branch(tx, &branch).await? {
        if result.id == request.id
            || !task.required_suites.contains(&result.suite_id)
            || previous.suite.conditions.policy_epoch != request.suite.conditions.policy_epoch
            || previous.suite.conditions.grant_epoch != request.suite.conditions.grant_epoch
            || result.execution != world_protocol::evaluation::EvaluationExecution::Completed
            || result.assurance != world_protocol::evaluation::EvaluationAssurance::Tested
        {
            continue;
        }
        let current = super::report_impact(tx, &result.id, false).await?;
        report.access.extend(current.access);
        report.labels.extend(current.labels);
        report.source_ids.extend(current.source_ids);
        report
            .access
            .push(world_protocol::authorization::AccessScope {
                resources: vec![world_protocol::ids::ResourceRef::Suite {
                    id: result.suite_id,
                }],
                fields: Vec::new(),
                modes: vec![world_protocol::authorization::AccessMode::Read],
                scope: task.scope.clone(),
                valid_time: None,
            });
    }
    report
        .access
        .push(world_protocol::authorization::AccessScope {
            resources: vec![world_protocol::ids::ResourceRef::Suite {
                id: request.suite.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![world_protocol::authorization::AccessMode::Read],
            scope: task.scope.clone(),
            valid_time: None,
        });
    let mut access = write.access;
    access.extend(read.access);
    access.extend(report.access);
    access.push(world_protocol::authorization::AccessScope {
        resources: vec![world_protocol::ids::ResourceRef::Branch { id: branch.id }],
        fields: Vec::new(),
        modes: vec![world_protocol::authorization::AccessMode::Execute],
        scope: task.scope,
        valid_time: None,
    });
    Ok(authorization::actual_impact(
        access,
        Vec::new(),
        write
            .labels
            .into_iter()
            .chain(read.labels)
            .chain(report.labels)
            .collect(),
        Vec::new(),
        write
            .source_ids
            .into_iter()
            .chain(read.source_ids)
            .chain(report.source_ids)
            .collect(),
    )?)
}

fn query_error(failure: QueryFailure) -> owner::Error {
    owner::Error::new(
        "world.evaluation_directory_unavailable",
        FailureStage::Read,
        "评测目录读取未完成。",
        world_protocol::api::ApiFailure::Query(failure),
        Recovery::None,
    )
}
