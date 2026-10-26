use crate::{
    authorization::{self, VerifiedInvocation},
    owner,
    store::WorldTransaction,
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    api::{BranchView, DefinitionQuery, DefinitionsQuery, ListQuery, ReleaseView},
    authorization::{AccessMode, AccessScope, ActualImpact},
    definitions::{Definition, DefinitionBody},
    failure::{FailureStage, FieldPath, Recovery},
    ids::{BranchId, DefinitionId, ReleaseId, ResourceRef, WorldRef},
    query::{Page, PageRequest, QueryFailure, TruncationReason},
    time::Timestamp,
};

use super::{Error, read::invalid};
type Model = Definition<DefinitionBody>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    world: WorldRef,
    directory: String,
    basis: String,
    after: String,
}

pub(crate) async fn directory_impact(
    tx: &WorldTransaction<'_>,
) -> Result<ActualImpact, owner::Error> {
    let head = super::read_active_head(tx)
        .await?
        .ok_or_else(|| invalid("activeRelease"))?;
    let release = super::read_release(tx, &head.release_id)
        .await?
        .ok_or_else(|| invalid("release"))?;
    Ok(authorization::actual_impact(
        release
            .scopes
            .iter()
            .map(|scope| AccessScope {
                resources: vec![ResourceRef::Head {
                    channel: head.channel.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: scope.id.clone(),
                valid_time: None,
            })
            .collect(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?)
}

pub(crate) async fn list_definitions(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &DefinitionsQuery,
    _now: &Timestamp,
) -> Result<Page<Model>, owner::Error> {
    let release = super::read_active_model(tx)
        .await?
        .ok_or_else(|| invalid("activeRelease"))?;
    let basis = crate::definitions::canonical_digest(&(&release.id, query.kind))?.to_string();
    let after = page_start(tx.world(), "definitions", &basis, &query.page)?;
    if !after.is_empty() {
        DefinitionId::try_new(after.clone())
            .map_err(|_| query_error(QueryFailure::CursorInvalid))?;
    }
    let mut definitions: Vec<_> = release
        .definitions
        .into_iter()
        .filter(|definition| {
            definition.reference.id.as_str() > after.as_str()
                && query.kind.is_none_or(|kind| definition.body.kind() == kind)
        })
        .collect();
    definitions.sort_by(|left, right| left.reference.id.cmp(&right.reference.id));
    let mut items = Vec::new();
    for (scanned, definition) in definitions.into_iter().enumerate() {
        check_budget(tx, verified, scanned).await?;
        let impact = super::model_impact(
            tx,
            std::slice::from_ref(&definition),
            Vec::new(),
            &[AccessMode::Read],
        )
        .await?;
        if !visible(
            tx,
            verified,
            &impact,
            (items.len() + 1).min(query.page.limit as usize) as u64,
        )
        .await?
        {
            continue;
        }
        if items.len() == query.page.limit as usize {
            return Ok(Page {
                next_cursor: Some(cursor(
                    tx.world(),
                    "definitions",
                    &basis,
                    items
                        .last()
                        .map(|item: &Model| item.reference.id.as_str())
                        .ok_or_else(|| invalid("cursor"))?,
                )?),
                items,
            });
        }
        items.push(definition);
    }
    Ok(Page {
        items,
        next_cursor: None,
    })
}

pub(crate) async fn definition(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &DefinitionQuery,
    _now: &Timestamp,
) -> Result<Option<Model>, owner::Error> {
    let reference = &query.reference;
    if &reference.world != tx.world() || reference.revision.0 == 0 {
        return Err(invalid("reference").into());
    }
    check_budget(tx, verified, 0).await?;
    let Some(historical) = super::read::read_definition_history(tx, reference).await? else {
        return Ok(None);
    };
    let model = historical.definition;
    if let super::read::DefinitionCarrier::Branches(references) = historical.carrier {
        for (scanned, reference) in references.into_iter().enumerate() {
            check_budget(tx, verified, scanned).await?;
            let branch = super::read_branch_revision(tx, &reference)
                .await?
                .ok_or_else(|| invalid("branch"))?;
            let task =
                crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
            let model = branch
                .compile
                .definitions
                .into_iter()
                .find(|definition| definition.reference == query.reference)
                .ok_or_else(|| invalid("definitionIndex"))?;
            let impact = super::model_impact(
                tx,
                std::slice::from_ref(&model),
                vec![AccessScope {
                    resources: vec![ResourceRef::Branch { id: reference.id }],
                    fields: Vec::new(),
                    modes: vec![AccessMode::Read],
                    scope: task.scope,
                    valid_time: None,
                }],
                &[AccessMode::Read],
            )
            .await?;
            if visible(tx, verified, &impact, 1).await? {
                return Ok(Some(model));
            }
        }
        return Ok(None);
    }
    let impact = super::model_impact(
        tx,
        std::slice::from_ref(&model),
        Vec::new(),
        &[AccessMode::Read],
    )
    .await?;
    if !visible(tx, verified, &impact, 1).await? {
        return Ok(None);
    }
    Ok(Some(model))
}

pub(crate) async fn list_branches(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &ListQuery,
    _now: &Timestamp,
) -> Result<Page<BranchView>, owner::Error> {
    let mut after = page_start(tx.world(), "branches", "current", &query.page)?;
    if !after.is_empty() {
        BranchId::try_new(after.clone()).map_err(|_| query_error(QueryFailure::CursorInvalid))?;
    }
    let mut items = Vec::new();
    let mut scanned = 0;
    loop {
        let rows = tx.query("SELECT branch_id FROM world_branch_head WHERE tenant_id=$1 AND world_id=$2 AND branch_id>$3 ORDER BY branch_id LIMIT 128",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
        let exhausted = rows.len() < 128;
        for row in rows {
            check_budget(tx, verified, scanned).await?;
            scanned += 1;
            after = row.get("branch_id");
            let id = BranchId::try_new(after.clone()).map_err(|_| invalid("branchId"))?;
            let branch = super::read_branch(tx, &id)
                .await?
                .ok_or_else(|| invalid("branch"))?;
            let impact = crate::learning::candidate_read_impact(tx, &branch.candidate_id).await?;
            if !visible(
                tx,
                verified,
                &impact,
                (items.len() + 1).min(query.page.limit as usize) as u64,
            )
            .await?
            {
                continue;
            }
            if items.len() == query.page.limit as usize {
                return Ok(Page {
                    next_cursor: Some(cursor(
                        tx.world(),
                        "branches",
                        "current",
                        items
                            .last()
                            .map(|item: &BranchView| item.id.as_str())
                            .ok_or_else(|| invalid("cursor"))?,
                    )?),
                    items,
                });
            }
            items.push(BranchView {
                id: branch.id,
                revision: branch.revision,
                base_release: branch.basis.release_id.clone(),
                basis: branch.basis,
            });
        }
        if exhausted {
            return Ok(Page {
                items,
                next_cursor: None,
            });
        }
    }
}

pub(crate) async fn list_releases(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &ListQuery,
    _now: &Timestamp,
) -> Result<Page<ReleaseView>, owner::Error> {
    let mut after = page_start(tx.world(), "releases", "immutable", &query.page)?;
    if !after.is_empty() {
        ReleaseId::try_new(after.clone()).map_err(|_| query_error(QueryFailure::CursorInvalid))?;
    }
    let mut items = Vec::new();
    let mut scanned = 0;
    loop {
        let rows = tx.query("SELECT release_id FROM world_release WHERE tenant_id=$1 AND world_id=$2 AND release_id>$3 ORDER BY release_id LIMIT 128",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
        let exhausted = rows.len() < 128;
        for row in rows {
            check_budget(tx, verified, scanned).await?;
            scanned += 1;
            after = row.get("release_id");
            let id = ReleaseId::try_new(after.clone()).map_err(|_| invalid("releaseId"))?;
            let release = super::read_release(tx, &id)
                .await?
                .ok_or_else(|| invalid("release"))?;
            let access = match &release.source_branch {
                Some(reference) => {
                    let scope = super::release_scope(tx, &release).await?;
                    vec![AccessScope {
                        resources: vec![ResourceRef::Branch {
                            id: reference.id.clone(),
                        }],
                        fields: Vec::new(),
                        modes: vec![AccessMode::Read],
                        scope,
                        valid_time: None,
                    }]
                }
                None => directory_impact(tx).await?.access,
            };
            let impact =
                super::model_impact(tx, &release.definitions, access, &[AccessMode::Read]).await?;
            if !visible(
                tx,
                verified,
                &impact,
                (items.len() + 1).min(query.page.limit as usize) as u64,
            )
            .await?
            {
                continue;
            }
            if items.len() == query.page.limit as usize {
                return Ok(Page {
                    next_cursor: Some(cursor(
                        tx.world(),
                        "releases",
                        "immutable",
                        items
                            .last()
                            .map(|item: &ReleaseView| item.id.as_str())
                            .ok_or_else(|| invalid("cursor"))?,
                    )?),
                    items,
                });
            }
            items.push(ReleaseView {
                id: release.id,
                artifact_id: release.artifact.id,
                activation_lock_id: release.artifact.activation_lock_id,
                published_at: release.published_at,
                previous: release.parent,
            });
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
    impact: &ActualImpact,
    delivered: u64,
) -> Result<bool, owner::Error> {
    let now = tx.now().await?;
    let admission = match authorization::admit(tx, verified, impact, &[], None, &now).await {
        Ok(admission) => admission,
        Err(authorization::AuthError::Denied(_)) => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    authorization::check_admitted_output(tx, &admission, impact, delivered, &tx.now().await?)
        .await?;
    Ok(true)
}

fn page_start(
    world: &WorldRef,
    directory: &str,
    basis: &str,
    page: &PageRequest,
) -> Result<String, owner::Error> {
    if page.limit == 0 || page.limit > world_protocol::api::MAX_PAGE_ITEMS {
        return Err(query_error(QueryFailure::InvalidQuery {
            field: FieldPath(vec!["page".into()]),
        }));
    }
    let Some(value) = &page.cursor else {
        return Ok(String::new());
    };
    let cursor: Cursor =
        serde_json::from_str(value).map_err(|_| query_error(QueryFailure::CursorInvalid))?;
    if &cursor.world != world || cursor.directory != directory || cursor.basis != basis {
        return Err(query_error(QueryFailure::CursorInvalid));
    }
    Ok(cursor.after)
}

fn cursor(
    world: &WorldRef,
    directory: &str,
    basis: &str,
    after: &str,
) -> Result<String, owner::Error> {
    serde_json::to_string(&Cursor {
        world: world.clone(),
        directory: directory.into(),
        basis: basis.into(),
        after: after.into(),
    })
    .map_err(|cause| owner::Error::internal(FailureStage::Read).caused(cause))
}

async fn check_budget(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    scanned: usize,
) -> Result<(), owner::Error> {
    if scanned >= 4096 {
        return Err(query_error(QueryFailure::BudgetExceeded {
            limit: TruncationReason::Rows,
        }));
    }
    if tx.now().await? >= verified.invocation().deadline {
        return Err(query_error(QueryFailure::BudgetExceeded {
            limit: TruncationReason::Deadline,
        }));
    }
    Ok(())
}

fn query_error(failure: QueryFailure) -> owner::Error {
    owner::Error::new(
        "world.model_directory_unavailable",
        FailureStage::Read,
        "模型目录读取未完成。",
        world_protocol::api::ApiFailure::Query(failure),
        Recovery::None,
    )
}
