use super::{
    actor,
    contract::{self, Context, input},
    decode, encode,
    proposal::read_proposal,
    rejected,
};
use crate::{
    authorization::{self, Admission, EffectBinding},
    owner::{Error, RunRecord, StepRecord},
    sources::connectors::effects::PreparedEffect,
    store::WorldTransaction,
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    actions::{ActionFailure, ActionSubmitRequest, EffectIntent},
    api::WorldCommand,
    authorization::AuthorizationFailure,
    expression::{Effect, TruthValue},
    failure::FailureStage,
    ids::*,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Execution {
    pub proposal_id: CandidateId,
    pub context: Context,
    pub evaluation: serde_json::Value,
    pub source: Option<serde_json::Value>,
    pub failure: Option<world_protocol::failure::Failure<ActionFailure>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedIntent {
    pub intent: EffectIntent,
    pub execution: Execution,
    pub binding: EffectBinding,
    pub replayed: bool,
}

pub(crate) fn prepare<'a>(
    tx: &'a mut WorldTransaction<'_>,
    admission: &'a Admission,
    run: &'a RunRecord,
    step: &'a StepRecord,
    request: &'a ActionSubmitRequest,
    plan: &'a world_protocol::slots::ActionPlanResult,
    budget: &'a crate::extensions::invocation::CallBudget,
    cancellation: &'a tokio_util::sync::CancellationToken,
) -> crate::store::StoreFuture<'a, PreparedIntent, Error> {
    Box::pin(async move {
        tx.require_domain(&WriterDomain::try_new("actions").expect("actions domain"))?;
        let now = tx.now().await?;
        authorization::recheck(tx, admission, &now).await?;
        if let Some(prepared) = existing_intent(tx, admission, request).await? { return Ok(prepared); }
        let (proposal, mut context, id, payload_digest, target_digest) =
            prepare_basis(tx, admission, run, step, request, plan, &now).await?;
        let evaluation = evaluate_preparation(
            tx, admission, &mut context, &proposal, request, budget, cancellation, &now,
        )
        .await?;
        let contract = contract::action(tx, &proposal.request.action).await?;
        if !contract.body.effects.contains(&Effect::ExternalWrite) {
            return Err(input("effects"));
        }
        let expected_versions = evaluation
            .dependencies()
            .iter()
            .filter_map(|dependency| match dependency {
                world_protocol::provenance::ReadDependency::Source { position, .. } => {
                    Some(position.clone())
                }
                _ => None,
            })
            .collect();
        let intent = EffectIntent {
            id,
            operation_id: run.operation.operation_id.clone(),
            run_id: run.id.clone(),
            step_id: step.id.clone(),
            action: proposal.request.action.clone(),
            proposal_digest: proposal.digest.clone(),
            source_operation: plan.source_operation.clone(),
            argument_values: plan.arguments.clone(),
            idempotency_key: request.idempotency_key.clone(),
            activation_lock_id: proposal.activation_lock_id.clone(),
            decision_id: admission.decision().id.clone(),
            expected_versions,
        };
        let execution = Execution {
            proposal_id: proposal.id.clone(),
            context,
            evaluation: evaluation.retained()?,
            source: None,
            failure: None,
        };
        let world = tx.world();
        tx.execute("INSERT INTO world_effect_intent(tenant_id,world_id,intent_id,operation_id,run_id,step_id,revision,status,action_id,action_revision,proposal_id,proposal_digest,impact_digest,payload_digest,target_digest,effect,actor_id,branch_id,idempotency_key,activation_lock_id,decision_id,record,execution) VALUES($1,$2,$3,$4,$5,$6,1,'prepared',$7,$8,$9,$10,$11,$12,$13,'external_write',$14,NULL,$15,$16,$17,$18,$19)", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &intent.id.as_str(), &intent.operation_id.as_str(), &intent.run_id.as_str(), &intent.step_id.as_str(), &intent.action.id.as_str(), &(intent.action.revision.0 as i64), &proposal.id.as_str(), &intent.proposal_digest.as_str(), &proposal.impact.digest.as_str(), &payload_digest.as_str(), &target_digest.as_str(), &actor(&admission.invocation().actor).as_str(), &intent.idempotency_key.as_str(), &intent.activation_lock_id.as_str(), &intent.decision_id.as_str(), &encode(&intent)?, &encode(&execution)?]).await?;
        let changed = tx.execute("UPDATE world_action_proposal SET status='prepared',revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND proposal_id=$3 AND status='proposed'", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &proposal.id.as_str()]).await?;
        if changed != 1 {
            return Err(rejected(
                ActionFailure::IdempotencyConflict,
                FailureStage::Commit,
            ));
        }
        let binding = EffectBinding {
            intent_id: intent.id.clone(),
            operation_id: intent.operation_id.clone(),
            step_id: intent.step_id.clone(),
            payload_digest,
            target_digest,
            effect: Effect::ExternalWrite,
        };
        Ok(PreparedIntent {
            intent,
            execution,
            binding,
            replayed: false,
        })
    })
}

