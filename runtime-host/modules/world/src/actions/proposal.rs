use super::{
    actor,
    contract::{self, Context, input},
    decode, encode, rejected,
};
use crate::{
    authorization::{self, Admission},
    owner::{Error, RunRecord},
    store::WorldTransaction,
};
use world_protocol::{
    actions::{ActionFailure, ActionProposal, ActionProposalRequest},
    api::{ApproveAction, WorldCommand},
    authorization::ApprovalBinding,
    failure::FailureStage,
    ids::*,
    time::Timestamp,
};

pub(crate) async fn read_proposal(
    tx: &WorldTransaction<'_>,
    id: &CandidateId,
) -> Result<(ActionProposal, Context), Error> {
    let world = tx.world();
    let row = tx.query_opt("SELECT proposal_digest,impact_digest,action_id,action_revision,activation_lock_id,body,execution FROM world_action_proposal WHERE tenant_id=$1 AND world_id=$2 AND proposal_id=$3 FOR SHARE", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?
        .ok_or(world_protocol::authorization::AuthorizationFailure::InsufficientScope)?;
    let proposal: ActionProposal = decode(row.get("body"))?;
    let context: Context = decode(row.get("execution"))?;
    if proposal.id != *id
        || proposal.request.world != *world
        || proposal.request.action.world != *world
        || row.get::<_, String>("proposal_digest") != proposal.digest.as_str()
        || row.get::<_, String>("impact_digest") != proposal.impact.digest.as_str()
        || row.get::<_, String>("action_id") != proposal.request.action.id.as_str()
        || i64::try_from(proposal.request.action.revision.0).ok()
            != Some(row.get("action_revision"))
        || row.get::<_, String>("activation_lock_id") != proposal.activation_lock_id.as_str()
        || context.branch.as_ref().map(|branch| &branch.id) != proposal.request.branch_id.as_ref()
        || digest(&proposal, &context)? != proposal.digest
    {
        return Err(rejected(
            ActionFailure::ProposalDigestMismatch,
            FailureStage::Read,
        ));
    }
    Ok((proposal, context))
}

/// Stored proposals are recalled under current read access, never under execution authority.
pub(crate) async fn proposal_read_impact(
    tx: &WorldTransaction<'_>, proposal: &ActionProposal,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let mut impact = contract::current_impact(tx, &WorldCommand::ActionPropose(proposal.request.clone())).await?;
    for access in &mut impact.access { access.modes = vec![world_protocol::authorization::AccessMode::Read]; }
    impact.effects = vec![world_protocol::expression::Effect::Pure]; impact.state.clear();
    Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
}
pub(crate) async fn require_proposal_read(
    tx: &WorldTransaction<'_>, verified: &authorization::VerifiedInvocation, id: &CandidateId, now: &Timestamp,
) -> Result<(ActionProposal, Context, world_protocol::authorization::ActualImpact), Error> {
    let (proposal, context) = read_proposal(tx, id).await?;
    if verified.invocation().world != *tx.world() || verified.invocation().branch_id != proposal.request.branch_id
        || &proposal.expires_at <= now { return Err(rejected(ActionFailure::ProposalExpired, FailureStage::Read)); }
    let model = contract::release(tx, &context).await?;
    if model.artifact.activation_lock_id != proposal.activation_lock_id { return Err(input("proposal.activationLock")); }
    let mut impact = proposal_read_impact(tx, &proposal).await?;
    authorization::check_impact_read(tx, verified, &impact, now).await?;
    let interval = crate::query::point_interval(now)?;
    let mut branch_dependencies = Vec::new();
    for basis in &proposal.request.basis {
        let (receipt, basis_impact) = crate::query::require_action_basis_preflight(tx, verified, basis, now).await?;
        if receipt.release_id != context.release_id || receipt.activation_lock_id != proposal.activation_lock_id || receipt.branch_id != proposal.request.branch_id
            || !receipt.coverage.complete || !receipt.dirty.is_empty() || receipt.truncation.is_some() { return Err(input("proposal.basis")); }
        if context.branch.is_some() { branch_dependencies.extend(receipt.actual_dependencies); }
        contract::merge(&mut impact, basis_impact);
    }
    // The original current receipt already checked its isolated branch inputs and capture material.
    let canonical: Vec<_> = proposal.read_dependencies.iter().filter(|dependency| !branch_dependencies.contains(dependency)).cloned().collect();
    if let Some(dependencies) = crate::facts::support::dependency_impact(tx, &canonical, &model, &context.scope, &interval).await? {
        contract::merge(&mut impact, dependencies);
        authorization::check_impact_read(tx, verified, &impact, now).await?;
    }
    crate::facts::support::recheck_dependencies_in_model(tx, &canonical, &model, &context.scope, &interval, now).await?;
    let evidence: Vec<_> = canonical.iter().filter_map(|dependency| match dependency { world_protocol::provenance::ReadDependency::Evidence { reference } => Some(reference.clone()), _ => None }).collect();
    crate::facts::assertions::require_evidence_preflight(tx, verified, &evidence, &context.scope, Some(&interval), now).await?;
    authorization::check_impact_read_output(tx, verified, &impact, 1, now).await?;
    Ok((proposal, context, impact))
}

pub(crate) async fn propose(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    run: &RunRecord,
    request: ActionProposalRequest,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<ActionProposal, Error> {
    propose_in_context(tx, admission, run, request, None, budget, cancellation).await
}

pub(crate) async fn propose_compensation(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    run: &RunRecord,
    original: &world_protocol::actions::EffectIntent,
    witness: &crate::query::CompensationEvaluation,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<ActionProposal, Error> {
    let (durable, execution, _) = super::intent::read_intent(tx, &original.id).await?;
    if durable != *original
        || witness.contract() != &original.action
        || witness.source_arguments() != original.argument_values
    {
        return Err(input("compensation.intent"));
    }
    let source = contract::action(tx, &original.action).await?;
    if source
        .body
        .compensation
        .as_ref()
        .is_none_or(|spec| &spec.action != witness.action())
    {
        return Err(input("compensation.action"));
    }
    if witness
        .preconditions()
        .iter()
        .any(|value| *value != world_protocol::expression::TruthValue::True)
    {
        return Err(input("compensation.preconditions"));
    }
    let model = contract::release(tx, &execution.context).await?;
    let now = tx.now().await?;
    crate::facts::support::recheck_dependencies_in_model(
        tx,
        witness.dependencies(),
        &model,
        &execution.context.scope,
        &crate::query::point_interval(&now)?,
        &now,
    )
    .await?;
    let request = ActionProposalRequest {
        world: tx.world().clone(),
        branch_id: None,
        action: witness.action().clone(),
        arguments: witness.arguments().to_vec(),
        targets: witness.targets().to_vec(),
        basis: Vec::new(),
    };
    propose_in_context(
        tx,
        admission,
        run,
        request,
        Some((original, witness)),
        budget,
        cancellation,
    )
    .await
}

async fn propose_in_context(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    run: &RunRecord,
    request: ActionProposalRequest,
    compensation: Option<(
        &world_protocol::actions::EffectIntent,
        &crate::query::CompensationEvaluation,
    )>,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<ActionProposal, Error> {
    tx.require_domain(&WriterDomain::try_new("actions").expect("actions domain"))?;
    let mut context = contract::initial_context(tx, &request).await?;
    context.compensation_intent = compensation.map(|(intent, _)| intent.id.clone());
    let release = contract::release(tx, &context).await?;
    if run.release_id.as_ref() != Some(&release.id)
        || run.activation_lock_id.as_ref() != Some(&release.artifact.activation_lock_id)
        || request.branch_id != run.branch_id
        || request.branch_id != admission.invocation().branch_id
    {
        return Err(input("run.basis"));
    }
    let now = tx.now().await?;
    context.at = now.clone();
    authorization::recheck(tx, admission, &now).await?;
    let mut impact = contract::impact(tx, &WorldCommand::ActionPropose(request.clone())).await?;
    if let Some((original, _)) = compensation {
        impact = contract::compensation_impact(tx, impact, original).await?;
    }
    admission.require_impact(&impact)?;
    let evaluation = crate::query::evaluate_action(
        tx,
        admission,
        &request.action,
        &context.release_id,
        request.branch_id.as_ref(),
        &request.arguments,
        &context.scope,
        budget,
        cancellation,
        &now,
    )
    .await?;
    let mut dependencies = evaluation.dependencies().to_vec();
    if let Some((_, witness)) = compensation {
        // The immutable original contract explains the mapping; only its live inputs must remain current.
        dependencies.extend(
            witness
                .dependencies()
                .iter()
                .filter(|dependency| {
                    !matches!(
                        dependency,
                        world_protocol::provenance::ReadDependency::Definition { .. }
                    )
                })
                .cloned(),
        );
    }
    let mut branch_dependencies = Vec::new();
    for id in &request.basis {
        let read = crate::query::require_action_basis(tx, admission, id, &now).await?;
        if read.world != *tx.world()
            || read.release_id != release.id
            || read.activation_lock_id != release.artifact.activation_lock_id
            || read.branch_id != request.branch_id
            || read
                .expires_at
                .as_ref()
                .is_some_and(|expires| expires <= &now)
            || !read.coverage.complete
            || !read.dirty.is_empty()
            || read.truncation.is_some()
        {
            return Err(input("basis"));
        }
        if request.branch_id.is_some() { branch_dependencies.extend(read.actual_dependencies.iter().cloned()); }
        dependencies.extend(read.actual_dependencies);
    }
    let canonical: Vec<_> = dependencies.iter().filter(|dependency| !branch_dependencies.contains(dependency)).cloned().collect();
    crate::facts::support::recheck_dependencies_in_model(
        tx,
        &canonical,
        &release,
        &context.scope,
        &crate::query::point_interval(&now)?,
        &now,
    )
    .await?;
    let expires_at = admission
        .decision()
        .expires_at
        .clone()
        .ok_or(world_protocol::authorization::AuthorizationFailure::DeadlineExpired)?;
    if expires_at <= now {
        return Err(rejected(
            ActionFailure::ProposalExpired,
            FailureStage::Admission,
        ));
    }
    let mut proposal = ActionProposal {
        id: CandidateId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID proposal"),
        request,
        digest: crate::definitions::canonical_digest(&())?,
        impact,
        preconditions: evaluation.preconditions().to_vec(),
        read_dependencies: dependencies,
        activation_lock_id: release.artifact.activation_lock_id,
        created_at: now,
        expires_at,
    };
    proposal.digest = digest(&proposal, &context)?;
    let world = tx.world();
    tx.execute("INSERT INTO world_action_proposal(tenant_id,world_id,proposal_id,revision,proposal_digest,impact_digest,actor_id,branch_id,action_id,action_revision,activation_lock_id,status,body,execution,expires_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,'proposed',$11,$12,$13::text::timestamptz)", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &proposal.id.as_str(), &proposal.digest.as_str(), &proposal.impact.digest.as_str(), &actor(&admission.invocation().actor).as_str(), &proposal.request.branch_id.as_ref().map(BranchId::as_str), &proposal.request.action.id.as_str(), &(proposal.request.action.revision.0 as i64), &proposal.activation_lock_id.as_str(), &encode(&proposal)?, &encode(&context)?, &proposal.expires_at.as_str()]).await?;
    Ok(proposal)
}

pub(crate) async fn effective_approval(
    tx: &WorldTransaction<'_>,
    proposal_id: &CandidateId,
) -> Result<world_protocol::actions::ApprovalRequirement, Error> {
    use world_protocol::actions::{ApprovalRequirement, RiskClass};
    let (proposal, context) = read_proposal(tx, proposal_id).await?;
    let target = contract::action(tx, &proposal.request.action).await?;
    let mut approval = if matches!(
        target.body.risk,
        RiskClass::Consequential | RiskClass::Irreversible
    ) {
        ApprovalRequirement::SeparateActor
    } else {
        target.body.approval
    };
    if let Some(id) = context.compensation_intent {
        let (original, _, _) = super::intent::read_intent(tx, &id).await?;
        let source = contract::action(tx, &original.action).await?;
        let spec = source
            .body
            .compensation
            .as_ref()
            .ok_or_else(|| input("compensation"))?;
        if spec.action != proposal.request.action {
            return Err(input("compensation.action"));
        }
        approval = match (approval, spec.approval) {
            (ApprovalRequirement::SeparateActor, _) | (_, ApprovalRequirement::SeparateActor) => {
                ApprovalRequirement::SeparateActor
            }
            (ApprovalRequirement::Human, _) | (_, ApprovalRequirement::Human) => {
                ApprovalRequirement::Human
            }
            _ => ApprovalRequirement::None,
        };
    }
    Ok(approval)
}

pub(crate) async fn approve(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    operation: &OperationId,
    request: &ApproveAction,
) -> Result<ApprovalBinding, Error> {
    tx.require_domain(&WriterDomain::try_new("actions").expect("actions domain"))?;
    let (proposal, _) = read_proposal(tx, &request.proposal_id).await?;
    if proposal.digest != request.proposal_digest {
        return Err(rejected(
            ActionFailure::ProposalDigestMismatch,
            FailureStage::Admission,
        ));
    }
    let now = tx.now().await?;
    authorization::recheck(tx, admission, &now).await?;
    Ok(authorization::approve(
        tx,
        admission.verified(),
        &request.proposal_id,
        operation,
        ApprovalId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID approval"),
        &request.expires_at,
        &now,
    )
    .await?)
}

fn digest(proposal: &ActionProposal, context: &Context) -> Result<Digest, Error> {
    Ok(crate::definitions::canonical_digest(&(
        "world.action.proposal.v1",
        &proposal.id,
        &proposal.request,
        &proposal.impact,
        &proposal.preconditions,
        &proposal.read_dependencies,
        &proposal.activation_lock_id,
        &proposal.created_at,
        &proposal.expires_at,
        context,
    ))?)
}
