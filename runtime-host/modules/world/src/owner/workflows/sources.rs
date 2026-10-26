mod retention;
pub(crate) use retention::{operation_retention_roots, step_retention_roots};

use std::sync::Arc;

use world_protocol::{
    api::{
        ApproveBranchSourceAuthority, BindingCommand, CommandResult, ConfigureConnection,
        DiscoverSchema, QueryResult, SetBranchMapping, SetMapping, WorldCommand, WorldQuery,
    },
    authorization::ActualImpact,
    bindings::{BindingFailure, SlotKind},
    failure::FailureStage,
    operation::{OperationPhase, OperationResult},
    sources::MappingFailure,
    time::Timestamp,
};

use crate::{
    authorization::{self, VerifiedInvocation},
    extensions::{
        bindings::{self, BindingError},
        invocation::InvocationLease,
    },
    owner::{self, Error, ExecutionContext, complete_operation},
    sources::{
        connectors::{self, SourceBroker, SourceError},
        mapping,
        sync::{self, SyncError},
    },
    store::{StoreFuture, WorldTransaction},
};

pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<ActualImpact, Error> {
    let now = tx.now().await?;
    match command {
        WorldCommand::ConfigureConnection(request) => connectors::configure_impact(tx, request)
            .await
            .map_err(|error| SyncError::Source(error).into()),
        WorldCommand::DiscoverSchema(request) => connectors::discovery::impact(tx, request)
            .await
            .map_err(|error| SyncError::Source(error).into()),
        WorldCommand::SetBranchMapping(request) => mapping::branch_mapping_impact(tx, request)
            .await
            .map_err(|error| SyncError::Mapping(error).into()),
        WorldCommand::ApproveBranchSourceAuthority(request) => {
            mapping::branch_authority_impact(tx, &request.branch, &request.authority)
                .await
                .map_err(|error| SyncError::Mapping(error).into())
        }
        WorldCommand::SetMapping(request) => mapping::set_mapping_impact(tx, request, &now)
            .await
            .map_err(Error::from),
        WorldCommand::StartSync(request) => sync::command_impact(tx, request, true, &now)
            .await
            .map_err(Error::from),
        WorldCommand::StopSync(request) => sync::command_impact(tx, request, false, &now)
            .await
            .map_err(Error::from),
        _ => Err(Error::internal(FailureStage::Decode)),
    }
}

