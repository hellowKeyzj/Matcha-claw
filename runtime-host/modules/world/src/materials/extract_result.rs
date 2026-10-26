use std::{collections::BTreeMap, error::Error as StdError, fmt};

use world_protocol::{
    definitions::{Definition, DefinitionBody},
    facts::{AssertionOrigin, Evidence, EvidenceAvailability, EvidenceStatus},
    failure::FieldPath,
    generation::{
        GenerationFailure, GenerationFailureKind, GenerationReceipt, GenerationRequest, GenerationStage,
        GenerationState,
    },
    ids::{EvidenceRef, Revision},
    learning::{CandidateOrigin, ChangeStatus, LearningFailure, SemanticOperation},
    materials::{CandidateBatch, ParseArtifact, SemanticExtractRequest, SourceVersion},
};

pub(crate) struct ExtractionError {
    failure: LearningFailure,
    source: Option<Box<dyn StdError + Send + Sync>>,
}

impl ExtractionError {
    pub(crate) fn failure(&self) -> &LearningFailure {
        &self.failure
    }
}
impl fmt::Debug for ExtractionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExtractionError").finish_non_exhaustive()
    }
}
impl fmt::Display for ExtractionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("material extraction output rejected")
    }
}
impl StdError for ExtractionError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source
            .as_deref()
            .map(|cause| cause as &(dyn StdError + 'static))
    }
}

/// The Host supplies facts from its RecordedGeneration; this pure result grants no admission.
pub(super) fn finish_output(
    source: &SourceVersion,
    request: &SemanticExtractRequest,
    generation: &GenerationRequest,
    receipt: &GenerationReceipt,
    artifact: &ParseArtifact,
) -> Result<CandidateBatch, ExtractionError> {
    if generation.world != request.world
        || source.reference.world != request.world
        || request.content.chunk.source_version != source.reference
        || generation.budget != request.budget
        || receipt.binding != generation.binding
        || receipt.prompt_digest != generation.prompt.digest
        || receipt.context_digests
            != generation
                .context
                .iter()
                .map(|blob| blob.digest.clone())
                .collect::<Vec<_>>()
        || artifact.world != request.world
        || artifact.id != request.content.chunk.parse_artifact_id
        || artifact.source_version != source.reference
    {
        return Err(invalid("generation.basis"));
    }
    if receipt.state != GenerationState::Completed
        || receipt.delivery_uncertain
        || receipt.completed_at.is_none()
    {
        let kind = match receipt.state {
            GenerationState::Refused => GenerationFailureKind::Refused,
            GenerationState::Truncated => GenerationFailureKind::Truncated,
            _ => GenerationFailureKind::InvalidOutput,
        };
        return Err(output_error(receipt, kind, None));
    }
    if receipt.text.len() as u64 > request.budget.max_bytes {
        return Err(output_error(
            receipt,
            GenerationFailureKind::OutputLimit,
            None,
        ));
    }
    let mut batch: CandidateBatch = serde_json::from_str(&receipt.text).map_err(|cause| {
        output_error(
            receipt,
            GenerationFailureKind::SchemaMismatch {
                expected: generation.result_schema.clone(),
            },
            Some(Box::new(cause)),
        )
    })?;
    let count = batch
        .candidates
        .len()
        .saturating_add(batch.observations.len())
        .saturating_add(batch.evidence.len());
    if count as u64 > request.budget.max_rows {
        return Err(invalid("batch.rows"));
    }
    if request
        .content
        .coverage
        .iter()
        .any(|entry| !batch.coverage.contains(entry))
        || batch
            .coverage
            .iter()
            .any(|entry| !request.content.coverage.contains(entry))
    {
        return Err(invalid("coverage"));
    }
    let mut evidence = BTreeMap::<EvidenceRef, &Evidence>::new();
    for item in batch.evidence.iter().chain(
        batch
            .candidates
            .iter()
            .flat_map(|candidate| &candidate.evidence),
    ) {
        if let Some(previous) = evidence.insert(item.reference.clone(), item) {
            if previous != item {
                return Err(invalid("evidence.revision"));
            }
        }
        validate_evidence(source, request, artifact, item)?;
    }
    for candidate in &batch.candidates {
        if candidate.world != request.world
            || candidate.change_set.world != request.world
            || candidate.origin != CandidateOrigin::Extraction
            || candidate.change_set.status != ChangeStatus::Proposed
            || candidate.change_set.revision != Revision(1)
            || candidate.change_set.base_release != request.base_release
            || !candidate.model_calls.is_empty()
            || !candidate.change_set.cases.is_empty()
            || candidate.change_set.evidence.is_empty()
            || candidate
                .change_set
                .evidence
                .iter()
                .any(|reference| !evidence.contains_key(reference))
        {
            return Err(invalid("candidate"));
        }
    }
    for observation in &batch.observations {
        if observation.scope != request.scope.id
            || observation.evidence.is_empty()
            || observation
                .evidence
                .iter()
                .any(|reference| !evidence.contains_key(reference))
            || !matches!(&observation.origin, AssertionOrigin::Extraction { run_id, model_call_id: None } if run_id == &generation.run_id)
        {
            return Err(invalid("observation"));
        }
    }
    for need in &batch.read_needs {
        if need.source_version != request.content.chunk.source_version
            || need.parse_artifact_id != request.content.chunk.parse_artifact_id
            || need.targets.is_empty()
        {
            return Err(invalid("readNeeds"));
        }
        super::read_targets(
            artifact,
            need,
            request.budget.max_bytes,
            request.budget.max_input_tokens,
        )
        .map_err(|cause| ExtractionError {
            failure: LearningFailure::InvalidOperation {
                index: 0,
                field: FieldPath(vec!["readNeeds".into()]),
            },
            source: Some(Box::new(cause)),
        })?;
    }
    drop(evidence);
    for candidate in &mut batch.candidates {
        for operation in &mut candidate.change_set.operations {
            let definitions: &mut [Definition<DefinitionBody>] = match operation {
                SemanticOperation::CreateDefinition { definition } => {
                    std::slice::from_mut(definition.as_mut())
                }
                SemanticOperation::RefineDefinition { replacement, .. }
                | SemanticOperation::SupersedeRule { replacement, .. } => {
                    std::slice::from_mut(replacement.as_mut())
                }
                SemanticOperation::SplitDefinition { replacements, .. } => replacements,
                _ => continue,
            };
            for definition in definitions {
                definition.content_digest = crate::definitions::content_digest(definition)
                    .map_err(|failure| ExtractionError {
                        failure: LearningFailure::Definition { failure },
                        source: None,
                    })?;
            }
        }
        candidate.model_calls.push(receipt.id.clone());
        candidate.created_at = receipt
            .completed_at
            .as_ref()
            .expect("completed receipt checked")
            .clone();
    }
    for observation in &mut batch.observations {
        observation.origin = AssertionOrigin::Extraction {
            run_id: generation.run_id.clone(),
            model_call_id: Some(receipt.id.clone()),
        };
    }
    Ok(batch)
}

