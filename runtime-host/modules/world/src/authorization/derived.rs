use world_protocol::{
    actions::ApprovalRequirement,
    api::WorldCommand,
    authorization::{ApprovalBinding, AuthorizationFailure},
    ids::CandidateId,
    operation::OperationKey,
    time::Timestamp,
};

use super::{Admission, ApprovalRecord, actor_id, admit, decode, read::AuthorityRead, recheck};
use crate::{actions, owner::Error, store::WorldTransaction};

/// A strategy action keeps the parent's verified identity and only narrows its current ceiling.
pub(crate) async fn derive_action(
    tx: &WorldTransaction<'_>,
    parent: &Admission,
    command: &WorldCommand,
    now: &Timestamp,
) -> Result<Admission, Error> {
    if parent.recovery_only
        || !matches!(
            command,
            WorldCommand::ActionPropose(_) | WorldCommand::ActionSubmit(_)
        )
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    recheck(tx, parent, now).await?;
    let impact = actions::impact(tx, command).await?;
    parent.require_access(&impact)?;
    let policies = actions::policies(tx, command).await?;
    let approval = actions::approval(tx, command).await?;
    if let WorldCommand::ActionSubmit(request) = command {
        if actions::effective_approval(tx, &request.proposal_id).await? != ApprovalRequirement::None
            && approval.is_none()
        {
            return Err(AuthorizationFailure::ApprovalMissing.into());
        }
    }
    Ok(admit(
        tx,
        parent.verified(),
        &impact,
        &policies,
        approval.as_ref(),
        now,
    )
    .await?)
}

/// Current authority for inspecting one original intent, never for a new effect send.
pub(crate) async fn derive_action_recovery(
    tx: &WorldTransaction<'_>,
    parent: &Admission,
    key: &OperationKey,
    now: &Timestamp,
) -> Result<Admission, Error> {
    recheck(tx, parent, now).await?;
    if key.world != *tx.world() {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let (intent, _, _) = actions::read_operation_intent(tx, &key.operation_id).await?;
    let world = tx.world();
    let owner = tx.query_opt(
        "SELECT actor_id FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &intent.id.as_str()],
    ).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
    if intent.operation_id != key.operation_id
        || owner.get::<_, String>("actor_id") != actor_id(&parent.invocation().actor).as_str()
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let command = WorldCommand::ActionReconcile(key.clone());
    let impact = actions::current_impact(tx, &command).await?;
    parent.require_access(&impact)?;
    let policies = actions::policies(tx, &command).await?;
    let mut admission = admit(tx, parent.verified(), &impact, &policies, None, now).await?;
    admission.recovery_only = true;
    Ok(admission)
}

/// Reads an original human approval; absence never mints or substitutes an approval.
pub(crate) async fn action_approval(
    tx: &WorldTransaction<'_>,
    parent: &Admission,
    proposal_id: &CandidateId,
    now: &Timestamp,
) -> Result<Option<ApprovalBinding>, Error> {
    recheck(tx, parent, now).await?;
    let (proposal, _) = actions::read_proposal(tx, proposal_id).await?;
    parent.require_access(&proposal.impact)?;
    if &proposal.expires_at <= now {
        return Err(AuthorizationFailure::ApprovalExpired.into());
    }
    let required = actions::effective_approval(tx, proposal_id).await?;
    let world = tx.world();
    let proposal_row = tx.query_opt(
        "SELECT actor_id,status FROM world_action_proposal WHERE tenant_id=$1 AND world_id=$2 AND proposal_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &proposal_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::ApprovalMissing)?;
    if proposal_row.get::<_, String>("actor_id") != actor_id(&parent.invocation().actor).as_str()
        || !matches!(
            proposal_row.get::<_, String>("status").as_str(),
            "proposed" | "prepared"
        )
    {
        return Err(AuthorizationFailure::ApprovalDigestMismatch.into());
    }
    let rows = tx.query(
        "SELECT binding,active,proposer_id,approver_id,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_approval WHERE tenant_id=$1 AND world_id=$2 AND actor_id=$3 AND binding->>'proposalId'=$4 ORDER BY approval_id FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &actor_id(&parent.invocation().actor).as_str(), &proposal_id.as_str()],
    ).await?;
    let contract = super::permit::action_contract(tx, &proposal.request.action).await?;
    let (payload, targets) = super::effect_digests(
        &contract.source_operation,
        &proposal.request.arguments,
        &proposal.request.targets,
    )?;
    for row in rows {
        if !row.get::<_, bool>("active") || row.get::<_, i64>("expires_ms") <= now.unix_millis() {
            continue;
        }
        let record: ApprovalRecord = decode(row.get("binding"))?;
        if record.proposal_id != *proposal_id
            || record.binding.action_digest != proposal.digest
            || record.binding.impact_digest != proposal.impact.digest
            || record.binding.contract != proposal.request.action
            || record.payload_digest != payload
            || record.target_digest != targets
            || (required == ApprovalRequirement::SeparateActor
                && row.get::<_, String>("proposer_id") == row.get::<_, String>("approver_id"))
        {
            return Err(AuthorizationFailure::ApprovalDigestMismatch.into());
        }
        if &record.binding.expires_at <= now {
            continue;
        }
        let mut until = parent.invocation().deadline.clone();
        super::admission::check_approval(
            AuthorityRead::Transaction(tx),
            parent.verified(),
            &proposal.impact,
            &record.binding,
            now,
            &mut until,
        )
        .await?;
        return Ok(Some(record.binding));
    }
    Ok(None)
}