fn prepare_basis<'a>(
    tx: &'a WorldTransaction<'_>,
    admission: &'a Admission,
    run: &'a RunRecord,
    step: &'a StepRecord,
    request: &'a ActionSubmitRequest,
    plan: &'a world_protocol::slots::ActionPlanResult,
    now: &'a world_protocol::time::Timestamp,
) -> crate::store::StoreFuture<'a, (world_protocol::actions::ActionProposal, Context, EffectIntentId, Digest, Digest), Error> {
    Box::pin(async move {
        let (proposal, context) = read_proposal(tx, &request.proposal_id).await?;
        if request.world != *tx.world()
            || proposal.request.branch_id.is_some()
            || admission.invocation().branch_id.is_some()
            || proposal.digest != request.proposal_digest
        {
            return Err(rejected(
                ActionFailure::ProposalDigestMismatch,
                FailureStage::Admission,
            ));
        }
        if proposal.impact != *admission.impact() {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        let world = tx.world();
        let row = tx.query_opt("SELECT actor_id,status FROM world_action_proposal WHERE tenant_id=$1 AND world_id=$2 AND proposal_id=$3 FOR UPDATE", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &proposal.id.as_str()]).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
        if row.get::<_, String>("actor_id") != actor(&admission.invocation().actor).as_str() {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        let id_digest = crate::definitions::canonical_digest(&(
            "world.action.intent.v1",
            tx.world(),
            actor(&admission.invocation().actor),
            &proposal.request.action.id,
            &request.idempotency_key,
        ))?;
        let id = EffectIntentId::try_new(format!("effect-{}", &id_digest.as_str()[7..]))
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        let (payload_digest, target_digest) = authorization::effect_digests(
            &contract::action(tx, &proposal.request.action)
                .await?
                .body
                .source_operation,
            &proposal.request.arguments,
            &proposal.request.targets,
        )?;
        if &proposal.expires_at <= now {
            return Err(rejected(ActionFailure::ProposalExpired, FailureStage::Admission));
        }
        super::check_plan(&super::plan_request(tx, admission, request).await?, plan)
            .map_err(|failure| rejected(failure, FailureStage::Validate))?;
        if row.get::<_, String>("status") != "proposed"
            || run.release_id.as_ref() != Some(&context.release_id)
            || run.activation_lock_id.as_ref() != Some(&proposal.activation_lock_id)
            || step.run_id != run.id
        {
            return Err(input("intent.basis"));
        }
        Ok((proposal, context, id, payload_digest, target_digest))
    })
}

