mod bounded;
mod prepared;
mod recall;

pub(crate) use prepared::PreparedContext;

use std::collections::{BTreeMap, BTreeSet};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::ContextFailure,
    authorization::{AccessMode, AccessScope, ActualImpact},
    definitions::DefinitionBody,
    expression::Effect,
    ids::{DefinitionRef, ResourceRef},
    learning::TaskContract,
    query::QueryPage,
    releases::Release,
    slots::{ContextRequest, ContextResult},
    time::Timestamp,
};
use crate::{
    authorization::{self, Admission}, extensions::invocation::CallBudget,
    store::{StoreFuture, WorldTransaction},
};

pub(crate) enum Error {
    Rejected(ContextFailure),
    Store(crate::store::StoreError),
    Authorization(crate::authorization::AuthError),
    Query(crate::query::QueryError),
    Evaluation(crate::evaluation::Error),
    Release(crate::releases::Error),
    Domain(Box<crate::owner::Error>),
}
impl From<ContextFailure> for Error { fn from(value: ContextFailure) -> Self { Self::Rejected(value) } }
impl From<crate::store::StoreError> for Error { fn from(value: crate::store::StoreError) -> Self { Self::Store(value) } }
impl From<crate::authorization::AuthError> for Error { fn from(value: crate::authorization::AuthError) -> Self { Self::Authorization(value) } }
impl From<crate::query::QueryError> for Error { fn from(value: crate::query::QueryError) -> Self { Self::Query(value) } }
impl From<crate::evaluation::Error> for Error { fn from(value: crate::evaluation::Error) -> Self { Self::Evaluation(value) } }
impl From<crate::releases::Error> for Error { fn from(value: crate::releases::Error) -> Self { Self::Release(value) } }
impl From<crate::owner::Error> for Error { fn from(value: crate::owner::Error) -> Self { Self::Domain(Box::new(value)) } }
impl std::fmt::Debug for Error { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { std::fmt::Display::fmt(self, f) } }
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(_) => f.write_str("world.context_rejected"), Self::Store(error) => error.fmt(f),
            Self::Authorization(error) => error.fmt(f), Self::Query(error) => error.fmt(f), Self::Evaluation(error) => error.fmt(f), Self::Release(error) => error.fmt(f), Self::Domain(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self { Self::Store(error) => Some(error), Self::Authorization(error) => Some(error), Self::Query(error) => Some(error), Self::Evaluation(error) => Some(error), Self::Release(error) => Some(error), Self::Domain(error) => Some(error.as_ref()), _ => None }
    }
}
impl From<Error> for crate::owner::Error {
    fn from(error: Error) -> Self {
        match error {
            Error::Store(error) => error.into(), Error::Authorization(error) => error.into(),
            Error::Query(error) => error.into(), Error::Evaluation(error) => error.into(), Error::Release(error) => error.into(), Error::Domain(error) => *error,
            Error::Rejected(reason) => Self::from_host_failure(
                world_protocol::process::HostFailure::Slot(world_protocol::slots::SlotFailure::Context(reason)),
                world_protocol::failure::FailureStage::Validate,
            ),
        }
    }
}

