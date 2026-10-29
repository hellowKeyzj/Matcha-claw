use std::{collections::BTreeSet, sync::Arc};

use world_protocol::{
    api::{CommandResult, InstallCommand, MigratePackage},
    authorization::{AccessMode, AccessScope, ActualImpact},
    bindings::{ActivationRequest, BindingFailure},
    ids::{EventId, ResourceRef},
    state::StateFailure,
};

use crate::{
    extensions::{
        bindings::{self, ActivationContext, BindingError, BindingGraph, ReservedActivation},
        lifecycle::{load_recovery, prepare_graph, prepare_graph_reserved},
        migration::{
            MIGRATION_CHECKPOINT_KEY, MIGRATION_COMMIT_KEY, MIGRATION_PREPARE_KEY, StateError,
            StateLimits, prepare_checkpoint, prepare_migration, prepare_namespace,
        },
    },
    owner::{Error, ExecutionContext},
    store::{StoreFuture, WorldTransaction},
};

pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    request: &ActivationRequest,
) -> Result<ActualImpact, Error> {
    let graph = BindingGraph::validate(request.graph.clone()).map_err(BindingError::from)?;
    bindings::validate_heads(&graph, &request.heads, &request.channels)?;
    bindings::activation_impact(tx, &graph, &request.heads)
        .await
        .map_err(Error::from)
}

pub(crate) fn run(
    ctx: ExecutionContext,
    request: ActivationRequest,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let graph =
            Arc::new(BindingGraph::validate(request.graph.clone()).map_err(BindingError::from)?);
        bindings::validate_heads(&graph, &request.heads, &request.channels)?;
        if graph.lock().world != ctx.operation.world {
            return Err(BindingError::from(BindingFailure::HeadInvalid).into());
        }
        let digest = crate::definitions::canonical_digest(&request)?;
        let mut namespaces = Vec::new();
        let mut seen = BTreeSet::new();
        for node in &graph.lock().nodes {
            let Some(state) = &node.state else {
                continue;
            };
            if state.migration.is_some() {
                continue;
            }
            if seen.insert(state.namespace.clone()) {
                let namespace = prepare_namespace(
                    &ctx.store,
                    &ctx.resources.inventory,
                    &ctx.operation.world,
                    &node.implementation,
                    &state.namespace,
                )
                .await?;
                if namespace.initializes() {
                    namespaces.push(namespace);
                }
            }
        }
        let mut domains = BTreeSet::from(["bindings".to_owned()]);
        if !namespaces.is_empty() {
            domains.insert("state".to_owned());
        }
        for node in &graph.lock().nodes {
            if let Some(state) = &node.state {
                if !namespaces
                    .iter()
                    .any(|namespace| namespace.initializes() && namespace.binding() == state)
                {
                    domains.insert(state.writer_domain.to_string());
                }
            }
        }
        let domain_names: Vec<_> = domains.iter().map(String::as_str).collect();
        let commit = ctx
            .commit_request("binding.activate", digest, &domain_names)
            .await?;
        let event_id = EventId::try_new(format!("binding-{}", commit.commit_id)).map_err(|cause| {
            Error::internal(world_protocol::failure::FailureStage::Prepare).caused(cause)
        })?;
        let recovery = load_recovery(&ctx.store, ctx.operation.world.clone()).await?;
        let prepared = prepare_graph(
            graph,
            request.channels,
            &recovery,
            &ctx.resources.inventory,
            &ctx.resources.live,
            &ctx.resources.preparation,
            &ctx.cancellation,
            ctx.deadline,
        )
        .await?;
        ctx.resources
            .bindings
            .activate(
                ActivationContext {
                    request: commit,
                    admission: ctx.admission.clone(),
                    operation: ctx.operation.clone(),
                    heads: request.heads,
                    namespaces,
                    migrations: Vec::new(),
                    install_revision: None,
                    reservation: None,
                    source_lock: None,
                    event_id,
                },
                prepared,
            )
            .await?;
        ctx.owner.repair_startup(ctx.operation.world.clone()).await?;
        Ok(CommandResult::Accepted(ctx.operation))
    })
}

