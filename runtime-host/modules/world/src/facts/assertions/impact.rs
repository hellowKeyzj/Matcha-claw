use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    expression::Effect,
    facts::{AssertionOrigin, Claim, Evidence, FactFailure, ObservationDraft},
    identity::SubjectRef,
    ids::{AssertionId, DefinitionRef, ResourceRef, ScopeId, SourceId},
};

use crate::{
    authorization::{Admission, actual_impact, recheck},
    store::WorldTransaction,
};

use super::{Error, read::claim_subjects};

pub(crate) fn observation_impact(
    id: &AssertionId,
    draft: &ObservationDraft,
) -> Result<ActualImpact, Error> {
    let predicate = match &draft.claim {
        Claim::Attribute(claim) => &claim.property,
        Claim::Relation(claim) => &claim.relation_type,
    };
    let mut sources = Vec::new();
    let mut dependencies = vec![ResourceRef::Definition {
        id: predicate.id.clone(),
    }];
    match &draft.origin {
        AssertionOrigin::Source {
            binding, position, ..
        } => {
            dependencies.push(ResourceRef::Definition {
                id: binding.id.clone(),
            });
            if let Some(position) = position {
                sources.push(position.source_id.clone());
            }
        }
        _ => {}
    }
    dependencies.extend(draft.evidence.iter().map(|evidence| ResourceRef::Evidence {
        id: evidence.id.clone(),
    }));
    let mut access = vec![AccessScope {
        resources: vec![ResourceRef::Assertion { id: id.clone() }],
        fields: vec![predicate.clone()],
        modes: vec![AccessMode::Write],
        scope: draft.scope.clone(),
        valid_time: Some(draft.valid_time.clone()),
    }];
    for subject in claim_subjects(&draft.claim) {
        access.push(AccessScope {
            resources: vec![subject_resource(&subject)],
            fields: vec![predicate.clone()],
            modes: vec![AccessMode::Read],
            scope: draft.scope.clone(),
            valid_time: Some(draft.valid_time.clone()),
        });
    }
    access.extend(dependencies.into_iter().map(|resource| AccessScope {
        fields: if matches!(resource, ResourceRef::Evidence { .. }) {
            Vec::new()
        } else {
            vec![predicate.clone()]
        },
        resources: vec![resource],
        modes: vec![AccessMode::Read],
        scope: draft.scope.clone(),
        valid_time: Some(draft.valid_time.clone()),
    }));
    Ok(actual_impact(
        access,
        vec![Effect::Pure],
        Vec::new(),
        Vec::new(),
        sources,
    )?)
}

pub(crate) async fn admission_impact(
    tx: &WorldTransaction<'_>,
    id: &AssertionId,
    draft: &ObservationDraft,
) -> Result<ActualImpact, Error> {
    observation_admission_impact(tx, id, draft, None).await
}

pub(crate) async fn extracted_observation_impact(
    tx: &WorldTransaction<'_>,
    proof: &crate::owner::DraftObservation,
) -> Result<ActualImpact, Error> {
    if proof.reference().world != *tx.world() || proof.request().world != *tx.world() {
        return Err(FactFailure::CrossWorld.into());
    }
    let id = super::observation_id(tx.world(), proof.draft())?;
    observation_admission_impact(tx, &id, proof.draft(), Some(proof.evidence())).await
}

