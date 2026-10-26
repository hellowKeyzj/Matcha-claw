use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact}, definitions::DefinitionBody,
    facts::{Assertion, AssertionOrigin, Claim, Polarity}, identity::SubjectRef, ids::*,
    provenance::ReadDependency, query::{FieldCell, QueryFailure}, releases::Release,
    slots::{ProjectedCell, ProjectionRequest, ProjectionSourceWitness, ReconcileRequest, SlotRequest, SlotResponse},
    sources::SourceBasis, time::{Timestamp, ValidTime}, value::{Cell, DirtyState, UnknownReason},
};
use crate::{
    authorization::{self, Admission}, extensions::invocation::{self, CompositionOutcome, InvocationContext, InvocationFailure, InvocationServices},
    facts::assertions, store::{StoreFuture, WorldStore, WorldTransaction},
};
use super::{QueryError, plan::CheckedPlan, projection::{ProjectedSubject, Projection}};

/// Exact calls are prepared by the query owner; the query never owns host resources.
pub(crate) struct ProjectionCall { pub context: InvocationContext, pub services: InvocationServices }
pub(crate) struct ProjectionCalls { pub projection: ProjectionCall, pub reconciliation: ProjectionCall }
pub(super) struct AlgorithmRead { contexts: Vec<InvocationContext>, outcomes: Vec<CompositionOutcome> }
impl AlgorithmRead {
    pub(super) fn retain_failure(self, cause: QueryError) -> QueryError { retain_failure(cause, self.outcomes) }
    pub(super) async fn recheck(&self, tx: &WorldTransaction<'_>, admission: &Admission) -> Result<(), QueryError> {
        for (context, outcome) in self.contexts.iter().zip(&self.outcomes) {
            for node in &outcome.nodes {
                invocation::check_current_in_transaction(tx, admission, context.lease(), &node.node).await
                    .map_err(|error| invocation_error(InvocationFailure::Current(error)))?;
            }
        }
        Ok(())
    }
}