fn evaluate_preparation<'a>(
    tx: &'a WorldTransaction<'_>,
    admission: &'a Admission,
    context: &'a mut Context,
    proposal: &'a world_protocol::actions::ActionProposal,
    request: &'a ActionSubmitRequest,
    budget: &'a crate::extensions::invocation::CallBudget,
    cancellation: &'a tokio_util::sync::CancellationToken,
    now: &'a world_protocol::time::Timestamp,
) -> crate::store::StoreFuture<'a, crate::query::ActionEvaluation, Error> {
    Box::pin(async move {
        let current =
            contract::current_impact(tx, &WorldCommand::ActionSubmit(request.clone())).await?;
        admission.require_access(&current)?;
        require_compensation(
            tx,
            admission,
            context,
            &proposal.request,
            budget,
            cancellation,
            now,
        )
        .await?;
        let model = contract::release(tx, context).await?;
        crate::facts::support::recheck_dependencies_in_model(
            tx,
            &proposal.read_dependencies,
            &model,
            &context.scope,
            &crate::query::point_interval(now)?,
            now,
        )
        .await?;
        context.at = now.clone();
        let evaluation = crate::query::evaluate_action(
            tx,
            admission,
            &proposal.request.action,
            &context.release_id,
            None,
            &proposal.request.arguments,
            &context.scope,
            budget,
            cancellation,
            now,
        )
        .await?;
        require_preconditions(evaluation.preconditions())?;
        Ok(evaluation)
    })
}

/// Rechecks the original send immediately before its single-use permit is issued or consumed.
pub(crate) async fn require_effect_ready(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    expected: &EffectIntent,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    now: &world_protocol::time::Timestamp,
) -> Result<(), Error> {
    let (intent, execution, phase) = read_intent(tx, &expected.id).await?;
    if intent != *expected || phase != "prepared" || execution.source.is_none() {
        return Err(input("intent.ready"));
    }
    authorization::recheck(tx, admission, now).await?;
    let (proposal, _) = read_proposal(tx, &execution.proposal_id).await?;
    admission.require_access(
        &contract::current_impact(
            tx,
            &WorldCommand::ActionSubmit(ActionSubmitRequest {
                world: tx.world().clone(),
                proposal_id: proposal.id.clone(),
                proposal_digest: proposal.digest.clone(),
                idempotency_key: intent.idempotency_key.clone(),
                approval: admission.approval().cloned(),
            }),
        )
        .await?,
    )?;
    let model = contract::release(tx, &execution.context).await?;
    let mut dependencies = proposal.read_dependencies.clone();
    dependencies.extend(crate::query::retained_action_dependencies(
        &execution.evaluation,
    )?);
    crate::facts::support::recheck_dependencies_in_model(
        tx,
        &dependencies,
        &model,
        &execution.context.scope,
        &crate::query::point_interval(now)?,
        now,
    )
    .await?;
    require_compensation(
        tx,
        admission,
        &execution.context,
        &proposal.request,
        budget,
        cancellation,
        now,
    )
    .await?;
    let evaluation = crate::query::evaluate_action(
        tx,
        admission,
        &intent.action,
        &execution.context.release_id,
        None,
        &intent.argument_values,
        &execution.context.scope,
        budget,
        cancellation,
        now,
    )
    .await?;
    require_preconditions(evaluation.preconditions())?;
    if !evaluation.matches_retained(&execution.evaluation)? {
        return Err(crate::query::QueryError::from(
            world_protocol::query::QueryFailure::BasisChanged,
        )
        .into());
    }
    Ok(())
}

async fn require_compensation(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    context: &Context,
    request: &world_protocol::actions::ActionProposalRequest,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    now: &world_protocol::time::Timestamp,
) -> Result<(), Error> {
    let Some(original_id) = &context.compensation_intent else {
        return Ok(());
    };
    let (original, execution, _) = read_intent(tx, original_id).await?;
    let witness = crate::query::evaluate_compensation(
        tx,
        admission,
        &original.action,
        &execution.context.release_id,
        None,
        &original.argument_values,
        &execution.context.scope,
        budget,
        cancellation,
        now,
    )
    .await?;
    require_preconditions(witness.preconditions())?;
    if witness.action() != &request.action
        || witness.arguments() != request.arguments.as_slice()
        || witness.targets() != request.targets.as_slice()
    {
        return Err(input("compensation.basis"));
    }
    Ok(())
}

