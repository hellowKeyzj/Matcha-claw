use world_protocol::{identity::{AliasResolution, SourceKey}, ids::*, sources::{SourceBasis, SourcePosition, SourceRecordStatus}, time::Timestamp, value::{Cell, DirtyState}};
use crate::{authorization::Admission, sources::sync::{self, Assignment}, store::WorldSnapshot};
use super::{QueryError, live::LiveRead, projection::Projection};

/// Only the full authorized facts/support scan below can construct this publication witness.
pub(crate) struct ProjectionProof {
    world: WorldRef, assignment: Assignment, sequence: u64, position: SourcePosition,
    generation: Generation, basis: SourceBasis, decision: DecisionId,
    fields: Vec<(world_protocol::identity::SubjectRef, DefinitionRef)>,
}
impl ProjectionProof {
    pub(crate) fn world(&self) -> &WorldRef { &self.world }
    pub(crate) fn assignment(&self) -> &Assignment { &self.assignment }
    pub(crate) fn sequence(&self) -> u64 { self.sequence }
    pub(crate) fn position(&self) -> &SourcePosition { &self.position }
    pub(crate) fn generation(&self) -> Generation { self.generation }
    pub(crate) fn snapshot(&self) -> Option<&str> { self.basis.snapshot.as_deref() }
    pub(crate) fn decision_id(&self) -> &DecisionId { &self.decision }
    pub(super) fn basis(&self) -> &SourceBasis { &self.basis }
    pub(super) fn require_ready(&self, projection: &Projection, mode: &world_protocol::query::ReadMode) -> Result<(), QueryError> {
        if self.fields.iter().any(|(subject, property)| !projection.subjects.get(subject).and_then(|subject| subject.fields.get(property)).is_some_and(|field| matches!(field.cell, Cell::Known { .. }) && field.dirty == DirtyState::Clean)) {
            return Err(world_protocol::query::QueryFailure::GuaranteeUnsatisfied { mode: mode.clone(), source_id: Some(self.basis.source_id.clone()) }.into());
        }
        Ok(())
    }
}

pub(super) async fn prepare(
    snapshot: &WorldSnapshot<'_>, projection: &mut Projection, plan: &super::plan::CheckedPlan, scope: &ScopeId, source: &LiveRead,
    frontier: &crate::sources::sync::Frontier, generation: Generation, admission: &Admission, at: &Timestamp,
    assertions: Option<&[world_protocol::facts::Assertion]>,
) -> Result<Option<ProjectionProof>, QueryError> {
    if source.binding.body.scope != frontier.assignment.scope || source.binding.reference != frontier.assignment.binding
        || scope != &frontier.assignment.scope || !source.mapping.fields.iter().all(|field| plan.fields.contains(&field.property))
        || !source.mapping.relations.iter().all(|relation| plan.datasets.contains(&relation.relation_type)) { return Ok(None); }
    let Some(basis) = sync::projection_basis(snapshot, frontier).await? else { return Ok(None); };
    let Some(sequence) = frontier.checkpoint.applied_sequence else { return Ok(None); };
    let Some(position) = &frontier.checkpoint.source.applied else { return Ok(None); };
    let states = sync::read_record_states(snapshot, &source.binding.reference).await?;
    let mut latest = std::collections::BTreeMap::new();
    for state in states.into_iter().filter(|state| state.key.valid_time.contains(at) && state.scope == frontier.assignment.scope && state.basis.position.as_ref().is_some_and(|position| position.partition == frontier.assignment.partition)) {
        let key = (state.key.namespace.clone(), state.key.native_key.clone(), state.key.incarnation.clone());
        let entry = latest.entry(key).or_insert_with(|| state.clone());
        if entry.revision < state.revision { *entry = state; }
    }
    let covered: Option<std::collections::BTreeSet<_>> = assertions.map(|assertions| assertions.iter().filter_map(|assertion| match &assertion.claim {
        world_protocol::facts::Claim::Attribute(claim) if assertion.polarity == world_protocol::facts::Polarity::Positive => Some((claim.subject.clone(), claim.property.clone())), _ => None,
    }).collect());
    let mut fields = Vec::new();
    for state in latest.into_values() {
        match state.status { SourceRecordStatus::Unavailable => continue, SourceRecordStatus::NeedsReconcile => return Ok(None), SourceRecordStatus::Available => {} }
        let key = SourceKey { valid_time: super::projection::point(at)?, ..state.key };
        let identity = crate::identity::resolve(snapshot, &key, &frontier.assignment.scope).await?;
        projection.dependencies.extend(identity.dependencies);
        let AliasResolution::Existing { identity, .. } = identity.resolution else { return Ok(None); };
        let subject = match &identity.record { world_protocol::identity::IdentityRecord::Object(object) => world_protocol::identity::SubjectRef::Object { id: object.id.clone() }, world_protocol::identity::IdentityRecord::Relation(relation) => world_protocol::identity::SubjectRef::Relation { id: relation.id.clone() } };
        let Some(projected) = projection.subjects.get(&subject) else { return Ok(None); };
        for field in &source.mapping.fields {
            let Some(projected_field) = projected.fields.get(&field.property) else { return Ok(None); };
            if projected_field.dirty != DirtyState::Clean { return Ok(None); }
            if !covered.as_ref().map_or_else(|| matches!(projected_field.cell, Cell::Known { .. }), |covered| covered.contains(&(subject.clone(), field.property.clone()))) { return Ok(None); }
            fields.push((subject.clone(), field.property.clone()));
        }
        if !source.mapping.relations.is_empty() && projected.relation.is_none() { return Ok(None); }
    }
    Ok(Some(ProjectionProof { world: snapshot.world().clone(), assignment: frontier.assignment.clone(), sequence,
        position: position.clone(), generation, basis, decision: admission.decision().id.clone(), fields }))
}
