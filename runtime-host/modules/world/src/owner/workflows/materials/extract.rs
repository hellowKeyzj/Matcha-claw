use super::*;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ExtractCheckpoint {
    pub(super) request: SemanticExtractRequest,
    pub(super) generation: GenerationRequest,
}

pub(super) async fn extract(
    ctx: &ExecutionContext,
    bound: &Arc<dyn BoundGeneration>,
    base: &Arc<Release>,
    scope: &Arc<Scope>,
    source: &Arc<SourceVersion>,
    artifact: &Arc<ParseArtifact>,
    content: Option<DocumentChunkContent>,
    key: &str,
    ordinal: u32,
) -> Result<CandidateBatch, Error> {
    let work = ctx.clone();
    let bound = bound.clone();
    let base = base.clone();
    let scope = scope.clone();
    let source = source.clone();
    let artifact = artifact.clone();
    let key = key.to_owned();
    ctx.pipeline
        .step(format!("materials.{key}"), move |_| {
            Box::pin(async move {
                execute_extract(
                    &work, &bound, &base, &scope, &source, &artifact, content, &key, ordinal,
                )
                .await
            })
        })
        .await
}

fn execute_extract<'a>(
    ctx: &'a ExecutionContext,
    bound: &'a Arc<dyn BoundGeneration>,
    base: &'a Arc<Release>,
    scope: &'a Arc<Scope>,
    source: &'a Arc<SourceVersion>,
    artifact: &'a Arc<ParseArtifact>,
    content: Option<DocumentChunkContent>,
    key: &'a str,
    ordinal: u32,
) -> StoreFuture<'a, CandidateBatch, Error> {
    Box::pin(async move {
        check(ctx)?;
        let id = step_id(ctx, key)?;
        let current_id = id.clone();
        let current_source = source.clone();
        let current_artifact = artifact.clone();
        let existing: StoreFuture<'_, Committed<Option<StepRecord>>, Error> = Box::pin(async {
            ctx.transact(
                &probe(), canonical_digest(&id)?, &[],
                move |tx, admission, operation, run| Box::pin(async move {
                    if operation.receipt.cancellation != world_protocol::operation::CancellationState::NotRequested {
                        return Err(materials::Error::new(MaterialFailure::Cancelled).into());
                    }
                    if ledger::terminal(operation.receipt.phase) || ledger::terminal(run.phase) { return Err(invalid()); }
                    require_extract_source(tx, &admission, &current_source, &current_artifact).await?;
                    read_step(tx, &run.id, &current_id).await
                }),
            ).await
        });
        let existing = existing.await?.value;
        let saved = existing.as_ref().map(|step| read_extract_checkpoint(step, ordinal)).transpose()?;
        let request = match &saved {
            Some(saved) => {
                if content.as_ref().is_some_and(|content| content != &saved.request.content) {
                    return Err(invalid());
                }
                saved.request.clone()
            }
            None => SemanticExtractRequest {
                world: ctx.operation.world.clone(), base_release: base.id.clone(),
                content: content.ok_or_else(invalid)?, definitions: base.definitions.clone(),
                scope: scope.as_ref().clone(), budget: ctx.run.budget.clone(),
            },
        };
        if request.world != ctx.operation.world || request.base_release != base.id
            || request.definitions != base.definitions || request.scope != **scope
            || request.budget != ctx.run.budget || request.content.chunk.source_version != source.reference
            || request.content.chunk.parse_artifact_id != artifact.id
        { return Err(invalid()); }
        if let Some(saved) = &saved {
            if saved.generation.binding != bound.binding().reference { return Err(invalid()); }
        }
        if let Some(step) = &existing {
            if step.phase == OperationPhase::Completed { return result(step); }
        }
        let mut prepared = None;
        let generation_request = if let Some(saved) = saved {
            saved.generation
        } else {
            charge(ctx, BudgetDimension::Steps, 1)?;
            let response = material_call(ctx, materials::MaterialRequest::Prepare {
                source: source.as_ref().clone(), artifact: artifact.as_ref().clone(), request: request.clone(),
                binding: bound.binding().clone(), run_id: ctx.run.id.clone(), step_id: id.clone(),
            }).await?;
            let saved_source = source.as_ref().clone();
            let saved_request = request.clone();
            let content_owner = ctx.resources.content.clone();
            let cancel = ctx.cancellation.clone();
            let value = Arc::new(blocking(ctx, move || materials::prepare_extraction(
                &content_owner, saved_source, saved_request, response, &cancel,
            )).await?);
            if let Err(error) = check(ctx) {
                return match value.discard(&ctx.resources.content) {
                    Ok(()) => Err(error), Err(cleanup) => Err(error.with_related(cleanup.into())),
                };
            }
            let input = value.input();
            if input.request.run_id != ctx.run.id || input.request.step_id != id
                || input.request.binding != bound.binding().reference {
                let error = invalid();
                return match value.discard(&ctx.resources.content) {
                    Ok(()) => Err(error), Err(cleanup) => Err(error.with_related(cleanup.into())),
                };
            }
            prepared = Some(value);
            input.request
        };
        if existing.is_none() {
            let prepared = prepared.as_ref().ok_or_else(invalid)?;
            let digest = canonical_digest(prepared.request())?;
            let checkpoint = ExtractCheckpoint {
                request: prepared.request().clone(),
                generation: generation_request.clone(),
            };
            let owner = ctx.resources.content.clone();
            let work = prepared.clone();
            let budget = ctx.budget.clone();
            let current_source = source.clone();
            let current_artifact = artifact.clone();
            let claimed: StoreFuture<'_, Committed<StepRecord>, Error> = Box::pin(async {
                ctx
                    .transact(
                        &format!("materials.{key}.prepare"),
                        digest.clone(),
                        &["content"],
                        move |tx, admission, _, run| {
                            Box::pin(async move {
                                require_extract_source(tx, &admission, &current_source, &current_artifact).await?;
                                let step = claim_step(
                                    tx,
                                    &admission,
                                    &run,
                                    id,
                                    ordinal,
                                    "materials.extract",
                                    digest,
                                    &tx.now().await?,
                                )
                                .await?;
                                work.register_in_transaction(&owner, tx)
                                    .await
                                    .map_err(Error::from)?;
                                let mut next = step.clone();
                                next.checkpoint = encode(&checkpoint)?;
                                checkpoint_usage(
                                    tx,
                                    &run,
                                    confirmed_usage(&run.usage, budget.checkpoint_usage())?,
                                )
                                .await?;
                                checkpoint_step(tx, &step, next).await
                            })
                        },
                    )
                    .await
            });
            let claimed = claimed.await;
            if let Err(error) = claimed {
                if unknown(&error) {
                    return Err(error);
                }
                return match prepared.discard(&ctx.resources.content) {
                    Ok(()) => Err(error),
                    Err(cleanup) => Err(error.with_related(Error::from(cleanup))),
                };
            }
        }
        // The confirmed prepare retained these bytes; discard private stages before waiting on Provider.
        if let Some(prepared) = prepared.take() {
            prepared.discard(&ctx.resources.content).map_err(Error::from)?;
        }
        let checkpoint = ExtractCheckpoint { request: request.clone(), generation: generation_request.clone() };
        let recorded = generation::generate(
            &ctx.store,
            &ctx.resources.model_calls,
            &ctx.admission,
            &ctx.pipeline,
            &ctx.budget,
            ctx.resources.content.clone(),
            bound.clone(),
            generation_request.clone(),
            vec![source.reference.clone()],
            key,
            ctx.cancellation.clone(),
            ctx.deadline,
        )
        .await?;
        if recorded.request() != &generation_request { return Err(invalid()); }
        let response = material_call(ctx, materials::MaterialRequest::Finish {
            source: source.as_ref().clone(), artifact: artifact.as_ref().clone(), request,
            generation: recorded.request().clone(), receipt: recorded.receipt().clone(),
        }).await?;
        let materials::MaterialResponse::Finish { batch } = response else { return Err(invalid()); };
        let rows = batch
            .candidates
            .len()
            .saturating_add(batch.observations.len())
            .saturating_add(batch.evidence.len());
        charge(ctx, BudgetDimension::Rows, rows as u64)?;
        let digest = canonical_digest(&batch)?;
        let value = batch.clone();
        let id = step_id(ctx, key)?;
        let budget = ctx.budget.clone();
        let current_source = source.clone();
        let current_artifact = artifact.clone();
        let cancel = ctx.cancellation.clone();
        check(ctx)?;
        let accepted: StoreFuture<'_, Committed<()>, Error> = Box::pin(async {
            ctx.transact(
                &format!("materials.{key}.accepted"),
                digest,
                &[],
                move |tx, admission, operation, run| {
                    Box::pin(async move {
                        if cancel.is_cancelled() || operation.receipt.cancellation != world_protocol::operation::CancellationState::NotRequested {
                            return Err(materials::Error::new(MaterialFailure::Cancelled).into());
                        }
                        if ledger::terminal(operation.receipt.phase) || ledger::terminal(run.phase) { return Err(invalid()); }
                        require_extract_source(tx, &admission, &current_source, &current_artifact).await?;
                        let step = read_step(tx, &run.id, &id).await?.ok_or_else(invalid)?;
                        if step.phase != OperationPhase::Running || read_extract_checkpoint(&step, ordinal)? != checkpoint {
                            return Err(invalid());
                        }
                        let current = generation::read_recorded(tx, &admission, &recorded.receipt().id).await?.ok_or_else(invalid)?;
                        if current.request() != &checkpoint.generation || current.receipt() != recorded.receipt() {
                            return Err(invalid());
                        }
                        let mut next = step.clone();
                        next.phase = OperationPhase::Completed;
                        next.result = Some(encode(&value)?);
                        checkpoint_step(tx, &step, next).await?;
                        input::append_draft(tx, &run, &value).await?;
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
            .await
        });
        accepted.await?;
        Ok(batch)
    })
}