pub(super) fn project<'a>(
    store: &'a WorldStore,
    admission: &'a Admission,
    calls: ProjectionCalls,
    release: &'a Release,
    plan: &'a CheckedPlan,
    scope: &'a ScopeId,
    valid_time: ValidTime,
    known_at: Option<Timestamp>,
    projection: &'a mut Projection,
    mut candidates: Vec<Assertion>,
    source_projection: &'a BTreeMap<DefinitionRef, BTreeMap<SubjectRef, ProjectedSubject>>,
    basis: &'a [SourceBasis],
    impact: &'a mut ActualImpact,
    cancel: &'a tokio_util::sync::CancellationToken,
) -> StoreFuture<'a, AlgorithmRead, QueryError> {
    Box::pin(async move {
        let budget = calls.projection.context.budget().clone();
        let mut sources = Vec::new();
        let mut refreshed = BTreeSet::new();
        for (binding, subjects) in source_projection {
            let basis = basis.iter().find(|basis| &basis.binding == binding).ok_or(QueryFailure::BasisChanged)?;
            for (subject, projected) in subjects {
                for field in projected.fields.values().filter(|field| plan.fields.contains(&field.property)) {
                    budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
                    refreshed.insert((binding.clone(), subject.clone(), field.property.clone()));
                    projection.incomplete |= !matches!(field.cell, Cell::Known { .. });
                    sources.push(ProjectionSourceWitness { basis: basis.clone(), cell: ProjectedCell { subject: subject.clone(), field: field.clone() } });
                }
            }
        }
        candidates.retain(|assertion| match &assertion.claim {
            Claim::Attribute(claim) => projection.subjects.get(&claim.subject).is_some_and(|subject| subject.fields.contains_key(&claim.property))
                && !(assertion.polarity == Polarity::Positive && matches!(&assertion.origin, AssertionOrigin::Source { binding, .. } if refreshed.contains(&(binding.clone(), claim.subject.clone(), claim.property.clone())))),
            Claim::Relation(_) => false,
        });
        let positive: BTreeSet<_> = candidates.iter().filter(|assertion| assertion.polarity == Polarity::Positive).filter_map(|assertion| match &assertion.claim {
            Claim::Attribute(claim) => Some((claim.subject.clone(), claim.property.clone())), _ => None,
        }).chain(sources.iter().filter(|source| matches!(source.cell.field.cell, Cell::Known { .. })).map(|source| (source.cell.subject.clone(), source.cell.field.property.clone()))).collect();
        let properties: BTreeMap<_, _> = release.definitions.iter().filter(|definition| plan.fields.contains(&definition.reference)).map(|definition| {
            let DefinitionBody::Property(body) = &definition.body else { return Err(QueryError::from(QueryFailure::BasisChanged)); };
            Ok((definition.reference.clone(), body))
        }).collect::<Result<_, QueryError>>()?;
        if properties.len() != plan.fields.len() { return Err(QueryFailure::BasisChanged.into()); }
        let mut cells = Vec::new();
        for (subject, projected) in &mut projection.subjects {
            if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
            budget.check().map_err(super::execution::budget_error)?;
            for (property, body) in &properties {
                let type_id = match &projected.identity.record { world_protocol::identity::IdentityRecord::Object(object) => &object.type_id, world_protocol::identity::IdentityRecord::Relation(relation) => &relation.type_id };
                if !body.domain.contains(type_id) { continue; }
                let field = projected.fields.entry(property.clone()).or_insert_with(|| FieldCell { property: property.clone(), cell: Cell::Unknown { reason: UnknownReason::NotObserved }, evidence: Vec::new(), dirty: DirtyState::Clean });
                field.evidence.sort(); field.evidence.dedup();
                cells.push(ProjectedCell { subject: subject.clone(), field: field.clone() });
            }
        }
        let source_keys: BTreeSet<_> = sources.iter().map(|source| (source.cell.subject.clone(), source.cell.field.property.clone())).collect();
        let fixed = cells.iter().filter(|cell| {
            let key = (cell.subject.clone(), cell.field.property.clone());
            !positive.contains(&key) && !source_keys.contains(&key)
        }).cloned().collect();
        let mut references: BTreeSet<_> = plan.datasets.iter().chain(&plan.fields).cloned().collect();
        references.extend(candidates.iter().filter_map(|assertion| match &assertion.origin { AssertionOrigin::Source { binding, .. } => Some(binding.clone()), _ => None }));
        references.extend(basis.iter().map(|basis| basis.binding.clone()));
        let definitions: Vec<_> = release.definitions.iter().filter(|definition| references.contains(&definition.reference)).cloned().collect();
        for definition in &definitions {
            let dependency = ReadDependency::Definition { reference: definition.reference.clone() };
            if !projection.dependencies.contains(&dependency) { projection.dependencies.push(dependency); }
        }
        let scope_ids: BTreeSet<_> = std::iter::once(scope.clone()).chain(definitions.iter().map(|definition| definition.scope.clone())).chain(candidates.iter().map(|assertion| assertion.scope.clone())).collect();
        let scopes = release.scopes.iter().filter(|scope| scope_ids.contains(&scope.id)).cloned().collect();
        let mut access = impact.access.clone();
        for call in [&calls.projection, &calls.reconciliation] {
            if call.context.lease().graph().lock().id != release.artifact.activation_lock_id { return Err(QueryFailure::BasisChanged.into()); }
            let resources = call.context.lease().graph().closure_nodes(call.context.node()).map_err(|failure| invocation_error(InvocationFailure::Binding(failure)))?.into_iter()
                .map(|node| call.context.lease().graph().node(&node).map(|node| ResourceRef::Binding { id: node.binding_id.clone() }))
                .collect::<Result<BTreeSet<_>, _>>().map_err(|failure| invocation_error(InvocationFailure::Binding(failure)))?;
            access.push(AccessScope { resources: resources.into_iter().collect(), fields: Vec::new(), modes: vec![AccessMode::Execute], scope: scope.clone(), valid_time: None });
        }
        *impact = authorization::actual_impact(access, impact.effects.clone(), impact.labels.clone(), impact.state.clone(), impact.source_ids.clone())?;
        admission.require_access(impact)?;
        let request = ProjectionRequest { world: release.world.clone(), release_id: release.id.clone(), definitions, scopes, scope: scope.clone(), valid_time, known_at, cells, fixed,
            assertions: candidates, sources, basis: basis.to_vec(), dependencies: projection.dependencies.clone(), budget: budget.limit().clone() };
        let contexts = vec![calls.projection.context.clone(), calls.reconciliation.context.clone()];
        let mut outcomes = Vec::new();
        let result: StoreFuture<'_, Vec<ProjectedCell>, QueryError> = Box::pin(async {
            let outcome = invoke(calls.projection, SlotRequest::Projection(request.clone()), cancel).await
                .map_err(|error| QueryError::Invocation { failure: error.host_failure(), cause: Box::new(error) })?;
            outcomes.push(outcome);
            let result = match &outcomes.last().expect("projection outcome").result {
                Ok(SlotResponse::Projection(result)) => result.clone(),
                Err(error) => return Err(QueryError::Invocation { failure: outcomes.last().and_then(|outcome| outcome.nodes.iter().find_map(|node| node.result.as_ref().err())).unwrap_or(error).host_failure(), cause: Box::new(std::io::Error::other("world.query_projection_failed")) }),
                _ => return Err(QueryFailure::BasisChanged.into()),
            };
            let saved_admission = admission.clone(); let saved_request = request.clone();
            let cells = store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
                assertions::validate_projection_snapshot(snapshot, &saved_admission, &saved_request, &result).await.map_err(QueryError::from)
            })).await?;
            let request = ReconcileRequest { world: request.world, release_id: request.release_id, definitions: request.definitions, scopes: request.scopes, scope: request.scope,
                valid_time: request.valid_time, known_at: request.known_at, cells, fixed: request.fixed, assertions: request.assertions, sources: request.sources,
                basis: request.basis, dependencies: request.dependencies, budget: request.budget };
            let outcome = invoke(calls.reconciliation, SlotRequest::Reconcile(request.clone()), cancel).await
                .map_err(|error| QueryError::Invocation { failure: error.host_failure(), cause: Box::new(error) })?;
            outcomes.push(outcome);
            let result = match &outcomes.last().expect("reconcile outcome").result {
                Ok(SlotResponse::Reconcile(result)) => result.clone(),
                Err(error) => return Err(QueryError::Invocation { failure: outcomes.last().and_then(|outcome| outcome.nodes.iter().find_map(|node| node.result.as_ref().err())).unwrap_or(error).host_failure(), cause: Box::new(std::io::Error::other("world.query_reconciliation_failed")) }),
                _ => return Err(QueryFailure::BasisChanged.into()),
            };
            let saved_admission = admission.clone();
            store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
                assertions::validate_reconciliation_snapshot(snapshot, &saved_admission, &request, &result).await.map_err(QueryError::from)
            })).await
        });
        let cells = match result.await { Ok(cells) => cells, Err(cause) => return Err(retain_failure(cause, outcomes)) };
        for cell in cells {
            projection.subjects.get_mut(&cell.subject).ok_or(QueryFailure::BasisChanged)?.fields.insert(cell.field.property.clone(), cell.field);
        }
        Ok(AlgorithmRead { contexts, outcomes })
    })
}