pub(crate) async fn run_basis(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<
    (
        world_protocol::ids::ReleaseId,
        world_protocol::ids::ActivationLockId,
    ),
    Error,
> {
    let release = crate::releases::read_active_model(tx)
        .await
        .map_err(|error| SyncError::Source(error.into()))?
        .ok_or_else(|| Error::from(SyncError::from(MappingFailure::RevisionMismatch)))?;
    let connector = match command {
        WorldCommand::DiscoverSchema(request) => {
            connectors::discovery::connection(tx, request)
                .await
                .map_err(SyncError::Source)?
                .connector
        }
        WorldCommand::StartSync(request) => {
            let binding = mapping::read_binding(tx, &request.binding)
                .await
                .map_err(SyncError::Mapping)?
                .ok_or_else(|| Error::from(SyncError::from(MappingFailure::RevisionMismatch)))?;
            binding.body.connector
        }
        _ => return Err(Error::internal(FailureStage::Decode)),
    };
    source_provider(tx, &release.artifact.activation_lock_id, &connector).await?;
    Ok((release.id, release.artifact.activation_lock_id))
}

pub(crate) async fn branch_run_basis(
    tx: &WorldTransaction<'_>,
    reference: &world_protocol::releases::BranchRef,
) -> Result<
    (
        world_protocol::ids::ReleaseId,
        world_protocol::ids::ActivationLockId,
        world_protocol::ids::BranchId,
    ),
    Error,
> {
    let branch = mapping::authoring_branch(tx, reference)
        .await
        .map_err(SyncError::Mapping)?;
    Ok((
        branch.basis.release_id,
        branch.compile.activation_lock.id,
        branch.id,
    ))
}

pub(crate) async fn stop_run_basis(
    tx: &WorldTransaction<'_>,
    request: &BindingCommand,
) -> Result<
    (
        Option<world_protocol::ids::ReleaseId>,
        Option<world_protocol::ids::ActivationLockId>,
    ),
    Error,
> {
    sync::stop_run_basis(tx, request).await.map_err(Error::from)
}

pub(crate) async fn query_impact(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &WorldQuery,
) -> Result<ActualImpact, Error> {
    let now = tx.now().await?;
    match query {
        WorldQuery::Connections(request) => connectors::connections_impact(tx, verified, request)
            .await
            .map_err(|error| SyncError::Source(error).into()),
        WorldQuery::Capabilities(request) => connectors::capabilities_impact(tx, request)
            .await
            .map_err(|error| SyncError::Source(error).into()),
        WorldQuery::SourceSchema(request) => connectors::discovery::schema_head_impact(tx, request)
            .await
            .map_err(|error| SyncError::Source(error).into()),
        WorldQuery::Mappings(request) => mapping::mappings_impact(tx, verified, request, &now)
            .await
            .map_err(Error::from),
        WorldQuery::SyncStatus(request) => sync::status_impact(tx, request, &now)
            .await
            .map_err(Error::from),
        _ => Err(Error::internal(FailureStage::Decode)),
    }
}

pub(crate) async fn query(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &WorldQuery,
    now: &Timestamp,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<QueryResult, Error> {
    if let WorldQuery::BranchSourceContext(request) = query {
        let mut limit = budget.limit();
        limit.max_rows = limit.max_rows.min(4096);
        limit.max_steps = limit.max_steps.min(4096);
        let budget = budget.scoped(&limit, now).map_err(|error| {
            SyncError::from(MappingFailure::BudgetExceeded { dimension: error.dimension })
        })?;
        let impact = branch_context_impact(tx, request, &budget, cancel).await?;
        let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
        let context = mapping::branch_source_context(tx, &admission, request, now, &budget, cancel)
            .await
            .map_err(SyncError::Mapping)?;
        let delivered = branch_context_delivered(&context, &budget, cancel)?;
        let impact = branch_context_impact(tx, request, &budget, cancel).await?;
        admission.require_access(&impact)?;
        mapping::context_step(&budget, cancel).map_err(SyncError::Mapping)?;
        let current = tx.now().await?;
        authorization::check_admitted_output(tx, &admission, &impact, delivered, &current).await?;
        mapping::context_step(&budget, cancel).map_err(SyncError::Mapping)?;
        return Ok(QueryResult::BranchSourceContext(context));
    }
    let impact = query_impact(tx, verified, query).await?;
    let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
    let (result, delivered) = match query {
        WorldQuery::Connections(request) => {
            let page = connectors::connections(tx, &admission, request)
                .await
                .map_err(SyncError::Source)?;
            let delivered = page.items.len() as u64;
            (QueryResult::Connections(page), delivered)
        }
        WorldQuery::Capabilities(request) => {
            let capabilities = connectors::capabilities(tx, &admission, request)
                .await
                .map_err(SyncError::Source)?;
            (QueryResult::Capabilities(capabilities), 1)
        }
        WorldQuery::SourceSchema(request) => {
            let schema = connectors::discovery::schema_head(tx, &admission, request)
                .await
                .map_err(SyncError::Source)?;
            let delivered = schema.as_ref().map_or(1, |schema| {
                (schema.fields.len() + schema.keys.len() + 1) as u64
            });
            (QueryResult::SourceSchema(schema), delivered)
        }
        WorldQuery::Mappings(request) => {
            let page = mapping::mappings(tx, &admission, request, now).await?;
            let delivered = page.items.len() as u64;
            (QueryResult::Mappings(page), delivered)
        }
        WorldQuery::SyncStatus(request) => {
            let checkpoint = sync::status(tx, &admission, request, now).await?;
            (QueryResult::SyncStatus(checkpoint), 1)
        }
        _ => return Err(Error::internal(FailureStage::Decode)),
    };
    authorization::check_admitted_output(tx, &admission, &impact, delivered, now).await?;
    Ok(result)
}

async fn branch_context_impact(
    tx: &WorldTransaction<'_>,
    request: &world_protocol::api::BranchSourceContextQuery,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<ActualImpact, Error> {
    let (mut impact, sources) = mapping::branch_source_context_impact(tx, request, budget, cancel)
        .await.map_err(SyncError::Mapping)?;
    for source_id in sources {
        mapping::context_step(budget, cancel).map_err(SyncError::Mapping)?;
        let source = connectors::discovery::schema_head_impact(
            tx, &world_protocol::api::SourceSchemaQuery { source_id },
        ).await.map_err(SyncError::Source)?;
        mapping::context_rows(budget, cancel, source.access.len()).map_err(SyncError::Mapping)?;
        impact.access.extend(source.access);
        impact.labels.extend(source.labels);
        impact.source_ids.extend(source.source_ids);
    }
    mapping::context_step(budget, cancel).map_err(SyncError::Mapping)?;
    Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
}

fn branch_context_delivered(
    context: &world_protocol::api::BranchSourceContext,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<u64, Error> {
    let mut delivered = 1u64;
    let mut add = |count: usize| -> Result<(), Error> {
        mapping::context_step(budget, cancel).map_err(SyncError::Mapping)?;
        delivered = delivered.checked_add(u64::try_from(count).map_err(|_| SyncError::from(
            MappingFailure::BudgetExceeded { dimension: world_protocol::budget::BudgetDimension::Rows },
        ))?).ok_or_else(|| SyncError::from(MappingFailure::BudgetExceeded {
            dimension: world_protocol::budget::BudgetDimension::Rows,
        }))?;
        Ok(())
    };
    for entry in &context.bindings {
        for count in [1, entry.targets.len(), 1, entry.schema.fields.len(), entry.schema.keys.len(), 1, 1] { add(count)?; }
        if let Some(mapping) = &entry.mapping {
            add(mapping.fields.len())?;
            add(mapping.relations.len())?;
            for relation in &mapping.relations { add(relation.roles.len())?; }
        }
        let authority = match &entry.authority {
            world_protocol::api::BranchSourceAuthorityState::Draft(authority)
            | world_protocol::api::BranchSourceAuthorityState::Approved(authority) => authority,
        };
        match &authority.ownership {
            world_protocol::facts::AuthorityOwnership::Properties { properties } => add(properties.len())?,
            world_protocol::facts::AuthorityOwnership::RelationRoles { roles, .. } => { add(1)?; add(roles.len())?; }
        }
    }
    Ok(delivered)
}

pub(crate) fn run(
    ctx: ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'static, CommandResult, Error> {
    match command {
        WorldCommand::ConfigureConnection(request) => configure(ctx, request),
        WorldCommand::DiscoverSchema(request) => discover_schema(ctx, request),
        WorldCommand::SetMapping(request) => set_mapping(ctx, request),
        WorldCommand::SetBranchMapping(request) => set_branch_mapping(ctx, request),
        WorldCommand::ApproveBranchSourceAuthority(request) => {
            approve_branch_authority(ctx, request)
        }
        WorldCommand::StartSync(request) => Box::pin(async move {
            let owner = ctx.resources.sync.clone();
            let (broker, lease) = broker(&ctx, &request).await?;
            let accepted = ctx.operation.clone();
            owner.start(ctx, request, broker, lease).await?;
            Ok(CommandResult::Accepted(accepted))
        }),
        WorldCommand::StopSync(request) => Box::pin(async move {
            let owner = ctx.resources.sync.clone();
            let accepted = ctx.operation.clone();
            owner.stop(ctx, request).await?;
            Ok(CommandResult::Accepted(accepted))
        }),
        _ => Box::pin(async { Err(Error::internal(FailureStage::Decode)) }),
    }
}

fn configure(
    ctx: ExecutionContext,
    request: ConfigureConnection,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let input = crate::definitions::canonical_digest(&request)?;
        ctx.transact(
            "connection.configure",
            input,
            &["sources"],
            move |tx, admission, operation, _| {
                Box::pin(async move {
                    let connection = connectors::configure(tx, &admission, &request)
                        .await
                        .map_err(SyncError::Source)?;
                    let now = tx.now().await?;
                    complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::Connection {
                            connection: connection.id,
                            revision: connection.revision,
                        },
                        &now,
                    )
                    .await
                })
            },
        )
        .await?;
        Ok(CommandResult::Accepted(ctx.operation))
    })
}

fn discover_schema(
    ctx: ExecutionContext,
    request: DiscoverSchema,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let input = crate::definitions::canonical_digest(&request)?;
        let selection = request.clone();
        let step_input = input.clone();
        ctx.budget
            .charge(world_protocol::budget::BudgetDimension::Steps, 1)
            .map_err(|failure| {
                SyncError::Source(SourceError::new(
                    world_protocol::sources::SourceFailure::BudgetExceeded {
                        dimension: failure.dimension,
                    },
                    FailureStage::Prepare,
                ))
            })?;
        let (lock, provider, now, step) = ctx
            .transact(
                "schema.provider",
                input.clone(),
                &["sources"],
                move |tx, admission, _, run| {
                    Box::pin(async move {
                        let impact = connectors::discovery::impact(tx, &selection)
                            .await
                            .map_err(SyncError::Source)?;
                        admission.require_access(&impact)?;
                        let connection = connectors::discovery::connection(tx, &selection)
                            .await
                            .map_err(SyncError::Source)?;
                        let lock = run
                            .activation_lock_id
                            .as_ref()
                            .ok_or_else(|| Error::internal(FailureStage::Prepare))?
                            .clone();
                        if let Some(reference) = &selection.branch {
                            let branch = mapping::authoring_branch(tx, reference)
                                .await
                                .map_err(SyncError::Mapping)?;
                            if run.branch_id.as_ref() != Some(&branch.id)
                                || run.release_id.as_ref() != Some(&branch.basis.release_id)
                                || branch.compile.activation_lock.id != lock
                            {
                                return Err(SyncError::from(MappingFailure::RevisionMismatch).into());
                            }
                        }
                        let provider = source_provider(tx, &lock, &connection.connector).await?;
                        let digest =
                            crate::definitions::canonical_digest(&(&run.id, "sources.discover"))?;
                        let id = world_protocol::ids::StepId::try_new(format!(
                            "step-{}",
                            &digest.as_str()[7..]
                        ))
                        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
                        let now = tx.now().await?;
                        let step = owner::claim_step(
                            tx,
                            &admission,
                            &run,
                            id,
                            0,
                            "sources.discover",
                            step_input,
                            &now,
                        )
                        .await?;
                        Ok((lock, provider, now, step))
                    })
                },
            )
            .await?
            .value;
        let (broker, lease) = acquire_broker(&ctx, lock, provider, now)?;
        let result = async {
            let discovered = broker
                .discover_schema(
                    request.clone(),
                    &ctx.admission,
                    &ctx.pipeline,
                    ctx.cancellation.clone(),
                    ctx.deadline,
                    ctx.budget.clone(),
                )
                .await
                .map_err(SyncError::Source)?;
            discovered
                .check_current(&ctx.admission)
                .await
                .map_err(SyncError::Source)?;
            let budget = ctx.budget.clone();
            let cancel = ctx.cancellation.clone();
            ctx.transact(
                "schema.discover",
                input,
                &["sources"],
                move |tx, admission, operation, run| {
                    Box::pin(async move {
                        if cancel.is_cancelled() {
                            return Err(SyncError::Source(SourceError::new(
                                world_protocol::sources::SourceFailure::Cancelled,
                                FailureStage::Commit,
                            ))
                            .into());
                        }
                        budget.check().map_err(|failure| {
                            SyncError::Source(SourceError::new(
                                world_protocol::sources::SourceFailure::BudgetExceeded {
                                    dimension: failure.dimension,
                                },
                                FailureStage::Commit,
                            ))
                        })?;
                        discovered
                            .recheck(tx, &admission)
                            .await
                            .map_err(SyncError::Source)?;
                        let now = tx.now().await?;
                        mapping::save_discovered_schema(
                            tx,
                            &admission,
                            &discovered,
                            request.expected_schema.as_ref(),
                            &now,
                        )
                        .await
                        .map_err(SyncError::Mapping)?;
                        let delivered = (discovered.schema().fields.len()
                            + discovered.schema().keys.len()
                            + 1) as u64;
                        authorization::check_admitted_output(
                            tx,
                            &admission,
                            admission.impact(),
                            delivered,
                            &now,
                        )
                        .await?;
                        let mut next = step.clone();
                        next.phase = OperationPhase::Completed;
                        next.result =
                            Some(serde_json::to_value(discovered.schema()).map_err(|cause| {
                                Error::internal(FailureStage::Commit).caused(cause)
                            })?);
                        owner::checkpoint_step(tx, &step, next).await?;
                        owner::checkpoint_usage(
                            tx,
                            &run,
                            owner::confirmed_usage(&run.usage, budget.checkpoint_usage())?,
                        )
                        .await?;
                        complete_operation(
                            tx,
                            &operation.receipt.accepted,
                            OperationResult::Schema(discovered.schema().clone()),
                            &now,
                        )
                        .await
                    })
                },
            )
            .await?;
            Ok(CommandResult::Accepted(ctx.operation.clone()))
        }
        .await;
        if broker.sync_drained() {
            lease.finish();
        }
        result
    })
}

