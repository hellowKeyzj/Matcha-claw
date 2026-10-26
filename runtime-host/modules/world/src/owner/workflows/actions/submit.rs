use crate::{
    actions, authorization, definitions::canonical_digest, extensions::bindings,
    owner::{self, Error, ExecutionContext},
    query,
    sources::connectors::SourceBroker,
    store::StoreFuture,
};
use world_protocol::{actions::EffectIntent, api::CommandResult, failure::FailureStage, ids::*};

use super::{
    action_failure, broker, complete_recovery, finish_step, invalid, record_observation,
    recover_effect, recover_with_broker, reject_prepared, resume_observation, slots, verify,
};

async fn policy(ctx: &ExecutionContext, input: &Digest) -> Result<(), Error> {
    use world_protocol::{bindings::SlotKind, slots::{SlotRequest, SlotResponse}};
    let node = ctx.transact(&format!("action.policy.input.{}", uuid::Uuid::new_v4()), input.clone(),
        &["authorization"], move |tx, admission, _, run| Box::pin(async move {
            authorization::recheck(tx, &admission, &tx.now().await?).await?;
            let graph = bindings::read_graph_in_transaction(tx, run.activation_lock_id.as_ref().ok_or_else(|| invalid("activationLockId"))?).await?;
            slots::select(&graph, SlotKind::Policy)
        })).await?.value;
    let request = ctx.admission.policy_request()?;
    let response = slots::invoke(ctx, "action.effect", input.clone(), node, SlotRequest::Policy(request.clone())).await?;
    let SlotResponse::Policy(result) = response else { return Err(invalid("action.policy")); };
    ctx.admission.check_policy_result(&request, &result)?;
    Ok(())
}

async fn plan(
    ctx: &ExecutionContext,
    request: &world_protocol::actions::ActionSubmitRequest,
) -> Result<world_protocol::slots::ActionPlanResult, Error> {
    use world_protocol::{bindings::SlotKind, slots::{SlotRequest, SlotResponse}};
    let input = canonical_digest(request)?;
    let request = request.clone();
    let (request, node) = ctx.transact(
        &format!("action.plan.input.{}", uuid::Uuid::new_v4()), input.clone(),
        &["actions", "authorization"], move |tx, admission, _, run| Box::pin(async move {
            let request = actions::plan_request(tx, &admission, &request).await?;
            let lock = run.activation_lock_id.as_ref().ok_or_else(|| invalid("activationLockId"))?;
            let graph = bindings::read_graph_in_transaction(tx, lock).await?;
            Ok((request, slots::select(&graph, SlotKind::Action)?))
        }),
    ).await?.value;
    let response = slots::invoke(ctx, "action.effect", input, node, SlotRequest::Action(request.clone())).await?;
    let SlotResponse::Action(result) = response else { return Err(invalid("action.plan")); };
    actions::check_plan(&request, &result).map_err(|failure| action_failure(failure, FailureStage::Validate))?;
    Ok(result)
}

pub(super) fn submit(
    ctx: ExecutionContext,
    request: world_protocol::actions::ActionSubmitRequest,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let ctx = &ctx;
        let input = canonical_digest(&request)?;
        let existing = existing(ctx, &request, &input).await?;
        if let Some(intent) = existing {
            resume_observation(ctx, &intent.id).await?;
            recover_effect(ctx, &intent).await?;
            complete_recovery(ctx, &intent).await?;
            return Ok(CommandResult::Accepted(ctx.operation.clone()));
        }
        let prepared = prepare(ctx, request, input).await?;
        resume_observation(ctx, &prepared.intent.id).await?;
        if prepared.replayed {
            recover_effect(ctx, &prepared.intent).await?;
            complete_recovery(ctx, &prepared.intent).await?;
            return Ok(CommandResult::Accepted(ctx.operation.clone()));
        }
        let (broker, lease) = match broker(ctx, &prepared.intent, false).await {
            Ok(value) => value,
            Err(error) => return Err(reject_prepared(ctx, &prepared.intent, error).await),
        };
        let outcome = effect(ctx, &prepared, &broker).await;
        lease.finish();
        if let Err(error) = outcome {
            return Err(reject_prepared(ctx, &prepared.intent, error).await);
        }
        Ok(CommandResult::Accepted(ctx.operation.clone()))
    })
}

fn existing<'a>(
    ctx: &'a ExecutionContext,
    request: &'a world_protocol::actions::ActionSubmitRequest,
    input: &'a Digest,
) -> StoreFuture<'a, Option<EffectIntent>, Error> {
    Box::pin(async move {
        let saved = request.clone();
        let existing = ctx.transact(
            &format!("action.intent.existing.{}", uuid::Uuid::new_v4()), input.clone(), &["actions", "authorization"],
            move |tx, admission, _, _| Box::pin(async move { Ok(actions::existing_intent(tx, &admission, &saved).await?.map(|prepared| prepared.intent)) }),
        ).await?.value;
        Ok(existing)
    })
}

