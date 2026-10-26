use super::{Error, invalid};
use crate::{
    authorization,
    store::{StoreFuture, WorldTransaction},
};
use std::collections::BTreeSet;
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    definitions::{Definition, DefinitionBody},
    ids::{CandidateId, CaseId, EvidenceRef, ResourceRef},
    learning::{Candidate, LearningFailure, SemanticOperation},
    releases::WorldBranch,
};

type Model = Definition<DefinitionBody>;

pub(super) fn evidence_refs(candidate: &Candidate) -> BTreeSet<EvidenceRef> {
    let mut references: BTreeSet<_> = candidate.change_set.evidence.iter().cloned().collect();
    for operation in &candidate.change_set.operations {
        match operation {
            SemanticOperation::AttachEvidence { evidence, .. }
            | SemanticOperation::MergeAliases { evidence, .. } => {
                references.extend(evidence.iter().cloned())
            }
            SemanticOperation::CreateDefinition { definition } => {
                references.extend(definition.evidence.iter().cloned())
            }
            SemanticOperation::RefineDefinition { replacement, .. }
            | SemanticOperation::SupersedeRule { replacement, .. } => {
                references.extend(replacement.evidence.iter().cloned())
            }
            SemanticOperation::SplitDefinition { replacements, .. } => {
                for definition in replacements {
                    references.extend(definition.evidence.iter().cloned());
                }
            }
            _ => {}
        }
    }
    references.extend(
        candidate
            .evidence
            .iter()
            .map(|evidence| evidence.reference.clone()),
    );
    references
}

pub(super) fn case_refs(candidate: &Candidate) -> BTreeSet<CaseId> {
    let mut references: BTreeSet<_> = candidate.change_set.cases.iter().cloned().collect();
    for operation in &candidate.change_set.operations {
        let definitions: &[Model] = match operation {
            SemanticOperation::CreateDefinition { definition } => {
                std::slice::from_ref(definition.as_ref())
            }
            SemanticOperation::RefineDefinition { replacement, .. }
            | SemanticOperation::SupersedeRule { replacement, .. } => {
                std::slice::from_ref(replacement.as_ref())
            }
            SemanticOperation::SplitDefinition { replacements, .. } => replacements,
            _ => continue,
        };
        for definition in definitions {
            if let DefinitionBody::Strategy(strategy) = &definition.body {
                references.extend(strategy.cases.iter().cloned());
            }
        }
    }
    references
}

/// Reads current canonical labels before admission, never trusts labels supplied in a candidate body.
pub(crate) async fn candidate_impact(
    tx: &WorldTransaction<'_>,
    candidate: &Candidate,
    branch: &WorldBranch,
    mode: AccessMode,
) -> Result<ActualImpact, Error> {
    derive(tx, false, candidate, branch, mode).await
}

pub(crate) async fn draft_candidate_impact(
    tx: &WorldTransaction<'_>,
    candidate: &Candidate,
    branch: &WorldBranch,
    mode: AccessMode,
) -> Result<ActualImpact, Error> {
    derive(tx, true, candidate, branch, mode).await
}

pub(crate) async fn validate_draft_evidence(
    tx: &WorldTransaction<'_>,
    content: &crate::content::Content,
    loaded: &[crate::content::LoadedParse],
    candidate: &Candidate,
) -> Result<(), Error> {
    if candidate.world != *tx.world() || content.world() != tx.world() {
        return Err(LearningFailure::BasisChanged.into());
    }
    let mut seen = BTreeSet::new();
    for item in &candidate.evidence {
        if !seen.insert(&item.reference) {
            return Err(invalid(0, "candidate.evidence"));
        }
        if let Some(stored) = crate::facts::assertions::read_evidence(tx, &item.reference).await? {
            if stored != *item {
                return Err(invalid(0, "candidate.evidence"));
            }
            continue;
        }
        let version =
            crate::content::read_source_version_in_transaction(tx, &item.locator.source_version)
                .await
                .map_err(|error| Error::Evaluation(error.into()))?;
        let artifact = match &item.locator.parse_artifact_id {
            Some(id) => {
                let parsed = loaded
                    .iter()
                    .find(|parsed| {
                        let artifact = parsed.artifact();
                        &artifact.id == id
                            && artifact.world == item.reference.world
                            && artifact.source_version == item.locator.source_version
                    })
                    .ok_or_else(|| invalid(0, "candidate.evidence.locator.parseArtifactId"))?;
                crate::content::require_loaded_parse_in_transaction(tx, parsed)
                    .await
                    .map_err(|error| Error::Evaluation(error.into()))?;
                Some(parsed.artifact())
            }
            None => None,
        };
        crate::facts::assertions::validate_evidence(item, &version, artifact, None)
            .map_err(crate::facts::assertions::Error::from)?;
    }
    Ok(())
}

