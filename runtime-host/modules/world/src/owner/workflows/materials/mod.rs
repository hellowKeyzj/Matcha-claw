mod extract;
mod input;

use extract::{extract, save_result};
pub(crate) use extract::{extraction_access, propose, propose_impact};
pub(crate) use input::{
    Acquired, DraftModelCalls, DraftObservation, archive_operation_retention_roots, archive_step_retention_roots,
    draft_query, draft_query_impact, draft_result as failure_result, operation_retention_roots,
    read_draft_basis, read_draft_model_calls, read_draft_observations, read_material_implementation, retain_partial_step, step_retention_roots,
};
use input::{Parsed, existing_blob, import, source_id};

use std::{collections::BTreeSet, sync::Arc};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use world_protocol::{
    api::{CommandResult, ImportMaterials, MaterialInput, ProposeMaterialDraft, UploadKey, WorldCommand},
    authorization::{AccessMode, AccessScope, ActualImpact},
    budget::BudgetDimension,
    compiler::CompileSelection,
    definitions::Scope,
    expression::Effect,
    failure::FailureStage,
    generation::{GenerationParameters, GenerationRequest},
    ids::*,
    learning::{Candidate, CandidateOrigin, ChangeSet, ChangeStatus, TaskRef},
    materials::{
        BlobRef, CandidateBatch, CandidateCompileSelection, DocumentChunkContent, MaterialCompileSelection, MaterialDraft, MaterialDraftRef,
        MaterialFailure, ParseArtifact, SemanticExtractRequest, SourceLineage, SourceVersion,
        SourceVersionRef,
    },
    operation::{OperationPhase, OperationResult},
    releases::Release,
    time::Timestamp,
};

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DraftStage {
    Raw,
    Aligned,
}

use crate::{
    authorization::{self, Admission},
    content::{self, BlobPin, ContentOwner, ContentReference, LoadedParse, ParseRead, PinKind},
    definitions::canonical_digest,
    generation::{self, BoundGeneration, GenerationSelection},
    materials::{self, DocumentInput, ImportDocument, ParsePlan},
    owner::{
        Error, ExecutionContext, StepRecord, checkpoint_step, checkpoint_usage, claim_step,
        confirmed_usage, ledger, read_step,
    },
    store::{Committed, StoreFuture, WorldTransaction},
};

