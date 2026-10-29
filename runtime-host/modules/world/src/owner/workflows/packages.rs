use world_protocol::{
    api::{CommandResult, QueryResult, WorldCommand, WorldQuery},
    authorization::{AccessMode, AccessScope, Actor, ActualImpact},
    failure::FailureStage,
    ids::*,
    operation::OperationReceipt,
};

use crate::{
    authorization,
    extensions::package::{self, InstallContext},
    owner::{Error, ExecutionContext},
    store::{StoreFuture, WorldTransaction},
};

pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<ActualImpact, Error> {
    let (installs, mode) = match command {
        WorldCommand::InstallPackage(request) => (
            vec![package::install_id(tx.world(), &request.request_key)?],
            AccessMode::Manage,
        ),
        WorldCommand::UpgradePackage(request) => {
            let target = package::upgrade_request(tx.world(), request)?;
            (
                vec![
                    request.install_id.clone(),
                    package::install_id(tx.world(), &target.request_key)?,
                ],
                AccessMode::Manage,
            )
        }
        WorldCommand::GrantPackage(request) => {
            (vec![request.install_id.clone()], AccessMode::Manage)
        }
        WorldCommand::ReplacePackageTrustPolicy(_) => (Vec::new(), AccessMode::Manage),
        WorldCommand::ConfigurePackage(request) => {
            (vec![request.install_id.clone()], AccessMode::Manage)
        }
        WorldCommand::EnablePackage(request) | WorldCommand::DisablePackage(request) => {
            (vec![request.install_id.clone()], AccessMode::Manage)
        }
        WorldCommand::UninstallPackage(request) => {
            (vec![request.install_id.clone()], AccessMode::Delete)
        }
        _ => return Err(Error::internal(FailureStage::Admission)),
    };
    Ok(authorization::actual_impact(
        vec![AccessScope {
            resources: installs
                .into_iter()
                .map(|id| ResourceRef::Package { id })
                .collect(),
            fields: Vec::new(),
            modes: vec![mode],
            scope: crate::owner::management_scope(tx).await?,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?)
}

pub(crate) fn run(
    ctx: ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let input = crate::definitions::canonical_digest(&command)?;
        if let WorldCommand::ReplacePackageTrustPolicy(request) = command {
            ctx.transact(
                "package.trust_policy",
                input,
                &["packages"],
                move |tx, admission, operation, _| {
                    Box::pin(async move {
                        package::replace_trust_policy(
                            tx,
                            &admission,
                            request.expected_revision,
                            &request.policy,
                        )
                        .await?;
                        let now = tx.now().await?;
                        authorization::check_admitted_output(tx, &admission, admission.impact(), 1, &now)
                            .await?;
                        crate::owner::ledger::complete(
                            tx,
                            &operation.receipt.accepted,
                            world_protocol::operation::OperationResult::PackageTrustPolicy {
                                revision: request.policy.revision,
                            },
                            &now,
                        )
                        .await?;
                        Ok::<_, Error>(())
                    })
                },
            )
            .await?;
            ctx.owner.repair_startup(ctx.operation.world.clone()).await?;
            return Ok(CommandResult::Accepted(ctx.operation));
        }
        let request = ctx
            .commit_request("package.context", input, &["packages"])
            .await?;
        let at = ctx
            .store
            .snapshot(ctx.operation.world.clone(), |snapshot| {
                Box::pin(async move { snapshot.now().await })
            })
            .await?;
        let context = InstallContext {
            admission: ctx.admission.clone(),
            accepted: ctx.operation.clone(),
            storage_epoch: request.storage_epoch,
            fences: request.fences,
            at,
        };
        let uninstall = matches!(&command, WorldCommand::UninstallPackage(_));
        let repair = matches!(&command, WorldCommand::UpgradePackage(_) | WorldCommand::GrantPackage(_)
            | WorldCommand::ConfigurePackage(_) | WorldCommand::EnablePackage(_));
        let receipt = execute(&ctx, &context, command).await?;
        if receipt.accepted.world != ctx.operation.world
            || receipt.accepted.operation_id != ctx.operation.operation_id
            || receipt.accepted.incarnation != ctx.operation.incarnation
            || !matches!(
                receipt.phase,
                world_protocol::operation::OperationPhase::Completed
                    | world_protocol::operation::OperationPhase::CancelledAfterCommit
                    | world_protocol::operation::OperationPhase::Retained
                    | world_protocol::operation::OperationPhase::Failed
            )
        {
            return Err(Error::internal(FailureStage::Commit));
        }
        if repair && receipt.phase == world_protocol::operation::OperationPhase::Completed {
            ctx.owner.repair_startup(ctx.operation.world.clone()).await?;
        }
        if uninstall
            && matches!(
                receipt.phase,
                world_protocol::operation::OperationPhase::Completed
                    | world_protocol::operation::OperationPhase::CancelledAfterCommit
            )
        {
            ctx.owner.maintain(ctx.operation.world.clone()).await?;
        }
        Ok(CommandResult::Accepted(ctx.operation))
    })
}

fn execute<'a>(
    ctx: &'a ExecutionContext,
    context: &'a InstallContext,
    command: WorldCommand,
) -> StoreFuture<'a, OperationReceipt, Error> {
    let inventory = &ctx.resources.inventory;
    match command {
        WorldCommand::InstallPackage(request) => Box::pin(async move {
            let bytes = input_bytes(ctx, &request.upload, &request.package).await?;
            inventory
                .install(context, &request, &bytes, &ctx.cancellation)
                .await
        }),
        WorldCommand::UpgradePackage(request) => Box::pin(async move {
            let bytes = input_bytes(ctx, &request.upload, &request.package).await?;
            inventory
                .upgrade(context, &request, &bytes, &ctx.cancellation)
                .await
        }),
        WorldCommand::GrantPackage(request) => {
            Box::pin(async move { inventory.grant_package(context, &request).await })
        }
        WorldCommand::ConfigurePackage(request) => {
            Box::pin(async move { inventory.configure_package(context, &request).await })
        }
        WorldCommand::EnablePackage(request) => Box::pin(async move {
            Ok(inventory
                .enable(context, &request, &ctx.resources.live)
                .await?
                .into_receipt())
        }),
        WorldCommand::DisablePackage(request) => Box::pin(async move {
            let (proof, closing) = inventory
                .begin_disable(context, &request, &ctx.resources.live)
                .await?;
            ctx.checkpoint_disable(&proof, &closing).await?;
            match closing.drain_until(ctx.deadline).await {
                Ok(drained) => {
                    inventory
                        .finish_disable(context, &proof, &ctx.resources.live, &drained)
                        .await
                }
                Err((closing, remaining)) => {
                    let resources = remaining
                        .iter()
                        .flat_map(crate::extensions::lifecycle::retained_resources)
                        .collect();
                    let receipt = inventory.retain_disable(context, &proof, resources).await?;
                    drop(closing); // Registry retains the same endpoints and ledgers for exact-intent recovery.
                    Ok(receipt)
                }
            }
        }),
        WorldCommand::UninstallPackage(request) => Box::pin(async move {
            inventory
                .uninstall(context, &request, &ctx.cancellation)
                .await
        }),
        _ => Box::pin(async move { Err(Error::internal(FailureStage::Admission)) }),
    }
}