fn task_impact(request: &ContextRequest) -> Result<ActualImpact, Error> {
    Ok(authorization::actual_impact(vec![AccessScope {
        resources: vec![ResourceRef::Task { id: request.task.id.clone() }], fields: Vec::new(),
        modes: vec![AccessMode::Read], scope: request.task.scope.clone(), valid_time: None,
    }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new())?)
}

/// Includes definition summaries before recall; a later output check cannot widen this admission.
pub(crate) async fn impact(tx: &WorldTransaction<'_>, request: &ContextRequest) -> Result<ActualImpact, Error> {
    if request.world != *tx.world() || request.task.world != request.world || request.query.world != request.world {
        return Err(ContextFailure::InvalidTask.into());
    }
    let id = match &request.query.release_id {
        Some(id) => id.clone(),
        None => match &request.query.branch_id {
            Some(id) => crate::releases::read_branch(tx, id).await?.ok_or(ContextFailure::BasisChanged)?.basis.release_id,
            None => crate::releases::read_active_release(tx).await?.ok_or(ContextFailure::BasisChanged)?,
        },
    };
    let release = crate::query::support_model(tx, &id, request.query.branch_id.as_ref()).await?;
    let mut impact = crate::query::impact_in_transaction(tx, &request.query, &request.task.scope).await?;
    let task = task_impact(request)?;
    impact.access.extend(task.access); impact.effects.extend(task.effects);
    let (_, impact) = definitions(tx, request, &release, impact, Vec::new(), None).await?;
    Ok(impact)
}

/// The request copy cannot replace a durable task or its hard constraints.
async fn check_task(
    tx: &WorldTransaction<'_>, admission: &Admission, request: &ContextRequest,
    now: &Timestamp, cancellation: &CancellationToken,
) -> Result<TaskContract, Error> {
    if cancellation.is_cancelled() { return Err(ContextFailure::Cancelled.into()); }
    if request.world != *tx.world() || request.task.world != request.world || request.query.world != request.world
        || admission.invocation().world != request.world
        || admission.invocation().task_id.as_ref().is_some_and(|id| id != &request.task.id)
        || request.query.branch_id != admission.invocation().branch_id {
        return Err(ContextFailure::InvalidTask.into());
    }
    admission.require_access(&task_impact(request)?)?;
    authorization::recheck(tx, admission, now).await?;
    let task = crate::evaluation::read_task(tx, &request.task.id, request.task.revision).await?;
    if task != request.task { return Err(ContextFailure::BasisChanged.into()); }
    crate::evaluation::validate_task(&task).map_err(crate::evaluation::Error::from)?;
    Ok(task)
}

/// Reuses the owner's committed page and original receipt. No query execution or source I/O occurs here.
pub(crate) async fn from_page(
    tx: &WorldTransaction<'_>, admission: &Admission, request: &ContextRequest, page: QueryPage,
    budget: &CallBudget, cancellation: &CancellationToken,
) -> Result<ContextResult, Error> {
    let now = tx.now().await?;
    let task = check_task(tx, admission, request, &now, cancellation).await?;
    budget.restrict(&task.budget, &now).map_err(|_| ContextFailure::BudgetExceeded)?;
    budget.restrict(&request.budget, &now).map_err(|_| ContextFailure::BudgetExceeded)?;
    let (release, impact) = crate::query::recheck_page_in_transaction(tx, admission, &request.query, &task.scope, &page).await?;
    let references = page_definitions(&release, &page)?;
    let (definitions, impact) = definitions(tx, request, &release, impact, references, Some((budget, cancellation))).await?;
    admission.require_access(&impact)?;
    let recalled = recall::collect(tx, admission, &task, &release, &page, budget, cancellation).await?;
    let result = bounded::assemble(&task, page.clone(), definitions, recalled, impact.labels.clone(), &request.budget, budget, cancellation)?;
    check_result(request, &page, &result)?;
    let recalled = recall::recheck(tx, admission, &task, &release, &page, &result.view, cancellation).await?;
    check_recalled_output(tx, admission, &impact, recalled, &result.view).await?;
    let delivered = (result.view.rows.len() + result.view.objects.len() + result.view.relations.len() + result.view.definitions.len()) as u64;
    authorization::check_admitted_output(tx, admission, &impact, delivered, &tx.now().await?).await?;
    Ok(result)
}

/// A replacement may select any committed occurrences, but cannot rewrite task facts or read custody.
pub(crate) fn check_result(
    request: &ContextRequest, page: &QueryPage, result: &ContextResult,
) -> Result<(), Error> {
    let task = &request.task;
    let view = &result.view;
    if request.world != task.world || request.query.world != task.world || page.receipt.world != task.world
        || view.world != task.world || view.task_id != task.id || view.task_revision != task.revision
        || view.scope != task.scope || view.goal != task.goal || view.hard_constraints != task.hard_constraints
        || view.allowed_effects != task.allowed_effects || view.stop_conditions != task.stop_conditions
        || result.receipt != page.receipt || view.read_receipts != [page.receipt.clone()]
        || view.actions.iter().any(|proposal| proposal.request.world != task.world || proposal.request.action.world != task.world)
        || view.actions.iter().map(|proposal| &proposal.id).collect::<BTreeSet<_>>().len() != view.actions.len()
        || view.abstractions.iter().any(|contract| contract.world != task.world || contract.task_id != task.id || contract.task_revision != task.revision)
        || view.abstractions.iter().map(|contract| (&contract.id, contract.revision)).collect::<BTreeSet<_>>().len() != view.abstractions.len()
        || view.untrusted_material.iter().map(|blob| &blob.digest).collect::<BTreeSet<_>>().len() != view.untrusted_material.len()
        || !committed_subset(&view.rows, &page.rows.items) || !committed_subset(&view.objects, &page.objects)
        || !committed_subset(&view.relations, &page.relations)
        || view.definitions.iter().any(|reference| reference.world != task.world)
        || view.definitions.iter().collect::<BTreeSet<_>>().len() != view.definitions.len()
        || view.labels.iter().collect::<BTreeSet<_>>().len() != view.labels.len() {
        return Err(ContextFailure::BasisChanged.into());
    }
    let base_count = (view.rows.len() + view.objects.len() + view.relations.len()) as u64;
    let count = item_count(view);
    let total = (page.rows.items.len() + page.objects.len() + page.relations.len()) as u64;
    let rows = request.budget.max_rows.min(task.budget.max_rows);
    let bytes = request.budget.max_bytes.min(task.budget.max_bytes);
    let tokens = request.budget.max_input_tokens.min(task.budget.max_input_tokens);
    let size = world_protocol::wire::encode(view, usize::MAX).map_err(|_| ContextFailure::InternalFault)?.len() as u64;
    if count > rows || size > bytes.min(tokens) { return Err(ContextFailure::BudgetExceeded.into()); }
    let original = page.receipt.truncation.clone().or_else(|| page.rows.next_cursor.as_ref().map(|_| world_protocol::query::Truncation {
        reason: world_protocol::query::TruncationReason::Rows,
        delivered: page.rows.items.len() as u64, limit: page.rows.items.len() as u64,
    }));
    if base_count != total || view.truncation != original {
        let truncation = view.truncation.as_ref().ok_or(ContextFailure::BasisChanged)?;
        use world_protocol::query::TruncationReason;
        let valid = truncation.delivered == count && match truncation.reason {
            TruncationReason::Rows | TruncationReason::Objects => count <= truncation.limit && truncation.limit <= rows,
            TruncationReason::Bytes => size <= truncation.limit && truncation.limit <= bytes,
            TruncationReason::Tokens => size <= truncation.limit && truncation.limit <= tokens,
            TruncationReason::Deadline => false,
        };
        if !valid { return Err(ContextFailure::BasisChanged.into()); }
    }
    Ok(())
}

/// Rechecks a selected result against current authority without rebuilding or charging for the algorithm.
pub(crate) fn recheck_result<'a>(
    tx: &'a WorldTransaction<'_>, admission: &'a Admission, request: &'a ContextRequest, page: &'a QueryPage,
    result: &'a ContextResult, cancellation: &'a CancellationToken,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        check_result(request, page, result)?;
        let task = check_task(tx, admission, request, &tx.now().await?, cancellation).await?;
        let (release, impact) = crate::query::recheck_page_in_transaction(tx, admission, &request.query, &task.scope, page).await?;
        let references = page_definitions(&release, page)?;
        let (allowed, impact) = definitions(tx, request, &release, impact, references, None).await?;
        if cancellation.is_cancelled() { return Err(ContextFailure::Cancelled.into()); }
        if result.view.definitions.iter().any(|reference| !allowed.contains(reference))
            || impact.labels.iter().any(|label| !result.view.labels.contains(label)) {
            return Err(ContextFailure::BasisChanged.into());
        }
        let recalled = recall::recheck(tx, admission, &task, &release, page, &result.view, cancellation).await?;
        let impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
        check_recalled_output(tx, admission, &impact, recalled, &result.view).await?;
        admission.require_access(&impact)?;
        let delivered = (result.view.rows.len() + result.view.objects.len() + result.view.relations.len() + result.view.definitions.len()) as u64;
        authorization::check_admitted_output(tx, admission, &impact, delivered, &tx.now().await?).await?;
        Ok(())
    })
}