/// Acceptance and execution share this single source-identity derivation.
pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    request: &ImportMaterials,
) -> Result<ActualImpact, Error> {
    validate(request)?;
    let mut ids = Vec::new();
    let mut labels = request.access.labels.clone();
    let mut material_access = Vec::new();
    let mut material_state = Vec::new();
    for input in &request.sources {
        let id = match input {
            MaterialInput::Blob {
                blob, media_type, ..
            } => {
                let source = existing_blob(tx, blob, media_type).await?;
                if source.access != request.access || source.retention != request.retention {
                    return Err(invalid());
                }
                let current = authorization::material_read_impact(tx, &source).await?;
                material_access.extend(current.access);
                material_state.extend(current.state);
                labels.extend(current.labels);
                source.reference.source_id
            }
            _ => source_id(tx.world(), input)?,
        };
        if ids.contains(&id) {
            return Err(invalid());
        }
        ids.push(id);
    }
    let release_id = crate::releases::read_active_head(tx)
        .await?
        .ok_or_else(invalid)?
        .release_id;
    let basis = crate::releases::read_compile_context(tx, &release_id).await?;
    let sources: Vec<_> = ids.iter().map(|id| ResourceRef::Source { id: id.clone() }).collect();
    let model = crate::releases::model_impact(
        tx,
        &basis.definitions,
        vec![
            AccessScope {
                // Immediate proposal can publish new, model-assigned resources.
                resources: if request.compile.is_some() { Vec::new() } else { sources.clone() },
                fields: Vec::new(),
                modes: vec![AccessMode::Read, AccessMode::Write],
                scope: request.scope.clone(),
                valid_time: None,
            },
            AccessScope {
                resources: sources,
                fields: Vec::new(),
                modes: vec![AccessMode::Execute],
                scope: request.scope.clone(),
                valid_time: None,
            },
        ],
        &[AccessMode::Read],
    )
    .await?;
    let target = match &request.compile {
        Some(selection) => crate::learning::selection_metadata(tx, selection).await?,
        None => {
            crate::extensions::bindings::read_activation_metadata(tx, &basis.activation_lock.id)
                .await?
                .1
        }
    };
    let mut access = model.access;
    access.extend(material_access);
    if let Some(task) = &request.task {
        if task.world != *tx.world() {
            return Err(invalid());
        }
        let task = crate::evaluation::read_task(tx, &task.id, task.revision).await?;
        access.push(AccessScope {
            resources: vec![ResourceRef::Task { id: task.id }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: task.scope,
            valid_time: None,
        });
    }
    labels.extend(model.labels);
    ids.extend(model.source_ids);
    material_state.extend(model.state);
    let mut effects = vec![Effect::Probabilistic];
    if let Some(target) = target {
        access.extend(target.access);
        labels.extend(target.labels);
        ids.extend(target.source_ids);
        material_state.extend(target.state);
        effects.extend(target.effects);
    }
    authorization::actual_impact(access, effects, labels, material_state, ids).map_err(Error::from)
}

pub(crate) fn command(
    ctx: ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'static, CommandResult, Error> {
    match command {
        WorldCommand::ImportMaterials(request) => Box::pin(async move {
            run(ctx.clone(), request).await?;
            Ok(CommandResult::Accepted(ctx.operation))
        }),
        WorldCommand::ProposeMaterialDraft(request) => Box::pin(async move {
            propose(ctx.clone(), request).await?;
            Ok(CommandResult::Accepted(ctx.operation))
        }),
        _ => Box::pin(async { Err(Error::internal(FailureStage::Decode)) }),
    }
}

pub(crate) fn run(
    ctx: ExecutionContext,
    request: ImportMaterials,
) -> StoreFuture<'static, (), Error> {
    Box::pin(async move {
        match execute(&ctx, request.clone()).await {
            Ok(()) => {
                cleanup_terminal(
                    &ctx.store,
                    &ctx.authority,
                    &ctx.operation,
                    &ctx.run.id,
                    &world_protocol::api::WorldCommand::ImportMaterials(request),
                )
                .await
            }
            Err(error) if unknown(&error) => Err(error),
            Err(error) => match settle_failure(&ctx, &request, &error).await {
                Ok(()) => Err(error),
                Err(cleanup) => Err(error.with_related(cleanup)),
            },
        }
    })
}

