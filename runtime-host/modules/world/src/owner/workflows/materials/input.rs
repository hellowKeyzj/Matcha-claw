use std::collections::BTreeMap;

use sha2::{Digest as _, Sha256};
use world_protocol::{
    api::ApiFailure,
    facts::{AssertionOrigin, Evidence, ObservationDraft},
    failure::Recovery,
};

use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Acquired {
    pub(super) source: SourceVersion,
    pub(super) name: String,
    pub(super) pin: Option<BlobPin>,
}

impl Acquired {
    pub(crate) fn source(&self) -> &SourceVersion {
        &self.source
    }

    pub(crate) fn pin(&self) -> Option<&BlobPin> {
        self.pin.as_ref()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Parsed {
    pub(super) sources: Vec<SourceVersion>,
    pub(super) artifacts: Vec<ParseArtifactId>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParseDocumentCheckpoint {
    acquired: Acquired,
    receipt: world_protocol::commit::CommitReceipt,
    plan: ParsePlan,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParseCheckpoint {
    implementation: materials::MaterialImplementation,
    documents: Vec<ParseDocumentCheckpoint>,
}

/// Decode only the original durable parse claim; callers fresh-read run/step and authority.
pub(crate) fn read_material_implementation(
    step: &StepRecord,
) -> Result<materials::MaterialImplementation, Error> {
    let expected = StepId::try_new(key_digest(&(&step.run_id, "parse"))?).map_err(codec)?;
    if step.kind != "materials.parse" || step.ordinal != 0 || step.id != expected {
        return Err(invalid());
    }
    if step.checkpoint.is_null() {
        return Err(Error::new(
            "world.material.implementation_unavailable", FailureStage::Prepare,
            "原材料执行工件未保存，不能改用当前实现恢复。",
            ApiFailure::Operation(world_protocol::operation::OperationFailure::Material(MaterialFailure::ParserUnavailable)),
            Recovery::ManualReview,
        ));
    }
    let checkpoint: ParseCheckpoint = decode(step.checkpoint.clone())?;
    if checkpoint.documents.is_empty() { return Err(invalid()); }
    let dependencies: Vec<_> = checkpoint.implementation.native_files.iter().map(|file| file.digest.clone()).collect();
    let mut artifacts = BTreeSet::new();
    for document in &checkpoint.documents {
        let expected = key_digest(&(&step.run_id, &document.acquired.source.reference, &document.plan.parser_fingerprint))?;
        if document.plan.parse_run != step.run_id
            || document.plan.parser_fingerprint != checkpoint.implementation.implementation.artifact_digest
            || document.plan.dependency_fingerprints != dependencies
            || document.plan.id.as_str() != expected
            || !artifacts.insert(document.plan.id.clone())
            || document.acquired.source.reference.world != document.receipt.world
            || document.acquired.pin.as_ref().is_none_or(|pin| pin.reference() != &document.acquired.source.blob)
        { return Err(invalid()); }
    }
    Ok(checkpoint.implementation)
}

/// Minted only from the stored alignment and its accepted extraction provenance.
pub(crate) struct DraftObservation {
    reference: MaterialDraftRef,
    draft: ObservationDraft,
    request: GenerationRequest,
    model_call_id: ModelCallId,
    sources: Vec<SourceVersionRef>,
    evidence: Vec<Evidence>,
}

impl DraftObservation {
    pub(crate) fn reference(&self) -> &MaterialDraftRef {
        &self.reference
    }

    pub(crate) fn draft(&self) -> &ObservationDraft {
        &self.draft
    }

    pub(crate) fn request(&self) -> &GenerationRequest {
        &self.request
    }

    pub(crate) fn model_call_id(&self) -> &ModelCallId {
        &self.model_call_id
    }

    pub(crate) fn sources(&self) -> &[SourceVersionRef] {
        &self.sources
    }

    pub(crate) fn evidence(&self) -> &[Evidence] {
        &self.evidence
    }
}

/// Minted only from an exact stored draft and its accepted extraction steps.
pub(crate) struct DraftModelCalls {
    reference: MaterialDraftRef,
    candidate: Candidate,
    calls: Vec<(ModelCallId, GenerationRequest, Vec<SourceVersionRef>)>,
}

impl DraftModelCalls {
    pub(crate) fn reference(&self) -> &MaterialDraftRef {
        &self.reference
    }

    pub(crate) fn candidate(&self) -> &Candidate {
        &self.candidate
    }

    pub(crate) fn accepts(&self, request: &GenerationRequest, id: &ModelCallId) -> bool {
        self.sources(request, id).is_some()
    }

    pub(crate) fn sources(
        &self,
        request: &GenerationRequest,
        id: &ModelCallId,
    ) -> Option<&[SourceVersionRef]> {
        self.calls.iter().find_map(|(accepted, saved, sources)| {
            (accepted == id && saved == request).then_some(sources.as_slice())
        })
    }
}

pub(crate) async fn read_draft_model_calls(
    tx: &WorldTransaction<'_>,
    reference: &MaterialDraftRef,
    candidate_id: &CandidateId,
) -> Result<DraftModelCalls, Error> {
    let (draft, budget) = read_aligned_draft(tx, reference).await?;
    let mut matching = draft
        .batch
        .candidates
        .iter()
        .filter(|candidate| candidate.id == *candidate_id);
    let candidate = matching.next().ok_or_else(invalid)?.clone();
    let expected: BTreeSet<_> = candidate.model_calls.iter().cloned().collect();
    if matching.next().is_some()
        || expected.is_empty()
        || expected.len() != candidate.model_calls.len()
    {
        return Err(invalid());
    }
    let rows = tx.query(
        "SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND kind='materials.extract' AND phase='completed' ORDER BY ordinal FOR UPDATE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.run_id.as_str()],
    ).await?;
    let mut calls = Vec::new();
    let mut accepted = BTreeSet::new();
    for row in rows {
        let step: StepRecord = decode(row.get("body"))?;
        if step.kind != "materials.extract"
            || step.phase != OperationPhase::Completed
            || step.run_id != reference.run_id
        {
            return Err(invalid());
        }
        let checkpoint: extract::ExtractCheckpoint = decode(step.checkpoint.clone())?;
        let request = &checkpoint.request;
        let generation = &checkpoint.generation;
        let chunk = &request.content.chunk;
        if step.input_digest != canonical_digest(request)?
            || request.world != reference.world
            || request.base_release != draft.base_release
            || request.scope.world != reference.world
            || request.scope.id != draft.scope
            || request.budget != budget
            || generation.world != reference.world
            || generation.run_id != reference.run_id
            || generation.step_id != step.id
            || generation.budget != budget
            || !draft
                .source_versions
                .iter()
                .zip(&draft.parse_artifacts)
                .any(|(source, artifact)| {
                    chunk.source_version == *source && chunk.parse_artifact_id == *artifact
                })
        {
            return Err(invalid());
        }
        let batch: CandidateBatch = result(&step)?;
        for part in batch.candidates {
            if part.world != reference.world
                || part.origin != CandidateOrigin::Extraction
                || part.change_set.world != reference.world
                || part.change_set.base_release != draft.base_release
                || part.model_calls.len() != 1
            {
                return Err(invalid());
            }
            let id = &part.model_calls[0];
            if expected.contains(id) && accepted.insert(id.clone()) {
                calls.push((
                    id.clone(),
                    generation.clone(),
                    vec![chunk.source_version.clone()],
                ));
            } else if expected.contains(id)
                && !calls
                    .iter()
                    .any(|(stored, request, _)| stored == id && request == generation)
            {
                return Err(invalid());
            }
        }
    }
    if accepted != expected {
        return Err(invalid());
    }
    Ok(DraftModelCalls {
        reference: reference.clone(),
        candidate,
        calls,
    })
}

pub(crate) async fn read_draft_observations(
    tx: &WorldTransaction<'_>,
    reference: &MaterialDraftRef,
) -> Result<Vec<DraftObservation>, Error> {
    let (draft, budget) = read_aligned_draft(tx, reference).await?;
    let step = read_step(tx, &reference.run_id, &reference.step_id)
        .await?
        .ok_or_else(invalid)?;
    if step.ordinal != 2 || step.failure.is_some()
        || !matches!(step.phase, OperationPhase::Running | OperationPhase::Completed)
    {
        return Err(invalid());
    }
    if draft.batch.observations.is_empty() {
        return Ok(Vec::new());
    }
    let base = crate::releases::read_release(tx, &draft.base_release)
        .await?
        .ok_or_else(invalid)?;
    let scope = crate::definitions::read_scopes(tx, &[draft.scope.clone()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(invalid)?;
    let binding_id = StepId::try_new(key_digest(&(&reference.run_id, "binding"))?).map_err(codec)?;
    let binding = read_step(tx, &reference.run_id, &binding_id).await?.ok_or_else(invalid)?;
    if binding.kind != "materials.binding" || binding.ordinal != 1
        || binding.phase != OperationPhase::Completed || binding.failure.is_some()
    {
        return Err(invalid());
    }
    let binding: generation::BindingBasis = result(&binding)?;
    let rows = tx.query(
        "SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND kind='materials.extract' AND phase='completed' ORDER BY ordinal FOR UPDATE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.run_id.as_str()],
    ).await?;
    let mut accepted = BTreeMap::<ModelCallId, (GenerationRequest, Vec<SourceVersionRef>, BTreeMap<EvidenceRef, Evidence>)>::new();
    for row in rows {
        let step: StepRecord = decode(row.get("body"))?;
        let checkpoint = extract::read_extract_checkpoint(&step, step.ordinal)?;
        let request = &checkpoint.request;
        let generation = &checkpoint.generation;
        let chunk = &request.content.chunk;
        if step.phase != OperationPhase::Completed || step.run_id != reference.run_id
            || step.ordinal < 3 || step.ordinal as u64 >= budget.max_steps
            || request.world != reference.world || request.base_release != draft.base_release
            || request.definitions != base.definitions || request.scope != scope
            || request.budget != budget || generation.binding != *binding.reference()
            || !draft.source_versions.iter().zip(&draft.parse_artifacts).any(|(source, artifact)| {
                chunk.source_version == *source && chunk.parse_artifact_id == *artifact
            })
        {
            return Err(invalid());
        }
        let batch: CandidateBatch = result(&step)?;
        let mut evidence = BTreeMap::new();
        for item in batch.evidence.iter().chain(batch.candidates.iter().flat_map(|candidate| &candidate.evidence)) {
            if item.reference.world != reference.world
                || item.locator.source_version != chunk.source_version
                || item.locator.parse_artifact_id.as_ref() != Some(&chunk.parse_artifact_id)
                || evidence.insert(item.reference.clone(), item).is_some_and(|old| old != item)
            {
                return Err(invalid());
            }
        }
        for observation in &batch.observations {
            let AssertionOrigin::Extraction { run_id, model_call_id: Some(id) } = &observation.origin else {
                return Err(invalid());
            };
            if run_id != &reference.run_id || observation.scope != draft.scope || observation.evidence.is_empty() {
                return Err(invalid());
            }
            let (saved, sources, accepted_evidence) = accepted.entry(id.clone()).or_insert_with(|| (
                generation.clone(), vec![chunk.source_version.clone()], BTreeMap::new(),
            ));
            if saved != generation || sources.as_slice() != std::slice::from_ref(&chunk.source_version) {
                return Err(invalid());
            }
            for reference in &observation.evidence {
                let item = evidence.get(reference).ok_or_else(invalid)?;
                if accepted_evidence.insert(reference.clone(), (**item).clone()).is_some_and(|old| old != **item) {
                    return Err(invalid());
                }
            }
        }
    }
    let mut aligned_evidence = BTreeMap::new();
    for item in draft.batch.evidence.iter().chain(draft.batch.candidates.iter().flat_map(|candidate| &candidate.evidence)) {
        if aligned_evidence.insert(item.reference.clone(), item).is_some_and(|old| old != item) {
            return Err(invalid());
        }
    }
    let mut observations = Vec::with_capacity(draft.batch.observations.len());
    for observation in &draft.batch.observations {
        let AssertionOrigin::Extraction { run_id, model_call_id: Some(id) } = &observation.origin else {
            return Err(invalid());
        };
        if run_id != &reference.run_id || observation.scope != draft.scope || observation.evidence.is_empty() {
            return Err(invalid());
        }
        let (request, sources, accepted_evidence) = accepted.get(id).ok_or_else(invalid)?;
        let mut evidence = Vec::with_capacity(observation.evidence.len());
        for reference in &observation.evidence {
            let item = accepted_evidence.get(reference).ok_or_else(invalid)?;
            if aligned_evidence.get(reference).copied() != Some(item) {
                return Err(invalid());
            }
            evidence.push(item.clone());
        }
        observations.push(DraftObservation {
            reference: reference.clone(),
            draft: observation.clone(),
            request: request.clone(),
            model_call_id: id.clone(),
            sources: sources.clone(),
            evidence,
        });
    }
    Ok(observations)
}

pub(super) async fn admit_draft_observations(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    reference: &MaterialDraftRef,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(), Error> {
    let mut observations = Vec::new();
    for proof in read_draft_observations(tx, reference).await? {
        admission.require_access(&crate::facts::assertions::extracted_observation_impact(tx, &proof).await?)?;
        admission.require_access(&generation::draft_observation_impact(tx, &proof).await?)?;
        observations.push((crate::facts::assertions::observation_id(tx.world(), proof.draft())?, proof));
    }
    if observations.is_empty() {
        return Ok(());
    }
    observations.sort_by(|left, right| left.0.cmp(&right.0));
    if observations.windows(2).any(|pair| pair[0].0 == pair[1].0 && pair[0].1.draft() != pair[1].1.draft()) {
        return Err(invalid());
    }
    observations.dedup_by(|right, left| right.0 == left.0);
    let drafts: Vec<_> = observations.iter().map(|(id, proof)| (id.clone(), proof.draft().clone())).collect();
    crate::facts::assertions::lock_observation_batch(tx, &drafts).await?;
    for (id, proof) in observations {
        budget.check().map_err(|cause| budget_error(cause.dimension))?;
        if cancellation.is_cancelled() {
            return Err(materials::Error::new(MaterialFailure::Cancelled).into());
        }
        let recorded = generation::read_draft_observation_recorded(tx, admission, &proof).await?;
        crate::facts::assertions::admit_extracted_observation(
            tx, admission, id, &proof, &recorded, budget, cancellation,
        ).await?;
    }
    Ok(())
}

pub(crate) async fn retain_partial_step(
    tx: &WorldTransaction<'_>,
    step: &StepRecord,
) -> Result<bool, Error> {
    if step.kind != "materials.draft" || step.result.is_none() {
        return Ok(false);
    }
    read_draft(
        tx,
        &MaterialDraftRef {
            world: tx.world().clone(),
            run_id: step.run_id.clone(),
            step_id: step.id.clone(),
            revision: step.revision,
        },
    )
    .await?;
    Ok(true)
}

pub(crate) async fn draft_result(
    tx: &WorldTransaction<'_>,
    run: &crate::owner::RunRecord,
) -> Result<Option<OperationResult>, Error> {
    let operation = ledger::read(tx, &run.operation.operation_id).await?;
    if !matches!(
        operation.input.command()?,
        world_protocol::api::WorldCommand::ImportMaterials(_)
    ) {
        return Ok(None);
    }
    let id = StepId::try_new(key_digest(&(&run.id, "draft"))?).map_err(codec)?;
    let Some(step) = read_step(tx, &run.id, &id).await? else {
        return Ok(None);
    };
    if step.result.is_none() {
        return Ok(None);
    }
    let reference = MaterialDraftRef {
        world: tx.world().clone(),
        run_id: run.id.clone(),
        step_id: id,
        revision: step.revision,
    };
    let (draft, _) = read_draft(tx, &reference).await?;
    Ok(Some(OperationResult::Materials {
        source_versions: draft.source_versions,
        parse_artifacts: draft.parse_artifacts,
        candidates: Vec::new(),
        drafts: vec![reference],
    }))
}

pub(super) async fn publish_draft(
    tx: &mut WorldTransaction<'_>,
    run: &crate::owner::RunRecord,
) -> Result<(), Error> {
    let value = draft_result(tx, run).await?.ok_or_else(invalid)?;
    let mut operation = ledger::read(tx, &run.operation.operation_id).await?;
    operation.receipt.result = Some(value);
    ledger::save(tx, &mut operation, &tx.now().await?).await
}

pub(super) async fn append_draft(
    tx: &mut WorldTransaction<'_>,
    run: &crate::owner::RunRecord,
    accepted: &CandidateBatch,
) -> Result<(), Error> {
    let id = StepId::try_new(key_digest(&(&run.id, "draft"))?).map_err(codec)?;
    let step = read_step(tx, &run.id, &id).await?.ok_or_else(invalid)?;
    let mut batch: CandidateBatch = result(&step)?;
    batch.candidates.extend(accepted.candidates.iter().cloned());
    batch
        .observations
        .extend(accepted.observations.iter().cloned());
    batch.evidence.extend(accepted.evidence.iter().cloned());
    for entry in &accepted.coverage {
        if !batch.coverage.contains(entry) {
            batch.coverage.push(entry.clone());
        }
    }
    for need in &accepted.read_needs {
        if !batch.read_needs.contains(need) {
            batch.read_needs.push(need.clone());
        }
    }
    let mut next = step.clone();
    next.result = Some(encode(&batch)?);
    next.checkpoint = encode(&DraftStage::Raw)?;
    checkpoint_step(tx, &step, next).await?;
    publish_draft(tx, run).await
}

pub(crate) async fn operation_retention_roots(
    tx: &WorldTransaction<'_>,
    command: &world_protocol::api::WorldCommand,
    result: Option<&OperationResult>,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    match command {
        world_protocol::api::WorldCommand::ImportMaterials(request) => {
            roots.scopes.push(request.scope.clone());
            if let Some(task) = &request.task {
                if task.world == *tx.world() {
                    roots.resources.push(ResourceRef::Task {
                        id: task.id.clone(),
                    });
                }
            }
            // Exact acquired versions are retained by the parse step, never guessed from input names.
        }
        world_protocol::api::WorldCommand::ProposeMaterialDraft(request) => {
            if request.task.world == *tx.world() {
                roots.resources.push(ResourceRef::Task {
                    id: request.task.id.clone(),
                });
            }
            draft_retention_roots(tx, &request.draft, roots).await?;
        }
        _ => {}
    }
    if let Some(OperationResult::Materials {
        source_versions,
        parse_artifacts,
        drafts,
        ..
    }) = result
    {
        for reference in source_versions {
            if reference.world != *tx.world() {
                return Err(invalid());
            }
            roots.source_versions.push(reference.clone());
        }
        roots
            .parse_artifacts
            .extend(parse_artifacts.iter().cloned());
        for reference in drafts {
            draft_retention_roots(tx, reference, roots).await?;
        }
    }
    Ok(())
}

async fn draft_retention_roots(
    tx: &WorldTransaction<'_>,
    reference: &MaterialDraftRef,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    if reference.world != *tx.world() {
        return Ok(());
    }
    let Some(step) = read_step(tx, &reference.run_id, &reference.step_id).await? else {
        return Ok(());
    };
    // A superseded reference is not the latest draft; retained steps cover their current results.
    if step.revision != reference.revision {
        return Ok(());
    }
    let (draft, _) = read_draft(tx, reference).await?;
    roots.releases.push(draft.base_release);
    roots.scopes.push(draft.scope);
    roots.source_versions.extend(draft.source_versions);
    roots.parse_artifacts.extend(draft.parse_artifacts);
    batch_retention_roots(tx, &draft.batch, roots).await
}

pub(crate) async fn step_retention_roots(
    tx: &WorldTransaction<'_>,
    step: &StepRecord,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    match step.kind.as_str() {
        "materials.parse" => {
            if !step.checkpoint.is_null() {
                read_material_implementation(step)?;
            }
            if let Some(value) = &step.result {
                let parsed: Parsed = decode(value.clone())?;
                for source in parsed.sources {
                    if source.reference.world != *tx.world() {
                        return Err(invalid());
                    }
                    roots.source_versions.push(source.reference);
                    roots.source_versions.extend(source.supersedes);
                    for lineage in source.lineage {
                        match lineage {
                            SourceLineage::SourceVersion { reference } => {
                                roots.source_versions.push(reference)
                            }
                            SourceLineage::Generated { inputs, .. } => {
                                roots.source_versions.extend(inputs)
                            }
                            SourceLineage::WikiSource { .. } | SourceLineage::WikiPage { .. } => {}
                        }
                    }
                }
                roots.parse_artifacts.extend(parsed.artifacts);
            }
        }
        "materials.binding" => {
            if let Some(value) = &step.result {
                let _: generation::BindingBasis = decode(value.clone())?;
            }
        }
        "materials.extract" => {
            if !step.checkpoint.is_null() {
                let checkpoint: extract::ExtractCheckpoint = decode(step.checkpoint.clone())?;
                if checkpoint.request.world != *tx.world()
                    || checkpoint.generation.world != *tx.world()
                    || checkpoint.generation.run_id != step.run_id
                    || checkpoint.generation.step_id != step.id
                    || step.input_digest != canonical_digest(&checkpoint.request)?
                {
                    return Err(invalid());
                }
                roots.releases.push(checkpoint.request.base_release);
                roots.scopes.push(checkpoint.request.scope.id);
                roots.definitions.extend(
                    checkpoint
                        .request
                        .definitions
                        .into_iter()
                        .map(|definition| definition.reference),
                );
                roots
                    .source_versions
                    .push(checkpoint.request.content.chunk.source_version);
                roots
                    .parse_artifacts
                    .push(checkpoint.request.content.chunk.parse_artifact_id);
            }
            if let Some(value) = &step.result {
                batch_retention_roots(tx, &decode(value.clone())?, roots).await?;
            }
        }
        "materials.draft" => {
            if let Some(value) = &step.result {
                batch_retention_roots(tx, &decode(value.clone())?, roots).await?;
            }
        }
        kind if kind.starts_with("materials.chunks-") => {
            if let Some(value) = &step.result {
                let chunks: Vec<DocumentChunkContent> = decode(value.clone())?;
                for chunk in chunks {
                    if chunk.chunk.source_version.world != *tx.world() {
                        return Err(invalid());
                    }
                    roots.source_versions.push(chunk.chunk.source_version);
                    roots.parse_artifacts.push(chunk.chunk.parse_artifact_id);
                }
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

pub(crate) fn archive_operation_retention_roots(
    world: &WorldRef,
    result: Option<&OperationResult>,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    if let Some(OperationResult::Materials {
        source_versions,
        parse_artifacts,
        drafts,
        ..
    }) = result
    {
        for reference in source_versions {
            archive_source_root(world, reference, roots)?;
        }
        roots
            .parse_artifacts
            .extend(parse_artifacts.iter().cloned());
        for reference in drafts {
            if reference.world != *world
                || reference.step_id
                    != StepId::try_new(key_digest(&(&reference.run_id, "draft"))?).map_err(codec)?
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

/// Snapshot traversal supplies the validated parent operation/run; no transaction or draft read is forged.
pub(crate) fn archive_step_retention_roots(
    world: &WorldRef,
    step: &StepRecord,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    let key = match step.kind.as_str() {
        "materials.parse" => {
            if !step.checkpoint.is_null() {
                read_material_implementation(step)?;
                let checkpoint: ParseCheckpoint = decode(step.checkpoint.clone())?;
                if checkpoint.documents.iter().any(|document| &document.acquired.source.reference.world != world) {
                    return Err(invalid());
                }
            }
            "parse"
        },
        "materials.binding" => "binding",
        "materials.draft" => "draft",
        "materials.extract" => {
            if step.checkpoint.is_null() {
                if step.result.is_some() {
                    return Err(invalid());
                }
                return Ok(());
            }
            let checkpoint: extract::ExtractCheckpoint = decode(step.checkpoint.clone())?;
            let request = &checkpoint.request;
            let generation = &checkpoint.generation;
            let chunk = &request.content.chunk;
            if request.world != *world
                || request.scope.world != *world
                || request
                    .definitions
                    .iter()
                    .any(|definition| definition.reference.world != *world)
                || generation.world != *world
                || generation.run_id != step.run_id
                || generation.step_id != step.id
                || generation.budget != request.budget
                || step.input_digest != canonical_digest(request)?
            {
                return Err(invalid());
            }
            archive_source_root(world, &chunk.source_version, roots)?;
            roots.parse_artifacts.push(chunk.parse_artifact_id.clone());
            if let Some(value) = &step.result {
                archive_batch_retention_roots(world, &decode(value.clone())?, roots)?;
            }
            return Ok(());
        }
        kind if kind.starts_with("materials.chunks-") => {
            if let Some(value) = &step.result {
                let chunks: Vec<DocumentChunkContent> = decode(value.clone())?;
                if step.input_digest != canonical_digest(&chunks)? {
                    return Err(invalid());
                }
                for content in chunks {
                    let chunk = content.chunk;
                    if kind != format!("materials.chunks-{}", chunk.parse_artifact_id) {
                        return Err(invalid());
                    }
                    archive_source_root(world, &chunk.source_version, roots)?;
                    roots.parse_artifacts.push(chunk.parse_artifact_id);
                }
            }
            &kind["materials.".len()..]
        }
        _ => return Err(invalid()),
    };
    if step.id != StepId::try_new(key_digest(&(&step.run_id, key))?).map_err(codec)? {
        return Err(invalid());
    }
    if let Some(value) = &step.result {
        match key {
            "parse" => {
                let parsed: Parsed = decode(value.clone())?;
                if parsed.sources.is_empty()
                    || parsed.sources.len() != parsed.artifacts.len()
                    || parsed.sources.iter().enumerate().any(|(index, source)| {
                        parsed.sources[..index]
                            .iter()
                            .any(|old| old.reference == source.reference)
                    })
                    || parsed.artifacts.iter().collect::<BTreeSet<_>>().len()
                        != parsed.artifacts.len()
                {
                    return Err(invalid());
                }
                for source in parsed.sources {
                    archive_source_root(world, &source.reference, roots)?;
                    for reference in source.supersedes {
                        archive_source_root(world, &reference, roots)?;
                    }
                    for lineage in source.lineage {
                        match lineage {
                            SourceLineage::SourceVersion { reference } => {
                                archive_source_root(world, &reference, roots)?
                            }
                            SourceLineage::Generated { inputs, .. } => {
                                for reference in inputs {
                                    archive_source_root(world, &reference, roots)?;
                                }
                            }
                            SourceLineage::WikiSource { .. } | SourceLineage::WikiPage { .. } => {}
                        }
                    }
                }
                roots.parse_artifacts.extend(parsed.artifacts);
            }
            "binding" => {
                let _: generation::BindingBasis = decode(value.clone())?;
            }
            "draft" => archive_batch_retention_roots(world, &decode(value.clone())?, roots)?,
            _ => {}
        }
    }
    Ok(())
}

fn archive_source_root(
    world: &WorldRef,
    reference: &SourceVersionRef,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    if reference.world != *world {
        return Err(invalid());
    }
    roots.source_versions.push(reference.clone());
    Ok(())
}

fn archive_batch_retention_roots(
    world: &WorldRef,
    batch: &CandidateBatch,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    for candidate in &batch.candidates {
        if candidate.world != *world || candidate.change_set.world != *world {
            return Err(invalid());
        }
    }
    for evidence in batch.evidence.iter().chain(
        batch
            .candidates
            .iter()
            .flat_map(|candidate| &candidate.evidence),
    ) {
        if evidence.reference.world != *world {
            return Err(invalid());
        }
        archive_source_root(world, &evidence.locator.source_version, roots)?;
        roots
            .parse_artifacts
            .extend(evidence.locator.parse_artifact_id.iter().cloned());
    }
    for need in &batch.read_needs {
        archive_source_root(world, &need.source_version, roots)?;
        roots.parse_artifacts.push(need.parse_artifact_id.clone());
    }
    Ok(())
}

async fn batch_retention_roots(
    tx: &WorldTransaction<'_>,
    batch: &CandidateBatch,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    for candidate in &batch.candidates {
        crate::learning::candidate_retention_roots(tx, candidate, roots).await?;
    }
    for evidence in &batch.evidence {
        crate::facts::assertions::evidence_retention_roots(evidence, roots);
    }
    for observation in &batch.observations {
        crate::facts::assertions::observation_retention_roots(tx, observation, roots).await?;
    }
    for need in &batch.read_needs {
        roots.source_versions.push(need.source_version.clone());
        roots.parse_artifacts.push(need.parse_artifact_id.clone());
    }
    Ok(())
}

pub(crate) async fn read_draft_basis(
    tx: &WorldTransaction<'_>,
    reference: &MaterialDraftRef,
) -> Result<(ReleaseId, world_protocol::budget::Budget), Error> {
    let (draft, mut budget) = read_draft(tx, reference).await?;
    // A later proposal starts a new run; only its current invocation supplies an absolute deadline.
    budget.deadline = None;
    Ok((draft.base_release, budget))
}

pub(crate) async fn draft_query_impact(
    tx: &WorldTransaction<'_>,
    reference: &MaterialDraftRef,
) -> Result<ActualImpact, Error> {
    draft_read_impact(tx, &read_draft(tx, reference).await?.0).await
}

pub(crate) async fn draft_query(
    tx: &WorldTransaction<'_>,
    verified: &authorization::VerifiedInvocation,
    reference: &MaterialDraftRef,
    now: &Timestamp,
) -> Result<MaterialDraft, Error> {
    let (draft, _) = read_draft(tx, reference).await?;
    let impact = draft_read_impact(tx, &draft).await?;
    let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
    authorization::check_admitted_output(tx, &admission, &impact, 1, now).await?;
    Ok(draft)
}

pub(super) async fn draft_read_impact(
    tx: &WorldTransaction<'_>,
    draft: &MaterialDraft,
) -> Result<ActualImpact, Error> {
    let basis = crate::releases::read_compile_context(tx, &draft.base_release).await?;
    let mut impact = crate::releases::model_impact(
        tx,
        &basis.definitions,
        Vec::new(),
        &[AccessMode::Read],
    )
    .await?;
    for reference in &draft.source_versions {
        let source = content::read_source_version_in_transaction(tx, reference).await?;
        let current = authorization::material_read_impact(tx, &source).await?;
        impact.access.extend(current.access);
        impact.effects.extend(current.effects);
        impact.labels.extend(current.labels);
        impact.state.extend(current.state);
        impact.source_ids.extend(current.source_ids);
    }
    Ok(authorization::actual_impact(
        impact.access,
        impact.effects,
        impact.labels,
        impact.state,
        impact.source_ids,
    )?)
}

pub(super) async fn read_aligned_draft(
    tx: &WorldTransaction<'_>,
    reference: &MaterialDraftRef,
) -> Result<(MaterialDraft, world_protocol::budget::Budget), Error> {
    let draft = read_draft(tx, reference).await?;
    let step = read_step(tx, &reference.run_id, &reference.step_id)
        .await?
        .ok_or_else(invalid)?;
    if step.checkpoint != encode(&DraftStage::Aligned)? {
        return Err(Error::new(
            "world.material.draft_not_aligned",
            FailureStage::Validate,
            "资料草稿尚未完成全局语义对齐，不能提案。",
            ApiFailure::Operation(world_protocol::operation::OperationFailure::Material(
                MaterialFailure::InputInvalid,
            )),
            Recovery::Refresh,
        ));
    }
    Ok(draft)
}

pub(super) async fn read_import_basis(
    tx: &WorldTransaction<'_>,
    run: &crate::owner::RunRecord,
) -> Result<(ScopeId, Digest, Parsed), Error> {
    let operation = ledger::read(tx, &run.operation.operation_id).await?;
    let WorldCommand::ImportMaterials(request) = operation.input.command()? else {
        return Err(invalid());
    };
    let mut limits = run.budget.clone();
    limits.deadline = request.budget.deadline.clone();
    if operation.input.world() != tx.world()
        || run.operation.world != *tx.world()
        || operation.receipt.progress.run_id.as_ref() != Some(&run.id)
        || operation.receipt.accepted.incarnation != run.operation.incarnation
        || limits != request.budget
        || run.budget.deadline.is_none()
        || request.budget.deadline.as_ref().is_some_and(|deadline| {
            run.budget.deadline.as_ref().is_none_or(|actual| actual > deadline)
        })
    {
        return Err(invalid());
    }
    let digest = canonical_digest(request)?;
    let parse_id = StepId::try_new(key_digest(&(&run.id, "parse"))?).map_err(codec)?;
    let parse = read_step(tx, &run.id, &parse_id).await?.ok_or_else(invalid)?;
    if parse.kind != "materials.parse"
        || parse.input_digest != digest
        || parse.phase != OperationPhase::Completed
    {
        return Err(invalid());
    }
    let parsed: Parsed = result(&parse)?;
    if parsed.sources.is_empty()
        || parsed.sources.len() != request.sources.len()
        || parsed.sources.len() != parsed.artifacts.len()
    {
        return Err(invalid());
    }
    let mut versions = Vec::new();
    let mut artifacts = BTreeSet::new();
    for (source, id) in parsed.sources.iter().zip(&parsed.artifacts) {
        let (current, parse_run) = content::parse_origin(tx, id).await?;
        if current != *source
            || parse_run != run.id
            || versions.contains(&source.reference)
            || !artifacts.insert(id.clone())
        {
            return Err(invalid());
        }
        versions.push(source.reference.clone());
    }
    Ok((request.scope.clone(), digest, parsed))
}

pub(super) async fn read_draft(
    tx: &WorldTransaction<'_>,
    reference: &MaterialDraftRef,
) -> Result<(MaterialDraft, world_protocol::budget::Budget), Error> {
    if reference.world != *tx.world()
        || reference.step_id
            != StepId::try_new(key_digest(&(&reference.run_id, "draft"))?).map_err(codec)?
    {
        return Err(invalid());
    }
    let run = crate::owner::read_run(tx, &reference.run_id).await?;
    let (scope, digest, parsed) = read_import_basis(tx, &run).await?;
    let step = read_step(tx, &run.id, &reference.step_id)
        .await?
        .ok_or_else(invalid)?;
    if step.revision != reference.revision {
        return Err(Error::new(
            "world.material.draft_revision_conflict",
            FailureStage::Read,
            "资料草稿已更新，请读取当前精确引用。",
            ApiFailure::RevisionConflict,
            Recovery::Refresh,
        ));
    }
    if step.kind != "materials.draft" || step.input_digest != digest {
        return Err(invalid());
    }
    let batch: CandidateBatch = result(&step)?;
    let base_release = run.release_id.ok_or_else(invalid)?;
    if batch.candidates.iter().any(|candidate| {
        candidate.world != reference.world
            || candidate.change_set.world != reference.world
            || candidate.change_set.base_release != base_release
            || candidate.origin != CandidateOrigin::Extraction
    }) || batch
        .evidence
        .iter()
        .chain(
            batch
                .candidates
                .iter()
                .flat_map(|candidate| &candidate.evidence),
        )
        .any(|item| {
            !parsed
                .sources
                .iter()
                .zip(&parsed.artifacts)
                .any(|(source, id)| {
                    item.locator.source_version == source.reference
                        && item.locator.parse_artifact_id.as_ref() == Some(id)
                })
        })
        || batch.read_needs.iter().any(|need| {
            !parsed
                .sources
                .iter()
                .zip(&parsed.artifacts)
                .any(|(source, id)| {
                    need.source_version == source.reference && need.parse_artifact_id == *id
                })
        })
    {
        return Err(invalid());
    }
    Ok((
        MaterialDraft {
            reference: reference.clone(),
            base_release,
            scope,
            source_versions: parsed
                .sources
                .into_iter()
                .map(|source| source.reference)
                .collect(),
            parse_artifacts: parsed.artifacts,
            batch,
        },
        run.budget,
    ))
}

pub(super) async fn import(
    ctx: &ExecutionContext,
    request: &ImportMaterials,
    digest: &Digest,
) -> Result<Parsed, Error> {
    let id = step_id(ctx, "parse")?;
    let existing = inspect(ctx, &id).await?;
    if let Some(step) = &existing {
        if step.result.is_some() {
            return result(step);
        }
    }
    let checkpoint = if let Some(step) = &existing {
        read_material_implementation(step)?;
        decode::<ParseCheckpoint>(step.checkpoint.clone())?
    } else {
        let implementation = crate::extensions::lifecycle::select_materials(
            &ctx.store, &ctx.admission, &ctx.resources.inventory, ctx.deadline,
        ).await?;
        let fingerprint = implementation.implementation.artifact_digest.clone();
        charge(ctx, BudgetDimension::Steps, 1)?;
        let mut documents = Vec::with_capacity(request.sources.len());
        for (index, input) in request.sources.iter().enumerate() {
            check(ctx)?;
            let acquired = acquire(ctx, request, input, &format!("acquire-{index}")).await?;
            charge(ctx, BudgetDimension::SourceReads, 1)?;
            charge(ctx, BudgetDimension::Bytes, acquired.value.source.blob.byte_size)?;
            let artifact_id = ParseArtifactId::try_new(key_digest(&(
                &ctx.run.id, &acquired.value.source.reference, &fingerprint,
            ))?).map_err(codec)?;
            documents.push(ParseDocumentCheckpoint {
                acquired: acquired.value,
                receipt: acquired.receipt,
                plan: ParsePlan {
                    id: artifact_id,
                    parse_run: ctx.run.id.clone(),
                    parser_fingerprint: fingerprint.clone(),
                    dependency_fingerprints: implementation.native_files.iter().map(|file| file.digest.clone()).collect(),
                    options: document_parser::ParseOptions::default(),
                },
            });
        }
        let checkpoint = ParseCheckpoint { implementation, documents };
        let selected = &checkpoint.implementation.implementation;
        let installed = ctx.resources.inventory.lookup(&ctx.operation.world, &selected.install_id, &selected.package_digest).await
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        let packages: Vec<_> = installed.lock.packages.iter().map(|package| package.package_digest.clone())
            .chain(std::iter::once(installed.package_digest.clone())).collect::<BTreeSet<_>>().into_iter().collect();
        let value = checkpoint.clone();
        let digest = digest.clone();
        let budget = ctx.budget.clone();
        let claim_id = id.clone();
        ctx.transact("materials.parse.prepare", digest.clone(), &["content", "packages", "auth"],
            move |tx, admission, _, run| Box::pin(async move {
                let step = claim_step(tx, &admission, &run, claim_id, 0, "materials.parse", digest, &tx.now().await?).await?;
                let mut next = step.clone();
                next.checkpoint = encode(&value)?;
                let step = checkpoint_step(tx, &step, next).await?;
                let run = crate::owner::retain_run_packages(tx, &admission, &run, &step, &packages).await?;
                checkpoint_usage(tx, &run, confirmed_usage(&run.usage, budget.checkpoint_usage())?).await?;
                Ok(value)
            }),
        ).await?.value
    };
    let mut inputs = Vec::with_capacity(checkpoint.documents.len());
    let mut pins = Vec::with_capacity(checkpoint.documents.len());
    for document in checkpoint.documents {
        if document.plan.parse_run != ctx.run.id || document.acquired.source.reference.world != ctx.operation.world {
            return Err(invalid());
        }
        let pin = document.acquired.pin.clone().ok_or_else(invalid)?;
        pins.push(pin.clone());
        inputs.push(ImportDocument {
            source: document.acquired.source,
            name: document.acquired.name,
            plan: document.plan,
            input: DocumentInput::Pinned(Committed { value: pin, receipt: document.receipt, replayed: true }),
        });
    }
    let work = materials::prepare_import(
        ctx.resources.content.clone(),
        &ctx.store,
        inputs,
        &ctx.pipeline,
        |request| material_call(ctx, request),
    );
    tokio::pin!(work);
    let prepared = Arc::new(tokio::select! {
        result = &mut work => result,
        _ = ctx.cancellation.cancelled() => { ctx.pipeline.cancellation().cancel(); work.await },
        _ = tokio::time::sleep_until(ctx.deadline) => { ctx.pipeline.cancellation().cancel(); work.await },
    }.map_err(|error| {
        let error = Error::from(error);
        match ctx.budget.check() {
            Ok(()) => error,
            Err(cause) => budget_error(cause.dimension).with_related(error),
        }
    })?);
    if let Err(error) = check(ctx) {
        return match prepared.discard(&ctx.resources.content) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(error.with_related(Error::from(cleanup))),
        };
    }
    let parsed = Parsed {
        sources: prepared
            .documents()
            .iter()
            .map(|document| document.source().clone())
            .collect(),
        artifacts: prepared
            .documents()
            .iter()
            .map(|document| document.artifact().id.clone())
            .collect(),
    };
    let content = ctx.resources.content.clone();
    let work = prepared.clone();
    let value = parsed.clone();
    let digest = digest.clone();
    let budget = ctx.budget.clone();
    let committed = ctx
        .transact(
            "materials.parse",
            digest.clone(),
            &["content", "auth"],
            move |tx, admission, operation, run| {
                Box::pin(async move {
                    let mut step = read_step(tx, &run.id, &id).await?.ok_or_else(invalid)?;
                    if step.kind != "materials.parse" || step.input_digest != digest || step.result.is_some() {
                        return Err(invalid());
                    }
                    read_material_implementation(&step)?;
                    work.register_in_transaction(
                        &content,
                        tx,
                        &admission,
                        &operation.receipt.accepted,
                    )
                    .await?;
                    for pin in pins {
                        content::release_pin(tx, &pin).await?;
                    }
                    let expected = step.clone();
                    step.phase = OperationPhase::Completed;
                    step.result = Some(encode(&value)?);
                    checkpoint_step(tx, &expected, step).await?;
                    checkpoint_usage(
                        tx,
                        &run,
                        confirmed_usage(&run.usage, budget.checkpoint_usage())?,
                    )
                    .await?;
                    Ok(value)
                })
            },
        )
        .await;
    match committed {
        Ok(value) => {
            prepared
                .discard(&ctx.resources.content)
                .map_err(Error::from)?;
            Ok(value.value)
        }
        Err(error) if unknown(&error) => Err(error),
        Err(error) => match prepared.discard(&ctx.resources.content) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(error.with_related(Error::from(cleanup))),
        },
    }
}

async fn acquire(
    ctx: &ExecutionContext,
    request: &ImportMaterials,
    input: &MaterialInput,
    key: &str,
) -> Result<Committed<Acquired>, Error> {
    let input = input.clone();
    let request = request.clone();
    let world = ctx.operation.world.clone();
    let content = ctx.resources.content.clone();
    let actor = authorization::actor_id(&ctx.admission.invocation().actor).clone();
    let digest = canonical_digest(&(&input, &request.access, &request.retention))?;
    let commit = ctx
        .commit_request(
            &format!("materials.{key}"),
            digest.clone(),
            &["content", "auth"],
        )
        .await?;
    if let Some(saved) = ctx
        .store
        .read_commit_optional::<Acquired>(&world, &commit.commit_id, &digest)
        .await?
    {
        ctx.recheck_replay(&saved).await?;
        return Ok(saved);
    }
    let unavailable = match &input {
        MaterialInput::WikiSource { .. } | MaterialInput::WikiPage { .. } => {
            Some(SourceVersionRef {
                world: world.clone(),
                source_id: source_id_for(&world, &input)?,
                version_id: version_id(&input, &request)?,
            })
        }
        _ => None,
    };
    let wiki = match &input {
        MaterialInput::WikiSource {
            project_id,
            source_id,
            version,
        }
        | MaterialInput::WikiPage {
            project_id,
            page_id: source_id,
            version,
        } => Some(
            ctx.resources
                .wiki
                .export_exact(project_id, source_id, version, ctx.cancellation.clone())
                .await
                .map_err(|cause| Error::from(materials::Error::from(cause)))?
                .ok_or_else(|| {
                    Error::from(materials::Error::new(
                        MaterialFailure::VersionContentUnavailable {
                            reference: unavailable.expect("Wiki reference"),
                        },
                    ))
                })?,
        ),
        _ => None,
    };
    let bytes = match (&input, &wiki) {
        (MaterialInput::Upload { bytes, .. }, _) => Some(bytes.clone()),
        (_, Some(wiki)) => Some(wiki.bytes.clone()),
        _ => None,
    };
    let staged = if let Some(bytes) = bytes {
        let content = content.clone();
        let cancel = ctx.cancellation.clone();
        Some(Arc::new(
            blocking(ctx, move || {
                content
                    .prepare_blob(&mut bytes.as_slice(), None, &cancel)
                    .map_err(materials::Error::from)
            })
            .await?,
        ))
    } else {
        None
    };
    if let Err(error) = check(ctx) {
        return match staged
            .as_ref()
            .map(|stage| ctx.resources.content.discard_prepared(stage))
            .transpose()
        {
            Ok(_) => Err(error),
            Err(cleanup) => Err(error.with_related(Error::from(cleanup))),
        };
    }
    let work_stage = staged.clone();
    let pin_id = ContentId::try_new(key_digest(&(&ctx.run.id, key, "input"))?).map_err(codec)?;
    let run_id = ctx.run.id.clone();
    let committed = ctx.transact(&format!("materials.{key}"), digest, &["content", "auth"], move |tx, admission, _, _| Box::pin(async move {
        if let MaterialInput::Blob { blob, name, media_type } = &input {
            let source = existing_blob(tx, blob, media_type).await?;
            if source.access != request.access || source.retention != request.retention { return Err(invalid()); }
            require_source(&admission, &source, &request.scope, AccessMode::Read)?;
            authorization::require_material_policies(tx, &admission, &source.reference.source_id, &source.access, &source.retention, &tx.now().await?).await?;
            let reference = ContentReference::new(ContentOwner::Run { id: run_id.clone() }, blob.clone())?;
            content::retain(tx, &reference).await?;
            let pin = content::pin(tx, &reference, pin_id, PinKind::Recovery).await?;
            return Ok(Acquired { source, name: name.clone(), pin: Some(pin) });
        }
        let source_id = source_id(tx.world(), &input)?;
        let reference = SourceVersionRef { world: tx.world().clone(), source_id: source_id.clone(), version_id: version_id(&input, &request)? };
        let (name, media_type, blob, captured_at, lineage, pin) = match &input {
            MaterialInput::Upload { name, media_type, bytes } => (name.clone(), media_type.clone(), blob(bytes), tx.now().await?, Vec::new(), None),
            MaterialInput::SealedUpload { name, media_type, transfer_id, blob } => {
                let upload_pin = content.checked_sealed_input(tx, &actor, &UploadKey { transfer_id: transfer_id.clone() }, blob, name, media_type).await?;
                let reference = ContentReference::new(ContentOwner::Run { id: run_id.clone() }, blob.clone())?;
                content::retain(tx, &reference).await?;
                let pin = content::pin(tx, &reference, pin_id.clone(), PinKind::Recovery).await?;
                content::release_pin(tx, &upload_pin).await?;
                (name.clone(), media_type.clone(), blob.clone(), tx.now().await?, Vec::new(), Some(pin))
            },
            MaterialInput::WikiSource { project_id, source_id, version } => {
                let wiki = wiki.ok_or_else(invalid)?;
                if wiki.relative_path != *source_id || wiki.version != *version || wiki.digest != blob(&wiki.bytes).digest { return Err(invalid()); }
                let captured = timestamp(wiki.captured_at_ms)?;
                (source_id.clone(), media_type(source_id).to_owned(), BlobRef { digest: wiki.digest, byte_size: wiki.bytes.len() as u64 }, captured,
                    vec![SourceLineage::WikiSource { project_id: project_id.clone(), source_id: source_id.clone(), version: version.clone() }], None)
            },
            MaterialInput::WikiPage { project_id, page_id, version } => {
                let wiki = wiki.ok_or_else(invalid)?;
                if wiki.relative_path != *page_id || wiki.version != *version || wiki.digest != blob(&wiki.bytes).digest { return Err(invalid()); }
                (page_id.clone(), "text/markdown".into(), BlobRef { digest: wiki.digest, byte_size: wiki.bytes.len() as u64 }, timestamp(wiki.captured_at_ms)?,
                    vec![SourceLineage::WikiPage { project_id: project_id.clone(), page_id: page_id.clone(), version: version.clone(), source_versions: Vec::new() }], None)
            }, MaterialInput::Blob { .. } => unreachable!(),
        };
        let existing = tx.query_opt("SELECT body FROM world_source_version WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND version_id=$4",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.source_id.as_str(), &reference.version_id.as_str()]).await?;
        let source = if let Some(row) = existing {
            let source: SourceVersion = decode(row.get("body"))?;
            if source.reference != reference || source.blob != blob || source.media_type != media_type || source.lineage != lineage
                || source.access != request.access || source.retention != request.retention { return Err(invalid()); }
            source
        } else { let origin_family = content::source_origin_family(tx, &blob, &lineage).await.map_err(origin_error)?;
            SourceVersion { reference, blob, media_type, captured_at, supersedes: None,
            origin_family, lineage,
            access: request.access, retention: request.retention } };
        require_source(&admission, &source, &request.scope, AccessMode::Write)?;
        authorization::require_material_policies(tx, &admission, &source.reference.source_id, &source.access, &source.retention, &tx.now().await?).await?;
        let pin = if let Some(stage) = work_stage {
            if stage.reference() != &source.blob { return Err(invalid()); }
            let owner = ContentOwner::Run { id: run_id };
            content.retain_prepared(tx, &stage, owner.clone()).await?;
            Some(content.pin_prepared(tx, &stage, owner, pin_id, PinKind::Recovery).await?)
        } else { pin };
        Ok(Acquired { source, name, pin })
    })).await;
    if let Some(stage) = staged {
        if committed.as_ref().is_err_and(unknown) {
            return committed;
        }
        if let Err(cleanup) = ctx.resources.content.discard_prepared(&stage) {
            return Err(match committed {
                Ok(_) => Error::from(cleanup),
                Err(error) => error.with_related(Error::from(cleanup)),
            });
        }
    }
    committed
}

fn origin_error(error: content::SourceOriginError) -> Error {
    match error {
        content::SourceOriginError::Content(error) => error.into(),
        error @ content::SourceOriginError::ConflictingFamilies { .. } => Error::new(
            "world.material.origin_family_conflict", FailureStage::Validate,
            "资料来源家族存在历史冲突，需要人工处理。", ApiFailure::RevisionConflict, Recovery::ManualReview,
        ).caused(error),
    }
}

pub(super) async fn existing_blob(
    tx: &WorldTransaction<'_>,
    blob: &BlobRef,
    media_type: &str,
) -> Result<SourceVersion, Error> {
    let world = tx.world();
    let rows = tx.query("SELECT body FROM world_source_version WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3 AND media_type=$4 ORDER BY source_id,version_id LIMIT 2",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &blob.digest.as_str(), &media_type]).await?;
    if rows.len() != 1 {
        return Err(invalid());
    }
    let source: SourceVersion = decode(rows[0].get("body"))?;
    let current = content::read_source_version_in_transaction(tx, &source.reference).await?;
    if current != source || source.blob != *blob {
        return Err(invalid());
    }
    Ok(source)
}

fn require_source(
    admission: &Admission,
    source: &SourceVersion,
    scope: &ScopeId,
    mode: AccessMode,
) -> Result<(), Error> {
    admission
        .require_access(&authorization::actual_impact(
            vec![AccessScope {
                resources: vec![ResourceRef::Source {
                    id: source.reference.source_id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![mode],
                scope: scope.clone(),
                valid_time: None,
            }],
            Vec::new(),
            source.access.labels.clone(),
            Vec::new(),
            vec![source.reference.source_id.clone()],
        )?)
        .map_err(Error::from)
}
pub(super) fn source_id(world: &WorldRef, input: &MaterialInput) -> Result<SourceId, Error> {
    source_id_for(world, input)
}
fn source_id_for(world: &WorldRef, input: &MaterialInput) -> Result<SourceId, Error> {
    let identity = match input {
        MaterialInput::Upload {
            name, media_type, ..
        }
        | MaterialInput::SealedUpload {
            name, media_type, ..
        } => encode(&("upload", name, media_type))?,
        MaterialInput::WikiSource {
            project_id,
            source_id,
            ..
        } => encode(&("wiki_source", project_id, source_id))?,
        MaterialInput::WikiPage {
            project_id,
            page_id,
            ..
        } => encode(&("wiki_page", project_id, page_id))?,
        MaterialInput::Blob { .. } => return Err(invalid()),
    };
    SourceId::try_new(key_digest(&(world, identity))?).map_err(codec)
}
fn version_id(input: &MaterialInput, request: &ImportMaterials) -> Result<SourceVersionId, Error> {
    let identity = match input {
        MaterialInput::Upload { bytes, .. } => encode(&blob(bytes))?,
        MaterialInput::SealedUpload { blob, .. } | MaterialInput::Blob { blob, .. } => {
            encode(blob)?
        }
        MaterialInput::WikiSource { version, .. } | MaterialInput::WikiPage { version, .. } => {
            encode(version)?
        }
    };
    SourceVersionId::try_new(key_digest(&(
        identity,
        &request.access,
        &request.retention,
    ))?)
    .map_err(codec)
}
fn blob(bytes: &[u8]) -> BlobRef {
    BlobRef {
        digest: Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes)))
            .expect("SHA256 digest"),
        byte_size: bytes.len() as u64,
    }
}

fn timestamp(millis: u64) -> Result<Timestamp, Error> {
    let millis = i64::try_from(millis).map_err(codec)?;
    let value = chrono::DateTime::from_timestamp_millis(millis).ok_or_else(invalid)?;
    Timestamp::try_new(value.to_rfc3339()).map_err(codec)
}
fn media_type(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}