fn derive<'a>(
    tx: &'a WorldTransaction<'_>,
    allow_embedded: bool,
    candidate: &'a Candidate,
    branch: &'a WorldBranch,
    mode: AccessMode,
) -> StoreFuture<'a, ActualImpact, Error> {
    Box::pin(async move {
        if candidate.world != *tx.world()
            || branch.world != *tx.world()
            || branch.candidate_id != candidate.id
        {
            return Err(LearningFailure::BasisChanged.into());
        }
        let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
        let base = crate::releases::read_release(tx, &branch.basis.release_id)
            .await?
            .ok_or(LearningFailure::BasisChanged)?;
        let mut access = vec![
            scope(
                ResourceRef::ChangeSet {
                    id: candidate.change_set.id.clone(),
                },
                task.scope.clone(),
                mode,
                None,
            ),
            scope(
                ResourceRef::Task {
                    id: task.id.clone(),
                },
                task.scope.clone(),
                AccessMode::Read,
                None,
            ),
            scope(
                ResourceRef::Branch {
                    id: branch.id.clone(),
                },
                task.scope.clone(),
                mode,
                None,
            ),
        ];
        let mut labels = Vec::new();
        let mut sources = Vec::new();
        let mut effects = Vec::new();
        let mut state = Vec::new();
        if mode == AccessMode::Write {
            let (_, target) = crate::extensions::bindings::read_activation_metadata(
                tx,
                &branch.compile.activation_lock.id,
            )
            .await
            .map_err(crate::owner::Error::from)?;
            if let Some(target) = target {
                access.extend(target.access);
                labels.extend(target.labels);
                sources.extend(target.source_ids);
                effects.extend(target.effects);
                state.extend(target.state);
            }
        }
        let mut evidence = evidence_refs(candidate);
        for definition in &base.definitions {
            access.push(definition_scope(definition, AccessMode::Read));
            definition_metadata(definition, &mut evidence, &mut labels, &mut sources);
        }
        let mut changed = BTreeSet::new();
        for operation in &candidate.change_set.operations {
            match operation {
                SemanticOperation::NoOp { .. } => {}
                SemanticOperation::AttachEvidence { target, .. } => {
                    if let ResourceRef::Definition { id } = target {
                        changed.insert(id.clone());
                    } else {
                        return Err(Error::DependencyMissing {
                            capability: "branch_support_target",
                        });
                    }
                }
                SemanticOperation::EnrichAnnotation { target, .. } => {
                    changed.insert(target.id.clone());
                }
                SemanticOperation::CreateDefinition { definition } => {
                    changed.insert(definition.reference.id.clone());
                }
                SemanticOperation::RefineDefinition { previous, .. }
                | SemanticOperation::ScopeDefinition { previous, .. }
                | SemanticOperation::SupersedeRule { previous, .. }
                | SemanticOperation::DeprecateDefinition { previous, .. } => {
                    changed.insert(previous.id.clone());
                }
                SemanticOperation::LinkExisting { source, target, .. } => {
                    changed.insert(source.id.clone());
                    changed.insert(target.id.clone());
                }
                SemanticOperation::MergeAliases {
                    sources, target, ..
                } => {
                    changed.extend(sources.iter().map(|reference| reference.id.clone()));
                    changed.insert(target.id.clone());
                }
                SemanticOperation::SplitDefinition {
                    previous,
                    replacements,
                    ..
                } => {
                    changed.insert(previous.id.clone());
                    changed.extend(
                        replacements
                            .iter()
                            .map(|definition| definition.reference.id.clone()),
                    );
                }
            }
        }
        for definition in base.definitions.iter().chain(&branch.compile.definitions) {
            if changed.contains(&definition.reference.id) {
                access.push(definition_scope(definition, mode));
                definition_metadata(definition, &mut evidence, &mut labels, &mut sources);
            }
        }
        for reference in evidence {
            let embedded: Vec<_> = candidate
                .evidence
                .iter()
                .filter(|item| item.reference == reference)
                .collect();
            if embedded.len() > 1 {
                return Err(invalid(0, "candidate.evidence"));
            }
            let item = match crate::facts::assertions::read_evidence(tx, &reference).await? {
                Some(item) => {
                    if embedded.first().is_some_and(|embedded| **embedded != item) {
                        return Err(invalid(0, "candidate.evidence"));
                    }
                    item
                }
                None if allow_embedded => {
                    (**embedded
                        .first()
                        .ok_or_else(|| LearningFailure::MissingEvidence {
                            reference: reference.clone(),
                        })?)
                    .clone()
                }
                None => return Err(LearningFailure::MissingEvidence { reference }.into()),
            };
            let version =
                crate::content::read_source_version_in_transaction(tx, &item.locator.source_version)
                    .await
                    .map_err(|error| Error::Evaluation(error.into()))?;
            labels.extend(item.access.labels);
            let material = authorization::material_read_impact(tx, &version).await?;
            access.extend(material.access);
            labels.extend(material.labels);
            sources.extend(material.source_ids);
            access.push(scope(
                ResourceRef::Evidence { id: reference.id },
                task.scope.clone(),
                AccessMode::Read,
                None,
            ));
        }
        for id in &case_refs(candidate) {
            let case = crate::evaluation::read_case(tx, id)
                .await?
                .ok_or_else(|| invalid(0, "cases"))?;
            if case.task_id != task.id || case.task_revision != task.revision {
                return Err(invalid(0, "cases.task"));
            }
            let current = authorization::case_read_impact(tx, &case).await?;
            access.extend(current.access);
            labels.extend(current.labels);
            sources.extend(current.source_ids);
            labels.extend(case.access.labels);
            sources.extend(
                case.read_receipts
                    .iter()
                    .flat_map(|receipt| receipt.basis.iter().map(|source| source.source_id.clone())),
            );
            sources.extend(
                case.source_receipts
                    .iter()
                    .map(|receipt| receipt.source_id.clone()),
            );
            access.push(scope(
                ResourceRef::Case { id: id.clone() },
                task.scope.clone(),
                AccessMode::Read,
                None,
            ));
        }
        for source in &branch.basis.sources {
            sources.push(source.source_id.clone());
            if source.snapshot.is_some() {
                for version in crate::sources::sync::branch_snapshot_materials(tx, branch, source)
                    .await
                    .map_err(|error| Error::Release(Box::new(error.into())))?
                {
                    let material = authorization::material_read_impact(tx, &version).await?;
                    access.extend(material.access);
                    labels.extend(material.labels);
                    sources.extend(material.source_ids);
                }
            }
        }
        if let Some((_, stored)) = crate::releases::read_candidate(tx, &candidate.id).await? {
            if stored.model_calls != candidate.model_calls {
                return Err(invalid(0, "modelCalls"));
            }
            for actual in super::provenance::impacts(tx, &stored).await? {
                access.extend(actual.access);
                labels.extend(actual.labels);
                sources.extend(actual.source_ids);
                effects.extend(actual.effects);
                state.extend(actual.state);
            }
        }
        Ok(authorization::actual_impact(
            access, effects, labels, state, sources,
        )?)
    })
}

