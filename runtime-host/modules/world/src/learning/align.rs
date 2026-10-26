mod graph;
pub(super) mod references;

use std::collections::BTreeMap;

use super::{Error, invalid, materialize};
use world_protocol::{
    definitions::{Definition, DefinitionBody},
    facts::Evidence,
    ids::EvidenceRef,
    learning::{Candidate, ChangeStatus, LearningFailure, SemanticOperation},
    materials::CandidateBatch,
    releases::Release,
};

type Model = Definition<DefinitionBody>;

/// Align every chunk together against one exact release; names never establish identity.
/// Draft identity and timestamps are supplied by the trusted material run, not the model.
pub(crate) fn align(
    base: &Release,
    batches: &[CandidateBatch],
    draft: &Candidate,
) -> Result<CandidateBatch, Error> {
    if draft.world != base.world
        || draft.change_set.world != base.world
        || draft.change_set.base_release != base.id
        || draft.change_set.status != ChangeStatus::Proposed
        || draft.change_set.revision.0 != 1
        || !draft.change_set.operations.is_empty()
    {
        return Err(invalid(0, "draft"));
    }
    let mut candidate = draft.clone();
    let mut evidence: BTreeMap<EvidenceRef, Evidence> = BTreeMap::new();
    let mut observations: Vec<world_protocol::facts::ObservationDraft> = Vec::new();
    let mut coverage = Vec::new();
    let mut read_needs = Vec::new();
    for batch in batches {
        for item in &batch.evidence {
            insert_evidence(&mut evidence, item)?;
        }
        for observation in &batch.observations {
            if let Some(old) = observations.iter_mut().find(|old| {
                old.claim == observation.claim
                    && old.polarity == observation.polarity
                    && old.scope == observation.scope
                    && old.valid_time == observation.valid_time
                    && old.observed_at == observation.observed_at
                    && old.origin == observation.origin
                    && old.supersedes == observation.supersedes
            }) {
                old.evidence.extend(observation.evidence.iter().cloned());
                old.evidence.sort();
                old.evidence.dedup();
            } else {
                observations.push(observation.clone());
            }
        }
        for entry in &batch.coverage {
            if !coverage.contains(entry) {
                coverage.push(entry.clone());
            }
        }
        for need in &batch.read_needs {
            if !read_needs.contains(need) {
                read_needs.push(need.clone());
            }
        }
        for part in &batch.candidates {
            if part.world != base.world
                || part.change_set.world != base.world
                || part.change_set.base_release != base.id
                || part.change_set.status != ChangeStatus::Proposed
                || part.change_set.revision.0 != 1
                || part.origin != draft.origin
            {
                return Err(invalid(0, "candidate.basis"));
            }
            for item in &part.evidence {
                insert_evidence(&mut evidence, item)?;
            }
            candidate
                .change_set
                .evidence
                .extend(part.change_set.evidence.iter().cloned());
            candidate
                .change_set
                .cases
                .extend(part.change_set.cases.iter().cloned());
            candidate
                .model_calls
                .extend(part.model_calls.iter().cloned());
            for operation in &part.change_set.operations {
                if !candidate.change_set.operations.contains(operation) {
                    candidate.change_set.operations.push(operation.clone());
                }
            }
        }
    }
    if batches.iter().all(|batch| batch.candidates.is_empty()) {
        return Ok(CandidateBatch {
            candidates: Vec::new(),
            observations,
            evidence: evidence.into_values().collect(),
            coverage,
            read_needs,
        });
    }
    for (index, operation) in candidate.change_set.operations.iter().enumerate() {
        let models: &[Model] = match operation {
            SemanticOperation::CreateDefinition { definition } => std::slice::from_ref(definition.as_ref()),
            SemanticOperation::RefineDefinition { replacement, .. }
            | SemanticOperation::SupersedeRule { replacement, .. } => std::slice::from_ref(replacement.as_ref()),
            SemanticOperation::SplitDefinition { replacements, .. } => replacements,
            _ => continue,
        };
        for model in models {
            if model.content_digest != crate::definitions::content_digest(model)? {
                return Err(invalid(index, "definition.contentDigest"));
            }
        }
    }
    let mut alignment = graph::align(base, &candidate.change_set.operations)?;
    let mut operations = Vec::new();
    let mut attachments = BTreeMap::<_, Vec<_>>::new();
    for operation in &candidate.change_set.operations {
        if let SemanticOperation::CreateDefinition { definition } = operation {
            if let Some(existing) = alignment.target(&definition.reference) {
                attachments.entry(existing.id.clone()).or_default()
                    .extend(definition.evidence.iter().cloned());
                continue;
            }
        }
        let mut operation = operation.clone();
        references::operation(&mut operation, &mut alignment);
        reseal(&mut operation)?;
        match &operation {
            SemanticOperation::NoOp { .. } => continue,
            SemanticOperation::AttachEvidence {
                target: world_protocol::ids::ResourceRef::Definition { id }, evidence,
            } => {
                attachments.entry(id.clone()).or_default().extend(evidence.iter().cloned());
                continue;
            }
            _ => {}
        }
        if !operations.contains(&operation) { operations.push(operation); }
    }
    for (id, mut evidence) in attachments {
        evidence.sort();
        evidence.dedup();
        if !evidence.is_empty() {
            operations.push(SemanticOperation::AttachEvidence {
                target: world_protocol::ids::ResourceRef::Definition { id }, evidence,
            });
        }
    }
    let mut aligned_observations: Vec<world_protocol::facts::ObservationDraft> = Vec::new();
    for mut observation in observations {
        references::observation(&mut observation, &mut alignment);
        if let Some(old) = aligned_observations.iter_mut().find(|old| {
            old.claim == observation.claim && old.polarity == observation.polarity
                && old.scope == observation.scope && old.valid_time == observation.valid_time
                && old.observed_at == observation.observed_at && old.origin == observation.origin
                && old.supersedes == observation.supersedes
        }) {
            old.evidence.extend(observation.evidence);
            old.evidence.sort();
            old.evidence.dedup();
        } else { aligned_observations.push(observation); }
    }
    let observations = aligned_observations;
    if operations.is_empty() {
        operations.push(SemanticOperation::NoOp {
            reason: "已有语义已覆盖本次材料，无需新增定义。".into(),
        });
    }
    candidate.change_set.operations = operations;
    candidate
        .change_set
        .evidence
        .extend(evidence.keys().cloned());
    candidate.change_set.evidence.sort();
    candidate.change_set.evidence.dedup();
    candidate.change_set.cases.sort();
    candidate.change_set.cases.dedup();
    candidate.model_calls.sort();
    candidate.model_calls.dedup();
    candidate.evidence = evidence.values().cloned().collect();
    materialize(
        &base.world,
        &base.definitions,
        &base.scopes,
        &candidate.change_set.operations,
    )?;
    Ok(CandidateBatch {
        candidates: vec![candidate],
        observations,
        evidence: evidence.into_values().collect(),
        coverage,
        read_needs,
    })
}

fn insert_evidence(
    items: &mut BTreeMap<EvidenceRef, Evidence>,
    item: &Evidence,
) -> Result<(), Error> {
    if items.get(&item.reference).is_some_and(|old| old != item) {
        return Err(LearningFailure::BasisChanged.into());
    }
    items.insert(item.reference.clone(), item.clone());
    Ok(())
}
fn reseal(operation: &mut SemanticOperation) -> Result<(), Error> {
    let models: &mut [Model] = match operation {
        SemanticOperation::CreateDefinition { definition } => std::slice::from_mut(definition.as_mut()),
        SemanticOperation::RefineDefinition { replacement, .. }
        | SemanticOperation::SupersedeRule { replacement, .. } => std::slice::from_mut(replacement.as_mut()),
        SemanticOperation::SplitDefinition { replacements, .. } => replacements,
        _ => return Ok(()),
    };
    for model in models {
        model.dependencies.sort();
        model.dependencies.dedup();
        model.content_digest = crate::definitions::content_digest(model)?;
    }
    Ok(())
}