pub(super) fn read_extract_checkpoint(step: &StepRecord, ordinal: u32) -> Result<ExtractCheckpoint, Error> {
    let checkpoint: ExtractCheckpoint = decode(step.checkpoint.clone())?;
    let request = &checkpoint.request;
    let generation = &checkpoint.generation;
    if step.kind != "materials.extract" || step.ordinal != ordinal || step.failure.is_some()
        || !matches!((step.phase, step.result.is_some()),
            (OperationPhase::Running, false) | (OperationPhase::Completed, true))
        || step.input_digest != canonical_digest(request)?
        || generation.world != request.world || generation.run_id != step.run_id
        || generation.step_id != step.id || generation.budget != request.budget
        || request.scope.world != request.world || request.content.chunk.source_version.world != request.world
        || request.definitions.iter().any(|definition| definition.reference.world != request.world)
    { return Err(invalid()); }
    Ok(checkpoint)
}

pub(crate) async fn extraction_access(
    tx: &WorldTransaction<'_>,
    run: &crate::owner::RunRecord,
    step: &StepRecord,
    generation: &GenerationRequest,
    sources: &[SourceVersionRef],
) -> Result<AccessScope, Error> {
    let checkpoint = read_extract_checkpoint(step, step.ordinal)?;
    let request = &checkpoint.request;
    let chunk = &request.content.chunk;
    if checkpoint.generation != *generation
        || generation.world != *tx.world()
        || generation.run_id != run.id || step.run_id != run.id
        || step.ordinal < 3 || step.ordinal as u64 >= run.budget.max_steps
        || request.budget != run.budget
        || run.release_id.as_ref() != Some(&request.base_release)
        || sources != std::slice::from_ref(&chunk.source_version)
    {
        return Err(invalid());
    }
    let (scope_id, _, parsed) = input::read_import_basis(tx, run).await?;
    if scope_id != request.scope.id
        || !parsed.sources.iter().zip(&parsed.artifacts).any(|(source, artifact)| {
            source.reference == chunk.source_version && *artifact == chunk.parse_artifact_id
        })
    {
        return Err(invalid());
    }
    let base = crate::releases::read_release(tx, &request.base_release).await?.ok_or_else(invalid)?;
    let scope = crate::definitions::read_scopes(tx, &[scope_id.clone()])
        .await?.into_iter().next().ok_or_else(invalid)?;
    let binding_id = StepId::try_new(key_digest(&(&run.id, "binding"))?).map_err(codec)?;
    let binding = read_step(tx, &run.id, &binding_id).await?.ok_or_else(invalid)?;
    if request.definitions != base.definitions || request.scope != scope
        || binding.kind != "materials.binding" || binding.ordinal != 1
        || binding.phase != OperationPhase::Completed || binding.failure.is_some()
        || result::<generation::BindingBasis>(&binding)?.reference() != &generation.binding
    {
        return Err(invalid());
    }
    content::require_parse_artifact_in_transaction(tx, &chunk.parse_artifact_id, &chunk.source_version).await?;
    Ok(AccessScope {
        resources: vec![ResourceRef::Source { id: chunk.source_version.source_id.clone() }],
        fields: Vec::new(),
        modes: vec![AccessMode::Execute],
        scope: scope_id,
        valid_time: None,
    })
}