pub(crate) async fn migration_impact(
    tx: &WorldTransaction<'_>,
    request: &MigratePackage,
) -> Result<ActualImpact, Error> {
    validate_migration(request)?;
    let graph =
        BindingGraph::validate(request.activation.graph.clone()).map_err(BindingError::from)?;
    bindings::validate_heads(
        &graph,
        &request.activation.heads,
        &request.activation.channels,
    )?;
    let base = bindings::activation_impact(tx, &graph, &request.activation.heads).await?;
    let source = bindings::read_graph_in_transaction(tx, &request.source_lock).await?;
    validate_source(&source, request)?;
    let mut access = base.access;
    access.push(AccessScope {
        resources: vec![
            ResourceRef::Package {
                id: request.install_id.clone(),
            },
            ResourceRef::State {
                id: request.migration.expected.root.id.clone(),
            },
        ],
        fields: Vec::new(),
        modes: vec![AccessMode::Manage, AccessMode::Publish],
        scope: crate::owner::management_scope(tx).await?,
        valid_time: None,
    });
    let mut state = base.state;
    state.push(request.migration.expected.root.clone());
    crate::authorization::actual_impact(access, base.effects, base.labels, state, base.source_ids)
        .map_err(Error::from)
}

pub(crate) fn migrate(
    ctx: ExecutionContext,
    request: MigratePackage,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let observer = ctx
            .resources
            .tasks
            .spawn_run(&ctx, migrate_owned(ctx.clone(), request))?;
        observer.await.map_err(|cause| {
            Error::internal(world_protocol::failure::FailureStage::Migrate).caused(cause)
        })?
    })
}

