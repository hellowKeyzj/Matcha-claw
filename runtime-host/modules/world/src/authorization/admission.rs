use super::read::AuthorityRead;
use super::{
    AuthError, active, actor_id, cap_expiry, decode, encode,
    ingress::VerifiedInvocation,
    scope::{AccessGrant, overlaps, permits, validate_impact},
};
use crate::store::{WorldSnapshot, WorldTransaction};
use world_protocol::{authorization::*, ids::*, time::Timestamp};

/// A current decision is evidence for exactly this host-computed impact, not a bearer grant.
#[derive(Clone)]
pub(crate) struct Admission {
    invocation: VerifiedInvocation,
    impact: ActualImpact,
    policies: Vec<PolicyRef>,
    approval: Option<ApprovalBinding>,
    decision: Decision,
    pub(super) recovery_only: bool,
    pub(super) state_basis: Vec<super::state::StateBasis>,
}
impl Admission {
    pub(crate) fn invocation(&self) -> &Invocation {
        self.invocation.invocation()
    }
    pub(crate) fn impact(&self) -> &ActualImpact {
        &self.impact
    }
    pub(crate) fn decision(&self) -> &Decision {
        &self.decision
    }
    pub(crate) fn approval(&self) -> Option<&ApprovalBinding> {
        self.approval.as_ref()
    }
    pub(crate) fn policy_request(
        &self,
    ) -> Result<world_protocol::slots::PolicyEvaluationRequest, AuthError> {
        Ok(world_protocol::slots::PolicyEvaluationRequest {
            world: self.invocation().world.clone(),
            impact: self.impact.clone(),
            policies: self.policies.clone(),
            scope_digest: super::digest(&(
                self.invocation(),
                &self.impact,
                &self.policies,
                &self.approval,
                self.decision.policy_epoch,
                self.decision.grant_epoch,
            ))?,
        })
    }
    pub(crate) fn check_policy_result(
        &self,
        request: &world_protocol::slots::PolicyEvaluationRequest,
        result: &world_protocol::slots::PolicyEvaluationResult,
    ) -> Result<(), AuthError> {
        if request != &self.policy_request()? || result.policies != self.policies {
            return Err(AuthorizationFailure::RequestDigestMismatch.into());
        }
        match result.verdict {
            PolicyVerdict::Deny => return Err(AuthorizationFailure::InsufficientScope.into()),
            PolicyVerdict::NeedsApproval if self.approval.is_none() => {
                return Err(AuthorizationFailure::ApprovalMissing.into());
            }
            _ => {}
        }
        if self.decision.verdict != PolicyVerdict::Allow
            || self.decision.obligations.iter().any(|obligation| !result.obligations.contains(obligation))
            || result.obligations.iter().any(|obligation| !self.decision.obligations.contains(obligation)
                && !(obligation == &PolicyObligation::Approval && self.approval.is_some()))
        {
            return Err(AuthorizationFailure::ObligationUnsatisfied.into());
        }
        Ok(())
    }
    pub(crate) fn restart_identity(&self) -> super::RestartIdentity {
        self.invocation.restart_identity()
    }
    pub(crate) fn require_impact(&self, impact: &ActualImpact) -> Result<(), AuthError> {
        if &self.impact != impact {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        Ok(())
    }
    /// Reducers must bind their own resolved resources, fields, mode and time before writing.
    pub(crate) fn require_access(&self, impact: &ActualImpact) -> Result<(), AuthError> {
        validate_impact(impact)?;
        let grant = AccessGrant {
            access: self.impact.access.clone(),
            labels: self.impact.labels.clone(),
            effects: self.impact.effects.clone(),
        };
        if !permits(&grant, impact)
            || !impact.state.iter().all(|s| self.impact.state.contains(s))
            || !impact
                .source_ids
                .iter()
                .all(|s| self.impact.source_ids.contains(s))
        {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        Ok(())
    }
    pub(crate) fn verified(&self) -> &VerifiedInvocation {
        &self.invocation
    }
    pub(crate) fn investigation_budget(&self) -> Option<&crate::extensions::invocation::CallBudget> {
        self.invocation.investigation.as_ref().map(|child| child.binding().budget())
    }
    pub(crate) fn investigation_cancellation(&self) -> Option<&tokio_util::sync::CancellationToken> {
        self.invocation.investigation.as_ref().map(|child| child.binding().cancellation())
    }
    pub(crate) fn investigation_work(&self) -> Result<Option<super::investigation::InvestigationWork>, AuthError> {
        self.invocation.investigation.as_ref().map(|child| child.work()).transpose()
    }
}

pub(crate) async fn admit(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    impact: &ActualImpact,
    policies: &[PolicyRef],
    approval: Option<&ApprovalBinding>,
    now: &Timestamp,
) -> Result<Admission, AuthError> {
    let decision = evaluate(
        AuthorityRead::Transaction(tx),
        invocation,
        impact,
        policies,
        approval.map(|binding| (binding, impact)),
        now,
    )
    .await?;
    let world = tx.world();
    tx.execute(
        "INSERT INTO world_auth_decision(tenant_id,world_id,decision_id,invocation_id,actor_id,impact_digest,decision) VALUES($1,$2,$3,$4,$5,$6,$7)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &decision.id.as_str(), &invocation.invocation.id.as_str(),
          &actor_id(&invocation.invocation.actor).as_str(), &impact.digest.as_str(), &encode(&decision)?],
    ).await?;
    let state_basis = super::state::capture(AuthorityRead::Transaction(tx), &impact.state).await?;
    Ok(Admission {
        invocation: invocation.clone(),
        impact: impact.clone(),
        policies: policies.into(),
        approval: approval.cloned(),
        decision,
        recovery_only: false,
        state_basis,
    })
}

/// Existing-intent inspection is current read authority, never permission for another send.
pub(crate) async fn read_recovery_admit(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    impact: &ActualImpact,
    policies: &[PolicyRef],
    now: &Timestamp,
) -> Result<Admission, AuthError> {
    if impact.access.iter().any(|scope| scope.modes.iter().any(|mode| *mode != AccessMode::Read))
        || impact.effects.iter().any(|effect| *effect != world_protocol::expression::Effect::Pure)
        || !impact.state.is_empty()
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let mut admission = admit(tx, invocation, impact, policies, None, now).await?;
    admission.recovery_only = true;
    Ok(admission)
}

/// Current read authorization only; no durable decision or dispatch capability is created.
pub(crate) async fn check_impact_read(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    impact: &ActualImpact,
    now: &Timestamp,
) -> Result<(), AuthError> {
    check_impact_read_decision(tx, invocation, impact, now).await.map(|_| ())
}

pub(crate) async fn check_impact_read_decision(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    impact: &ActualImpact,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    let decision = evaluate(
        AuthorityRead::Transaction(tx),
        invocation,
        impact,
        &[],
        None,
        now,
    )
    .await?;
    for obligation in &decision.obligations {
        match obligation {
            PolicyObligation::Limit { maximum: 0 } => {
                return Err(AuthorizationFailure::ObligationUnsatisfied.into());
            }
            PolicyObligation::Redact { fields }
                if impact.access.iter().any(|access| {
                    access.fields.is_empty()
                        || access.fields.iter().any(|field| fields.contains(&field.id))
                }) =>
            {
                return Err(AuthorizationFailure::ObligationUnsatisfied.into());
            }
            _ => {}
        }
    }
    Ok(decision)
}

/// Checks actual read output obligations without recording a decision or creating admission.
pub(crate) async fn check_impact_read_output(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    output: &ActualImpact,
    delivered: u64,
    now: &Timestamp,
) -> Result<(), AuthError> {
    let decision = evaluate(
        AuthorityRead::Transaction(tx),
        invocation,
        output,
        &[],
        None,
        now,
    )
    .await?;
    check_output_obligations(&decision, output, delivered)?;
    if let Some(child) = &invocation.investigation {
        child.check_output(AuthorityRead::Transaction(tx), output, delivered, now).await?;
    }
    Ok(())
}

pub(crate) async fn recheck(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    recheck_current(AuthorityRead::Transaction(tx), admission, now).await
}

pub(crate) async fn recheck_read(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    recheck_current(AuthorityRead::Snapshot(snapshot), admission, now).await
}
pub(super) async fn recheck_current(
    tx: AuthorityRead<'_, '_>,
    admission: &Admission,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    let decision = evaluate(
        tx,
        &admission.invocation,
        &admission.impact,
        &admission.policies,
        admission
            .approval
            .as_ref()
            .map(|binding| (binding, &admission.impact)),
        now,
    )
    .await?;
    if decision.policy_epoch != admission.decision.policy_epoch
        || decision.grant_epoch != admission.decision.grant_epoch
    {
        return Err(AuthorizationFailure::EpochChanged {
            policy_epoch: decision.policy_epoch,
            grant_epoch: decision.grant_epoch,
        }
        .into());
    }
    Ok(decision)
}

/// Run before returning rows/counts/events/explanations, including cached cross-actor results.
/// The supplied output impact contains actual derived labels and dependencies, not guest claims.
pub(crate) async fn check_output(
    tx: &WorldTransaction<'_>,
    invocation: &VerifiedInvocation,
    admission: &Admission,
    output: &ActualImpact,
    delivered: u64,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    output_current(
        AuthorityRead::Transaction(tx),
        invocation,
        admission,
        output,
        delivered,
        now,
    )
    .await
}
pub(crate) async fn check_admitted_output(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    output: &ActualImpact,
    delivered: u64,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    check_output(tx, admission.verified(), admission, output, delivered, now).await
}
pub(crate) async fn check_output_read(
    snapshot: &WorldSnapshot<'_>,
    invocation: &VerifiedInvocation,
    admission: &Admission,
    output: &ActualImpact,
    delivered: u64,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    output_current(
        AuthorityRead::Snapshot(snapshot),
        invocation,
        admission,
        output,
        delivered,
        now,
    )
    .await
}
pub(crate) async fn check_admitted_output_read(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    output: &ActualImpact,
    delivered: u64,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    check_output_read(
        snapshot,
        admission.verified(),
        admission,
        output,
        delivered,
        now,
    )
    .await
}
async fn output_current(
    tx: AuthorityRead<'_, '_>,
    invocation: &VerifiedInvocation,
    admission: &Admission,
    output: &ActualImpact,
    delivered: u64,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    if invocation.invocation != admission.invocation.invocation
        || invocation.restart_identity() != admission.invocation.restart_identity()
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    admission.require_access(output)?;
    evaluate_output(tx, invocation, admission, output, delivered, now).await
}

pub(super) async fn evaluate_output(
    tx: AuthorityRead<'_, '_>,
    invocation: &VerifiedInvocation,
    admission: &Admission,
    output: &ActualImpact,
    delivered: u64,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    let decision = evaluate(
        tx,
        invocation,
        output,
        &admission.policies,
        admission
            .approval
            .as_ref()
            .map(|binding| (binding, &admission.impact)),
        now,
    )
    .await?;
    check_output_obligations(&decision, output, delivered)?;
    if let Some(child) = &invocation.investigation {
        child.check_output(tx, output, delivered, now).await?;
    }
    Ok(decision)
}

fn check_output_obligations(
    decision: &Decision,
    output: &ActualImpact,
    delivered: u64,
) -> Result<(), AuthError> {
    for obligation in &decision.obligations {
        match obligation {
            PolicyObligation::Limit { maximum } if delivered > *maximum => {
                return Err(AuthorizationFailure::ObligationUnsatisfied.into());
            }
            PolicyObligation::Redact { fields }
                if output.access.iter().any(|access| {
                    access.fields.is_empty()
                        || access.fields.iter().any(|field| fields.contains(&field.id))
                }) =>
            {
                return Err(AuthorizationFailure::ObligationUnsatisfied.into());
            }
            _ => {}
        }
    }
    Ok(())
}

/// Refresh only current data revisions within the original admitted state identities.
pub(crate) async fn refresh_state(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    impact: &ActualImpact,
    now: &Timestamp,
) -> Result<Admission, AuthError> {
    super::state::require_current(AuthorityRead::Transaction(tx), admission, impact).await?;
    let mut refreshed = admit(
        tx,
        admission.verified(),
        impact,
        &admission.policies,
        admission.approval.as_ref(),
        now,
    )
    .await?;
    refreshed.recovery_only = admission.recovery_only;
    Ok(refreshed)
}

/// Read-only reauthorization returns no authority which could dispatch an effect.
pub(crate) async fn check_state_output_read(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    impact: &ActualImpact,
    delivered: u64,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    super::state::require_current(AuthorityRead::Snapshot(snapshot), admission, impact).await?;
    evaluate_output(
        AuthorityRead::Snapshot(snapshot),
        admission.verified(),
        admission,
        impact,
        delivered,
        now,
    )
    .await
}

pub(super) async fn head(
    tx: &WorldTransaction<'_>,
) -> Result<(PolicyEpoch, GrantEpoch), AuthError> {
    head_read(AuthorityRead::Transaction(tx)).await
}
async fn head_read(tx: AuthorityRead<'_, '_>) -> Result<(PolicyEpoch, GrantEpoch), AuthError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT policy_epoch,grant_epoch FROM world_authority_head WHERE tenant_id=$1 AND world_id=$2 FOR SHARE",
        "SELECT policy_epoch,grant_epoch FROM world_authority_head WHERE tenant_id=$1 AND world_id=$2",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::InvalidPrincipal)?;
    let policy = u64::try_from(row.get::<_, i64>("policy_epoch"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    let grant = u64::try_from(row.get::<_, i64>("grant_epoch"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    Ok((PolicyEpoch(policy), GrantEpoch(grant)))
}

async fn evaluate(
    tx: AuthorityRead<'_, '_>,
    verified: &VerifiedInvocation,
    impact: &ActualImpact,
    requested: &[PolicyRef],
    approval: Option<(&ApprovalBinding, &ActualImpact)>,
    now: &Timestamp,
) -> Result<Decision, AuthError> {
    let invocation = &verified.invocation;
    if tx.world() != &invocation.world {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    if &invocation.deadline <= now {
        return Err(AuthorizationFailure::DeadlineExpired.into());
    }
    validate_impact(impact)?;
    if impact
        .access
        .iter()
        .flat_map(|s| &s.fields)
        .any(|f| f.world != invocation.world)
        || impact.state.iter().any(|s| s.world != invocation.world)
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    let inherited = if let Some(child) = &verified.investigation {
        if verified.execution.is_none() || verified.evaluation.is_some() || verified.online_oracle.is_some() {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        Some(child.current(tx, impact, now).await?)
    } else { None };
    let (policy_epoch, grant_epoch) = head_read(tx).await?;
    let mut until = invocation.deadline.clone();
    if let Some(parent) = &inherited { cap_expiry(&mut until, parent.expires_at.clone()); }
    let transport = tx
        .principal(&verified.issuer, &verified.subject, now, &mut until)
        .await?;
    if actor_id(&transport) != &verified.transport_actor {
        return Err(AuthorizationFailure::InvalidPrincipal.into());
    }
    let world = tx.world();
    if let Some(delegation) = &invocation.delegation {
        let row = tx.query_opt(
            "SELECT actor_id,delegate_id,restriction,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_delegation WHERE tenant_id=$1 AND world_id=$2 AND delegation_id=$3 FOR SHARE",
            "SELECT actor_id,delegate_id,restriction,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_delegation WHERE tenant_id=$1 AND world_id=$2 AND delegation_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &delegation.as_str()],
        ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
        cap_expiry(
            &mut until,
            active(&row, now, AuthorizationFailure::InvalidDelegation)?,
        );
        let restriction: AccessGrant = decode(row.get("restriction"))?;
        if row.get::<_, String>("actor_id") != actor_id(&invocation.actor).as_str()
            || row.get::<_, String>("delegate_id") != verified.transport_actor.as_str()
            || !permits(&restriction, impact)
        {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        tx.represented(&invocation.actor, now, &mut until).await?;
    } else if actor_id(&transport) != actor_id(&invocation.actor) || transport != invocation.actor {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    if let Some(context) = &verified.evaluation {
        super::evaluation::require_invocation(tx, verified, context, impact, now, &mut until).await?;
    } else if let Some(context) = &verified.online_oracle {
        if verified.execution.is_some() {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        super::online::require_invocation(context, invocation, impact)?;
    } else if let Some((binding, context)) = &verified.execution {
        let row = tx.query_opt(
            "SELECT actor_id,agent_id,task_id,context,restriction,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_execution WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 AND issuer=$4 AND subject=$5 FOR SHARE",
            "SELECT actor_id,agent_id,task_id,context,restriction,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_execution WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 AND issuer=$4 AND subject=$5",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.as_str(), &verified.issuer, &verified.subject],
        ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
        cap_expiry(
            &mut until,
            active(&row, now, AuthorizationFailure::Revoked)?,
        );
        let current: super::NativeContext = decode(row.get("context"))?;
        let restriction: AccessGrant = decode(row.get("restriction"))?;
        if &current != context
            || row.get::<_, String>("actor_id") != actor_id(&invocation.actor).as_str()
            || row.get::<_, Option<String>>("agent_id").as_deref()
                != invocation.agent_id.as_ref().map(AgentId::as_str)
            || row.get::<_, Option<String>>("task_id").as_deref()
                != invocation.task_id.as_ref().map(TaskId::as_str)
            || !permits(&restriction, impact)
        {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
    } else if invocation.agent_id.is_some()
        || invocation.task_id.is_some()
        || invocation.native_run_id.is_some()
        || invocation.native_session_id.is_some()
    {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    grants(tx, actor_id(&invocation.actor), impact, verified.evaluation.as_ref(), now, &mut until).await?;
    for state in &impact.state {
        let current = tx.query_opt(
            "SELECT state_root_revision FROM world_state_namespace WHERE tenant_id=$1 AND world_id=$2 AND state_root_id=$3 FOR SHARE",
            "SELECT state_root_revision FROM world_state_namespace WHERE tenant_id=$1 AND world_id=$2 AND state_root_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &state.id.as_str()],
        ).await?.ok_or(AuthorizationFailure::InsufficientScope)?;
        if u64::try_from(current.get::<_, i64>("state_root_revision")).ok()
            != Some(state.revision.0)
        {
            return Err(AuthorizationFailure::EpochChanged {
                policy_epoch,
                grant_epoch,
            }
            .into());
        }
    }
    let rows = tx.query(
        "SELECT policy_id,revision,policy,scope_id,mandatory,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 ORDER BY policy_id FOR SHARE",
        "SELECT policy_id,revision,policy,scope_id,mandatory,active,available FROM world_auth_policy WHERE tenant_id=$1 AND world_id=$2 ORDER BY policy_id",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    let mut found = Vec::new();
    let mut obligations = inherited.map(|decision| decision.obligations).unwrap_or_default();
    let mut needs_approval = false;
    for row in rows {
        let id = PolicyId::try_new(row.get::<_, String>("policy_id"))
            .map_err(|_| AuthorizationFailure::InternalFault)?;
        let expected = requested.iter().find(|p| p.policy_id == id);
        if expected.is_none() && !row.get::<_, bool>("mandatory") && !row.get::<_, bool>("active") {
            continue;
        }
        let rule: super::PolicyRule = decode(row.get("policy"))?;
        let applicable = rule
            .access
            .iter()
            .any(|scope| impact.access.iter().any(|actual| overlaps(scope, actual)))
            && (rule.labels.is_empty()
                || rule
                    .labels
                    .iter()
                    .any(|label| impact.labels.contains(label)))
            && (rule.effects.is_empty()
                || rule
                    .effects
                    .iter()
                    .any(|effect| impact.effects.contains(effect)));
        if expected.is_none() && !applicable {
            continue;
        }
        if !row.get::<_, bool>("active") || !row.get::<_, bool>("available") {
            return Err(AuthorizationFailure::RequiredPolicyUnavailable { policy_id: id }.into());
        }
        if rule.reference.policy_id != id
            || i64::try_from(rule.reference.revision.0).ok() != Some(row.get::<_, i64>("revision"))
        {
            return Err(AuthorizationFailure::InternalFault.into());
        }
        if expected.is_some_and(|expected| expected != &rule.reference) {
            return Err(AuthorizationFailure::PolicyContractMismatch {
                contract_id: rule.reference.contract.id.clone(),
            }
            .into());
        }
        if expected.is_some() {
            found.push(id);
        }
        // Every selected mandatory or explicit policy must allow. An ordinary allow
        // never cancels a deny, a grant restriction, or an unavailable required policy.
        match rule.verdict {
            PolicyVerdict::Deny => return Err(AuthorizationFailure::InsufficientScope.into()),
            PolicyVerdict::NeedsApproval => needs_approval = true,
            PolicyVerdict::Allow => {}
        }
        for obligation in rule.reference.obligations {
            if obligation == PolicyObligation::Approval {
                needs_approval = true;
            }
            if !obligations.contains(&obligation) {
                obligations.push(obligation);
            }
        }
    }
    if let Some(missing) = requested.iter().find(|p| !found.contains(&p.policy_id)) {
        return Err(AuthorizationFailure::RequiredPolicyUnavailable {
            policy_id: missing.policy_id.clone(),
        }
        .into());
    }
    if needs_approval || approval.is_some() {
        let (binding, approved_impact) = approval.ok_or(AuthorizationFailure::ApprovalMissing)?;
        check_approval(tx, verified, approved_impact, binding, now, &mut until).await?;
    }
    Ok(Decision {
        id: DecisionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
        invocation_id: invocation.id.clone(),
        impact_digest: impact.digest.clone(),
        verdict: PolicyVerdict::Allow,
        policy_epoch,
        grant_epoch,
        evaluated_at: now.clone(),
        expires_at: Some(until),
        obligations,
    })
}

pub(super) async fn grants(
    tx: AuthorityRead<'_, '_>,
    actor: &ActorId,
    impact: &ActualImpact,
    evaluation: Option<&super::evaluation::EvaluationContext>,
    now: &Timestamp,
    until: &mut Timestamp,
) -> Result<(), AuthError> {
    let world = tx.world();
    let rows = tx.query(
        "SELECT \"grant\",active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_grant WHERE tenant_id=$1 AND world_id=$2 AND actor_id=$3 ORDER BY grant_id FOR SHARE",
        "SELECT \"grant\",active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_grant WHERE tenant_id=$1 AND world_id=$2 AND actor_id=$3 ORDER BY grant_id",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &actor.as_str()],
    ).await?;
    let mut allowed = Vec::new();
    let mut had_revoked = false;
    for row in rows {
        let grant: AccessGrant = decode(row.get("grant"))?;
        match active(&row, now, AuthorizationFailure::Revoked) {
            Ok(expires) => allowed.push((grant, expires)),
            Err(AuthError::Denied(AuthorizationFailure::Revoked)) => had_revoked = true,
            Err(error) => return Err(error),
        }
    }
    // Coverage may compose different resource grants, but labels/effects must belong
    // to the same grant covering each resource. Never union wildcard lists into authority.
    for access in &impact.access {
        let required = if let Some(context) = evaluation.filter(|context| access.resources.iter()
            .any(|resource| access.modes.iter().any(|mode| context.owns_result(resource, mode)))) {
            access.modes.iter().filter_map(|mode| {
                let mut remaining = access.clone();
                remaining.modes = vec![*mode];
                remaining.resources.retain(|resource| !context.owns_result(resource, mode));
                (!remaining.resources.is_empty()).then_some(remaining)
            }).collect()
        } else {
            vec![access.clone()]
        };
        for access in required {
        let partial = ActualImpact {
            access: vec![access],
            ..impact.clone()
        };
        let (_, expires) = allowed
            .iter()
            .find(|(grant, _)| permits(grant, &partial))
            .ok_or(if had_revoked {
                AuthorizationFailure::Revoked
            } else {
                AuthorizationFailure::InsufficientScope
            })?;
        cap_expiry(until, expires.clone());
        }
    }
    Ok(())
}

pub(super) async fn check_approval(
    tx: AuthorityRead<'_, '_>,
    verified: &VerifiedInvocation,
    impact: &ActualImpact,
    binding: &ApprovalBinding,
    now: &Timestamp,
    until: &mut Timestamp,
) -> Result<(), AuthError> {
    if &binding.expires_at <= now {
        return Err(AuthorizationFailure::ApprovalExpired.into());
    }
    if binding.impact_digest != impact.digest || binding.contract.world != *tx.world() {
        return Err(AuthorizationFailure::ApprovalDigestMismatch.into());
    }
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT actor_id,proposer_id,approver_id,binding,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_approval WHERE tenant_id=$1 AND world_id=$2 AND approval_id=$3 FOR SHARE",
        "SELECT actor_id,proposer_id,approver_id,binding,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_approval WHERE tenant_id=$1 AND world_id=$2 AND approval_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.approval_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::ApprovalMissing)?;
    cap_expiry(
        until,
        active(&row, now, AuthorizationFailure::ApprovalExpired)?,
    );
    let record: super::ApprovalRecord = decode(row.get("binding"))?;
    if record.binding != *binding
        || row.get::<_, String>("actor_id") != actor_id(&verified.invocation.actor).as_str()
        || (record.separate_actor
            && row.get::<_, String>("proposer_id") == row.get::<_, String>("approver_id"))
    {
        return Err(AuthorizationFailure::ApprovalDigestMismatch.into());
    }
    let approver = ActorId::try_new(row.get::<_, String>("approver_id"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    let mut represented_until = until.clone();
    tx.represented(
        &Actor::Human {
            id: approver.clone(),
        },
        now,
        &mut represented_until,
    )
    .await?;
    cap_expiry(until, Some(represented_until));
    let mut approval_impact = impact.clone();
    for access in &mut approval_impact.access {
        access.modes = vec![AccessMode::Approve];
    }
    grants(tx, &approver, &approval_impact, None, now, until).await?;
    cap_expiry(until, Some(binding.expires_at.clone()));
    Ok(())
}
