use world_protocol::{
    facts::{Assertion, AssertionStatus, Claim, FactFailure, ObservationDraft},
    ids::{AssertionId, AssertionRef, Revision, WorldRef},
    time::{Timestamp, ValidTime},
};

pub(crate) fn observation_id(
    world: &WorldRef,
    draft: &ObservationDraft,
) -> Result<AssertionId, super::Error> {
    if let Some(reference) = &draft.supersedes {
        if reference.world != *world {
            return Err(FactFailure::CrossWorld.into());
        }
        return Ok(reference.id.clone());
    }
    let digest = crate::definitions::canonical_digest(&("world.observation.v1", world, draft))?;
    AssertionId::try_new(format!("observation-{}", &digest.as_str()[7..]))
        .map_err(|cause| super::Error::caused_by(FactFailure::InternalFault, cause))
}

/// Builds a candidate only. Current authorization and evidence admission must precede acceptance.
pub(crate) fn candidate(
    reference: AssertionRef,
    observation: ObservationDraft,
    recorded_at: Timestamp,
    previous: Option<&Assertion>,
) -> Result<Assertion, FactFailure> {
    validate_interval(&observation.valid_time)?;
    if observation.observed_at > recorded_at {
        return Err(FactFailure::InvalidRecordedTime);
    }
    match previous {
        Some(previous) => {
            if reference.world != previous.reference.world {
                return Err(FactFailure::CrossWorld);
            }
            if reference.id != previous.reference.id
                || observation.supersedes.as_ref() != Some(&previous.reference)
                || !same_claim_identity(&observation.claim, &previous.claim)
            {
                return Err(FactFailure::SupersedesMismatch {
                    expected: previous.reference.clone(),
                });
            }
            let expected = previous.reference.revision.0.checked_add(1);
            if expected != Some(reference.revision.0) {
                return Err(FactFailure::RevisionConflict {
                    expected: Revision(expected.unwrap_or(u64::MAX)),
                    actual: reference.revision,
                });
            }
            if recorded_at < previous.recorded_at || previous.superseded_at.is_some() {
                return Err(FactFailure::InvalidRecordedTime);
            }
        }
        None => {
            if let Some(supersedes) = &observation.supersedes {
                return Err(FactFailure::SupersedesMismatch {
                    expected: supersedes.clone(),
                });
            }
            if reference.revision != Revision(1) {
                return Err(FactFailure::RevisionConflict {
                    expected: Revision(1),
                    actual: reference.revision,
                });
            }
        }
    }
    let definition = match &observation.claim {
        Claim::Attribute(claim) => &claim.property,
        Claim::Relation(claim) => &claim.relation_type,
    };
    if definition.world != reference.world
        || observation
            .evidence
            .iter()
            .any(|evidence| evidence.world != reference.world)
    {
        return Err(FactFailure::CrossWorld);
    }
    Ok(Assertion {
        reference,
        scope: observation.scope,
        claim: observation.claim,
        polarity: observation.polarity,
        valid_time: observation.valid_time,
        recorded_at,
        superseded_at: None,
        status: AssertionStatus::Candidate,
        origin: observation.origin,
        evidence: observation.evidence,
        supersedes: observation.supersedes,
    })
}

pub(super) fn same_claim_identity(left: &Claim, right: &Claim) -> bool {
    match (left, right) {
        (Claim::Attribute(left), Claim::Attribute(right)) => {
            left.subject == right.subject
                && left.property.world == right.property.world
                && left.property.id == right.property.id
        }
        (Claim::Relation(left), Claim::Relation(right)) => {
            left.relation_id == right.relation_id
                && left.relation_type.world == right.relation_type.world
                && left.relation_type.id == right.relation_type.id
        }
        _ => false,
    }
}

pub(super) fn validate_interval(interval: &ValidTime) -> Result<(), FactFailure> {
    if interval.to.as_ref().is_some_and(|to| to <= &interval.from) {
        return Err(FactFailure::ValidTimeMismatch);
    }
    Ok(())
}