fn migrate_owned(
    ctx: ExecutionContext,
    request: MigratePackage,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        validate_migration(&request)?;
        let graph = Arc::new(
            BindingGraph::validate(request.activation.graph.clone()).map_err(BindingError::from)?,
        );
        bindings::validate_heads(
            &graph,
            &request.activation.heads,
            &request.activation.channels,
        )?;
        if graph.lock().world != ctx.operation.world {
            return Err(StateError::from(StateFailure::Fenced).into());
        }
        let source_lock = request.source_lock.clone();
        let source = ctx
            .store
            .snapshot(ctx.operation.world.clone(), move |snapshot| {
                Box::pin(async move {
                    bindings::read_active_graph(snapshot, &source_lock)
                        .await
                        .map(Arc::new)
                })
            })
            .await?;
        validate_source(&source, &request)?;
        let recovery = load_recovery(&ctx.store, ctx.operation.world.clone()).await?;
        let config = recovery
            .installs
            .get(&request.install_id)
            .and_then(|install| install.config.clone())
            .filter(|config| config.digest == request.implementation.config_digest)
            .ok_or_else(|| StateError::from(StateFailure::Fenced))?;
        if recovery
            .installs
            .get(&request.install_id)
            .is_none_or(|install| {
                install.revision != request.expected_revision
                    || !install.desired_enabled
                    || install.pending_removal
                    || !install.trusted
                    || install.quarantined
            })
        {
            return Err(StateError::from(StateFailure::Fenced).into());
        }
        let mut namespaces = Vec::new();
        let mut seen = BTreeSet::new();
        for node in &graph.lock().nodes {
            let Some(state) = &node.state else {
                continue;
            };
            if state.namespace != request.migration.expected.namespace
                && state.migration.is_none()
                && seen.insert(state.namespace.clone())
            {
                let namespace = prepare_namespace(
                    &ctx.store,
                    &ctx.resources.inventory,
                    &ctx.operation.world,
                    &node.implementation,
                    &state.namespace,
                )
                .await?;
                if namespace.initializes() {
                    namespaces.push(namespace);
                }
            }
        }
        let digest = crate::definitions::canonical_digest(&request)?;
        let mut domains = BTreeSet::from([
            "bindings".to_owned(),
            "content".to_owned(),
            "state".to_owned(),
            request.migration.expected.writer_domain.to_string(),
        ]);
        for node in &graph.lock().nodes {
            if let Some(state) = &node.state {
                if !namespaces
                    .iter()
                    .any(|namespace| namespace.initializes() && namespace.binding() == state)
                {
                    domains.insert(state.writer_domain.to_string());
                }
            }
        }
        let domains: Vec<_> = domains.iter().map(String::as_str).collect();
        let commit = ctx
            .commit_request(MIGRATION_COMMIT_KEY, digest, &domains)
            .await?;
        let reservation = ctx.resources.bindings.reserve_migration(
            &commit,
            &graph,
            &request.activation.heads,
            &request.migration.expected,
        )?;
        let work = async {
            let drained = ctx
                .resources
                .bindings
                .drain_migration(&reservation, ctx.deadline)
                .await?;
            let limits = StateLimits {
                maximum_keys: ctx.budget.limit().max_rows,
                maximum_bytes: ctx.budget.limit().max_bytes,
            };
            let source_node = source
                .node(&request.source_node)
                .map_err(BindingError::from)?;
            let checkpoint = Arc::new(
                prepare_checkpoint(
                    &ctx.store,
                    &ctx.resources.content,
                    &ctx.resources.live,
                    &ctx.admission,
                    source_node,
                    drained,
                    limits,
                    &ctx.cancellation,
                )
                .await?,
            );
            if let Err(error) = checkpoint_stages(
                &ctx,
                &reservation,
                MIGRATION_CHECKPOINT_KEY,
                checkpoint.staged_commit(commit.clone()),
            )
            .await
            {
                return Err(match checkpoint.discard_prepared() {
                    Ok(()) => {
                        reservation.release_stage(&ctx.commit_id(MIGRATION_CHECKPOINT_KEY)?);
                        error
                    }
                    Err(cleanup) => error.with_related(cleanup),
                });
            }
            let migration = match prepare_migration(
                &ctx.store,
                &ctx.resources.inventory,
                &ctx.resources.live,
                &source,
                &ctx.admission,
                checkpoint.clone(),
                request.migration.clone(),
                request.implementation.clone(),
                config,
                ctx.resources.preparation.engine_resources(),
                ctx.resources.preparation.execution_policy(),
                ctx.resources.preparation.artifact_limit(),
                limits,
                &ctx.cancellation,
                ctx.deadline,
            )
            .await
            {
                Ok(migration) => migration,
                Err(error) => {
                    let mut error = Error::from(error);
                    if let Err(cleanup) = checkpoint.discard_prepared() {
                        error = error.with_related(cleanup);
                    }
                    return Err(error);
                }
            };
            if let Err(error) = checkpoint_stages(
                &ctx,
                &reservation,
                MIGRATION_PREPARE_KEY,
                migration.staged_commit(commit.clone()),
            )
            .await
            {
                return Err(match migration.discard_prepared() {
                    Ok(()) => {
                        reservation.release_stage(&ctx.commit_id(MIGRATION_PREPARE_KEY)?);
                        error
                    }
                    Err(cleanup) => error.with_related(cleanup),
                });
            }
            if !graph
                .lock()
                .nodes
                .iter()
                .any(|node| node.state.as_ref() == Some(migration.binding()))
            {
                let error = Error::from(StateError::from(StateFailure::ShadowValidationFailed));
                return Err(match migration.discard_prepared() {
                    Ok(()) => error,
                    Err(cleanup) => error.with_related(cleanup),
                });
            }
            let event_id = match EventId::try_new(format!("binding-{}", commit.commit_id)) {
                Ok(event_id) => event_id,
                Err(cause) => {
                    let error =
                        Error::internal(world_protocol::failure::FailureStage::Prepare).caused(cause);
                    return Err(match migration.discard_prepared() {
                        Ok(()) => error,
                        Err(cleanup) => error.with_related(cleanup),
                    });
                }
            };
            let prepared = match prepare_graph_reserved(
                graph.clone(),
                request.activation.channels,
                &recovery,
                &ctx.resources.inventory,
                &ctx.resources.live,
                &ctx.resources.preparation,
                &ctx.cancellation,
                ctx.deadline,
                &commit.commit_id,
            )
            .await
            {
                Ok(prepared) => prepared,
                Err(error) => {
                    let error = Error::from(error);
                    return Err(match migration.discard_prepared() {
                        Ok(()) => error,
                        Err(cleanup) => error.with_related(cleanup),
                    });
                }
            };
            ctx.resources
                .bindings
                .activate(
                    ActivationContext {
                        request: commit,
                        admission: ctx.admission.clone(),
                        operation: ctx.operation.clone(),
                        heads: request.activation.heads,
                        namespaces,
                        migrations: vec![migration],
                        install_revision: Some(InstallCommand {
                            install_id: request.install_id,
                            expected_revision: request.expected_revision,
                        }),
                        reservation: Some(reservation.clone()),
                        source_lock: Some(request.source_lock),
                        event_id,
                    },
                    prepared,
                )
                .await?;
            ctx.owner.maintain(ctx.operation.world.clone()).await?;
            Ok::<_, Error>(CommandResult::Accepted(ctx.operation.clone()))
        }
        .await;
        if work.is_err() && reservation.may_restore() {
            if let Err(cleanup) = restore_previous(&ctx, &reservation).await {
                return Err(work.err().expect("failed migration").with_related(cleanup));
            }
        }
        work
    })
}

