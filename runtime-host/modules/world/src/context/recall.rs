use world_protocol::{
    abstraction::{AbstractionContract, ContextFailure, WorldView},
    actions::{ActionFailure, ActionProposal},
    api::ApiFailure,
    authorization::{AccessMode, AccessScope, ActualImpact},
    budget::BudgetDimension,
    definitions::DefinitionBody,
    ids::{CandidateId, EvidenceRef, ResourceRef},
    identity::SubjectRef,
    learning::TaskContract,
    materials::{BlobRef, MaterialFailure},
    operation::OperationFailure,
    provenance::ReadDependency,
    query::QueryPage,
    releases::Release,
};
use tokio_util::sync::CancellationToken;
use crate::{authorization::{self, Admission}, extensions::invocation::CallBudget, store::WorldTransaction};
use super::Error;

pub(super) struct Recalled {
    pub actions: Vec<ActionProposal>,
    pub abstractions: Vec<AbstractionContract>,
    pub materials: Vec<BlobRef>,
    pub labels: Vec<String>,
}

pub(super) async fn collect(
    tx: &WorldTransaction<'_>, admission: &Admission, task: &TaskContract, release: &Release,
    page: &QueryPage, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<Recalled, Error> {
    let mut recalled = Recalled { actions: Vec::new(), abstractions: Vec::new(), materials: Vec::new(), labels: Vec::new() };
    let world = tx.world();
    let mut after = String::new();
    loop {
        tick(budget, cancel)?;
        let rows = tx.query("SELECT proposal_id FROM world_action_proposal WHERE tenant_id=$1 AND world_id=$2 AND branch_id IS NOT DISTINCT FROM $3 AND proposal_id>$4 AND status='proposed' AND expires_at>transaction_timestamp() ORDER BY proposal_id LIMIT 128",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &page.receipt.branch_id.as_ref().map(|id| id.as_str()), &after]).await?;
        if rows.is_empty() { break; }
        for row in rows {
            tick(budget, cancel)?;
            after = row.get("proposal_id");
            let id = CandidateId::try_new(&after).map_err(|_| ContextFailure::InternalFault)?;
            match crate::actions::require_proposal_read(tx, admission.verified(), &id, &tx.now().await?).await {
                Ok((proposal, context, impact)) => {
                    if eligible_action(&proposal, &context, task, release, page)? {
                        recalled.labels.extend(impact.labels);
                        recalled.actions.push(proposal);
                    }
                },
                Err(error) if unavailable(&error) => {},
                Err(error) => return Err(error.into()),
            }
        }
    }
    recalled.abstractions = crate::abstraction::recall(tx, admission.verified(), task, page, budget, cancel).await.map_err(crate::owner::Error::from)?;
    for contract in &recalled.abstractions {
        if let Some(impact) = crate::abstraction::recalled(tx, admission.verified(), task, page, contract, None, cancel).await.map_err(crate::owner::Error::from)? {
            recalled.labels.extend(impact.labels);
        } else { return Err(ContextFailure::BasisChanged.into()); }
    }
    for (blob, impact) in materials(tx, admission, task, page, Some(budget), cancel).await? {
        if !recalled.materials.contains(&blob) { recalled.materials.push(blob); }
        recalled.labels.extend(impact.labels);
    }
    recalled.actions.sort_by(|a, b| a.id.cmp(&b.id));
    recalled.abstractions.sort_by(|a, b| (&a.id, a.revision).cmp(&(&b.id, b.revision)));
    recalled.materials.sort_by(|a, b| a.digest.cmp(&b.digest));
    Ok(recalled)
}