fn set_branch_mapping(
    ctx: ExecutionContext,
    request: SetBranchMapping,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let input = crate::definitions::canonical_digest(&request)?;
        ctx.transact(
            "mapping.branch.set",
            input,
            &["sources"],
            move |tx, admission, operation, _| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    mapping::set_branch_mapping(tx, &admission, &request, &now)
                        .await
                        .map_err(SyncError::Mapping)?;
                    let impact = mapping::branch_mapping_impact(tx, &request)
                        .await
                        .map_err(SyncError::Mapping)?;
                    authorization::check_admitted_output(tx, &admission, &impact, 1, &now).await?;
                    complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::Mapping {
                            binding: request.binding,
                            mapping: request.mapping.reference,
                        },
                        &now,
                    )
                    .await
                })
            },
        )
        .await?;
        Ok(CommandResult::Accepted(ctx.operation))
    })
}

fn approve_branch_authority(
    ctx: ExecutionContext,
    request: ApproveBranchSourceAuthority,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let input = crate::definitions::canonical_digest(&request)?;
        ctx.transact(
            "source.branch.authority.approve",
            input,
            &["sources"],
            move |tx, admission, operation, _| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    mapping::approve_branch_authority(
                        tx,
                        &admission,
                        &request.branch,
                        &request.authority,
                        &now,
                    )
                    .await
                    .map_err(SyncError::Mapping)?;
                    let impact =
                        mapping::branch_authority_impact(tx, &request.branch, &request.authority)
                            .await
                            .map_err(SyncError::Mapping)?;
                    authorization::check_admitted_output(tx, &admission, &impact, 1, &now).await?;
                    complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::BranchSourceAuthority {
                            branch: request.branch,
                            authority: request.authority,
                        },
                        &now,
                    )
                    .await
                })
            },
        )
        .await?;
        Ok(CommandResult::Accepted(ctx.operation))
    })
}