fn item_count(view: &world_protocol::abstraction::WorldView) -> u64 {
    (view.rows.len() + view.objects.len() + view.relations.len() + view.actions.len() + view.abstractions.len() + view.untrusted_material.len()) as u64
}

async fn check_recalled_output(
    tx: &WorldTransaction<'_>, admission: &Admission, base: &ActualImpact, recalled: ActualImpact,
    view: &world_protocol::abstraction::WorldView,
) -> Result<(), Error> {
    let impact = authorization::actual_impact(base.access.iter().chain(&recalled.access).cloned().collect(), Vec::new(), view.labels.clone(),
        base.state.iter().chain(&recalled.state).cloned().collect(), base.source_ids.iter().chain(&recalled.source_ids).cloned().collect())?;
    authorization::check_impact_read_output(tx, admission.verified(), &impact, item_count(view) + view.definitions.len() as u64, &tx.now().await?).await?;
    Ok(())
}

fn committed_subset<T: PartialEq>(selected: &[T], committed: &[T]) -> bool {
    let mut used = vec![false; committed.len()];
    selected.iter().all(|item| {
        let Some(index) = committed.iter().enumerate().position(|(index, original)| !used[index] && item == original) else { return false; };
        used[index] = true;
        true
    })
}

fn page_definitions(release: &Release, page: &QueryPage) -> Result<Vec<DefinitionRef>, Error> {
    let mut references: Vec<_> = page.receipt.actual_dependencies.iter().filter_map(|dependency| {
        if let world_protocol::provenance::ReadDependency::Definition { reference } = dependency { Some(reference.clone()) } else { None }
    }).collect();
    for type_id in page.objects.iter().map(|view| &view.object.type_id).chain(page.relations.iter().map(|view| &view.relation.type_id)) {
        let definition = release.definitions.iter().find(|definition| &definition.reference.id == type_id).ok_or(ContextFailure::BasisChanged)?;
        references.push(definition.reference.clone());
    }
    Ok(references)
}