fn prepare<'a>(
    ctx: &'a ExecutionContext,
    request: world_protocol::actions::ActionSubmitRequest,
    input: Digest,
) -> StoreFuture<'a, actions::PreparedIntent, Error> {
    Box::pin(async move {
        policy(ctx, &input).await?;
        let plan = plan(ctx, &request).await?;
        let budget = ctx.budget.clone();
        let cancel = ctx.cancellation.clone();
        let prepared = ctx
            .transact(
                "action.prepare",
                input.clone(),
                &["actions", "facts", "query", "authorization"],
                move |tx, admission, _, run| {
                    Box::pin(async move {
                        let id = StepId::try_new(format!("step-{}", &canonical_digest(&(&run.id, "action.effect"))?.as_str()[7..]))
                            .map_err(|cause| invalid("action.step").caused(cause))?;
                        let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(|| invalid("action.step"))?;
                        if step.kind != "action.effect" || step.input_digest != input { return Err(invalid("action.step")); }
                        let prepared =
                            actions::prepare(tx, &admission, &run, &step, &request, &plan, &budget, &cancel)
                                .await?;
                        if prepared.replayed && prepared.intent.run_id != run.id {
                            finish_step(tx, step, &prepared.intent.id).await?;
                        }
                        Ok(prepared)
                    })
                },
            )
            .await?
            .value;
        Ok(prepared)
    })
}

fn effect<'a>(
    ctx: &'a ExecutionContext,
    prepared: &'a actions::PreparedIntent,
    broker: &'a SourceBroker,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let source = prepare_source(ctx, prepared, broker).await?;
        match consume(ctx, &prepared.binding).await? {
            authorization::PermitConsumption::Authorized(authorized) => {
                let observation = broker
                    .execute_effect(
                        source,
                        authorized,
                        &ctx.admission,
                        &ctx.pipeline,
                        ctx.cancellation.clone(),
                        ctx.deadline,
                        ctx.budget.clone(),
                    )
                    .await
                    .map_err(actions::source_error)?;
                record_observation(ctx, &prepared.intent, observation).await?;
            }
            authorization::PermitConsumption::Replayed { .. } => {
                recover_with_broker(ctx, &prepared.intent, broker).await?
            }
        }
        verify(ctx, &prepared.intent).await
    })
}

fn prepare_source<'a>(
    ctx: &'a ExecutionContext,
    prepared: &'a actions::PreparedIntent,
    broker: &'a SourceBroker,
) -> StoreFuture<'a, crate::sources::connectors::effects::PreparedEffect, Error> {
    Box::pin(async move {
        let intent = prepared.intent.clone();
        let admission = ctx.admission.clone();
        let evaluation = ctx
            .store
            .snapshot(ctx.operation.world.clone(), move |snapshot| {
                Box::pin(async move {
                    query::restore_action_evaluation(snapshot, &admission, &intent).await
                })
            })
            .await?;
        let action_ref = prepared.intent.action.clone();
        let contract = ctx
            .transact(
                "action.contract",
                canonical_digest(&action_ref)?,
                &["actions"],
                move |tx, _, _, _| Box::pin(async move { actions::action(tx, &action_ref).await }),
            )
            .await?
            .value;
        let source = broker
            .prepare_effect(
                &prepared.intent,
                &evaluation,
                &prepared.binding,
                contract.body.idempotency,
                &ctx.admission,
            )
            .await
            .map_err(actions::source_error)?;
        let intent = prepared.intent.clone();
        let retained = source.clone();
        ctx.transact(
            "action.source.prepare",
            canonical_digest(&source.retained().map_err(actions::source_error)?)?,
            &["actions"],
            move |tx, admission, _, _| {
                Box::pin(
                    async move { actions::retain_source(tx, &admission, &intent, &retained).await },
                )
            },
        )
        .await?;
        Ok(source)
    })
}

fn consume<'a>(
    ctx: &'a ExecutionContext,
    binding: &'a authorization::EffectBinding,
) -> StoreFuture<'a, authorization::PermitConsumption, Error> {
    Box::pin(async move {
        let batch = ctx
            .prepare_batch(
                "action.permit.issue",
                canonical_digest(binding)?,
                &["actions", "authorization"],
            )
            .await?;
        let permit = authorization::issue_permit(
            &ctx.store,
            batch,
            &ctx.admission,
            binding,
            &ctx.budget,
            &ctx.cancellation,
        )
        .await
        .map_err(Error::from)?;
        let batch = ctx
            .prepare_batch(
                "action.permit.consume",
                canonical_digest(binding)?,
                &["actions", "authorization"],
            )
            .await?;
        authorization::consume_permit(
            &ctx.store,
            batch,
            permit,
            &ctx.admission,
            binding,
            &ctx.budget,
            &ctx.cancellation,
        )
        .await
        .map_err(Error::from)
    })
}