fn set_mapping(ctx: ExecutionContext, request: SetMapping) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let input = crate::definitions::canonical_digest(&request)?;
        ctx.transact(
            "mapping.set",
            input,
            &["sources"],
            move |tx, admission, operation, _| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    let plan = mapping::set_mapping(tx, &admission, &request, &now)
                        .await
                        .map_err(SyncError::Mapping)?;
                    complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::Mapping {
                            binding: plan.binding,
                            mapping: plan.mapping.reference,
                        },
                        &now,
                    )
                    .await
                })
            },
        )
        .await?;
        Ok(CommandResult::Accepted(ctx.operation))
    })
}

pub(in crate::owner) async fn broker(
    ctx: &ExecutionContext,
    request: &BindingCommand,
) -> Result<(Arc<SourceBroker>, Arc<InvocationLease>), Error> {
    let binding = request.binding.clone();
    let input = crate::definitions::canonical_digest(request)?;
    let key = format!("source.provider.{}", input.as_str());
    let selected = ctx
        .transact(&key, input, &["sources"], move |tx, _, _, run| {
            Box::pin(async move {
                let binding = mapping::read_binding(tx, &binding)
                    .await
                    .map_err(SyncError::Mapping)?
                    .ok_or_else(|| {
                        Error::from(SyncError::from(MappingFailure::RevisionMismatch))
                    })?;
                let lock = run.activation_lock_id.ok_or_else(|| {
                    Error::from(SyncError::Source(SourceError::new(
                        world_protocol::sources::SourceFailure::ProtocolViolation,
                        FailureStage::Prepare,
                    )))
                })?;
                let provider = source_provider(tx, &lock, &binding.body.connector).await?;
                Ok((lock, provider, tx.now().await?))
            })
        })
        .await?
        .value;
    let (lock, provider, now) = selected;
    acquire_broker(ctx, lock, provider, now)
}