async fn definitions(
    tx: &WorldTransaction<'_>, request: &ContextRequest, release: &Release, mut impact: ActualImpact,
    mut references: Vec<DefinitionRef>, accounting: Option<(&CallBudget, &CancellationToken)>,
) -> Result<(Vec<DefinitionRef>, ActualImpact), Error> {
    references.extend(crate::definitions::query_references(&request.query.query));
    references.extend(impact.access.iter().flat_map(|access| access.fields.iter().cloned()));
    let index: BTreeMap<_, _> = release.definitions.iter().map(|definition| (&definition.reference, definition)).collect();
    let mut complete = BTreeSet::new();
    while let Some(reference) = references.pop() {
        if !complete.insert(reference.clone()) { continue; }
        if let Some((budget, cancellation)) = accounting {
            if cancellation.is_cancelled() { return Err(ContextFailure::Cancelled.into()); }
            budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|_| ContextFailure::BudgetExceeded)?;
        }
        let definition = index.get(&reference).ok_or(ContextFailure::BasisChanged)?;
        references.extend(definition.dependencies.clone());
        references.extend(crate::definitions::definition_references(&definition.body));
        if let DefinitionBody::Property(property) = &definition.body { impact.labels.extend(property.access_labels.clone()); }
        impact.access.push(AccessScope { resources: vec![ResourceRef::Definition { id: reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: definition.scope.clone(), valid_time: None });
        if let Some(current) = crate::definitions::read_definition_head(tx, &reference.id).await? {
            if current.body.kind() != definition.body.kind() { return Err(ContextFailure::BasisChanged.into()); }
            if let DefinitionBody::Property(property) = &current.body { impact.labels.extend(property.access_labels.clone()); }
            impact.access.push(AccessScope { resources: vec![ResourceRef::Definition { id: reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: current.scope, valid_time: None });
        }
    }
    let impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
    Ok((complete.into_iter().collect(), impact))
}
