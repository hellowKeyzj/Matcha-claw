use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionFailure, AbstractionRef},
    authorization::{AccessMode, AccessScope, ActualImpact},
    budget::BudgetDimension,
    ids::{AbstractionId, BranchId, ResourceRef, Revision, ScopeId},
    learning::TaskRef,
    query::{Page, PageRequest, QueryFailure},
};
use crate::{authorization::{self, AuthError, VerifiedInvocation}, content::Content, extensions::invocation::CallBudget, store::WorldTransaction};
use super::{basis, Error};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor { task: TaskRef, id: String, revision: Revision }

async fn preflight(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, task: &TaskRef, scope: &ScopeId, branch: Option<&BranchId>,
) -> Result<ActualImpact, Error> {
    let invocation = verified.invocation();
    if task.world != *tx.world() || invocation.world != task.world
        || invocation.task_id.as_ref().is_some_and(|id| id != &task.id)
        || invocation.branch_id.as_ref().is_some_and(|id| Some(id) != branch) {
        return Err(AuthError::from(world_protocol::authorization::AuthorizationFailure::InsufficientScope).into());
    }
    let mut resources = vec![ResourceRef::Task { id: task.id.clone() }];
    resources.extend(branch.map(|id| ResourceRef::Branch { id: id.clone() }));
    let impact = authorization::actual_impact(vec![AccessScope { resources, fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
    authorization::check_impact_read(tx, verified, &impact, &tx.now().await?).await?;
    Ok(impact)
}

pub(crate) async fn read_authorized(
    tx: &WorldTransaction<'_>, content: &Content, verified: &VerifiedInvocation, reference: &AbstractionRef,
) -> Result<Option<AbstractionContract>, Error> {
    if content.world() != tx.world() { return Err(AbstractionFailure::BasisChanged.into()); }
    read_current(tx, verified, reference).await
}

async fn read_current(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, reference: &AbstractionRef,
) -> Result<Option<AbstractionContract>, Error> {
    if reference.world != *tx.world() { return Err(AbstractionFailure::BasisChanged.into()); }
    let world = tx.world();
    let row = tx.query_opt("SELECT task_id,task_revision,scope_id,branch_id FROM world_abstraction_revision WHERE tenant_id=$1 AND world_id=$2 AND abstraction_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &super::number(reference.revision)?]).await?;
    let Some(row) = row else { return Ok(None); };
    let task = TaskRef { world: world.clone(), id: world_protocol::ids::TaskId::try_new(row.get::<_, String>("task_id")).map_err(|_| AbstractionFailure::InternalFault)?, revision: revision(row.get("task_revision"))? };
    let scope = ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|_| AbstractionFailure::InternalFault)?;
    let branch = row.get::<_, Option<String>>("branch_id").map(BranchId::try_new).transpose().map_err(|_| AbstractionFailure::InternalFault)?;
    match preflight(tx, verified, &task, &scope, branch.as_ref()).await {
        Ok(_) => {}, Err(Error::Authorization(AuthError::Denied(_))) => return Ok(None), Err(error) => return Err(error),
    }
    let contract = super::read(tx, &reference.id, reference.revision).await?.ok_or(AbstractionFailure::BasisChanged)?;
    match current(tx, verified, &contract).await {
        Ok(_) => Ok(Some(contract)),
        Err(Error::Authorization(AuthError::Denied(_))) | Err(Error::Rejected(AbstractionFailure::BasisChanged)) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Reads the original immutable store; filtering precedes the caller-visible page and cursor.
pub(crate) async fn list_authorized(
    tx: &WorldTransaction<'_>, content: &Content, verified: &VerifiedInvocation, task: &TaskRef,
    page: &PageRequest, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<Page<AbstractionContract>, Error> {
    if content.world() != tx.world() { return Err(AbstractionFailure::BasisChanged.into()); }
    list_current(tx, verified, task, page, budget, cancel).await
}

async fn list_current(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, task: &TaskRef,
    page: &PageRequest, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<Page<AbstractionContract>, Error> {
    if task.world != *tx.world() || page.limit == 0 || page.limit > world_protocol::api::MAX_PAGE_ITEMS {
        return Err(crate::query::QueryError::from(QueryFailure::CursorInvalid).into());
    }
    let cursor: Cursor = match &page.cursor {
        Some(value) => serde_json::from_str(value).map_err(|_| crate::query::QueryError::from(QueryFailure::CursorInvalid))?,
        None => Cursor { task: task.clone(), id: String::new(), revision: Revision(0) },
    };
    if cursor.task != *task || (!cursor.id.is_empty() && cursor.revision.0 == 0) { return Err(crate::query::QueryError::from(QueryFailure::CursorInvalid).into()); }
    let world = tx.world();
    let row = tx.query_opt("SELECT scope_id FROM world_task_revision WHERE tenant_id=$1 AND world_id=$2 AND task_id=$3 AND revision=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &task.id.as_str(), &super::number(task.revision)?]).await?;
    let Some(row) = row else { return Ok(Page { items: Vec::new(), next_cursor: None }); };
    let scope = ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|_| AbstractionFailure::InternalFault)?;
    let task_impact = preflight(tx, verified, task, &scope, verified.invocation().branch_id.as_ref()).await?;
    let durable_task = crate::evaluation::read_task(tx, &task.id, task.revision).await?;
    if durable_task.scope != scope { return Err(AbstractionFailure::BasisChanged.into()); }
    let mut after = (cursor.id, i64::try_from(cursor.revision.0).map_err(|_| AbstractionFailure::BasisChanged)?);
    let mut items = Vec::new();
    loop {
        check(budget, cancel)?;
        let rows = tx.query("SELECT abstraction_id,revision FROM world_abstraction_revision WHERE tenant_id=$1 AND world_id=$2 AND task_id=$3 AND task_revision=$4 AND (abstraction_id,revision)>($5,$6) ORDER BY abstraction_id,revision LIMIT 128",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &task.id.as_str(), &super::number(task.revision)?, &after.0, &after.1]).await?;
        if rows.is_empty() { break; }
        for row in rows {
            check(budget, cancel)?;
            budget.charge(BudgetDimension::Steps, 1).map_err(|_| AbstractionFailure::BudgetExceeded)?;
            after = (row.get("abstraction_id"), row.get("revision"));
            let reference = AbstractionRef { world: world.clone(), id: AbstractionId::try_new(&after.0).map_err(|_| AbstractionFailure::InternalFault)?, revision: revision(after.1)? };
            if let Some(contract) = read_current(tx, verified, &reference).await? { items.push(contract); }
            if items.len() > page.limit as usize { break; }
        }
        if items.len() > page.limit as usize { break; }
    }
    let next_cursor = if items.len() > page.limit as usize {
        items.pop();
        let last = items.last().ok_or(AbstractionFailure::InternalFault)?;
        Some(serde_json::to_string(&Cursor { task: task.clone(), id: last.id.to_string(), revision: last.revision }).map_err(|_| AbstractionFailure::InternalFault)?)
    } else { None };
    let mut impacts = vec![task_impact];
    for contract in &items { impacts.push(current(tx, verified, contract).await?); }
    let impact = authorization::actual_impact(impacts.iter().flat_map(|i| i.access.clone()).collect(), Vec::new(), impacts.iter().flat_map(|i| i.labels.clone()).collect(), impacts.iter().flat_map(|i| i.state.clone()).collect(), impacts.iter().flat_map(|i| i.source_ids.clone()).collect())?;
    authorization::check_impact_read_output(tx, verified, &impact, items.len() as u64, &tx.now().await?).await?;
    Ok(Page { items, next_cursor })
}

pub(crate) async fn recall(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, task: &world_protocol::learning::TaskContract,
    page: &world_protocol::query::QueryPage, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<Vec<AbstractionContract>, Error> {
    let task_ref = TaskRef { world: task.world.clone(), id: task.id.clone(), revision: task.revision };
    let mut request = PageRequest { limit: world_protocol::api::MAX_PAGE_ITEMS, cursor: None };
    let mut contracts = Vec::new();
    loop {
        let candidates = list_current(tx, verified, &task_ref, &request, budget, cancel).await?;
        for contract in candidates.items {
            match recalled(tx, verified, task, page, &contract, Some(budget), cancel).await {
                Ok(Some(_)) => contracts.push(contract), Ok(None) => {},
                Err(Error::Authorization(AuthError::Denied(_))) | Err(Error::Rejected(AbstractionFailure::BasisChanged)) => {},
                Err(error) => return Err(error),
            }
        }
        match candidates.next_cursor { Some(cursor) => request.cursor = Some(cursor), None => break }
    }
    Ok(contracts)
}

pub(crate) async fn recalled(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, task: &world_protocol::learning::TaskContract,
    page: &world_protocol::query::QueryPage, contract: &AbstractionContract, budget: Option<&CallBudget>, cancel: &CancellationToken,
) -> Result<Option<ActualImpact>, Error> {
    if contract.world != task.world || contract.task_id != task.id || contract.task_revision != task.revision
        || contract.base_release != page.receipt.release_id || contract.branch.as_ref().map(|b| &b.id) != page.receipt.branch_id.as_ref() {
        return Ok(None);
    }
    if super::read(tx, &contract.id, contract.revision).await?.as_ref() != Some(contract) { return Err(AbstractionFailure::BasisChanged.into()); }
    let basis = basis::load_read(tx, verified, contract).await?;
    if basis.task != *task || !basis.current { return Ok(None); }
    let checked = super::check::contract(contract, &basis.definitions, &basis.scopes)?;
    let (_, _, truth) = super::resolve::mapped_parameters(tx, contract, &basis, &checked, page, basis.current, &tx.now().await?, budget, cancel).await?;
    if truth != world_protocol::expression::TruthValue::True { return Ok(None); }
    authorization::check_impact_read_output(tx, verified, &basis.impact, 1, &tx.now().await?).await?;
    Ok(Some(basis.impact))
}

pub(super) async fn current(tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, contract: &AbstractionContract) -> Result<ActualImpact, Error> {
    let basis = basis::load_read(tx, verified, contract).await?;
    super::check::contract(contract, &basis.definitions, &basis.scopes)?;
    if !basis.current { return Err(AbstractionFailure::BasisChanged.into()); }
    authorization::check_impact_read_output(tx, verified, &basis.impact, 1, &tx.now().await?).await?;
    Ok(basis.impact)
}
fn check(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), Error> {
    if cancel.is_cancelled() { return Err(AbstractionFailure::Cancelled.into()); }
    budget.check().map_err(|_| AbstractionFailure::BudgetExceeded.into())
}
fn revision(value: i64) -> Result<Revision, Error> {
    u64::try_from(value).ok().filter(|value| *value > 0).map(Revision).ok_or_else(|| AbstractionFailure::InternalFault.into())
}