fn execute<'a>(ctx: &'a ExecutionContext, request: ImportMaterials) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        validate(&request)?;
        let request_digest = canonical_digest(&request)?;
        let work = ctx.clone();
        let input = request.clone();
        let digest = request_digest.clone();
        let parsed = ctx
            .pipeline
            .step("materials.parse", move |_| {
                Box::pin(async move { import(&work, &input, &digest).await })
            })
            .await?;
        let (base, scope) = basis(&ctx, &request).await?;
        let base = Arc::new(base);
        let scope = Arc::new(scope);
        let draft_id = step_id(ctx, "draft")?;
        if inspect(ctx, &draft_id).await?.is_none() {
            checkpoint_draft(
                ctx,
                &request_digest,
                &CandidateBatch {
                    candidates: Vec::new(),
                    observations: Vec::new(),
                    evidence: Vec::new(),
                    coverage: Vec::new(),
                    read_needs: Vec::new(),
                },
                2,
                DraftStage::Raw,
                &BTreeSet::new(),
            )
            .await?;
        }
        let binding_step = step_id(&ctx, "binding")?;
        let saved = inspect(&ctx, &binding_step).await?;
        let bound = if let Some(saved) = saved {
            let value: generation::BindingBasis = result(&saved)?;
            generation::restore_binding(
                &ctx.store,
                &ctx.admission,
                ctx.resources.generation.as_ref(),
                value.reference(),
                ctx.cancellation.clone(),
            )
            .await?
        } else {
            check(&ctx)?;
            let (bound, value) = generation::prepare_binding(
                &ctx.store,
                &ctx.admission,
                ctx.resources.generation.as_ref(),
                GenerationSelection {
                    model_ref: None,
                    parameters: GenerationParameters {
                        temperature: None,
                        top_p: None,
                        seed: None,
                        maximum_output_tokens: ctx.run.budget.max_output_tokens,
                    },
                    strict_reproducibility: false,
                },
                ctx.cancellation.clone(),
            )
            .await?;
            save_result(&ctx, "binding", 1, request_digest.clone(), value).await?;
            bound
        };
        let artifacts = load_artifacts(&ctx, &parsed, &request_digest).await?;
        let documents: Vec<_> = artifacts
            .iter()
            .map(|loaded| Arc::new(loaded.artifact().clone()))
            .collect();
        let mut batches = Vec::new();
        let mut ordinal = 3u32;
        for (source, artifact) in parsed.sources.iter().zip(&documents) {
            let source = Arc::new(source.clone());
            let chunk_key = format!("chunks-{}", artifact.id);
            let chunks: Vec<DocumentChunkContent> =
                if let Some(step) = inspect(&ctx, &step_id(&ctx, &chunk_key)?).await? {
                    result(&step)?
                } else {
                    let response = material_call(ctx, materials::MaterialRequest::Chunks {
                        artifact: artifact.as_ref().clone(), source: source.as_ref().clone(),
                        base: base.as_ref().clone(), scope: scope.as_ref().clone(), budget: ctx.run.budget.clone(),
                        binding: bound.binding().clone(), run_id: ctx.run.id.clone(),
                    }).await?;
                    let materials::MaterialResponse::Chunks { chunks } = response else { return Err(invalid()); };
                    save_result(
                        &ctx,
                        &chunk_key,
                        ordinal,
                        canonical_digest(&chunks)?,
                        chunks.clone(),
                    )
                    .await?;
                    chunks
                };
            ordinal = next(ordinal)?;
            for chunk in chunks {
                let key = format!("extract-{}", chunk.chunk.id);
                batches.push(
                    extract(
                        &ctx,
                        &bound,
                        &base,
                        &scope,
                        &source,
                        artifact,
                        Some(chunk),
                        &key,
                        ordinal,
                    )
                    .await?,
                );
                ordinal = next(ordinal)?;
            }
        }
        let draft = draft(&ctx, &base).await?;
        let mut read = BTreeSet::new();
        let mut aligned = align(ctx, &base, &batches, &draft, &artifacts).await?;
        checkpoint_draft(
            ctx,
            &request_digest,
            &aligned,
            2,
            DraftStage::Aligned,
            &read,
        )
        .await?;
        // Every exact read has its own durable step. Repeated requests are retained as
        // unresolved draft needs instead of a paid, unbounded loop.
        loop {
            let needs = aligned.read_needs.clone();
            let mut progressed = false;
            for need in needs {
                let digest = canonical_digest(&need)?;
                if !read.insert(digest.clone()) {
                    continue;
                }
                let Some(index) = parsed
                    .sources
                    .iter()
                    .position(|source| source.reference == need.source_version)
                else {
                    return Err(invalid());
                };
                let artifact = &documents[index];
                let source = Arc::new(parsed.sources[index].clone());
                let key = format!("read-{}", digest);
                let content = if inspect(ctx, &step_id(ctx, &key)?).await?.is_some() {
                    None
                } else {
                    charge(ctx, BudgetDimension::SourceReads, 1)?;
                    let response = material_call(ctx, materials::MaterialRequest::Read {
                        artifact: artifact.as_ref().clone(), source: source.as_ref().clone(),
                        base: base.as_ref().clone(), scope: scope.as_ref().clone(), budget: ctx.run.budget.clone(),
                        binding: bound.binding().clone(), run_id: ctx.run.id.clone(), need: need.clone(),
                    }).await?;
                    let materials::MaterialResponse::Read { content } = response else { return Err(invalid()); };
                    Some(content)
                };
                let batch = extract(
                    &ctx, &bound, &base, &scope, &source, artifact, content, &key, ordinal,
                )
                .await?;
                ordinal = next(ordinal)?;
                // A completed exact reread replaces the originating need, not its evidence.
                for old in &mut batches {
                    old.read_needs.retain(|old| old != &need);
                }
                batches.push(batch);
                progressed = true;
            }
            aligned = align(ctx, &base, &batches, &draft, &artifacts).await?;
            checkpoint_draft(
                ctx,
                &request_digest,
                &aligned,
                2,
                DraftStage::Aligned,
                &read,
            )
            .await?;
            if !progressed || aligned.read_needs.is_empty() {
                break;
            }
        }
        finish(&ctx, &request, &parsed, artifacts, aligned).await
    })
}

