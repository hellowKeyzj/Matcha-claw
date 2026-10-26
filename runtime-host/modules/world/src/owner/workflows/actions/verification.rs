use std::sync::Arc;

use crate::{
    actions, authorization, definitions::canonical_digest, extensions::bindings,
    owner::{Error, ExecutionContext},
    query,
    sources::connectors::SourceBroker,
    store::StoreFuture,
};
use world_protocol::{actions::EffectIntent, api::WorldCommand, failure::FailureStage};

use super::{invalid, lease_error};

pub(super) fn verify<'a>(
    ctx: &'a ExecutionContext,
    intent: &'a EffectIntent,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let saved = intent.clone();
        let plan = ctx
            .transact(
                &format!("action.verifier.plan.{}", uuid::Uuid::new_v4()),
                canonical_digest(&intent.id)?,
                &["actions", "query", "authorization"],
                move |tx, admission, _, _| {
                    Box::pin(async move {
                        let (_, execution, phase) = actions::read_intent(tx, &saved.id).await?;
                        if matches!(
                            phase.as_str(),
                            "completed"
                                | "rejected"
                                | "cancelled_before_effect"
                                | "cancelled_after_effect"
                        ) {
                            return Ok(None);
                        }
                        let (proposal, _) = actions::read_proposal(tx, &execution.proposal_id).await?;
                        let contract = actions::action(tx, &saved.action).await?;
                        admission.require_access(
                            &actions::current_impact(
                                tx,
                                &WorldCommand::ActionReconcile(
                                    world_protocol::operation::OperationKey {
                                        world: tx.world().clone(),
                                        operation_id: saved.operation_id.clone(),
                                    },
                                ),
                            )
                            .await?,
                        )?;
                        let request = actions::verifier_request(
                            &proposal.request,
                            &contract.body,
                            &execution.context,
                            &tx.now().await?,
                        );
                        Ok(Some((request, execution.context.scope, contract)))
                    })
                },
            )
            .await?
            .value;
        let Some((request, scope, _contract)) = plan else {
            return Ok(());
        };
        let connectors_request = request.clone();
        let release_id = intent.activation_lock_id.clone();
        let admission = ctx.admission.clone();
        let providers = ctx
            .store
            .snapshot(ctx.operation.world.clone(), move |snapshot| {
                Box::pin(async move {
                    authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
                    let release = query::read_release(snapshot, &connectors_request).await?;
                    if release.artifact.activation_lock_id != release_id {
                        return Err(invalid("verifier.release"));
                    }
                    let providers = query::source_connectors(
                        snapshot,
                        &connectors_request,
                        &release,
                        world_protocol::api::MAX_PAGE_ITEMS as u64,
                    )
                    .await?;
                    let graph =
                        bindings::read_graph(snapshot, &release.artifact.activation_lock_id).await?;
                    Ok::<_, Error>((providers, graph, snapshot.now().await?))
                })
            })
            .await?;
        let (providers, graph, now) = providers;
        let mut brokers = query::SourceBrokers::new();
        let mut leases = Vec::new();
        let outcome: StoreFuture<'_, (), Error> = Box::pin(async {
            let required = world_protocol::sources::read_contract()
                .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
            for provider in providers {
                let nodes: Vec<_> = graph
                    .lock()
                    .nodes
                    .iter()
                    .filter(|node| {
                        node.provider_id == provider
                            && node.slot == world_protocol::bindings::SlotKind::Connector
                            && node.implementation.contracts.contains(&required)
                    })
                    .collect();
                if nodes.len() != 1 {
                    return Err(invalid("verifier.connector"));
                }
                let node = nodes[0].id.clone();
                let lease = Arc::new(
                    ctx.resources
                        .live
                        .acquire(
                            &ctx.operation.world,
                            &intent.activation_lock_id,
                            &node,
                            ctx.admission.invocation().id.clone(),
                            now.clone(),
                        )
                        .map_err(lease_error)?,
                );
                leases.push(lease.clone());
                let access = ctx.source_access.clone();
                brokers.insert(
                    provider,
                    Arc::new(
                        SourceBroker::for_provider(
                            Arc::new(ctx.store.clone()),
                            access,
                            lease,
                            node,
                            ctx.invocation_service_seed(),
                        )
                        .map_err(actions::source_error)?,
                    ),
                );
            }
            let prepared = query::execute_verifier(
                &ctx.store,
                Some(&brokers),
                &ctx.admission,
                &intent.action,
                &request,
                &scope,
                &ctx.pipeline,
                &ctx.budget,
                &ctx.cancellation,
                ctx.deadline,
            )
            .await?;
            let evaluated_at = ctx
                .store
                .snapshot(ctx.operation.world.clone(), |snapshot| {
                    Box::pin(async move { Ok::<_, Error>(snapshot.now().await?) })
                })
                .await?;
            let evaluation = query::evaluate_verification(
                &prepared,
                &intent.action,
                &intent.argument_values,
                &evaluated_at,
            )?;
            let saved = intent.clone();
            ctx.transact(
                &format!("action.verify.commit.{}", prepared.receipt().id),
                canonical_digest(&(&intent.id, prepared.receipt().id.clone()))?,
                &["actions", "query", "authorization"],
                move |tx, admission, _, _| {
                    Box::pin(async move {
                        let receipt =
                            query::commit_verification(tx, &admission, prepared, evaluation, &saved)
                                .await?;
                        actions::settle_verification(tx, &saved, &receipt).await
                    })
                },
            )
            .await?;
            Ok::<_, Error>(())
        });
        let outcome = outcome.await;
        for lease in leases {
            lease.finish();
        }
        outcome
    })
}