pub(crate) async fn candidate_read_impact(
    tx: &WorldTransaction<'_>,
    id: &CandidateId,
) -> Result<ActualImpact, Error> {
    let (branch, candidate) = crate::releases::read_candidate(tx, id)
        .await?
        .ok_or(LearningFailure::BasisChanged)?;
    candidate_impact(tx, &candidate, &branch, AccessMode::Read).await
}

fn scope(
    resource: ResourceRef,
    scope: world_protocol::ids::ScopeId,
    mode: AccessMode,
    valid_time: Option<world_protocol::time::ValidTime>,
) -> AccessScope {
    AccessScope {
        resources: vec![resource],
        fields: Vec::new(),
        modes: vec![mode],
        scope,
        valid_time,
    }
}
fn definition_scope(definition: &Model, mode: AccessMode) -> AccessScope {
    scope(
        ResourceRef::Definition {
            id: definition.reference.id.clone(),
        },
        definition.scope.clone(),
        mode,
        Some(definition.valid_time.clone()),
    )
}
fn definition_metadata(
    definition: &Model,
    evidence: &mut BTreeSet<EvidenceRef>,
    labels: &mut Vec<String>,
    sources: &mut Vec<world_protocol::ids::SourceId>,
) {
    evidence.extend(definition.evidence.iter().cloned());
    if let DefinitionBody::Property(property) = &definition.body {
        labels.extend(property.access_labels.iter().cloned());
    }
    if let DefinitionBody::SourceBinding(binding) = &definition.body {
        sources.push(binding.source_id.clone());
    }
}