fn invoke<'a>(
    call: ProjectionCall,
    request: SlotRequest,
    cancel: &'a tokio_util::sync::CancellationToken
) -> StoreFuture<'a, CompositionOutcome, invocation::CompositionFailure> {
    let pipeline = call.context.pipeline().clone();
    let invocation = invocation::invoke_composition(call.context, request, call.services);
    Box::pin(async move {
        if cancel.is_cancelled() { pipeline.cancel(); }
        tokio::pin!(invocation);
        tokio::select! {
            result = &mut invocation => result,
            _ = cancel.cancelled() => { pipeline.cancel(); invocation.await },
        }
    })
}

pub(super) fn invocation_error(error: InvocationFailure) -> QueryError {
    QueryError::Invocation { failure: error.host_failure(), cause: Box::new(error) }
}
struct AlgorithmFailure { cause: QueryError, outcomes: Vec<CompositionOutcome> }
impl std::fmt::Debug for AlgorithmFailure { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { std::fmt::Display::fmt(self, f) } }
impl std::fmt::Display for AlgorithmFailure { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{} ({} retained compositions)", self.cause, self.outcomes.len()) } }
impl std::error::Error for AlgorithmFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.outcomes.iter().rev().find_map(|outcome| outcome.nodes.iter().find_map(|node| node.result.as_ref().err()).or_else(|| outcome.result.as_ref().err()))
            .map(|cause| cause as &(dyn std::error::Error + 'static)).or(Some(&self.cause))
    }
}
fn retain_failure(cause: QueryError, outcomes: Vec<CompositionOutcome>) -> QueryError {
    QueryError::Invocation { failure: cause.host_failure(), cause: Box::new(AlgorithmFailure { cause, outcomes }) }
}