fn require_preconditions(preconditions: &[TruthValue]) -> Result<(), Error> {
    for (index, value) in preconditions.iter().enumerate() {
        match value {
            TruthValue::True => {}
            TruthValue::False => {
                return Err(rejected(
                    ActionFailure::PreconditionFalse {
                        index: index as u32,
                    },
                    FailureStage::Admission,
                ));
            }
            value => {
                return Err(rejected(
                    ActionFailure::PreconditionUnknown {
                        index: index as u32,
                        value: *value,
                    },
                    FailureStage::Admission,
                ));
            }
        }
    }
    Ok(())
}

pub(crate) async fn retain_source(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    intent: &EffectIntent,
    source: &PreparedEffect,
) -> Result<(), Error> {
    tx.require_domain(&WriterDomain::try_new("actions").expect("actions domain"))?;
    let (durable, mut execution, status) = read_intent(tx, &intent.id).await?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    let (proposal, _) = read_proposal(tx, &execution.proposal_id).await?;
    let (payload_digest, target_digest) = authorization::effect_digests(
        &intent.source_operation,
        &intent.argument_values,
        &proposal.request.targets,
    )?;
    let binding = EffectBinding {
        intent_id: intent.id.clone(),
        operation_id: intent.operation_id.clone(),
        step_id: intent.step_id.clone(),
        payload_digest,
        target_digest,
        effect: Effect::ExternalWrite,
    };
    if durable != *intent || status != "prepared" || source.binding() != &binding {
        return Err(input("intent"));
    }
    let retained = source.retained().map_err(super::source_error)?;
    if execution
        .source
        .as_ref()
        .is_some_and(|old| old != &retained)
    {
        return Err(rejected(
            ActionFailure::IdempotencyConflict,
            FailureStage::Prepare,
        ));
    }
    execution.source = Some(retained);
    let changed = tx.execute("UPDATE world_effect_intent SET execution=$4,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 AND status='prepared'", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str(), &encode(&execution)?]).await?;
    if changed != 1 {
        return Err(rejected(
            ActionFailure::IdempotencyConflict,
            FailureStage::Commit,
        ));
    }
    Ok(())
}

/// A known business key resumes its original intent before checking an expired proposal or invoking a planner.
pub(crate) async fn existing_intent(
    tx: &WorldTransaction<'_>, admission: &Admission, request: &ActionSubmitRequest,
) -> Result<Option<PreparedIntent>, Error> {
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    if admission.invocation().branch_id.is_some() { return Err(AuthorizationFailure::InsufficientScope.into()); }
    let Some((prepared, impact)) = lookup_recovery(tx, &admission.invocation().actor, request).await? else { return Ok(None); };
    admission.require_access(&impact)?;
    Ok(Some(prepared))
}