async fn checkpoint_stages(
    ctx: &ExecutionContext,
    reservation: &ReservedActivation,
    key: &str,
    staged: Result<crate::content::StagedCommit, Error>,
) -> Result<(), Error> {
    let staged = staged?;
    let checkpoint = ctx.commit_id(key)?;
    reservation.retain_stage(checkpoint.clone(), staged.clone())?;
    let digest = crate::definitions::canonical_digest(&staged)?;
    ctx.transact(key, digest, &[], move |_, _, _, _| {
        Box::pin(async move { Ok(staged) })
    })
    .await?;
    reservation.release_stage(&checkpoint);
    Ok(())
}

pub(crate) async fn recover_stage_cleanup(
    store: &crate::store::WorldStore,
    content: &crate::content::Content,
    authority: &crate::authorization::AuthorityRoot,
    world: &world_protocol::ids::WorldRef,
    checkpoint_id: &world_protocol::ids::CommitId,
) -> Result<crate::content::StageCleanupOutcome, Error> {
    let checkpoint = store
        .read_commit_for_recovery::<crate::content::StagedCommit>(authority, world, checkpoint_id)
        .await?;
    content
        .discard_committed_stages(store, authority, &checkpoint)
        .await
        .map_err(Into::into)
}

fn validate_migration(request: &MigratePackage) -> Result<(), Error> {
    let expected = &request.migration.expected;
    if request.migration_id != request.migration.id
        || request.install_id != request.implementation.install_id
        || expected.world != request.activation.graph.world
        || expected.root.world != expected.world
        || expected.root.revision.0 == 0
        || expected.writer_epoch.0 == 0
        || request.migration.contract
            != world_protocol::state::migration_contract()
                .map_err(|_| StateError::from(StateFailure::ShadowValidationFailed))?
    {
        return Err(StateError::from(StateFailure::CheckpointBarrierUnsatisfied).into());
    }
    Ok(())
}