pub(in crate::owner) async fn fence_rejected_segment(
    store: &crate::store::WorldStore, resources: &Arc<crate::owner::resources::Resources>,
    admission: &authorization::Admission, input: &sync::SourceSegment,
    source_access: Result<Arc<dyn connectors::SourceAccess>, Arc<SourceError>>,
    deadline: tokio::time::Instant, cancel: tokio_util::sync::CancellationToken,
) -> Result<sync::FencedSourceSegment, Error> {
    let request = super::super::execution::prepare_request(store, &input.parent.assignment.world,
        world_protocol::ids::CommitId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
        crate::definitions::canonical_digest(&("world.source.cleanup.prepare.v1", input))?,
        &["sources", "operation"]).await?;
    let current = input.clone();
    let admitted = admission.clone();
    let selected = store.transact(request.clone().prepare()?, move |tx| Box::pin(async move {
        sync::require_segment_recovery(tx, &admitted, &current).await?;
        let run = owner::read_run(tx, &current.run_id).await?;
        let lock = run.activation_lock_id.ok_or_else(|| Error::internal(FailureStage::Recover))?;
        let binding = mapping::read_binding(tx, &current.parent.request.binding).await.map_err(SyncError::Mapping)?
            .ok_or_else(|| Error::from(SyncError::protocol()))?;
        let provider = source_provider(tx, &lock, &binding.body.connector).await?;
        Ok::<_, Error>((lock, provider, tx.now().await?))
    })).await?.value;
    let (lock, provider, now) = selected;
    let lease = Arc::new(resources.live.acquire(&input.parent.assignment.world, &lock, &provider,
        admission.invocation().id.clone(), now).map_err(|error| SyncError::Source(connectors::lease_error(error)))?);
    let broker = match SourceBroker::for_provider(Arc::new(store.clone()), source_access.clone(), lease.clone(), provider,
        owner::InvocationServiceSeed::for_resources(store, resources, source_access)) {
        Ok(broker) => Arc::new(broker),
        Err(error) => { lease.finish(); return Err(SyncError::Source(error).into()); }
    };
    resources.sync.fence_rejected_segment(store, admission, input, broker, lease, &request, deadline, cancel).await.map_err(Error::from)
}