fn material_call(
    ctx: &ExecutionContext,
    request: materials::MaterialRequest,
) -> StoreFuture<'_, materials::MaterialResponse, Error> {
    Box::pin(async move {
        check(ctx)?;
        let id = step_id(ctx, "parse")?;
        let (run, step, implementation) = ctx.transact(
            &probe(), canonical_digest(&id)?, &[],
            move |tx, _, _, run| Box::pin(async move {
                let step = read_step(tx, &run.id, &id).await?.ok_or_else(invalid)?;
                let implementation = read_material_implementation(&step)?;
                Ok((run, step, implementation))
            }),
        ).await?.value;
        let mut lease = ctx.resources.live.lease_materials(
            &ctx.store, &ctx.admission, &run, &step, &implementation,
            &ctx.resources.inventory, &ctx.resources.preparation, ctx.deadline,
        ).await?;
        let result = lease.invoke(request, ctx.budget.clone(), ctx.cancellation.clone(), ctx.deadline).await;
        let cleanup = lease.close_checked(ctx.deadline).await;
        match (result, cleanup) {
            (Ok(response), Ok(())) => Ok(response),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(error.with_related(cleanup)),
        }
    })
}

async fn align(
    ctx: &ExecutionContext,
    base: &Arc<Release>,
    batches: &[CandidateBatch],
    draft: &Candidate,
    artifacts: &[LoadedParse],
) -> Result<CandidateBatch, Error> {
    let base = base.clone();
    let batches = batches.to_vec();
    let draft = draft.clone();
    let coverage: Vec<_> = artifacts
        .iter()
        .flat_map(|loaded| &loaded.artifact().coverage)
        .cloned()
        .collect();
    let work = ctx.clone();
    ctx.pipeline
        .step("materials.align", move |_| {
            Box::pin(async move {
                let response = material_call(&work, materials::MaterialRequest::Align {
                    base: base.as_ref().clone(), batches, draft,
                }).await?;
                let materials::MaterialResponse::Align { mut batch } = response else { return Err(invalid()); };
                for entry in coverage {
                    if !batch.coverage.contains(&entry) {
                        batch.coverage.push(entry);
                    }
                }
                Ok(batch)
            })
        })
        .await
}

fn checkpoint_draft<'a>(
    ctx: &'a ExecutionContext,
    request_digest: &'a Digest,
    batch: &'a CandidateBatch,
    ordinal: u32,
    stage: DraftStage,
    processed: &'a BTreeSet<Digest>,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let id = step_id(ctx, "draft")?;
        let expected = inspect(ctx, &id).await?.map(|step| step.revision);
        if expected.is_none() {
            charge(ctx, BudgetDimension::Steps, 1)?;
        }
        let value = batch.clone();
        let basis = request_digest.clone();
        let digest = canonical_digest(batch)?;
        let key = key_digest(&("materials.draft", stage, processed, &digest, expected))?;
        let budget = ctx.budget.clone();
        ctx.transact(
            &format!("materials.draft-{key}"),
            digest,
            &[],
            move |tx, admission, _, run| {
                Box::pin(async move {
                    let current = read_step(tx, &run.id, &id).await?;
                    if current.as_ref().map(|step| step.revision) != expected {
                        return Err(invalid());
                    }
                    let step = match current {
                        Some(step) => step,
                        None => {
                            claim_step(
                                tx,
                                &admission,
                                &run,
                                id,
                                ordinal,
                                "materials.draft",
                                basis.clone(),
                                &tx.now().await?,
                            )
                            .await?
                        }
                    };
                    if step.input_digest != basis || ledger::terminal(step.phase) {
                        return Err(invalid());
                    }
                    let result = encode(&value)?;
                    let checkpoint = encode(&stage)?;
                    if step.result.as_ref() != Some(&result) || step.checkpoint != checkpoint {
                        let mut next = step.clone();
                        next.result = Some(result);
                        next.checkpoint = checkpoint;
                        checkpoint_step(tx, &step, next).await?;
                    }
                    input::publish_draft(tx, &run).await?;
                    checkpoint_usage(
                        tx,
                        &run,
                        confirmed_usage(&run.usage, budget.checkpoint_usage())?,
                    )
                    .await?;
                    Ok(())
                })
            },
        )
        .await?;
        Ok(())
    })
}

