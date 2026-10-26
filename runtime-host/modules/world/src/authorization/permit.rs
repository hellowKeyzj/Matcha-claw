use super::{Admission, AuthError, actor_id, decode, digest, encode, recheck};
use crate::store::{PreparedBatch, TransactionError, WorldStore, WorldTransaction};
use crate::extensions::invocation::CallBudget;
use tokio_util::sync::CancellationToken;
use serde::{Deserialize, Serialize};
use world_protocol::{
    actions::{ActionContract, ActionProposal, ApprovalRequirement, EffectIntent, SourceOperation},
    authorization::AuthorizationFailure,
    definitions::DefinitionBody,
    expression::Effect,
    ids::*,
    query::QueryArgument,
    time::Timestamp,
};

/// Exact host-resolved effect binding. Never accepted from a guest or public command.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EffectBinding {
    pub intent_id: EffectIntentId,
    pub operation_id: OperationId,
    pub step_id: StepId,
    pub payload_digest: Digest,
    pub target_digest: Digest,
    pub effect: Effect,
}
#[derive(Clone, Serialize, Deserialize)]
struct PermitRecord {
    id: String,
    world: WorldRef,
    actor: ActorId,
    invocation_id: InvocationId,
    binding: EffectBinding,
    policy_epoch: PolicyEpoch,
    grant_epoch: GrantEpoch,
    expires_at: Timestamp,
}

/// Non-cloneable, non-serializable, unforgeable outside this private owner.
pub(crate) struct EffectPermit {
    record: PermitRecord,
}
impl std::fmt::Debug for EffectPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EffectPermit")
    }
}
/// Created only after the consume transaction committed. A trusted executor owns it.
/// Source permissions, conditional writes and idempotency remain independently required.
pub(crate) struct AuthorizedEffect {
    binding: EffectBinding,
    expires_at: Timestamp,
}
impl AuthorizedEffect {
    pub(crate) fn binding(&self) -> &EffectBinding {
        &self.binding
    }
    pub(crate) fn ensure_live(&self, now: &Timestamp) -> Result<(), AuthError> {
        if now >= &self.expires_at {
            return Err(AuthorizationFailure::DeadlineExpired.into());
        }
        Ok(())
    }
}

pub(crate) async fn issue_permit(
    store: &WorldStore,
    batch: PreparedBatch,
    admission: &Admission,
    binding: &EffectBinding,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<EffectPermit, TransactionError<crate::owner::Error>> {
    let admission = admission.clone();
    let binding = binding.clone();
    let budget = budget.clone();
    let cancellation = cancellation.clone();
    let committed = store.transact(batch, move |tx| Box::pin(async move {
        production(&admission)?;
        let now = tx.now().await?;
        let decision = recheck(tx, &admission, &now).await?;
        let durable = effect(tx, &admission, &binding, &budget, &cancellation, &now).await?;
        if durable.intent.decision_id != admission.decision().id { return Err(AuthorizationFailure::RequestDigestMismatch.into()); }
        let expires = decision.expires_at.clone().ok_or(AuthorizationFailure::DeadlineExpired)?;
        let proposal_expiry = durable.proposal.expires_at.clone();
        let expires_at = expires.min(proposal_expiry);
        if expires_at <= now { return Err(AuthorizationFailure::DeadlineExpired.into()); }
        let record = PermitRecord {
            id: uuid::Uuid::new_v4().to_string(), world: tx.world().clone(), actor: actor_id(&admission.invocation().actor).clone(),
            invocation_id: admission.invocation().id.clone(), binding, policy_epoch: decision.policy_epoch, grant_epoch: decision.grant_epoch, expires_at,
        };
        let world = tx.world();
        tx.execute(
            "INSERT INTO world_auth_permit(tenant_id,world_id,permit_id,intent_id,operation_id,step_id,actor_id,invocation_id,binding,policy_epoch,grant_epoch,expires_at,remaining_uses,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::timestamptz,1,'issued')",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &record.id, &record.binding.intent_id.as_str(), &record.binding.operation_id.as_str(), &record.binding.step_id.as_str(),
              &record.actor.as_str(), &record.invocation_id.as_str(), &encode(&record.binding)?, &(record.policy_epoch.0 as i64), &(record.grant_epoch.0 as i64), &record.expires_at.as_str()],
        ).await?;
        Ok::<_, crate::owner::Error>(record)
    })).await?;
    // A replayed issue can recover the same opaque handle, but consume still checks
    // current authority, expiry, intent status and its durable single-use CAS.
    Ok(EffectPermit {
        record: committed.value,
    })
}