async fn require_extract_source(
    tx: &WorldTransaction<'_>, admission: &Admission, source: &SourceVersion, artifact: &ParseArtifact,
) -> Result<(), Error> {
    if &source.reference.world != tx.world() || artifact.world != source.reference.world
        || artifact.source_version != source.reference
    { return Err(invalid()); }
    let current = content::read_source_version_in_transaction(tx, &source.reference).await?;
    if current != *source { return Err(invalid()); }
    admission.require_access(&authorization::material_read_impact(tx, &current).await?)?;
    content::require_parse_artifact_in_transaction(tx, &artifact.id, &source.reference).await?;
    Ok(())
}

fn candidate_selections<'a>(
    draft: &'a MaterialDraft,
    selection: &MaterialCompileSelection,
) -> Result<Vec<(&'a Candidate, CompileSelection)>, Error> {
    if selection.candidates.len() != draft.batch.candidates.len() {
        return Err(invalid());
    }
    let mut selected = std::collections::BTreeMap::new();
    for candidate in &selection.candidates {
        if selected.insert(&candidate.candidate_id, &candidate.external_contracts).is_some() {
            return Err(invalid());
        }
    }
    draft.batch.candidates.iter().map(|candidate| {
        let external_contracts = selected.remove(&candidate.id).ok_or_else(invalid)?;
        Ok((candidate, CompileSelection {
            activation_lock_id: selection.activation_lock_id.clone(),
            external_contracts: external_contracts.clone(),
        }))
    }).collect()
}