fn finish<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ImportMaterials,
    parsed: &'a Parsed,
    artifacts: Vec<LoadedParse>,
    batch: CandidateBatch,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let id = step_id(ctx, "draft")?;
        let digest = canonical_digest(&batch)?;
        let request = request.clone();
        let parsed = parsed.clone();
        let owner = ctx.resources.content.clone();
        let budget = ctx.budget.clone();
        let cancel = ctx.cancellation.clone();
        ctx.transact(
            "materials.finish",
            digest.clone(),
            &[
                "learning",
                "releases",
                "definitions",
                "content",
                "facts",
                "support",
                "identity",
                "auth",
            ],
            move |tx, admission, operation, run| {
                Box::pin(async move {
                    let step = read_step(tx, &run.id, &id).await?.ok_or_else(invalid)?;
                    if step.result.as_ref() != Some(&encode(&batch)?) {
                        return Err(invalid());
                    }
                    let reference = MaterialDraftRef {
                        world: tx.world().clone(),
                        run_id: run.id.clone(),
                        step_id: step.id.clone(),
                        revision: step.revision,
                    };
                    let (stored, _) = input::read_aligned_draft(tx, &reference).await?;
                    admission.require_access(&input::draft_read_impact(tx, &stored).await?)?;
                    for loaded in &artifacts {
                        content::require_loaded_parse_in_transaction(tx, loaded).await?;
                    }
                    let mut next = step.clone();
                    next.phase = OperationPhase::Completed;
                    let candidates = if let (Some(task), Some(compile)) = (&request.task, &request.compile) {
                        if run.activation_lock_id.as_ref() != Some(&compile.activation_lock_id) {
                            return Err(invalid());
                        }
                        let compile = MaterialCompileSelection {
                            activation_lock_id: compile.activation_lock_id.clone(),
                            candidates: stored.batch.candidates.iter().map(|candidate| CandidateCompileSelection {
                                candidate_id: candidate.id.clone(),
                                external_contracts: compile.external_contracts.clone(),
                            }).collect(),
                        };
                        extract::propose_candidates(
                            tx, &admission, &stored, task, &compile, &owner,
                            &artifacts, &budget, &cancel,
                        ).await?
                    } else {
                        Vec::new()
                    };
                    let completed = checkpoint_step(tx, &step, next).await?;
                    checkpoint_usage(
                        tx,
                        &run,
                        confirmed_usage(&run.usage, budget.checkpoint_usage())?,
                    )
                    .await?;
                    ledger::complete(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::Materials {
                            source_versions: parsed
                                .sources
                                .iter()
                                .map(|source| source.reference.clone())
                                .collect(),
                            parse_artifacts: parsed.artifacts,
                            candidates,
                            drafts: vec![MaterialDraftRef {
                                world: tx.world().clone(),
                                run_id: run.id.clone(),
                                step_id: completed.id,
                                revision: completed.revision,
                            }],
                        },
                        &tx.now().await?,
                    )
                    .await?;
                    Ok(())
                })
            },
        )
        .await?;
        Ok(())
    })
}