pub(crate) enum PermitConsumption {
    Authorized(AuthorizedEffect),
    /// Already committed: reconcile the retained intent; never dispatch again.
    Replayed {
        binding: EffectBinding,
        receipt: world_protocol::commit::CommitReceipt,
    },
}

pub(crate) async fn consume_permit(
    store: &WorldStore,
    batch: PreparedBatch,
    permit: EffectPermit,
    admission: &Admission,
    actual: &EffectBinding,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<PermitConsumption, TransactionError<crate::owner::Error>> {
    let record = permit.record;
    let admission = admission.clone();
    let actual = actual.clone();
    let budget = budget.clone();
    let cancellation = cancellation.clone();
    let committed = store.transact(batch, move |tx| Box::pin(async move {
        production(&admission)?;
        let now = tx.now().await?;
        if record.binding != actual
            || record.world != admission.invocation().world
            || record.actor != *actor_id(&admission.invocation().actor)
            || record.invocation_id != admission.invocation().id
        {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        if record.expires_at <= now {
            return Err(AuthorizationFailure::DeadlineExpired.into());
        }
        let decision = recheck(tx, &admission, &now).await?;
        if record.policy_epoch != decision.policy_epoch || record.grant_epoch != decision.grant_epoch {
            return Err(AuthorizationFailure::EpochChanged { policy_epoch: decision.policy_epoch, grant_epoch: decision.grant_epoch }.into());
        }
        let durable = effect(tx, &admission, &record.binding, &budget, &cancellation, &now).await?;
        let world = tx.world();
        let changed = tx.execute(
            "UPDATE world_auth_permit SET remaining_uses=remaining_uses-1,status='consumed' WHERE tenant_id=$1 AND world_id=$2 AND permit_id=$3 AND intent_id=$4 AND operation_id=$5 AND step_id=$6 AND actor_id=$7 AND invocation_id=$8 AND binding=$9 AND policy_epoch=$10 AND grant_epoch=$11 AND expires_at>$12::text::timestamptz AND remaining_uses=1 AND status='issued'",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &record.id, &record.binding.intent_id.as_str(), &record.binding.operation_id.as_str(), &record.binding.step_id.as_str(),
              &record.actor.as_str(), &record.invocation_id.as_str(), &encode(&record.binding)?, &(record.policy_epoch.0 as i64), &(record.grant_epoch.0 as i64), &now.as_str()],
        ).await?;
        if changed != 1 { return Err(AuthorizationFailure::Revoked.into()); }
        // Do not turn cancellation/crash after this point into NotSent. The actions
        // owner must reconcile the retained consumed intent with the source.
        let changed = tx.execute(
            "UPDATE world_effect_intent SET status='dispatching',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 AND status='prepared'",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &record.binding.intent_id.as_str()],
        ).await?;
        if changed != 1 { return Err(AuthorizationFailure::Revoked.into()); }
        crate::actions::mark_dispatching(tx, &durable.intent, &now).await?;
        Ok::<_, crate::owner::Error>(record)
    })).await?;
    if committed.replayed {
        return Ok(PermitConsumption::Replayed {
            binding: committed.value.binding,
            receipt: committed.receipt,
        });
    }
    Ok(PermitConsumption::Authorized(AuthorizedEffect {
        binding: committed.value.binding,
        expires_at: committed.value.expires_at,
    }))
}

fn production(admission: &Admission) -> Result<(), AuthError> {
    let invocation = admission.verified();
    if admission.recovery_only
        || invocation.evaluation.is_some()
        || invocation.online_oracle.is_some()
        || invocation.invocation.branch_id.is_some()
        || invocation
            .execution
            .as_ref()
            .is_some_and(|(_, context)| context.evaluation || context.branch_id.is_some())
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    Ok(())
}