fn validate_evidence(
    source: &SourceVersion,
    request: &SemanticExtractRequest,
    artifact: &ParseArtifact,
    evidence: &Evidence,
) -> Result<(), ExtractionError> {
    if evidence.reference.revision != Revision(1)
        || evidence.reference.world != source.reference.world
        || evidence.locator.source_version != source.reference
        || evidence.locator.parse_artifact_id.as_ref() != Some(&artifact.id)
        || evidence.authority.is_some()
        || !evidence.derived_from.is_empty()
        || evidence.status != EvidenceStatus::Active
        || evidence.availability != EvidenceAvailability::Available
        || evidence
            .digest
            .as_ref()
            .is_some_and(|digest| digest != &source.blob.digest)
        || !request.content.source_map.iter().any(|entry| {
            crate::facts::assertions::anchor_contains(&entry.anchor, &evidence.locator.anchor)
        })
    {
        return Err(invalid("evidence"));
    }
    crate::facts::assertions::validate_evidence(evidence, source, Some(artifact), None).map_err(
        |cause| {
            let mut error = invalid("evidence.locator");
            error.source = Some(Box::new(EvidenceFailure(cause)));
            error
        },
    )
}

#[derive(Debug)]
struct EvidenceFailure(world_protocol::facts::FactFailure);
impl fmt::Display for EvidenceFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "evidence validation: {:?}", self.0)
    }
}
impl StdError for EvidenceFailure {}

fn invalid(field: &str) -> ExtractionError {
    ExtractionError {
        failure: LearningFailure::InvalidOperation {
            index: 0,
            field: FieldPath(field.split('.').map(str::to_owned).collect()),
        },
        source: None,
    }
}

fn output_error(
    receipt: &GenerationReceipt,
    kind: GenerationFailureKind,
    source: Option<Box<dyn StdError + Send + Sync>>,
) -> ExtractionError {
    ExtractionError {
        failure: LearningFailure::Model {
            failure: GenerationFailure {
                stage: GenerationStage::Output,
                kind,
                receipt: Some(Box::new(receipt.clone())),
            },
        },
        source,
    }
}