async fn settle_failure(
    ctx: &ExecutionContext,
    request: &ImportMaterials,
    error: &Error,
) -> Result<(), Error> {
    let receipt = ctx.fail(error).await?;
    if !crate::owner::terminal_phase(receipt.phase) {
        return Ok(());
    }
    cleanup_terminal(
        &ctx.store,
        &ctx.authority,
        &ctx.operation,
        &ctx.run.id,
        &world_protocol::api::WorldCommand::ImportMaterials(request.clone()),
    )
    .await
}

fn basis<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ImportMaterials,
) -> StoreFuture<'a, (Release, Scope), Error> {
    Box::pin(async move {
        let release_id = ctx.run.release_id.clone().ok_or_else(invalid)?;
        let scope_id = request.scope.clone();
        ctx.transact(
            &probe(),
            canonical_digest(&(&release_id, &scope_id))?,
            &[],
            move |tx, _, _, _| {
                Box::pin(async move {
                    let base = crate::releases::read_release(tx, &release_id)
                        .await?
                        .ok_or_else(invalid)?;
                    let scope = crate::definitions::read_scopes(tx, &[scope_id])
                        .await?
                        .into_iter()
                        .next()
                        .ok_or_else(invalid)?;
                    Ok((base, scope))
                })
            },
        )
        .await
        .map(|value| value.value)
    })
}

fn load_artifacts<'a>(
    ctx: &'a ExecutionContext,
    parsed: &'a Parsed,
    request_digest: &'a Digest,
) -> StoreFuture<'a, Vec<LoadedParse>, Error> {
    Box::pin(async move {
        if parsed.sources.is_empty() || parsed.sources.len() != parsed.artifacts.len() {
            return Err(invalid());
        }
        // Read pins survive until terminal settlement so a retained run can hydrate the same receipt.
        // This current authorization check also runs before reading a replayed pin receipt.
        let current = parsed.clone();
        ctx.transact(
            &probe(),
            request_digest.clone(),
            &[],
            move |tx, admission, _, _| {
                Box::pin(async move {
                    for (source, id) in current.sources.iter().zip(&current.artifacts) {
                        let stored =
                            content::read_source_version_in_transaction(tx, &source.reference).await?;
                        if stored != *source {
                            return Err(invalid());
                        }
                        admission
                            .require_access(&authorization::material_read_impact(tx, &stored).await?)?;
                        content::require_parse_artifact_in_transaction(tx, id, &source.reference)
                            .await?;
                    }
                    Ok(())
                })
            },
        )
        .await?;
        let inputs = parsed.clone();
        let owner = ctx.resources.content.clone();
        let committed = ctx
            .transact(
                "materials.parse-read",
                request_digest.clone(),
                &["content"],
                move |tx, admission, _, run| {
                    Box::pin(async move {
                        let mut reads = Vec::with_capacity(inputs.artifacts.len());
                        for (source, id) in inputs.sources.iter().zip(&inputs.artifacts) {
                            let current =
                                content::read_source_version_in_transaction(tx, &source.reference)
                                    .await?;
                            if current != *source {
                                return Err(invalid());
                            }
                            admission.require_access(
                                &authorization::material_read_impact(tx, &current).await?,
                            )?;
                            content::require_parse_artifact_in_transaction(tx, id, &source.reference)
                                .await?;
                            let pin_id = ContentId::try_new(key_digest(&(&run.id, "parse-read", id))?)
                                .map_err(codec)?;
                            reads.push(owner.prepare_parse_read(tx, id, pin_id).await?);
                        }
                        Ok(reads)
                    })
                },
            )
            .await?;
        if committed.value.len() != parsed.artifacts.len() {
            return Err(invalid());
        }
        let mut artifacts = Vec::with_capacity(committed.value.len());
        for ((read, source), id) in committed
            .value
            .into_iter()
            .zip(&parsed.sources)
            .zip(&parsed.artifacts)
        {
            check(ctx)?;
            let pinned = Committed {
                value: read,
                receipt: committed.receipt.clone(),
                replayed: committed.replayed,
            };
            let loaded = ctx
                .resources
                .content
                .read_parse_pinned(&ctx.store, &pinned)
                .await?;
            if loaded.artifact().id != *id || loaded.artifact().source_version != source.reference {
                return Err(invalid());
            }
            artifacts.push(loaded);
        }
        check(ctx)?;
        Ok(artifacts)
    })
}