pub(super) async fn branch_broker(
    ctx: &ExecutionContext,
    branch: &world_protocol::releases::BranchRef,
    binding: &world_protocol::ids::DefinitionRef,
) -> Result<(Arc<SourceBroker>, Arc<InvocationLease>), Error> {
    if branch.world != ctx.operation.world || binding.world != branch.world {
        return Err(SyncError::from(MappingFailure::CrossWorld).into());
    }
    let input = crate::definitions::canonical_digest(&(branch, binding))?;
    let key = format!("source.branch.provider.{}", input.as_str());
    let branch = branch.clone();
    let binding = binding.clone();
    let (lock, provider, now) = ctx
        .transact(&key, input, &["sources"], move |tx, _, _, run| {
            Box::pin(async move {
                let model = crate::releases::read_branch_revision(tx, &branch)
                    .await?
                    .ok_or_else(|| {
                        Error::from(SyncError::from(MappingFailure::RevisionMismatch))
                    })?;
                let lock = run
                    .activation_lock_id
                    .ok_or_else(|| Error::internal(FailureStage::Prepare))?;
                if model.compile.activation_lock.id != lock {
                    return Err(BindingError::from(BindingFailure::LockIdentityConflict).into());
                }
                let plan = mapping::compile_branch_binding(tx, &branch, &binding)
                    .await
                    .map_err(SyncError::Mapping)?;
                let provider = source_provider(tx, &lock, &plan.binding_body.connector).await?;
                Ok((lock, provider, tx.now().await?))
            })
        })
        .await?
        .value;
    acquire_broker(ctx, lock, provider, now)
}

