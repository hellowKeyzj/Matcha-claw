use std::collections::BTreeSet;

use world_protocol::{
    facts::{Assertion, Claim, ObservationDraft},
    identity::{IdentityChangeProposal, IdentityFailure, SubjectRef},
    value::Value,
};

use super::{IdentityError, contains, overlaps, validate_interval};

pub(crate) struct RemappedObservation<'a> {
    original: &'a Assertion,
    draft: &'a ObservationDraft,
}
impl RemappedObservation<'_> {
    pub(crate) fn original(&self) -> &Assertion { self.original }
    pub(crate) fn draft(&self) -> &ObservationDraft { self.draft }
}

pub(super) fn validated<'a>(
    proposal: &IdentityChangeProposal, original: &'a Assertion, drafts: &[&'a ObservationDraft],
) -> Result<Vec<RemappedObservation<'a>>, IdentityError> {
    validate_drafts(proposal, original, drafts)?;
    Ok(drafts.iter().map(|draft| RemappedObservation { original, draft }).collect())
}

fn validate_drafts(
    proposal: &IdentityChangeProposal, original: &Assertion, drafts: &[&ObservationDraft],
) -> Result<(), IdentityError> {
    if drafts.is_empty() { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    let mut encoded = BTreeSet::new();
    for draft in drafts {
        validate_interval(&draft.valid_time)?;
        if !contains(&original.valid_time, &draft.valid_time) || draft.scope != original.scope
            || draft.polarity != original.polarity || draft.evidence != original.evidence
            || draft.origin != original.origin || draft.supersedes.is_some() {
            return Err(IdentityFailure::CandidateScopeIncomplete.into());
        }
        if !encoded.insert(serde_json::to_string(draft).map_err(|_| IdentityFailure::InternalFault)?) {
            return Err(IdentityFailure::CandidateScopeIncomplete.into());
        }
        if overlaps(&draft.valid_time, &proposal.valid_time) {
            if !contains(&proposal.valid_time, &draft.valid_time) || !mapped_claim(proposal, &original.claim, &draft.claim) {
                return Err(IdentityFailure::CandidateScopeIncomplete.into());
            }
        } else if draft.claim != original.claim { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    }
    // Withdrawing the old head must not erase portions outside the operation interval.
    let mut intervals: Vec<_> = drafts.iter().map(|draft| &draft.valid_time).collect();
    intervals.sort_unstable_by(|left, right| left.from.cmp(&right.from));
    let mut cursor = original.valid_time.from.clone();
    let mut unbounded = false;
    for interval in intervals {
        if interval.from > cursor { return Err(IdentityFailure::InvalidInterval.into()); }
        match &interval.to {
            None => { unbounded = true; break; }
            Some(to) if to > &cursor => cursor = to.clone(),
            _ => {}
        }
    }
    if !(unbounded || original.valid_time.to.as_ref().is_some_and(|to| &cursor == to)) {
        return Err(IdentityFailure::InvalidInterval.into());
    }
    Ok(())
}

fn allowed(proposal: &IdentityChangeProposal, original: &SubjectRef, replacement: &SubjectRef) -> bool {
    match proposal.remapping.iter().find(|mapping| &mapping.original == original) {
        Some(mapping) => mapping.replacements.contains(replacement),
        None => original == replacement,
    }
}

fn mapped_claim(proposal: &IdentityChangeProposal, original: &Claim, replacement: &Claim) -> bool {
    match (original, replacement) {
        (Claim::Attribute(original), Claim::Attribute(replacement)) => original.property == replacement.property
            && allowed(proposal, &original.subject, &replacement.subject) && mapped_value(proposal, &original.value, &replacement.value),
        (Claim::Relation(original), Claim::Relation(replacement)) => original.relation_type == replacement.relation_type
            && allowed(proposal, &SubjectRef::Relation { id: original.relation_id.clone() }, &SubjectRef::Relation { id: replacement.relation_id.clone() })
            && original.roles.len() == replacement.roles.len()
            && original.roles.iter().zip(&replacement.roles).all(|(original, replacement)| original.role == replacement.role
                && allowed(proposal, &SubjectRef::Object { id: original.object_id.clone() }, &SubjectRef::Object { id: replacement.object_id.clone() })),
        _ => false,
    }
}

fn mapped_value(proposal: &IdentityChangeProposal, original: &Value, replacement: &Value) -> bool {
    let mut pending = vec![(original, replacement)];
    while let Some((original, replacement)) = pending.pop() {
        match (original, replacement) {
            (Value::Object { id: original }, Value::Object { id: replacement }) => {
                if !allowed(proposal, &SubjectRef::Object { id: original.clone() }, &SubjectRef::Object { id: replacement.clone() }) { return false; }
            }
            (Value::Relation { id: original }, Value::Relation { id: replacement }) => {
                if !allowed(proposal, &SubjectRef::Relation { id: original.clone() }, &SubjectRef::Relation { id: replacement.clone() }) { return false; }
            }
            (Value::List { items: original }, Value::List { items: replacement }) if original.len() == replacement.len() => pending.extend(original.iter().zip(replacement)),
            (Value::Record { fields: original }, Value::Record { fields: replacement }) if original.keys().eq(replacement.keys()) => pending.extend(original.values().zip(replacement.values())),
            _ if original == replacement => {}
            _ => return false,
        }
    }
    true
}