fn evidence_parse<'a>(
    artifacts: &'a [LoadedParse],
    evidence: &world_protocol::facts::Evidence,
) -> Result<Option<&'a LoadedParse>, Error> {
    let Some(id) = &evidence.locator.parse_artifact_id else {
        return Ok(None);
    };
    artifacts
        .iter()
        .find(|loaded| {
            let artifact = loaded.artifact();
            artifact.world == evidence.reference.world
                && artifact.id == *id
                && artifact.source_version == evidence.locator.source_version
        })
        .map(Some)
        .ok_or_else(invalid)
}

/// Only after confirmed terminal settlement; the store rechecks the original typed receipts.
pub(crate) async fn cleanup_terminal(
    store: &crate::store::WorldStore,
    root: &authorization::AuthorityRoot,
    operation: &world_protocol::operation::OperationAccepted,
    run: &RunId,
    command: &world_protocol::api::WorldCommand,
) -> Result<(), Error> {
    use world_protocol::api::WorldCommand;
    let digest = match command {
        WorldCommand::ImportMaterials(request) => canonical_digest(request)?,
        WorldCommand::ProposeMaterialDraft(request) => canonical_digest(request)?,
        _ => return Err(invalid()),
    };
    let commit_id = |key: &str| {
        crate::owner::execution_commit_id(&operation.world, &operation.operation_id, run, key)
    };
    let mut cleanup = async {
        let commit = commit_id("materials.parse-read")?;
        if store
            .read_commit_optional::<Vec<ParseRead>>(&operation.world, &commit, &digest)
            .await?
            .is_some()
        {
            store
                .release_material_parse_reads(root, &operation.world, &commit, &digest, run)
                .await?;
        }
        Ok::<_, Error>(())
    }
    .await
    .err();
    if let WorldCommand::ImportMaterials(request) = command {
        for (index, input) in request.sources.iter().enumerate() {
            let released = async {
                let digest = canonical_digest(&(input, &request.access, &request.retention))?;
                let commit = commit_id(&format!("materials.acquire-{index}"))?;
                if store
                    .read_commit_optional::<Acquired>(&operation.world, &commit, &digest)
                    .await?
                    .is_some()
                {
                    store
                        .release_material_acquisition(
                            root,
                            &operation.world,
                            &commit,
                            &digest,
                            run,
                            index,
                        )
                        .await?;
                }
                Ok::<_, Error>(())
            }
            .await;
            if let Err(error) = released {
                cleanup = Some(match cleanup {
                    Some(previous) => previous.with_related(error),
                    None => error,
                });
            }
        }
    }
    cleanup.map_or(Ok(()), Err)
}

fn draft<'a>(ctx: &'a ExecutionContext, base: &'a Release) -> StoreFuture<'a, Candidate, Error> {
    Box::pin(async move {
        let world = ctx.operation.world.clone();
        let base_id = base.id.clone();
        let run_id = ctx.run.id.clone();
        let digest = canonical_digest(&(&world, &run_id, &base_id))?;
        let id = CandidateId::try_new(key_digest(&(&run_id, "candidate"))?).map_err(codec)?;
        let change_id = ChangeSetId::try_new(key_digest(&(&run_id, "change"))?).map_err(codec)?;
        let value = ctx
            .transact(
                "materials.draft_identity",
                digest,
                &[],
                move |tx, _, _, _| {
                    Box::pin(async move {
                        Ok(Candidate {
                            world: world.clone(),
                            id,
                            change_set: ChangeSet {
                                world,
                                id: change_id,
                                revision: Revision(1),
                                base_release: base_id,
                                operations: Vec::new(),
                                evidence: Vec::new(),
                                cases: Vec::new(),
                                rationale: "Material extraction draft".into(),
                                status: ChangeStatus::Proposed,
                            },
                            origin: CandidateOrigin::Extraction,
                            evidence: Vec::new(),
                            model_calls: Vec::new(),
                            created_at: tx.now().await?,
                        })
                    })
                },
            )
            .await?;
        Ok(value.value)
    })
}