pub(crate) async fn propose_impact(
    tx: &WorldTransaction<'_>,
    request: &ProposeMaterialDraft,
) -> Result<ActualImpact, Error> {
    let (draft, _) = input::read_aligned_draft(tx, &request.draft).await?;
    if !draft.batch.read_needs.is_empty() || request.task.world != *tx.world() {
        return Err(invalid());
    }
    let candidates = candidate_selections(&draft, &request.compile)?;
    let task = crate::evaluation::read_task(tx, &request.task.id, request.task.revision).await?;
    let (_, target) = crate::extensions::bindings::read_activation_metadata(
        tx, &request.compile.activation_lock_id,
    ).await?;
    let mut impact = input::draft_read_impact(tx, &draft).await?;
    if let Some(target) = target {
        impact.access.extend(target.access);
        impact.effects.extend(target.effects);
        impact.labels.extend(target.labels);
        impact.state.extend(target.state);
        impact.source_ids.extend(target.source_ids);
    }
    impact.access.push(AccessScope {
        resources: vec![ResourceRef::Task { id: task.id }],
        fields: Vec::new(),
        modes: vec![AccessMode::Read],
        scope: task.scope,
        valid_time: None,
    });
    if !draft.batch.evidence.is_empty() {
        impact.effects.push(Effect::Pure);
    }
    for evidence in &draft.batch.evidence {
        impact.access.push(AccessScope {
            resources: vec![ResourceRef::Evidence {
                id: evidence.reference.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Write],
            scope: draft.scope.clone(),
            valid_time: None,
        });
        impact.access.push(AccessScope {
            resources: vec![ResourceRef::Source {
                id: evidence.locator.source_version.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: draft.scope.clone(),
            valid_time: None,
        });
    }
    for proof in input::read_draft_observations(tx, &draft.reference).await? {
        for current in [
            crate::facts::assertions::extracted_observation_impact(tx, &proof).await?,
            generation::draft_observation_impact(tx, &proof).await?,
        ] {
            impact.access.extend(current.access);
            impact.effects.extend(current.effects);
            impact.labels.extend(current.labels);
            impact.state.extend(current.state);
            impact.source_ids.extend(current.source_ids);
        }
    }
    for (candidate, compile) in candidates {
        let proof = input::read_draft_model_calls(tx, &draft.reference, &candidate.id).await?;
        for id in &candidate.model_calls {
            let current = generation::draft_impact(tx, &proof, id).await?;
            impact.access.extend(current.access);
            impact.effects.extend(current.effects);
            impact.labels.extend(current.labels);
            impact.state.extend(current.state);
            impact.source_ids.extend(current.source_ids);
        }
        let branch =
            crate::learning::derive_branch(tx, candidate, &request.task, &compile).await?;
        for mode in [AccessMode::Read, AccessMode::Write] {
            let current =
                crate::learning::draft_candidate_impact(tx, candidate, &branch, mode).await?;
            impact.access.extend(current.access);
            impact.effects.extend(current.effects);
            impact.labels.extend(current.labels);
            impact.state.extend(current.state);
            impact.source_ids.extend(current.source_ids);
        }
    }
    Ok(authorization::actual_impact(
        impact.access,
        impact.effects,
        impact.labels,
        impact.state,
        impact.source_ids,
    )?)
}

pub(super) fn propose_candidates<'a>(
    tx: &'a mut WorldTransaction<'_>,
    admission: &'a Admission,
    draft: &'a MaterialDraft,
    task: &'a TaskRef,
    compile: &'a MaterialCompileSelection,
    owner: &'a content::Content,
    artifacts: &'a [LoadedParse],
    budget: &'a crate::extensions::invocation::CallBudget,
    cancel: &'a tokio_util::sync::CancellationToken,
) -> StoreFuture<'a, Vec<CandidateId>, Error> {
    Box::pin(async move {
        if !draft.batch.read_needs.is_empty() || task.world != *tx.world() {
            return Err(invalid());
        }
        let selections = candidate_selections(draft, compile)?;
        // Validate new embedded evidence before any append can make it appear stored.
        for (candidate, _) in &selections {
            crate::learning::validate_draft_evidence(tx, owner, artifacts, candidate).await?;
        }
        for evidence in &draft.batch.evidence {
            match crate::facts::assertions::read_evidence(tx, &evidence.reference).await? {
                Some(stored) if stored == *evidence => {}
                Some(_) => return Err(invalid()),
                None => {
                    crate::facts::assertions::append_evidence(
                        tx, owner, evidence_parse(artifacts, evidence)?, admission,
                        &draft.scope, evidence, budget, cancel,
                    ).await?;
                }
            }
        }
        input::admit_draft_observations(tx, admission, &draft.reference, budget, cancel).await?;
        let mut candidates = Vec::with_capacity(selections.len());
        for (candidate, selection) in selections {
            let proof = input::read_draft_model_calls(tx, &draft.reference, &candidate.id).await?;
            let candidate = crate::learning::propose_request(
                tx, admission, candidate, task, &selection, Some(&proof), budget, cancel,
                &tx.now().await?,
            ).await?;
            let output = crate::learning::candidate_read_impact(tx, &candidate.id).await?;
            authorization::check_admitted_output(tx, admission, &output, 1, &tx.now().await?).await?;
            candidates.push(candidate.id);
        }
        Ok(candidates)
    })
}

pub(crate) fn propose(
    ctx: ExecutionContext,
    request: ProposeMaterialDraft,
) -> StoreFuture<'static, (), Error> {
    Box::pin(async move {
        let digest = canonical_digest(&request)?;
        let committed: Result<(), Error> = async {
            let saved = request.clone();
            let parsed = ctx
                .transact(&probe(), digest.clone(), &[], move |tx, admission, _, _| {
                    Box::pin(async move {
                        admission.require_access(&propose_impact(tx, &saved).await?)?;
                        let (draft, _) = input::read_draft(tx, &saved.draft).await?;
                        let mut sources = Vec::with_capacity(draft.source_versions.len());
                        for source in &draft.source_versions {
                            sources
                                .push(content::read_source_version_in_transaction(tx, source).await?);
                        }
                        Ok(Parsed {
                            sources,
                            artifacts: draft.parse_artifacts,
                        })
                    })
                })
                .await?
                .value;
            let artifacts = load_artifacts(&ctx, &parsed, &digest).await?;
            let request = request.clone();
            let owner = ctx.resources.content.clone();
            let budget = ctx.budget.clone();
            let cancel = ctx.cancellation.clone();
            ctx.transact(
                "materials.propose",
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
                        admission.require_access(&propose_impact(tx, &request).await?)?;
                        let (draft, _) = input::read_draft(tx, &request.draft).await?;
                        if run.release_id.as_ref() != Some(&draft.base_release)
                            || run.activation_lock_id.as_ref() != Some(&request.compile.activation_lock_id)
                        {
                            return Err(invalid());
                        }
                        for loaded in &artifacts {
                            content::require_loaded_parse_in_transaction(tx, loaded).await?;
                        }
                        let candidates = propose_candidates(
                            tx, &admission, &draft, &request.task, &request.compile,
                            &owner, &artifacts, &budget, &cancel,
                        ).await?;
                        let output = input::draft_read_impact(tx, &draft).await?;
                        authorization::check_admitted_output(
                            tx,
                            &admission,
                            &output,
                            1,
                            &tx.now().await?,
                        )
                        .await?;
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
                                source_versions: draft.source_versions,
                                parse_artifacts: draft.parse_artifacts,
                                candidates,
                                drafts: vec![draft.reference],
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
        }
        .await;
        let command = world_protocol::api::WorldCommand::ProposeMaterialDraft(request);
        match committed {
            Ok(()) => {
                cleanup_terminal(
                    &ctx.store,
                    &ctx.authority,
                    &ctx.operation,
                    &ctx.run.id,
                    &command,
                )
                .await
            }
            Err(error) if unknown(&error) => Err(error),
            Err(error) => match ctx.fail(&error).await {
                Ok(receipt) if crate::owner::terminal_phase(receipt.phase) => {
                    match cleanup_terminal(
                        &ctx.store,
                        &ctx.authority,
                        &ctx.operation,
                        &ctx.run.id,
                        &command,
                    )
                    .await
                    {
                        Ok(()) => Err(error),
                        Err(cleanup) => Err(error.with_related(cleanup)),
                    }
                }
                Ok(_) => Err(error),
                Err(cleanup) => Err(error.with_related(cleanup)),
            },
        }
    })
}

pub(super) fn save_result<'a, T: Serialize + DeserializeOwned + Clone + Send + 'static>(
    ctx: &'a ExecutionContext,
    key: &'a str,
    ordinal: u32,
    digest: Digest,
    value: T,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        charge(ctx, BudgetDimension::Steps, 1)?;
        let id = step_id(ctx, key)?;
        let kind = format!("materials.{key}");
        let budget = ctx.budget.clone();
        ctx.transact(
            &format!("materials.{key}"),
            digest.clone(),
            &[],
            move |tx, admission, _, run| {
                Box::pin(async move {
                    let step = claim_step(
                        tx,
                        &admission,
                        &run,
                        id,
                        ordinal,
                        &kind,
                        digest,
                        &tx.now().await?,
                    )
                    .await?;
                    let mut next = step.clone();
                    next.phase = OperationPhase::Completed;
                    next.result = Some(encode(&value)?);
                    checkpoint_step(tx, &step, next).await?;
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