pub(crate) async fn query_impact(
    tx: &WorldTransaction<'_>,
    query: &WorldQuery,
) -> Result<ActualImpact, Error> {
    let resources = match query {
        WorldQuery::PackageTrustPolicy(_) => {
            return Ok(authorization::actual_impact(
                vec![AccessScope {
                    resources: Vec::new(),
                    fields: Vec::new(),
                    modes: vec![AccessMode::Manage],
                    scope: crate::owner::management_scope(tx).await?,
                    valid_time: None,
                }],
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )?);
        }
        WorldQuery::Packages(_) => Vec::new(),
        WorldQuery::Bindings(request) => {
            let page = crate::extensions::bindings::read_binding_page(tx, &request.page).await?;
            return read_impact(tx, binding_resources(&page.items), Vec::new()).await;
        }
        WorldQuery::BindingHead(request) => vec![ResourceRef::Head {
            channel: request.channel.clone(),
        }],
        WorldQuery::PackageConfig(request) | WorldQuery::Contributions(request) => {
            vec![ResourceRef::Package {
                id: request.install_id.clone(),
            }]
        }
        _ => return Err(Error::internal(FailureStage::Admission)),
    };
    read_impact(tx, resources, Vec::new()).await
}

pub(crate) async fn query(
    tx: &WorldTransaction<'_>,
    verified: &authorization::VerifiedInvocation,
    query: &WorldQuery,
    now: &world_protocol::time::Timestamp,
) -> Result<QueryResult, Error> {
    let impact = query_impact(tx, query).await?;
    let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
    let result = match query {
        WorldQuery::PackageTrustPolicy(_) => {
            let policy = package::read_trust_policy_in(tx).await?;
            let at = tx.now().await?;
            authorization::check_admitted_output(tx, &admission, &impact, 1, &at).await?;
            return Ok(QueryResult::PackageTrustPolicy(policy));
        }
        WorldQuery::Packages(request) => {
            QueryResult::Packages(package::read_packages(tx, &request.page).await?)
        }
        WorldQuery::Bindings(request) => QueryResult::Bindings(
            crate::extensions::bindings::read_binding_page(tx, &request.page).await?,
        ),
        WorldQuery::BindingHead(request) => QueryResult::BindingHead(
            crate::extensions::bindings::read_binding_head(tx, &request.channel).await?,
        ),
        WorldQuery::PackageConfig(request) => {
            QueryResult::PackageConfig(package::read_config(tx, &request.install_id).await?)
        }
        WorldQuery::Contributions(request) => {
            QueryResult::Contributions(package::read_contributions(tx, &request.install_id).await?)
        }
        _ => return Err(Error::internal(FailureStage::Read)),
    };
    let (resources, state, delivered) = match &result {
        QueryResult::Packages(page) => (
            page.items
                .iter()
                .map(|record| ResourceRef::Package {
                    id: record.install_id.clone(),
                })
                .collect(),
            Vec::new(),
            page.items.len() as u64,
        ),
        QueryResult::Bindings(page) => (
            binding_resources(&page.items),
            Vec::new(),
            page.items.len() as u64,
        ),
        QueryResult::BindingHead(head) => (
            impact.access[0].resources.clone(),
            Vec::new(),
            u64::from(head.is_some()),
        ),
        QueryResult::PackageConfig(config) => (
            impact.access[0].resources.clone(),
            Vec::new(),
            config.fields.len() as u64,
        ),
        QueryResult::Contributions(items) => (
            impact.access[0].resources.clone(),
            Vec::new(),
            items.len() as u64,
        ),
        _ => return Err(Error::internal(FailureStage::Read)),
    };
    let output = read_impact(tx, resources, state).await?;
    let at = tx.now().await?;
    authorization::check_admitted_output(tx, &admission, &output, delivered, &at).await?;
    Ok(result)
}

