use std::collections::BTreeMap;
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact}, definitions::{Definition, DefinitionBody},
    expression::Effect, facts::{Assertion, Evidence}, ids::*, query::{QueryRequest, QueryFailure}, releases::Release,
};
use crate::{authorization, store::{WorldSnapshot, WorldTransaction}};
use super::{QueryError, error::{decode, invalid}, plan::{self, CheckedPlan}};

pub(crate) async fn release(snapshot: &WorldSnapshot<'_>, request: &QueryRequest) -> Result<Release, QueryError> {
    if let Some((_, release)) = cursor_model_snapshot(snapshot, request).await? { return Ok(release); }
    if let Some(id) = &request.branch_id {
        let branch = crate::releases::read_branch_snapshot(snapshot, id).await?.ok_or_else(|| invalid("branchId"))?;
        if request.release_id.as_ref().is_some_and(|release| release != &branch.basis.release_id) { return Err(invalid("releaseId")); }
        let reference = world_protocol::releases::BranchRef { world: branch.world, id: branch.id, revision: branch.revision };
        return Ok(super::branch::model_snapshot(snapshot, &reference, &world_protocol::evaluation::EvaluationArm::Candidate).await?.1);
    }
    let release = match &request.release_id {
        Some(id) => crate::releases::read_release_snapshot(snapshot, id).await?,
        None => match crate::releases::read_active_release_snapshot(snapshot).await? {
            Some(id) => crate::releases::read_release_snapshot(snapshot, &id).await?, None => None,
        },
    };
    let mut release = release.ok_or_else(|| invalid("releaseId"))?;
    release.source_branch = None;
    Ok(release)
}
pub(crate) async fn release_in_transaction(tx: &WorldTransaction<'_>, request: &QueryRequest) -> Result<Release, QueryError> {
    if let Some((_, release)) = cursor_model_transaction(tx, request).await? { return Ok(release); }
    let id = match (&request.release_id, &request.branch_id) {
        (Some(id), _) => id.clone(),
        (None, Some(id)) => crate::releases::read_branch(tx, id).await?.ok_or_else(|| invalid("branchId"))?.basis.release_id,
        (None, None) => crate::releases::read_active_release(tx).await?.ok_or_else(|| invalid("releaseId"))?,
    };
    super::current::release(tx, &id, request.branch_id.as_ref()).await
}
async fn cursor_model_snapshot(snapshot: &WorldSnapshot<'_>, request: &QueryRequest) -> Result<Option<(super::receipt::StoredRead, Release)>, QueryError> {
    let Some(cursor) = &request.page.cursor else { return Ok(None); };
    let (id, _) = super::receipt::cursor(cursor)?;
    let read = super::receipt::read_snapshot(snapshot, &id).await?;
    let release = if read.context.branch_model.is_some() { super::branch::stored_plan_snapshot(snapshot, &read).await? }
        else { let mut release = crate::releases::read_release_snapshot(snapshot, &read.receipt.release_id).await?.ok_or(QueryFailure::CursorInvalid)?; release.source_branch = None; release };
    check_cursor(&read, request, &release)?;
    Ok(Some((read, release)))
}
async fn cursor_model_transaction(tx: &WorldTransaction<'_>, request: &QueryRequest) -> Result<Option<(super::receipt::StoredRead, Release)>, QueryError> {
    let Some(cursor) = &request.page.cursor else { return Ok(None); };
    let (id, _) = super::receipt::cursor(cursor)?;
    let read = super::receipt::read_transaction(tx, &id).await?;
    let release = if read.context.branch_model.is_some() { super::branch::stored_plan_transaction(tx, &read).await? }
        else { let mut release = crate::releases::read_release(tx, &read.receipt.release_id).await?.ok_or(QueryFailure::CursorInvalid)?; release.source_branch = None; release };
    check_cursor(&read, request, &release)?;
    Ok(Some((read, release)))
}
fn check_cursor(read: &super::receipt::StoredRead, request: &QueryRequest, release: &Release) -> Result<(), QueryError> {
    if request.world != read.receipt.world || request.branch_id != read.receipt.branch_id
        || request.release_id.as_ref().is_some_and(|id| id != &release.id)
        || super::execution::query_digest(request)? != read.receipt.query_digest
        || release.id != read.receipt.release_id || release.artifact.activation_lock_id != read.receipt.activation_lock_id
        || super::execution::evaluated_scope_digest(&read.context, release, &read.impact)? != read.receipt.evaluated_scope_digest { return Err(QueryFailure::CursorInvalid.into()); }
    Ok(())
}
fn merge_impact(target: &mut ActualImpact, source: ActualImpact) { target.access.extend(source.access); target.effects.extend(source.effects); target.labels.extend(source.labels); target.state.extend(source.state); target.source_ids.extend(source.source_ids); }
pub(crate) async fn impact(snapshot: &WorldSnapshot<'_>, request: &QueryRequest, scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    if request.world != *snapshot.world() { return Err(invalid("world")); }
    if let Some((read, release)) = cursor_model_snapshot(snapshot, request).await? {
        if &read.context.scope != scope { return Err(QueryFailure::CursorInvalid.into()); }
        let mut impact = read.impact.clone();
        let current = if read.context.branch_model.is_some() { super::branch::stored_dependency_impact_snapshot(snapshot, &read, &release).await? }
            else { impact_for(snapshot, &plan::check(&request.query, &release)?, &release, scope).await? };
        merge_impact(&mut impact, current);
        return Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?);
    }
    if let Some(id) = &request.branch_id {
        let branch = crate::releases::read_branch_snapshot(snapshot, id).await?.ok_or(QueryFailure::BasisChanged)?;
        return super::branch::impact_snapshot(snapshot, &world_protocol::releases::BranchRef { world: branch.world, id: branch.id, revision: branch.revision }, request, scope).await;
    }
    let release = release(snapshot, request).await?;
    let plan = plan::check(&request.query, &release)?;
    impact_for(snapshot, &plan, &release, scope).await
}
pub(crate) fn impact_in_transaction<'a>(tx: &'a WorldTransaction<'_>, request: &'a QueryRequest, scope: &'a ScopeId) -> crate::store::StoreFuture<'a, ActualImpact, QueryError> {
    Box::pin(async move {
        if request.world != *tx.world() { return Err(invalid("world")); }
        if let Some((read, release)) = cursor_model_transaction(tx, request).await? {
            return cursor_impact(tx, request, scope, read, release).await;
        }
        if let Some(id) = &request.branch_id {
            return branch_impact(tx, request, scope, id).await;
        }
        release_impact(tx, request, scope).await
    })
}
fn cursor_impact<'a>(tx: &'a WorldTransaction<'_>, request: &'a QueryRequest, scope: &'a ScopeId, read: super::receipt::StoredRead, release: Release) -> crate::store::StoreFuture<'a, ActualImpact, QueryError> {
    Box::pin(async move {
        if &read.context.scope != scope { return Err(QueryFailure::CursorInvalid.into()); }
        let mut impact = read.impact.clone();
        let current = if read.context.branch_model.is_some() { super::branch::stored_dependency_impact(tx, &read, &release).await? }
            else { impact_for_transaction(tx, &plan::check(&request.query, &release)?, &release, scope).await? };
        merge_impact(&mut impact, current);
        Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
    })
}
fn branch_impact<'a>(tx: &'a WorldTransaction<'_>, request: &'a QueryRequest, scope: &'a ScopeId, id: &'a BranchId) -> crate::store::StoreFuture<'a, ActualImpact, QueryError> {
    Box::pin(async move {
        let branch = crate::releases::read_branch(tx, id).await?.ok_or(world_protocol::query::QueryFailure::BasisChanged)?;
        super::branch::branch_impact_in_transaction(tx, &world_protocol::releases::BranchRef { world: branch.world, id: branch.id, revision: branch.revision }, &world_protocol::evaluation::EvaluationArm::Candidate, &request.query, &request.arguments, scope).await
    })
}
fn release_impact<'a>(tx: &'a WorldTransaction<'_>, request: &'a QueryRequest, scope: &'a ScopeId) -> crate::store::StoreFuture<'a, ActualImpact, QueryError> {
    Box::pin(async move {
        let id = match (&request.release_id, &request.branch_id) {
            (Some(id), _) => id.clone(),
            (None, Some(id)) => crate::releases::read_branch(tx, id).await?.ok_or_else(|| invalid("branchId"))?.basis.release_id,
            (None, None) => crate::releases::read_active_release(tx).await?.ok_or_else(|| invalid("releaseId"))?,
        };
        let release = super::current::release(tx, &id, request.branch_id.as_ref()).await?;
        let plan = plan::check(&request.query, &release)?;
        impact_for_transaction(tx, &plan, &release, scope).await
    })
}
pub(super) async fn impact_for_transaction(tx: &WorldTransaction<'_>, plan: &CheckedPlan, release: &Release, scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let current = crate::releases::read_active_model(tx).await?.ok_or(QueryFailure::BasisChanged)?.definitions.into_iter().map(|definition| (definition.reference.id.clone(), definition)).collect();
    let datasets: Vec<_> = plan.datasets.iter().map(|dataset| dataset.id.as_str()).collect();
    let rows = tx.query(FACTS, &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &datasets]).await?;
    let facts = rows.into_iter().map(|row| decode(row.get("body"))).collect::<Result<Vec<Assertion>, _>>()?;
    let mut evidence = Vec::new();
    for reference in fact_evidence(&facts, &plan) {
        if let Some(row) = tx.query_opt(EVIDENCE, &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str()]).await? { evidence.push(decode(row.get("body"))?); }
    }
    let mut impact = impact_from(&plan, &release, scope, &current, &evidence)?;
    for fact in &facts {
        if matches!(&fact.claim, world_protocol::facts::Claim::Attribute(claim) if !plan.fields.contains(&claim.property)) { continue; }
        impact.access.push(AccessScope { resources: vec![ResourceRef::Assertion { id: fact.reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(fact.valid_time.clone()) });
        let dependencies: Vec<_> = fact.evidence.iter().cloned().map(|reference| world_protocol::provenance::ReadDependency::Evidence { reference }).collect();
        if let Some(material) = crate::facts::support::dependency_impact(tx, &dependencies, &release, scope, &fact.valid_time).await? {
            impact.access.extend(material.access); impact.effects.extend(material.effects); impact.labels.extend(material.labels); impact.state.extend(material.state); impact.source_ids.extend(material.source_ids);
        }
    }
    Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
}
const FACTS: &str = "SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND ((r.subject_kind='object' AND EXISTS(SELECT 1 FROM world_object_identity o WHERE o.tenant_id=r.tenant_id AND o.world_id=r.world_id AND o.object_id=r.subject_id AND o.type_id=ANY($3::text[]))) OR (r.subject_kind='relation' AND EXISTS(SELECT 1 FROM world_relation_identity o WHERE o.tenant_id=r.tenant_id AND o.world_id=r.world_id AND o.relation_id=r.subject_id AND o.type_id=ANY($3::text[])))) ORDER BY h.assertion_id";
const EVIDENCE: &str = "SELECT r.body FROM world_evidence_head h JOIN world_evidence_revision r USING(tenant_id,world_id,evidence_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.evidence_id=$3";
fn fact_evidence(facts: &[Assertion], plan: &CheckedPlan) -> Vec<EvidenceRef> {
    let mut result = Vec::new();
    for fact in facts {
        if matches!(&fact.claim, world_protocol::facts::Claim::Attribute(claim) if !plan.fields.contains(&claim.property)) { continue; }
        result.extend(fact.evidence.clone());
    }
    result.sort(); result.dedup(); result
}
pub(super) async fn impact_for(snapshot: &WorldSnapshot<'_>, plan: &CheckedPlan, release: &Release, scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let current_id = crate::releases::read_active_release_snapshot(snapshot).await?.ok_or(QueryFailure::BasisChanged)?;
    let current = crate::releases::read_release_snapshot(snapshot, &current_id).await?.ok_or(QueryFailure::BasisChanged)?.definitions.into_iter().map(|definition| (definition.reference.id.clone(), definition)).collect();
    let datasets: Vec<_> = plan.datasets.iter().map(|dataset| dataset.id.as_str()).collect();
    let rows = snapshot.query(FACTS, &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &datasets]).await?;
    let facts = rows.into_iter().map(|row| decode(row.get("body"))).collect::<Result<Vec<Assertion>, _>>()?;
    let mut evidence = Vec::new();
    for reference in fact_evidence(&facts, plan) {
        if let Some(row) = snapshot.query_opt(EVIDENCE, &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &reference.id.as_str()]).await? { evidence.push(decode(row.get("body"))?); }
    }
    let mut impact = impact_from(plan, release, scope, &current, &evidence)?;
    for fact in &facts {
        if matches!(&fact.claim, world_protocol::facts::Claim::Attribute(claim) if !plan.fields.contains(&claim.property)) { continue; }
        impact.access.push(AccessScope { resources: vec![ResourceRef::Assertion { id: fact.reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(fact.valid_time.clone()) });
        let dependencies: Vec<_> = fact.evidence.iter().cloned().map(|reference| world_protocol::provenance::ReadDependency::Evidence { reference }).collect();
        if let Some(material) = crate::facts::support::dependency_impact_snapshot(snapshot, &dependencies, release, scope, &fact.valid_time).await? {
            impact.access.extend(material.access); impact.effects.extend(material.effects); impact.labels.extend(material.labels); impact.state.extend(material.state); impact.source_ids.extend(material.source_ids);
        }
    }
    Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
}
pub(super) fn impact_from(plan: &CheckedPlan, release: &Release, scope: &ScopeId, current: &BTreeMap<DefinitionId, Definition<DefinitionBody>>, evidence: &[Evidence]) -> Result<ActualImpact, QueryError> {
    let mut access = vec![AccessScope { resources: Vec::new(), fields: plan.fields.iter().cloned().collect(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None }];
    let mut labels = Vec::new(); let mut sources = Vec::new();
    for reference in &plan.fields {
        let definition = release.definitions.iter().find(|entry| entry.reference == *reference).ok_or_else(|| invalid("query.field"))?;
        let DefinitionBody::Property(property) = &definition.body else { return Err(invalid("query.field")); };
        labels.extend(property.access_labels.clone());
        access.push(AccessScope { resources: vec![ResourceRef::Definition { id: reference.id.clone() }], fields: vec![reference.clone()], modes: vec![AccessMode::Read], scope: definition.scope.clone(), valid_time: None });
        if let Some(current) = current.get(&reference.id) {
            let DefinitionBody::Property(property) = &current.body else { return Err(invalid("query.field")); };
            labels.extend(property.access_labels.clone());
            access.push(AccessScope { resources: vec![ResourceRef::Definition { id: reference.id.clone() }], fields: vec![reference.clone()], modes: vec![AccessMode::Read], scope: current.scope.clone(), valid_time: None });
        }
    }
    for item in evidence {
        access.push(AccessScope { resources: vec![ResourceRef::Evidence { id: item.reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None });
        labels.extend(item.access.labels.clone()); sources.push(item.locator.source_version.source_id.clone());
    }
    for definition in &release.definitions {
        let DefinitionBody::SourceBinding(binding) = &definition.body else { continue; };
        if !plan.datasets.iter().any(|dataset| dataset.id == binding.identity_mapping.type_id)
            && !binding.field_mapping.iter().any(|field| plan.fields.contains(&field.property)) { continue; }
        sources.push(binding.source_id.clone());
        access.push(AccessScope { resources: vec![ResourceRef::Source { id: binding.source_id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: binding.scope.clone(), valid_time: None });
        for field in &binding.field_mapping {
            if let Some(property) = release.definitions.iter().find(|entry| entry.reference == field.property) {
                if let DefinitionBody::Property(body) = &property.body { labels.extend(body.access_labels.clone()); }
                access.push(AccessScope { resources: vec![ResourceRef::Source { id: binding.source_id.clone() }], fields: vec![field.property.clone()], modes: vec![AccessMode::Read], scope: property.scope.clone(), valid_time: None });
            }
        }
    }
    let effects = if sources.is_empty() { vec![Effect::Pure] } else { vec![Effect::Pure, Effect::SourceRead] };
    Ok(authorization::actual_impact(access, effects, labels, Vec::new(), sources)?)
}