fn inspect<'a>(
    ctx: &'a ExecutionContext,
    id: &'a StepId,
) -> StoreFuture<'a, Option<StepRecord>, Error> {
    Box::pin(async move {
        let id = id.clone();
        ctx.transact(
            &probe(),
            canonical_digest(&id)?,
            &[],
            move |tx, _, _, run| Box::pin(async move { read_step(tx, &run.id, &id).await }),
        )
        .await
        .map(|value| value.value)
    })
}

async fn blocking<T: Send + 'static>(
    ctx: &ExecutionContext,
    work: impl FnOnce() -> Result<T, materials::Error> + Send + 'static,
) -> Result<T, Error> {
    check(ctx)?;
    let mut handle = tokio::task::spawn_blocking(work);
    let result = tokio::select! {
        value = &mut handle => value,
        _ = ctx.cancellation.cancelled() => handle.await,
        _ = tokio::time::sleep_until(ctx.deadline) => { ctx.cancellation.cancel(); handle.await },
    }
    .map_err(|cause| Error::internal(FailureStage::Parse).caused(cause))?
    .map_err(|error| {
        let error = Error::from(error);
        match ctx.budget.check() {
            Ok(()) => error,
            Err(cause) => budget_error(cause.dimension).with_related(error),
        }
    })?;
    Ok(result)
}

fn step_id(ctx: &ExecutionContext, key: &str) -> Result<StepId, Error> {
    StepId::try_new(key_digest(&(&ctx.run.id, key))?).map_err(codec)
}
fn key_digest(value: &impl Serialize) -> Result<String, Error> {
    Ok(canonical_digest(value)?.as_str()[7..].to_owned())
}
fn probe() -> String {
    format!("materials.inspect.{}", uuid::Uuid::new_v4())
}
fn next(ordinal: u32) -> Result<u32, Error> {
    ordinal.checked_add(1).ok_or_else(invalid)
}
fn result<T: DeserializeOwned>(step: &StepRecord) -> Result<T, Error> {
    decode(step.result.clone().ok_or_else(invalid)?)
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(codec)
}
fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(codec)
}
fn codec(cause: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::internal(FailureStage::Prepare).caused(cause)
}
fn invalid() -> Error {
    Error::from(materials::Error::new(MaterialFailure::InputInvalid))
}
fn validate(request: &ImportMaterials) -> Result<(), Error> {
    if request.sources.is_empty()
        || request.sources.len() as u64 > request.budget.max_steps
        || request.task.is_some() != request.compile.is_some()
        || request.budget.max_model_calls == 0
        || request.budget.max_output_tokens == 0
    {
        return Err(invalid());
    }
    Ok(())
}
fn check(ctx: &ExecutionContext) -> Result<(), Error> {
    ctx.budget
        .check()
        .map_err(|cause| budget_error(cause.dimension))?;
    if ctx.cancellation.is_cancelled() || ctx.pipeline.is_cancelled() {
        return Err(Error::from(materials::Error::new(
            MaterialFailure::Cancelled,
        )));
    }
    Ok(())
}
fn charge(ctx: &ExecutionContext, dimension: BudgetDimension, amount: u64) -> Result<(), Error> {
    ctx.budget
        .charge(dimension, amount)
        .map_err(|cause| budget_error(cause.dimension))
}
fn budget_error(dimension: BudgetDimension) -> Error {
    Error::from_host_failure(
        world_protocol::process::HostFailure::BudgetExceeded { dimension },
        FailureStage::Admission,
    )
}
fn unknown(error: &Error) -> bool {
    matches!(
        error.unresolved_phase(),
        Some(
            OperationPhase::CommitIndeterminate
                | OperationPhase::EffectIndeterminate
                | OperationPhase::Retained
        )
    )
}