async fn observation_admission_impact(
    tx: &WorldTransaction<'_>,
    id: &AssertionId,
    draft: &ObservationDraft,
    pending: Option<&[Evidence]>,
) -> Result<ActualImpact, Error> {
    let mut impact = observation_impact(id, draft)?;
    let predicate = match &draft.claim {
        Claim::Attribute(claim) => &claim.property,
        Claim::Relation(claim) => &claim.relation_type,
    };
    let read = super::claim::ClaimRead::transaction(tx).await?;
    let definition = read.definition(predicate, &draft.valid_time).await?;
    if let world_protocol::definitions::DefinitionBody::Property(property) = definition.body {
        impact.labels.extend(property.access_labels);
    }
    for reference in &draft.evidence {
        let expected = pending
            .map(|items| {
                items.iter().find(|item| item.reference == *reference).ok_or_else(|| {
                    FactFailure::EvidenceMissing { reference: reference.clone() }
                })
            })
            .transpose()?;
        let stored = super::read::read_evidence(tx, reference).await?;
        let unstored = stored.is_none();
        let exact = match (stored, expected) {
            (Some(stored), Some(expected)) if stored != *expected => {
                return Err(FactFailure::EvidenceIncomplete { reference: reference.clone() }.into());
            }
            (Some(stored), _) => stored,
            (None, Some(expected)) => expected.clone(),
            (None, None) => {
                return Err(FactFailure::EvidenceMissing { reference: reference.clone() }.into());
            }
        };
        let head = super::read::peek_evidence_head(tx, &reference.id).await?;
        if head.is_none() && !(unstored && expected.is_some()) {
            return Err(FactFailure::EvidenceMissing { reference: reference.clone() }.into());
        }
        for evidence in std::iter::once(&exact)
            .chain(head.as_ref().filter(|head| head.reference != exact.reference))
        {
            impact.labels.extend(evidence.access.labels.clone());
            impact
                .source_ids
                .push(evidence.locator.source_version.source_id.clone());
            impact.access.push(AccessScope {
                resources: vec![ResourceRef::Source {
                    id: evidence.locator.source_version.source_id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: draft.scope.clone(),
                valid_time: Some(draft.valid_time.clone()),
            });
            let source =
                crate::content::read_source_version_metadata(tx, &evidence.locator.source_version)
                    .await
                    .map_err(|error| super::evidence_write::material_error(error, reference))?;
            let material = crate::authorization::material_read_impact(tx, &source).await?;
            impact.access.extend(material.access);
            impact.effects.extend(material.effects);
            impact.labels.extend(material.labels);
            impact.state.extend(material.state);
            impact.source_ids.extend(material.source_ids);
        }
    }
    Ok(actual_impact(
        impact.access,
        impact.effects,
        impact.labels,
        impact.state,
        impact.source_ids,
    )?)
}

pub(super) fn evidence_impact(evidence: &Evidence, scope: &ScopeId) -> Result<ActualImpact, Error> {
    let mut access = vec![AccessScope {
        resources: vec![ResourceRef::Evidence {
            id: evidence.reference.id.clone(),
        }],
        fields: Vec::new(),
        modes: vec![
            if evidence.status == world_protocol::facts::EvidenceStatus::ContentDeleted {
                AccessMode::Delete
            } else {
                AccessMode::Write
            },
        ],
        scope: scope.clone(),
        valid_time: None,
    }];
    access.push(AccessScope {
        resources: vec![ResourceRef::Source {
            id: evidence.locator.source_version.source_id.clone(),
        }],
        fields: Vec::new(),
        modes: vec![AccessMode::Read],
        scope: scope.clone(),
        valid_time: None,
    });
    access.extend(evidence.derived_from.iter().map(|parent| AccessScope {
        resources: vec![ResourceRef::Evidence {
            id: parent.id.clone(),
        }],
        fields: Vec::new(),
        modes: vec![AccessMode::Read],
        scope: scope.clone(),
        valid_time: None,
    }));
    Ok(actual_impact(
        access,
        vec![Effect::Pure],
        evidence.access.labels.clone(),
        Vec::new(),
        vec![evidence.locator.source_version.source_id.clone()],
    )?)
}

pub(super) async fn authorize(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    impact: &ActualImpact,
    now: &world_protocol::time::Timestamp,
) -> Result<world_protocol::authorization::Decision, Error> {
    if &admission.invocation().world != tx.world() {
        return Err(world_protocol::facts::FactFailure::AccessDenied.into());
    }
    admission.require_access(impact)?;
    Ok(recheck(tx, admission, now).await?)
}

pub(super) fn resource_read_impact(
    resource: ResourceRef,
    fields: Vec<DefinitionRef>,
    scope: &ScopeId,
    valid_time: Option<&world_protocol::time::ValidTime>,
    labels: Vec<String>,
    source: Option<SourceId>,
) -> Result<ActualImpact, Error> {
    Ok(actual_impact(
        vec![AccessScope {
            resources: vec![resource],
            fields,
            modes: vec![AccessMode::Read],
            scope: scope.clone(),
            valid_time: valid_time.cloned(),
        }],
        vec![Effect::Pure],
        labels,
        Vec::new(),
        source.into_iter().collect(),
    )?)
}

fn subject_resource(subject: &SubjectRef) -> ResourceRef {
    match subject {
        SubjectRef::Object { id } => ResourceRef::Object { id: id.clone() },
        SubjectRef::Relation { id } => ResourceRef::Relation { id: id.clone() },
    }
}