/// Exact owned history lookup only. It grants neither read admission nor another send permit.
pub(crate) async fn lookup_intent_recovery(
    tx: &WorldTransaction<'_>, principal: &world_protocol::authorization::Actor, request: &ActionSubmitRequest,
) -> Result<Option<(EffectIntent, world_protocol::authorization::ActualImpact)>, Error> {
    Ok(lookup_recovery(tx, principal, request).await?.map(|(prepared, impact)| (prepared.intent, impact)))
}
async fn lookup_recovery(
    tx: &WorldTransaction<'_>, principal: &world_protocol::authorization::Actor, request: &ActionSubmitRequest,
) -> Result<Option<(PreparedIntent, world_protocol::authorization::ActualImpact)>, Error> {
    let (proposal, _) = read_proposal(tx, &request.proposal_id).await?;
    if request.world != *tx.world() || proposal.request.branch_id.is_some() || proposal.digest != request.proposal_digest {
        return Err(rejected(ActionFailure::ProposalDigestMismatch, FailureStage::Admission));
    }
    let row = tx.query_opt("SELECT actor_id FROM world_action_proposal WHERE tenant_id=$1 AND world_id=$2 AND proposal_id=$3 FOR SHARE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &proposal.id.as_str()]).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
    if row.get::<_, String>("actor_id") != actor(principal).as_str() { return Err(AuthorizationFailure::InsufficientScope.into()); }
    let digest = crate::definitions::canonical_digest(&("world.action.intent.v1", tx.world(), actor(principal), &proposal.request.action.id, &request.idempotency_key))?;
    let id = EffectIntentId::try_new(format!("effect-{}", &digest.as_str()[7..])).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
    let Some((intent, execution, _)) = find_intent(tx, &id).await? else { return Ok(None); };
    let row = tx.query_opt("SELECT actor_id,proposal_id,proposal_digest,payload_digest,target_digest,idempotency_key FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 FOR SHARE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
    let (payload_digest, target_digest) = authorization::effect_digests(&intent.source_operation, &intent.argument_values, &proposal.request.targets)?;
    let expected = authorization::effect_digests(&contract::action(tx, &proposal.request.action).await?.body.source_operation, &proposal.request.arguments, &proposal.request.targets)?;
    if row.get::<_, String>("actor_id") != actor(principal).as_str() || execution.proposal_id != proposal.id
        || row.get::<_, String>("proposal_id") != proposal.id.as_str() || row.get::<_, String>("proposal_digest") != proposal.digest.as_str()
        || intent.proposal_digest != proposal.digest || intent.action != proposal.request.action || intent.idempotency_key != request.idempotency_key
        || row.get::<_, String>("idempotency_key") != intent.idempotency_key.as_str() || row.get::<_, String>("payload_digest") != payload_digest.as_str()
        || row.get::<_, String>("target_digest") != target_digest.as_str() || expected != (payload_digest.clone(), target_digest.clone()) {
        return Err(rejected(ActionFailure::IdempotencyConflict, FailureStage::Admission));
    }
    let command = WorldCommand::ActionReconcile(world_protocol::operation::OperationKey { world: tx.world().clone(), operation_id: intent.operation_id.clone() });
    let mut impact = contract::current_impact(tx, &command).await?;
    for access in &mut impact.access { access.modes = vec![world_protocol::authorization::AccessMode::Read]; }
    impact.effects = vec![Effect::Pure]; impact.state.clear();
    let status = super::receipt::status(tx, &intent.operation_id).await?;
    impact = super::receipt::status_impact(tx, impact, &proposal, &status).await?;
    Ok(Some((PreparedIntent {
        binding: EffectBinding { intent_id: intent.id.clone(), operation_id: intent.operation_id.clone(), step_id: intent.step_id.clone(), payload_digest, target_digest, effect: Effect::ExternalWrite },
        intent, execution, replayed: true,
    }, impact)))
}

pub(crate) async fn read_intent(
    tx: &WorldTransaction<'_>,
    id: &EffectIntentId,
) -> Result<(EffectIntent, Execution, String), Error> {
    find_intent(tx, id).await?.ok_or_else(|| input("intentId"))
}
async fn find_intent(
    tx: &WorldTransaction<'_>,
    id: &EffectIntentId,
) -> Result<Option<(EffectIntent, Execution, String)>, Error> {
    let row = tx.query_opt("SELECT operation_id,run_id,step_id,status,actor_id,record,execution FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 FOR UPDATE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?;
    row.map(|row| {
        let intent: EffectIntent = decode(row.get("record"))?;
        let execution: Execution = decode(row.get("execution"))?;
        if intent.id != *id
            || intent.action.world != *tx.world()
            || intent.operation_id.as_str() != row.get::<_, String>("operation_id")
            || intent.run_id.as_str() != row.get::<_, String>("run_id")
            || intent.step_id.as_str() != row.get::<_, String>("step_id")
        {
            return Err(input("intent"));
        }
        Ok((intent, execution, row.get("status")))
    })
    .transpose()
}
pub(crate) async fn read_operation_intent(
    tx: &WorldTransaction<'_>,
    operation: &OperationId,
) -> Result<(EffectIntent, Execution, String), Error> {
    let rows = tx.query("SELECT intent_id FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3 ORDER BY step_id LIMIT 2", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &operation.as_str()]).await?;
    if rows.len() != 1 {
        return Err(input("operationId"));
    }
    let id = EffectIntentId::try_new(rows[0].get::<_, String>("intent_id"))
        .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
    read_intent(tx, &id).await
}
