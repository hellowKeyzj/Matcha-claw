use std::collections::BTreeSet;

use serde::de::DeserializeOwned;
use world_protocol::{
    authorization::{AccessMode, AccessScope, AuthorizationFailure},
    budget::BudgetDimension,
    commit::{CommitFailure, CommittedRevision},
    definitions::{Definition, DefinitionBody},
    expression::Effect,
    facts::{Assertion, Claim, Evidence},
    failure::FailureStage,
    ids::{ResourceRef, ScopeId},
    process::HostFailure,
    slots::{StorageReadRequest, StorageReadResult},
    time::{Timestamp, ValidTime},
};

use super::{StoreError, WorldSnapshot, prepared::check_call};
use crate::{
    authorization::{self, Admission},
    definitions,
    extensions::invocation::InvocationContext,
    facts::assertions,
    owner::Error,
};

pub(super) async fn read(
    context: &InvocationContext,
    request: &StorageReadRequest,
) -> Result<StorageReadResult, Error> {
    if request.resources.is_empty() || request.resources.len() > 256
        || request.resources.iter().collect::<BTreeSet<_>>().len() != request.resources.len()
        || request.resources.iter().any(|resource| !matches!(resource,
            ResourceRef::Assertion { .. } | ResourceRef::Definition { .. } | ResourceRef::Evidence { .. }))
    {
        return Err(invalid());
    }
    check_call(context)?;
    context.check_current().await.map_err(current_error)?;
    let call = context.clone();
    let request = request.clone();
    let result = context.store().snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
        let now = snapshot.now().await?;
        if request.known_at.as_ref().is_some_and(|at| at > &now) {
            return Err(invalid());
        }
        let mut result = StorageReadResult {
            assertions: Vec::new(), definitions: Vec::new(), evidence: Vec::new(), revisions: Vec::new(),
        };
        let mut bytes = 0u64;
        for resource in &request.resources {
            check_call(&call)?;
            charge(&call, BudgetDimension::Steps, 1)?;
            // Authorize the resource before resolving its existence; the body adds its exact impact.
            let grant = call.admission().impact().access.iter().find(|grant|
                grant.modes.contains(&AccessMode::Read)
                    && (grant.resources.is_empty() || grant.resources.contains(resource)))
                .ok_or_else(denied)?;
            authorize(call.admission(), vec![resource.clone()], grant.fields.clone(),
                &grant.scope, grant.valid_time.as_ref(), Vec::new())?;
            let known = request.known_at.as_ref().map(Timestamp::as_str);
            match resource {
                ResourceRef::Assertion { id } => {
                    let row = snapshot.query_opt(
                        "SELECT r.body,r.revision FROM world_assertion_head h JOIN LATERAL (SELECT body,revision FROM world_assertion_revision a WHERE (a.tenant_id,a.world_id,a.assertion_id)=(h.tenant_id,h.world_id,h.assertion_id) AND a.revision<=h.revision AND ($4::text IS NULL OR a.recorded_at<=$4::text::timestamptz) ORDER BY a.revision DESC LIMIT 1) r ON true WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.assertion_id=$3",
                        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &id.as_str(), &known],
                    ).await?;
                    let Some(row) = row else { continue; };
                    let assertion: Assertion = decode(row.get("body"))?;
                    if assertion.reference.world != *snapshot.world() || &assertion.reference.id != id
                        || i64::try_from(assertion.reference.revision.0).ok() != Some(row.get("revision"))
                    { return Err(corrupt()); }
                    let predicate = match &assertion.claim {
                        Claim::Attribute(claim) => &claim.property,
                        Claim::Relation(claim) => &claim.relation_type,
                    };
                    let exact = definitions::read_definition_snapshot(snapshot, predicate).await?
                        .ok_or_else(corrupt)?;
                    let mut labels = property_labels(&exact.body);
                    let current = current_definition(snapshot, &predicate.id).await?;
                    labels.extend(property_labels(&current.body));
                    authorize(call.admission(), vec![ResourceRef::Definition { id: predicate.id.clone() }],
                        vec![predicate.clone()], &current.scope, Some(&assertion.valid_time), labels.clone())?;
                    let mut resources = vec![resource.clone(), ResourceRef::Definition { id: predicate.id.clone() }];
                    resources.extend(assertions::claim_subjects(&assertion.claim).into_iter().map(|subject| match subject {
                        world_protocol::identity::SubjectRef::Object { id } => ResourceRef::Object { id },
                        world_protocol::identity::SubjectRef::Relation { id } => ResourceRef::Relation { id },
                    }));
                    if let Claim::Attribute(claim) = &assertion.claim {
                        definitions::value_resources(&claim.value, &mut resources);
                    }
                    authorize(call.admission(), resources, vec![predicate.clone()], &assertion.scope,
                        Some(&assertion.valid_time), labels)?;
                    assertions::require_evidence_snapshot(snapshot, call.admission(), &assertion.evidence,
                        &assertion.scope, Some(&assertion.valid_time), &now).await?;
                    result.revisions.push(CommittedRevision { resource: resource.clone(), revision: assertion.reference.revision });
                    account(&call, &assertion, &mut bytes)?;
                    result.assertions.push(assertion);
                }
                ResourceRef::Definition { id } => {
                    let row = snapshot.query_opt(
                        "SELECT r.body,r.revision FROM world_definition_head h JOIN LATERAL (SELECT body,revision FROM world_definition_revision d WHERE (d.tenant_id,d.world_id,d.definition_id)=(h.tenant_id,h.world_id,h.definition_id) AND d.revision<=h.revision AND ($4::text IS NULL OR d.recorded_at<=$4::text::timestamptz) ORDER BY d.revision DESC LIMIT 1) r ON true WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.definition_id=$3",
                        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &id.as_str(), &known],
                    ).await?;
                    let Some(row) = row else { continue; };
                    let definition: Definition<DefinitionBody> = decode(row.get("body"))?;
                    if definition.reference.world != *snapshot.world() || &definition.reference.id != id
                        || i64::try_from(definition.reference.revision.0).ok() != Some(row.get("revision"))
                    { return Err(corrupt()); }
                    let mut labels = property_labels(&definition.body);
                    let current = current_definition(snapshot, id).await?;
                    labels.extend(property_labels(&current.body));
                    authorize(call.admission(), vec![resource.clone()], vec![definition.reference.clone()],
                        &current.scope, Some(&definition.valid_time), labels.clone())?;
                    let mut resources = definitions::definition_resources(&definition.body);
                    resources.push(resource.clone());
                    resources.extend(definition.dependencies.iter().map(|reference| ResourceRef::Definition { id: reference.id.clone() }));
                    authorize(call.admission(), resources, vec![definition.reference.clone()], &definition.scope,
                        Some(&definition.valid_time), labels)?;
                    assertions::require_evidence_snapshot(snapshot, call.admission(), &definition.evidence,
                        &definition.scope, Some(&definition.valid_time), &now).await?;
                    result.revisions.push(CommittedRevision { resource: resource.clone(), revision: definition.reference.revision });
                    account(&call, &definition, &mut bytes)?;
                    result.definitions.push(definition);
                }
                ResourceRef::Evidence { id } => {
                    let row = snapshot.query_opt(
                        "SELECT r.body,r.revision FROM world_evidence_head h JOIN LATERAL (SELECT body,revision FROM world_evidence_revision e WHERE (e.tenant_id,e.world_id,e.evidence_id)=(h.tenant_id,h.world_id,h.evidence_id) AND e.revision<=h.revision AND ($4::text IS NULL OR e.recorded_at<=$4::text::timestamptz) ORDER BY e.revision DESC LIMIT 1) r ON true WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.evidence_id=$3",
                        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &id.as_str(), &known],
                    ).await?;
                    let Some(row) = row else { continue; };
                    let evidence: Evidence = decode(row.get("body"))?;
                    if evidence.reference.world != *snapshot.world() || &evidence.reference.id != id
                        || i64::try_from(evidence.reference.revision.0).ok() != Some(row.get("revision"))
                    { return Err(corrupt()); }
                    assertions::require_evidence_snapshot(snapshot, call.admission(), std::slice::from_ref(&evidence.reference),
                        &grant.scope, None, &now).await?;
                    result.revisions.push(CommittedRevision { resource: resource.clone(), revision: evidence.reference.revision });
                    account(&call, &evidence, &mut bytes)?;
                    result.evidence.push(evidence);
                }
                _ => return Err(invalid()),
            }
        }
        authorization::check_admitted_output_read(snapshot, call.admission(), call.admission().impact(),
            result.revisions.len() as u64, &snapshot.now().await?).await?;
        Ok(result)
    })).await?;
    check_call(context)?;
    context.check_current().await.map_err(current_error)?;
    context.check_output(result.revisions.len() as u64).await?;
    Ok(result)
}