fn binding_resources(graphs: &[world_protocol::bindings::ActivationLock]) -> Vec<ResourceRef> {
    let mut resources = Vec::new();
    for graph in graphs {
        for node in &graph.nodes {
            resources.push(ResourceRef::Binding {
                id: node.binding_id.clone(),
            });
            resources.push(ResourceRef::Package {
                id: node.implementation.install_id.clone(),
            });
            if let Some(binding) = &node.state {
                resources.push(ResourceRef::State {
                    id: binding.root.id.clone(),
                });
            }
        }
    }
    resources
}

async fn read_impact(
    tx: &WorldTransaction<'_>,
    resources: Vec<ResourceRef>,
    state: Vec<StateRef>,
) -> Result<ActualImpact, Error> {
    Ok(authorization::actual_impact(
        vec![AccessScope {
            resources,
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: crate::owner::management_scope(tx).await?,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        state,
        Vec::new(),
    )?)
}

async fn input_bytes(
    ctx: &ExecutionContext,
    upload: &world_protocol::api::UploadKey,
    blob: &world_protocol::materials::BlobRef,
) -> Result<Vec<u8>, Error> {
    ctx.resources.inventory.validate_input_size(blob)?;
    let content = ctx.resources.content.clone();
    let upload = upload.clone();
    let blob = blob.clone();
    let input = crate::definitions::canonical_digest(&(&upload, &blob))?;
    let committed = ctx
        .transact(
            "package.input",
            input,
            &["content"],
            move |tx, admission, _, _| {
                Box::pin(async move {
                    let actor = match &admission.invocation().actor {
                        Actor::Human { id } | Actor::Service { id } => id,
                    };
                    content
                        .sealed_upload_pin(tx, actor, &upload, &blob)
                        .await
                        .map_err(Error::from)
                })
            },
        )
        .await?;
    let bytes = ctx
        .resources
        .content
        .read_pinned(&ctx.store, &committed)
        .await?;
    let admission = ctx.admission.clone();
    ctx.store
        .snapshot(ctx.operation.world.clone(), move |snapshot| {
            Box::pin(async move {
                let at = snapshot.now().await?;
                authorization::recheck_read(snapshot, &admission, &at).await?;
                Ok::<_, Error>(())
            })
        })
        .await?;
    Ok(bytes)
}