fn validate_source(source: &BindingGraph, request: &MigratePackage) -> Result<(), Error> {
    let node = source
        .node(&request.source_node)
        .map_err(BindingError::from)?;
    let expected = &request.migration.expected;
    if node.state.as_ref().is_none_or(|state| {
        state.namespace != expected.namespace
            || state.root.id != expected.root.id
            || state.root.world != expected.world
            || state.root.revision > expected.root.revision
            || state.schema != expected.schema
            || state.writer_domain != expected.writer_domain
            || state.writer_epoch != expected.writer_epoch
    }) || node.implementation.checkpoint_format.as_ref() != Some(&expected.checkpoint_format)
    {
        return Err(StateError::from(StateFailure::CheckpointBarrierUnsatisfied).into());
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct MaintenanceResult {
    pub retiring: Vec<crate::extensions::lifecycle::RetiringGraph>,
    pub drained: Vec<crate::extensions::lifecycle::DrainedGraph>,
    pub retry_finish: Vec<(world_protocol::ids::ActivationLockId, bindings::RetirementContext)>,
    pub unknown: Vec<world_protocol::ids::CommitId>,
    pub released: Vec<world_protocol::ids::ActivationLockId>,
    pub retained: Vec<world_protocol::ids::ActivationLockId>,
    pub failures: Vec<Error>,
}

pub(crate) async fn maintenance(
    ctx: &crate::owner::MaintenanceContext,
    candidates: Vec<bindings::RetirementCandidate>,
    previous: MaintenanceResult,
) -> MaintenanceResult {
    let MaintenanceResult { mut retiring, mut drained, retry_finish, unknown, released, retained, .. } = previous;
    let mut result = MaintenanceResult { released, retained, ..MaintenanceResult::default() };
    for commit in unknown {
        if let Err(error) = retirement_step(ctx) {
            result.unknown.push(commit);
            result.failures.push(error);
            continue;
        }
        match ctx.resources.bindings.recover_retirement_commit(&ctx.admission.invocation().world, &commit).await {
            Ok(bindings::RetirementCommitted::Draining { retirement, .. }) => retiring.push(retirement),
            Ok(bindings::RetirementCommitted::Released { lock, .. }) => result.released.push(lock),
            Err(error) => {
                result.unknown.push(commit);
                result.failures.push(error.into());
            }
        }
    }
    for (lock, context) in retry_finish {
        if let Err(error) = retirement_step(ctx) {
            result.retry_finish.push((lock, context));
            result.failures.push(error);
            continue;
        }
        let outcome = ctx.resources.bindings.retry_finish_retirement(context.clone(), &lock).await;
        record_retirement(&mut result, lock, context, outcome);
    }
    for candidate in candidates {
        let graph = candidate.graph;
        let lock = graph.lock().id.clone();
        if ctx.cancellation.is_cancelled() {
            result.retained.push(lock);
            continue;
        }
        if let Err(error) = retirement_step(ctx).and_then(|()| {
            ctx.budget.charge(world_protocol::budget::BudgetDimension::Rows, 1).map_err(|failure| {
                Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded {
                    dimension: failure.dimension,
                }, world_protocol::failure::FailureStage::Drain)
            })
        }) {
            result.retained.push(lock);
            result.failures.push(error);
            continue;
        }
        let context = retirement_context(ctx, graph.lock().world.clone(), lock.clone(),
            graph.lock().digest.clone(), candidate.revision, "begin").await;
        let context = match context {
            Ok(context) => context,
            Err(error) => {
                result.retained.push(lock);
                result.failures.push(error);
                continue;
            }
        };
        match ctx.resources.bindings.begin_retirement(context.clone(), graph).await {
            Ok(bindings::RetirementCommitted::Draining { retirement, .. }) => retiring.push(retirement),
            Ok(bindings::RetirementCommitted::Released { lock, .. }) => result.released.push(lock),
            Err(error) => {
                let error = Error::from(error);
                if matches!(&error.safe_failure().recovery, world_protocol::failure::Recovery::ReadCommit { commit_id } if commit_id == &context.request.commit_id) {
                    result.unknown.push(context.request.commit_id);
                } else {
                    result.retained.push(lock);
                }
                result.failures.push(error);
            }
        }
    }
    for graph in retiring {
        if let Err(error) = retirement_step(ctx) {
            result.retiring.push(graph);
            result.failures.push(error);
            continue;
        }
        match graph.drain_until(ctx.deadline).await {
            Ok(proof) => drained.push(proof),
            Err((graph, remaining)) => {
                result.retiring.push(graph);
                result.failures.push(
                    crate::extensions::lifecycle::LifecycleError::Cleanup {
                        cause: Box::new(crate::extensions::lifecycle::LifecycleError::Contract(
                            world_protocol::lifecycle::LifecycleFailure::AcquisitionClosed,
                        )),
                        remaining_resources: remaining
                            .iter()
                            .flat_map(crate::extensions::lifecycle::retained_resources)
                            .collect(),
                    }
                    .into(),
                );
            }
        }
    }
    for proof in drained {
        if let Err(error) = retirement_step(ctx) {
            result.drained.push(proof);
            result.failures.push(error);
            continue;
        }
        for failure in proof.process_failures() {
            result.failures.push(
                crate::extensions::lifecycle::LifecycleError::Process(failure.clone()).into(),
            );
        }
        let context = async {
            let revision = ctx.resources.bindings.retirement_revision(proof.world(), proof.lock())?;
            retirement_context(ctx, proof.world().clone(), proof.lock().clone(),
                proof.digest().clone(), revision, "finish").await
        }.await;
        let context = match context {
            Ok(context) => context,
            Err(error) => {
                result.drained.push(proof);
                result.failures.push(error);
                continue;
            }
        };
        let lock = proof.lock().clone();
        let outcome = ctx.resources.bindings.finish_retirement(context.clone(), proof).await;
        record_retirement(&mut result, lock, context, outcome);
    }
    result
}

fn retirement_step(ctx: &crate::owner::MaintenanceContext) -> Result<(), Error> {
    ctx.budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|failure| {
        Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded {
            dimension: failure.dimension,
        }, world_protocol::failure::FailureStage::Drain)
    })
}