struct DurableEffect {
    intent: EffectIntent,
    proposal: ActionProposal,
}
async fn effect(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    binding: &EffectBinding,
    budget: &CallBudget,
    cancellation: &CancellationToken,
    now: &Timestamp,
) -> Result<DurableEffect, crate::owner::Error> {
    if binding.effect != Effect::ExternalWrite
        || !admission.impact().effects.contains(&Effect::ExternalWrite)
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT operation_id,run_id,step_id,status,action_id,action_revision,proposal_id,proposal_digest,impact_digest,payload_digest,target_digest,effect,actor_id,branch_id,decision_id,record FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.intent_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
    if row.get::<_, String>("status") != "prepared"
        || row.get::<_, Option<String>>("branch_id").is_some()
        || row.get::<_, String>("actor_id") != actor_id(&admission.invocation().actor).as_str()
        || row.get::<_, String>("operation_id") != binding.operation_id.as_str()
        || row.get::<_, String>("step_id") != binding.step_id.as_str()
        || row.get::<_, String>("payload_digest") != binding.payload_digest.as_str()
        || row.get::<_, String>("target_digest") != binding.target_digest.as_str()
        || row.get::<_, String>("impact_digest") != admission.impact().digest.as_str()
        || row.get::<_, String>("effect") != "external_write"
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let intent: EffectIntent = decode(row.get("record"))?;
    if intent.id != binding.intent_id
        || intent.operation_id != binding.operation_id
        || intent.step_id != binding.step_id
        || intent.run_id.as_str() != row.get::<_, String>("run_id")
        || intent.proposal_digest.as_str() != row.get::<_, String>("proposal_digest")
        || intent.action.id.as_str() != row.get::<_, String>("action_id")
        || i64::try_from(intent.action.revision.0).ok()
            != Some(row.get::<_, i64>("action_revision"))
        || intent.action.world != *world
        || intent.decision_id.as_str() != row.get::<_, String>("decision_id")
    {
        return Err(AuthorizationFailure::RequestDigestMismatch.into());
    }
    let decision = tx.query_opt(
        "SELECT invocation_id,actor_id,impact_digest,decision FROM world_auth_decision WHERE tenant_id=$1 AND world_id=$2 AND decision_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &intent.decision_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::Revoked)?;
    if decision.get::<_, String>("actor_id") != actor_id(&admission.invocation().actor).as_str()
        || decision.get::<_, String>("invocation_id") != admission.invocation().id.as_str()
        || decision.get::<_, String>("impact_digest") != admission.impact().digest.as_str()
    {
        return Err(AuthorizationFailure::RequestDigestMismatch.into());
    }
    let proposal_id: String = row.get("proposal_id");
    let proposal_row = tx.query_opt(
        "SELECT proposal_digest,impact_digest,actor_id,branch_id,status,body,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_action_proposal WHERE tenant_id=$1 AND world_id=$2 AND proposal_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &proposal_id],
    ).await?.ok_or(AuthorizationFailure::ApprovalDigestMismatch)?;
    let proposal: ActionProposal = decode(proposal_row.get("body"))?;
    let (payload_digest, target_digest) = effect_digests(
        &intent.source_operation,
        &intent.argument_values,
        &proposal.request.targets,
    )?;
    if proposal.id.as_str() != proposal_id
        || proposal.digest != intent.proposal_digest
        || proposal.request.action != intent.action
        || proposal.request.world != *world
        || proposal.request.branch_id.is_some()
        || proposal_row.get::<_, Option<String>>("branch_id").is_some()
        || proposal.impact != *admission.impact()
        || &proposal.expires_at <= now
        || proposal_row.get::<_, String>("actor_id")
            != actor_id(&admission.invocation().actor).as_str()
        || proposal_row.get::<_, String>("status") != "prepared"
        || payload_digest != binding.payload_digest
        || target_digest != binding.target_digest
    {
        return Err(AuthorizationFailure::ApprovalDigestMismatch.into());
    }
    let contract = action_contract(tx, &intent.action).await?;
    if contract.source_operation != intent.source_operation
        || !contract.effects.contains(&Effect::ExternalWrite)
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let run_id: String = row.get("run_id");
    let runtime = tx.query_opt(
        "SELECT o.actor_id,o.branch_id AS operation_branch,o.phase AS operation_phase,o.terminal_at IS NULL AS operation_live,r.branch_id AS run_branch,r.terminal_at IS NULL AS run_live,s.phase AS step_phase,g.mode,g.writer_epoch,s.writer_epoch AS step_epoch FROM world_operation o JOIN world_run r ON r.tenant_id=o.tenant_id AND r.world_id=o.world_id AND r.operation_id=o.operation_id JOIN world_step s ON s.tenant_id=r.tenant_id AND s.world_id=r.world_id AND s.run_id=r.run_id JOIN world_writer_gate g ON g.tenant_id=o.tenant_id AND g.world_id=o.world_id AND g.domain=o.writer_domain WHERE o.tenant_id=$1 AND o.world_id=$2 AND o.operation_id=$3 AND r.run_id=$4 AND s.step_id=$5 FOR SHARE OF o,r,s,g",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.operation_id.as_str(), &run_id, &binding.step_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::Revoked)?;
    if !runtime.get::<_, bool>("operation_live")
        || !runtime.get::<_, bool>("run_live")
        || runtime.get::<_, String>("actor_id") != actor_id(&admission.invocation().actor).as_str()
        || runtime
            .get::<_, Option<String>>("operation_branch")
            .is_some()
        || runtime.get::<_, Option<String>>("run_branch").is_some()
        || runtime.get::<_, String>("mode") != "active"
        || runtime.get::<_, i64>("writer_epoch") != runtime.get::<_, i64>("step_epoch")
        || !matches!(
            runtime.get::<_, String>("step_phase").as_str(),
            "admitted" | "running"
        )
    {
        return Err(AuthorizationFailure::Revoked.into());
    }
    let required_approval = crate::actions::effective_approval(tx, &proposal.id).await?;
    if required_approval != ApprovalRequirement::None {
        let approval = admission
            .approval()
            .ok_or(AuthorizationFailure::ApprovalMissing)?;
        if approval.action_digest != proposal.digest || approval.contract != intent.action {
            return Err(AuthorizationFailure::ApprovalDigestMismatch.into());
        }
        let approved = tx.query_opt("SELECT binding,approver_id,proposer_id FROM world_auth_approval WHERE tenant_id=$1 AND world_id=$2 AND approval_id=$3 FOR SHARE", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &approval.approval_id.as_str()]).await?.ok_or(AuthorizationFailure::ApprovalMissing)?;
        let record: super::ApprovalRecord = decode(approved.get("binding"))?;
        if record.proposal_id != proposal.id
            || record.payload_digest != binding.payload_digest
            || record.target_digest != binding.target_digest
            || (required_approval == ApprovalRequirement::SeparateActor
                && approved.get::<_, String>("approver_id")
                    == approved.get::<_, String>("proposer_id"))
        {
            return Err(AuthorizationFailure::ApprovalDigestMismatch.into());
        }
    }
    crate::actions::require_effect_ready(tx, admission, &intent, budget, cancellation, now).await?;
    Ok(DurableEffect { intent, proposal })
}

pub(super) async fn action_contract(
    tx: &WorldTransaction<'_>,
    reference: &DefinitionRef,
) -> Result<ActionContract, AuthError> {
    let definition = crate::definitions::read_definition(tx, reference)
        .await?
        .ok_or(AuthorizationFailure::InsufficientScope)?;
    match definition.body {
        DefinitionBody::ActionContract(contract) => Ok(contract),
        _ => Err(AuthorizationFailure::InsufficientScope.into()),
    }
}
pub(crate) fn effect_digests(
    operation: &SourceOperation,
    arguments: &[QueryArgument],
    targets: &[world_protocol::identity::SubjectRef],
) -> Result<(Digest, Digest), AuthError> {
    Ok((payload_digest(operation, arguments)?, digest(&targets)?))
}

pub(super) fn payload_digest(
    operation: &SourceOperation,
    arguments: &[QueryArgument],
) -> Result<Digest, AuthError> {
    digest(&(operation, arguments))
}
