use crate::{
    authorization::{self, AuthError, VerifiedInvocation},
    owner::Error,
    store::WorldTransaction,
};
use world_protocol::{
    api::{ApiFailure, TasksQuery},
    authorization::{AccessMode, AccessScope},
    failure::{FailureStage, Recovery},
    ids::{ResourceRef, TaskId},
    learning::{TaskContract, TaskRef, TaskSummary},
    query::{Page, QueryFailure, TruncationReason},
    time::Timestamp,
};

pub(crate) async fn task_summary(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    reference: &TaskRef,
    now: &Timestamp,
) -> Result<Option<TaskSummary>, Error> {
    if reference.world != *tx.world() || verified.invocation().world != *tx.world() {
        return Err(world_protocol::authorization::AuthorizationFailure::InsufficientScope.into());
    }
    let revision = i64::try_from(reference.revision.0)
        .map_err(|_| query_error(QueryFailure::CursorInvalid))?;
    if tx.query_opt("SELECT 1 FROM world_task_revision WHERE tenant_id=$1 AND world_id=$2 AND task_id=$3 AND revision=$4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &revision]).await?.is_none() { return Ok(None); }
    let task = crate::evaluation::read_task(tx, &reference.id, reference.revision).await?;
    visible(tx, verified, &task, 1, now).await
}

pub(crate) async fn list_tasks(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &TasksQuery,
    now: &Timestamp,
) -> Result<Page<TaskSummary>, Error> {
    if query.page.limit == 0 || query.page.limit > 200 || verified.invocation().world != *tx.world()
    {
        return Err(query_error(QueryFailure::InvalidQuery {
            field: world_protocol::failure::FieldPath(vec!["page".into()]),
        }));
    }
    let mut after = query.page.cursor.clone().unwrap_or_default();
    if !after.is_empty() {
        TaskId::try_new(after.clone()).map_err(|_| query_error(QueryFailure::CursorInvalid))?;
    }
    let mut items = Vec::new();
    let mut scanned = 0usize;
    loop {
        if &tx.now().await? >= &verified.invocation().deadline {
            return Err(query_error(QueryFailure::BudgetExceeded {
                limit: TruncationReason::Deadline,
            }));
        }
        let rows = tx.query("SELECT task_id,revision FROM (SELECT DISTINCT ON(task_id) task_id,revision,body FROM world_task_revision WHERE tenant_id=$1 AND world_id=$2 AND task_id>$3 ORDER BY task_id,revision DESC) latest WHERE body->>'scope'=$4 ORDER BY task_id LIMIT 128",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after, &query.scope.as_str()]).await?;
        let exhausted = rows.len() < 128;
        for row in rows {
            scanned += 1;
            if scanned > 4096 {
                return Err(query_error(QueryFailure::BudgetExceeded {
                    limit: TruncationReason::Rows,
                }));
            }
            after = row.get("task_id");
            let id =
                TaskId::try_new(after.clone()).map_err(|_| Error::internal(FailureStage::Read))?;
            let revision = u64::try_from(row.get::<_, i64>("revision"))
                .map_err(|_| Error::internal(FailureStage::Read))?;
            let task =
                crate::evaluation::read_task(tx, &id, world_protocol::ids::Revision(revision))
                    .await?;
            if task.scope != query.scope {
                return Err(Error::internal(FailureStage::Read));
            }
            if let Some(summary) = visible(
                tx,
                verified,
                &task,
                (items.len() + 1).min(query.page.limit as usize) as u64,
                now,
            )
            .await?
            {
                if items.len() == query.page.limit as usize {
                    return Ok(Page {
                        next_cursor: items
                            .last()
                            .map(|item: &TaskSummary| item.reference.id.to_string()),
                        items,
                    });
                }
                items.push(summary);
            }
        }
        if exhausted {
            return Ok(Page {
                items,
                next_cursor: None,
            });
        }
    }
}

async fn visible(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    task: &TaskContract,
    delivered: u64,
    now: &Timestamp,
) -> Result<Option<TaskSummary>, Error> {
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::Task {
                id: task.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: task.scope.clone(),
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    let admission = match authorization::admit(tx, verified, &impact, &[], None, now).await {
        Ok(admission) => admission,
        Err(AuthError::Denied(_)) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    authorization::check_output(tx, verified, &admission, &impact, delivered, now).await?;
    Ok(Some(TaskSummary {
        reference: TaskRef {
            world: task.world.clone(),
            id: task.id.clone(),
            revision: task.revision,
        },
        goal: task.goal.clone(),
        scope: task.scope.clone(),
    }))
}
fn query_error(failure: QueryFailure) -> Error {
    Error::new(
        "world.task_directory_unavailable",
        FailureStage::Read,
        "任务目录读取未完成。",
        ApiFailure::Query(failure),
        Recovery::None,
    )
}