fn authorize(
    admission: &Admission, resources: Vec<ResourceRef>, fields: Vec<world_protocol::ids::DefinitionRef>,
    scope: &ScopeId, valid_time: Option<&ValidTime>, labels: Vec<String>,
) -> Result<(), Error> {
    admission.require_access(&authorization::actual_impact(resources.into_iter().map(|resource| AccessScope {
        resources: vec![resource], fields: fields.clone(), modes: vec![AccessMode::Read],
        scope: scope.clone(), valid_time: valid_time.cloned(),
    }).collect(), vec![Effect::Pure], labels, Vec::new(), Vec::new())?)?;
    Ok(())
}

async fn current_definition(snapshot: &WorldSnapshot<'_>, id: &world_protocol::ids::DefinitionId) -> Result<Definition<DefinitionBody>, Error> {
    let row = snapshot.query_opt(
        "SELECT r.body,r.revision FROM world_definition_head h JOIN world_definition_revision r USING(tenant_id,world_id,definition_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.definition_id=$3",
        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(corrupt)?;
    let definition: Definition<DefinitionBody> = decode(row.get("body"))?;
    if definition.reference.world != *snapshot.world() || &definition.reference.id != id
        || i64::try_from(definition.reference.revision.0).ok() != Some(row.get("revision"))
    { return Err(corrupt()); }
    Ok(definition)
}
fn property_labels(body: &DefinitionBody) -> Vec<String> {
    match body { DefinitionBody::Property(property) => property.access_labels.clone(), _ => Vec::new() }
}
fn account(context: &InvocationContext, value: &impl serde::Serialize, bytes: &mut u64) -> Result<(), Error> {
    let size = serde_json::to_vec(value).map_err(|cause| corrupt().caused(cause))?.len() as u64;
    *bytes = bytes.checked_add(size).ok_or_else(invalid)?;
    if *bytes > 4_194_304 { return Err(invalid()); }
    charge(context, BudgetDimension::Rows, 1)?;
    charge(context, BudgetDimension::Bytes, size)
}
fn charge(context: &InvocationContext, dimension: BudgetDimension, amount: u64) -> Result<(), Error> {
    context.budget().charge(dimension, amount).map_err(|failure| Error::from_host_failure(
        HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Read,
    ))
}
fn decode<T: DeserializeOwned>(body: serde_json::Value) -> Result<T, Error> {
    serde_json::from_value(body).map_err(|cause| corrupt().caused(cause))
}
fn current_error(cause: crate::extensions::invocation::CurrentFailure) -> Error {
    Error::from_host_failure(cause.host_failure(), FailureStage::Read).caused(cause)
}
fn denied() -> Error {
    Error::from_host_failure(HostFailure::Authorization(AuthorizationFailure::InsufficientScope), FailureStage::Read)
}
fn corrupt() -> Error { StoreError::new(CommitFailure::InternalFault, FailureStage::Read).into() }
fn invalid() -> Error { StoreError::new(CommitFailure::InvalidBatch, FailureStage::Read).into() }