async fn source_provider(
    tx: &WorldTransaction<'_>,
    lock: &world_protocol::ids::ActivationLockId,
    connector: &world_protocol::ids::ProviderId,
) -> Result<world_protocol::ids::NodeId, Error> {
    let graph = bindings::read_graph_in_transaction(tx, lock).await?;
    let contract = world_protocol::sources::read_contract().map_err(|cause| {
        SyncError::Source(SourceError::caused_by(
            world_protocol::sources::SourceFailure::InternalFault,
            FailureStage::Prepare,
            cause,
        ))
    })?;
    let mut providers = graph.lock().nodes.iter().filter(|node| {
        node.slot == SlotKind::Connector
            && &node.provider_id == connector
            && node.implementation.contracts.contains(&contract)
    });
    let provider = providers
        .next()
        .ok_or(BindingError::from(BindingFailure::HeadInvalid))?;
    if providers.next().is_some() {
        return Err(BindingError::from(BindingFailure::HeadInvalid).into());
    }
    Ok(provider.id.clone())
}

fn acquire_broker(
    ctx: &ExecutionContext,
    lock: world_protocol::ids::ActivationLockId,
    provider: world_protocol::ids::NodeId,
    now: Timestamp,
) -> Result<(Arc<SourceBroker>, Arc<InvocationLease>), Error> {
    let lease = Arc::new(
        ctx.resources
            .live
            .acquire(
                &ctx.operation.world,
                &lock,
                &provider,
                ctx.admission.invocation().id.clone(),
                now,
            )
            .map_err(|error| SyncError::Source(connectors::lease_error(error)))?,
    );
    match SourceBroker::for_provider(
        Arc::new(ctx.store.clone()),
        ctx.source_access.clone(),
        lease.clone(),
        provider,
        ctx.invocation_service_seed(),
    ) {
        Ok(broker) => Ok((Arc::new(broker), lease)),
        Err(error) => {
            lease.finish();
            Err(SyncError::Source(error).into())
        }
    }
}