async fn retirement_context(
    ctx: &crate::owner::MaintenanceContext,
    world: world_protocol::ids::WorldRef,
    lock: world_protocol::ids::ActivationLockId,
    digest: world_protocol::ids::Digest,
    revision: world_protocol::ids::Revision,
    phase: &str,
) -> Result<bindings::RetirementContext, Error> {
    if world != ctx.admission.invocation().world {
        return Err(BindingError::from(BindingFailure::LockIdentityConflict).into());
    }
    let input = crate::definitions::canonical_digest(&(&world, &lock, digest, revision))?;
    let request = ctx.commit_request(&format!("binding.retire.{lock}.{phase}"), input, &["bindings"]).await?;
    let event_id = EventId::try_new(format!("retired-{}", request.commit_id)).map_err(|cause| {
        Error::internal(world_protocol::failure::FailureStage::Prepare).caused(cause)
    })?;
    Ok(bindings::RetirementContext { request, admission: ctx.admission.clone(), expected_revision: revision, event_id })
}

fn record_retirement(
    result: &mut MaintenanceResult,
    lock: world_protocol::ids::ActivationLockId,
    context: bindings::RetirementContext,
    outcome: Result<bindings::RetirementCommitted, BindingError>,
) {
    match outcome {
        Ok(bindings::RetirementCommitted::Released { lock, .. }) => result.released.push(lock),
        Ok(bindings::RetirementCommitted::Draining { retirement, .. }) => result.retiring.push(retirement),
        Err(error) => {
            let error = Error::from(error);
            if matches!(&error.safe_failure().recovery, world_protocol::failure::Recovery::ReadCommit { commit_id } if commit_id == &context.request.commit_id) {
                result.unknown.push(context.request.commit_id);
            } else {
                result.retry_finish.push((lock, context));
            }
            result.failures.push(error);
        }
    }
}

async fn restore_previous(
    ctx: &ExecutionContext,
    reservation: &ReservedActivation,
) -> Result<(), Error> {
    let deadline =
        tokio::time::Instant::now() + ctx.resources.preparation.execution_policy().cleanup_timeout;
    ctx.resources
        .bindings
        .drain_migration(reservation, deadline)
        .await?;
    let recovery = load_recovery(&ctx.store, ctx.operation.world.clone()).await?;
    let cancellation = tokio_util::sync::CancellationToken::new();
    let commit = reservation.commit_id();
    let mut restored = Vec::new();
    for (graph, channels) in reservation.affected_graphs() {
        match prepare_graph_reserved(
            graph,
            channels,
            &recovery,
            &ctx.resources.inventory,
            &ctx.resources.live,
            &ctx.resources.preparation,
            &cancellation,
            deadline,
            commit,
        )
        .await
        {
            Ok(graph) => restored.push(graph),
            Err(error) => {
                for candidate in restored {
                    ctx.resources.bindings.reject_candidate(candidate);
                }
                return Err(error.into());
            }
        }
    }
    ctx.resources
        .bindings
        .restore_migration(reservation, restored)
        .map_err(Error::from)
}