/// Exact durable items and their current guards/dependencies are checked, not recalled a second time.
pub(super) async fn recheck(
    tx: &WorldTransaction<'_>, admission: &Admission, task: &TaskContract, release: &Release,
    page: &QueryPage, view: &WorldView, cancel: &CancellationToken,
) -> Result<ActualImpact, Error> {
    let mut impacts = vec![authorization::actual_impact(vec![AccessScope {
        resources: vec![ResourceRef::Task { id: task.id.clone() }], fields: Vec::new(),
        modes: vec![AccessMode::Read], scope: task.scope.clone(), valid_time: None,
    }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?];
    for expected in &view.actions {
        if cancel.is_cancelled() { return Err(ContextFailure::Cancelled.into()); }
        let (actual, context, impact) = crate::actions::require_proposal_read(tx, admission.verified(), &expected.id, &tx.now().await?).await?;
        if actual != *expected || !eligible_action(&actual, &context, task, release, page)? { return Err(ContextFailure::BasisChanged.into()); }
        impacts.push(impact);
    }
    for contract in &view.abstractions {
        impacts.push(crate::abstraction::recalled(tx, admission.verified(), task, page, contract, None, cancel).await
            .map_err(crate::owner::Error::from)?.ok_or(ContextFailure::BasisChanged)?);
    }
    let current = materials(tx, admission, task, page, None, cancel).await?;
    for blob in &view.untrusted_material {
        let (_, impact) = current.iter().find(|(actual, _)| actual == blob).ok_or(ContextFailure::BasisChanged)?;
        impacts.push(impact.clone());
    }
    let impact = authorization::actual_impact(impacts.iter().flat_map(|i| i.access.clone()).collect(), Vec::new(),
        impacts.iter().flat_map(|i| i.labels.clone()).collect(), impacts.iter().flat_map(|i| i.state.clone()).collect(), impacts.iter().flat_map(|i| i.source_ids.clone()).collect())?;
    if impact.labels.iter().any(|label| !view.labels.contains(label)) { return Err(ContextFailure::BasisChanged.into()); }
    authorization::check_impact_read_output(tx, admission.verified(), &impact,
        (view.actions.len() + view.abstractions.len() + view.untrusted_material.len()) as u64, &tx.now().await?).await?;
    Ok(impact)
}

fn eligible_action(proposal: &ActionProposal, context: &crate::actions::Context, task: &TaskContract, release: &Release, page: &QueryPage) -> Result<bool, Error> {
    if context.release_id != page.receipt.release_id || context.branch.as_ref().map(|b| &b.id) != page.receipt.branch_id.as_ref()
        || proposal.request.branch_id != page.receipt.branch_id || proposal.activation_lock_id != page.receipt.activation_lock_id
        || !release.definitions.iter().any(|d| d.reference == proposal.request.action && matches!(d.body, DefinitionBody::ActionContract(_)))
        || !proposal.preconditions.iter().all(|truth| *truth == world_protocol::expression::TruthValue::True) { return Ok(false); }
    if !crate::definitions::scope_contains(&task.world, &task.scope, &context.scope, &release.scopes)
        .map_err(|failure| crate::query::QueryError::from(failure))? { return Ok(false); }
    Ok(proposal.request.targets.iter().all(|target| match target {
        SubjectRef::Object { id } => page.objects.iter().any(|view| &view.object.id == id),
        SubjectRef::Relation { id } => page.relations.iter().any(|view| &view.relation.id == id && view.claim.is_some()),
    }))
}

async fn materials(
    tx: &WorldTransaction<'_>, admission: &Admission, task: &TaskContract, page: &QueryPage,
    budget: Option<&CallBudget>, cancel: &CancellationToken,
) -> Result<Vec<(BlobRef, ActualImpact)>, Error> {
    let mut references: Vec<EvidenceRef> = page.receipt.actual_dependencies.iter().filter_map(|dependency| match dependency {
        ReadDependency::Evidence { reference } => Some(reference.clone()), _ => None,
    }).collect();
    for field in page.objects.iter().flat_map(|v| &v.fields).chain(page.relations.iter().flat_map(|v| &v.fields)) { references.extend(field.evidence.clone()); }
    references.sort(); references.dedup();
    let mut sources = Vec::new();
    let mut items = Vec::new();
    for reference in references {
        if cancel.is_cancelled() { return Err(ContextFailure::Cancelled.into()); }
        if let Some(budget) = budget { tick(budget, cancel)?; }
        let evidence = crate::facts::assertions::require_evidence_preflight(tx, admission.verified(), &[reference], &task.scope, None, &tx.now().await?).await;
        let evidence = match evidence {
            Ok(evidence) => evidence,
            Err(error) => { let error = crate::owner::Error::from(error); if unavailable(&error) { continue; } return Err(error.into()); },
        };
        for evidence in evidence {
            let reference = &evidence.locator.source_version;
            if sources.contains(reference) { continue; }
            sources.push(reference.clone());
            let source = match crate::content::read_source_version_metadata(tx, reference).await {
                Ok(source) => source,
                Err(error) if matches!(error.reason(), Some(MaterialFailure::SourceVersionMissing { .. } | MaterialFailure::VersionContentUnavailable { .. } | MaterialFailure::Deleted)) => continue,
                Err(error) => return Err(crate::owner::Error::from(error).into()),
            };
            let mut impact = authorization::material_read_impact(tx, &source).await?;
            impact.access.push(AccessScope { resources: vec![ResourceRef::Evidence { id: evidence.reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: task.scope.clone(), valid_time: None });
            impact.labels.extend(evidence.access.labels);
            let impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
            match authorization::check_impact_read(tx, admission.verified(), &impact, &tx.now().await?).await {
                Ok(()) => {}, Err(authorization::AuthError::Denied(_)) => continue, Err(error) => return Err(error.into()),
            }
            let live = match crate::content::read_source_version_in_transaction(tx, reference).await {
                Ok(live) => live,
                Err(error) if matches!(error.reason(), Some(MaterialFailure::VersionContentUnavailable { .. } | MaterialFailure::Deleted)) => continue,
                Err(error) => return Err(crate::owner::Error::from(error).into()),
            };
            if live != source { return Err(ContextFailure::BasisChanged.into()); }
            authorization::check_impact_read_output(tx, admission.verified(), &impact, 1, &tx.now().await?).await?;
            items.push((source.blob, impact));
        }
    }
    Ok(items)
}

fn tick(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), Error> {
    if cancel.is_cancelled() { return Err(ContextFailure::Cancelled.into()); }
    budget.charge(BudgetDimension::Steps, 1).map_err(|_| ContextFailure::BudgetExceeded.into())
}
fn unavailable(error: &crate::owner::Error) -> bool {
    matches!(&error.safe_failure().details,
        ApiFailure::Authorization(_)
        | ApiFailure::Operation(OperationFailure::Action(ActionFailure::ProposalExpired | ActionFailure::PreconditionFalse { .. } | ActionFailure::PreconditionUnknown { .. }))
        | ApiFailure::Operation(OperationFailure::Fact(world_protocol::facts::FactFailure::EvidenceIncomplete { .. } | world_protocol::facts::FactFailure::EvidenceUnavailable { .. } | world_protocol::facts::FactFailure::EvidenceDeleted { .. })))
}
