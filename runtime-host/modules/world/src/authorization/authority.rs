use super::{AccessGrant, AuthError, NativeContext, actor_id, actor_kind, decode, encode, recheck};
use crate::store::WorldTransaction;
use serde::{Deserialize, Serialize};
use world_protocol::{authorization::*, ids::*, time::Timestamp};

/// Capability created only by trusted composition and retained by authority producers.
/// It is not a plugin slot implementation, public command, or deserializable credential.
pub struct AuthorityRoot {
    _private: (),
}

#[derive(Clone, Debug, Serialize)]
pub struct PrincipalRecord {
    pub issuer: String,
    pub subject: String,
    pub actor: Actor,
    pub expires_at: Option<Timestamp>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalRecord {
    pub binding: ApprovalBinding,
    pub proposal_id: CandidateId,
    pub operation_id: OperationId,
    pub payload_digest: Digest,
    pub target_digest: Digest,
    pub separate_actor: bool,
}

pub(crate) enum Revoke<'a> {
    Principal { issuer: &'a str, subject: &'a str },
    Grant(&'a GrantId),
    Delegation(&'a DelegationId),
    Execution(&'a BindingId),
    Approval(&'a ApprovalId),
    Policy(&'a PolicyId),
}

impl AuthorityRoot {
    /// Host must retain this capability; never expose it through an SDK or command DTO.
    pub fn new() -> Self {
        Self { _private: () }
    }

    pub(crate) async fn principal(
        &self,
        tx: &WorldTransaction<'_>,
        record: &PrincipalRecord,
    ) -> Result<(), AuthError> {
        if record.issuer.is_empty()
            || record.issuer.len() > 256
            || record.subject.is_empty()
            || record.subject.len() > 256
            || record.issuer.chars().any(char::is_control)
            || record.subject.chars().any(char::is_control)
        {
            return Err(AuthorizationFailure::InvalidPrincipal.into());
        }
        lock(tx).await?;
        let world = tx.world();
        tx.execute(
            "INSERT INTO world_auth_principal(tenant_id,world_id,issuer,subject,actor_id,actor_kind,active,expires_at) VALUES($1,$2,$3,$4,$5,$6,true,$7::text::timestamptz) ON CONFLICT(tenant_id,world_id,issuer,subject) DO UPDATE SET actor_id=excluded.actor_id,actor_kind=excluded.actor_kind,active=true,expires_at=excluded.expires_at",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &record.issuer, &record.subject, &actor_id(&record.actor).as_str(),
              &actor_kind(&record.actor), &record.expires_at.as_ref().map(Timestamp::as_str)],
        ).await?;
        Ok(())
    }

    pub(crate) async fn grant(
        &self,
        tx: &WorldTransaction<'_>,
        id: &GrantId,
        actor: &ActorId,
        grant: &AccessGrant,
        expires: Option<&Timestamp>,
    ) -> Result<(), AuthError> {
        validate_grant(grant, tx.world())?;
        lock(tx).await?;
        let world = tx.world();
        tx.execute(
            "INSERT INTO world_auth_grant(tenant_id,world_id,grant_id,actor_id,\"grant\",active,expires_at) VALUES($1,$2,$3,$4,$5,true,$6::text::timestamptz) ON CONFLICT(tenant_id,world_id,grant_id) DO UPDATE SET actor_id=excluded.actor_id,\"grant\"=excluded.\"grant\",active=true,expires_at=excluded.expires_at",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &actor.as_str(), &encode(grant)?, &expires.map(Timestamp::as_str)],
        ).await?;
        Ok(())
    }

    pub(crate) async fn delegation(
        &self,
        tx: &WorldTransaction<'_>,
        id: &DelegationId,
        actor: &ActorId,
        delegate: &ActorId,
        restriction: &AccessGrant,
        expires: &Timestamp,
    ) -> Result<(), AuthError> {
        validate_grant(restriction, tx.world())?;
        if actor == delegate {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        lock(tx).await?;
        let world = tx.world();
        tx.execute(
            "INSERT INTO world_auth_delegation(tenant_id,world_id,delegation_id,actor_id,delegate_id,restriction,active,expires_at) VALUES($1,$2,$3,$4,$5,$6,true,$7::text::timestamptz) ON CONFLICT(tenant_id,world_id,delegation_id) DO UPDATE SET actor_id=excluded.actor_id,delegate_id=excluded.delegate_id,restriction=excluded.restriction,active=true,expires_at=excluded.expires_at",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &actor.as_str(), &delegate.as_str(), &encode(restriction)?, &expires.as_str()],
        ).await?;
        Ok(())
    }

    /// The real native producer supplies identity, task/attempt and permission facts.
    /// This mapping narrows world access; it never replaces native authorization.
    pub(crate) async fn execution(
        &self,
        tx: &WorldTransaction<'_>,
        id: &BindingId,
        issuer: &str,
        subject: &str,
        actor: &ActorId,
        context: &NativeContext,
        restriction: &AccessGrant,
        expires: &Timestamp,
    ) -> Result<(), AuthError> {
        validate_grant(restriction, tx.world())?;
        if issuer.is_empty()
            || subject.is_empty()
            || (context.task_id.is_some() && context.attempt_id.is_none())
        {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        lock(tx).await?;
        let world = tx.world();
        tx.execute(
            "INSERT INTO world_auth_execution(tenant_id,world_id,binding_id,issuer,subject,actor_id,agent_id,task_id,context,restriction,active,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11::text::timestamptz) ON CONFLICT(tenant_id,world_id,binding_id) DO UPDATE SET issuer=excluded.issuer,subject=excluded.subject,actor_id=excluded.actor_id,agent_id=excluded.agent_id,task_id=excluded.task_id,context=excluded.context,restriction=excluded.restriction,active=true,expires_at=excluded.expires_at",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &issuer, &subject, &actor.as_str(),
              &context.agent_id.as_ref().map(AgentId::as_str), &context.task_id.as_ref().map(TaskId::as_str), &encode(context)?, &encode(restriction)?, &expires.as_str()],
        ).await?;
        Ok(())
    }

    pub(crate) async fn revoke(
        &self,
        tx: &WorldTransaction<'_>,
        target: Revoke<'_>,
    ) -> Result<(), AuthError> {
        lock(tx).await?;
        let world = tx.world();
        let tenant = world.tenant_id.as_str();
        let world_id = world.world_id.as_str();
        let changed = match target {
            Revoke::Principal { issuer, subject } => tx.execute("UPDATE world_auth_principal SET active=false WHERE tenant_id=$1 AND world_id=$2 AND issuer=$3 AND subject=$4", &[&tenant, &world_id, &issuer, &subject]).await?,
            Revoke::Grant(id) => tx.execute("UPDATE world_auth_grant SET active=false WHERE tenant_id=$1 AND world_id=$2 AND grant_id=$3", &[&tenant, &world_id, &id.as_str()]).await?,
            Revoke::Delegation(id) => tx.execute("UPDATE world_auth_delegation SET active=false WHERE tenant_id=$1 AND world_id=$2 AND delegation_id=$3", &[&tenant, &world_id, &id.as_str()]).await?,
            Revoke::Execution(id) => tx.execute("UPDATE world_auth_execution SET active=false WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3", &[&tenant, &world_id, &id.as_str()]).await?,
            Revoke::Approval(id) => tx.execute("UPDATE world_auth_approval SET active=false WHERE tenant_id=$1 AND world_id=$2 AND approval_id=$3", &[&tenant, &world_id, &id.as_str()]).await?,
            Revoke::Policy(id) => tx.execute("UPDATE world_auth_policy SET active=false WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3", &[&tenant, &world_id, &id.as_str()]).await?,
        };
        if changed != 1 {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        // Outstanding permits are revoked as well as fenced by the new epoch. Old
        // release pins, approvals, and cached admissions cannot preserve authority.
        tx.execute("UPDATE world_auth_permit SET status='revoked' WHERE tenant_id=$1 AND world_id=$2 AND status='issued'", &[&tenant, &world_id]).await?;
        Ok(())
    }
}

/// Only trusted provisioning or a current Manage producer reaches this writer.
pub(super) async fn write_policy(
    tx: &WorldTransaction<'_>,
    rule: &PolicyRule,
    scope: &ScopeId,
    mandatory: bool,
    available: bool,
) -> Result<(), AuthError> {
    validate_grant(
        &AccessGrant {
            access: rule.access.clone(),
            labels: rule.labels.clone(),
            effects: rule.effects.clone(),
        },
        tx.world(),
    )?;
    let revision = i64::try_from(rule.reference.revision.0)
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    if revision <= 0 || rule.access.iter().any(|access| &access.scope != scope) {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    lock(tx).await?;
    let world = tx.world();
    tx.execute(
        "INSERT INTO world_auth_policy(tenant_id,world_id,policy_id,revision,policy,scope_id,mandatory,active,available) VALUES($1,$2,$3,$4,$5,$6,$7,true,$8) ON CONFLICT(tenant_id,world_id,policy_id) DO UPDATE SET revision=excluded.revision,policy=excluded.policy,scope_id=excluded.scope_id,mandatory=excluded.mandatory,active=true,available=excluded.available",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &rule.reference.policy_id.as_str(), &revision, &encode(rule)?, &scope.as_str(), &mandatory, &available],
    ).await?;
    Ok(())
}

pub(super) async fn lock(tx: &WorldTransaction<'_>) -> Result<(), AuthError> {
    let world = tx.world();
    tx.execute("INSERT INTO world_authority_head(tenant_id,world_id,policy_epoch,grant_epoch) VALUES($1,$2,1,1) ON CONFLICT DO NOTHING", &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?;
    tx.query_opt("SELECT policy_epoch,grant_epoch FROM world_authority_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE", &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?.ok_or(AuthorizationFailure::InternalFault)?;
    Ok(())
}
pub(super) fn validate_grant(grant: &AccessGrant, world: &WorldRef) -> Result<(), AuthError> {
    super::actual_impact(
        grant.access.clone(),
        grant.effects.clone(),
        grant.labels.clone(),
        Vec::new(),
        Vec::new(),
    )?;
    if grant
        .access
        .iter()
        .flat_map(|scope| &scope.fields)
        .any(|field| &field.world != world)
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    Ok(())
}

/// Approvals are recorded by a currently authorized approver for a durable proposal.
/// There is deliberately no set_approved(bool) or root-supplied approval record API.
pub(crate) async fn approve(
    tx: &WorldTransaction<'_>,
    approver: &super::VerifiedInvocation,
    proposal_id: &CandidateId,
    operation_id: &OperationId,
    approval_id: ApprovalId,
    expires_at: &Timestamp,
    now: &Timestamp,
) -> Result<ApprovalBinding, crate::owner::Error> {
    if expires_at <= now {
        return Err(AuthorizationFailure::ApprovalExpired.into());
    }
    lock(tx).await?;
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT proposal_digest,impact_digest,actor_id,branch_id,action_id,action_revision,status,body,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_action_proposal WHERE tenant_id=$1 AND world_id=$2 AND proposal_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &proposal_id.as_str()],
    ).await?.ok_or(AuthorizationFailure::ApprovalMissing)?;
    let proposal: world_protocol::actions::ActionProposal = decode(row.get("body"))?;
    if proposal.request.world != *world
        || proposal.request.branch_id.is_some()
        || row.get::<_, Option<String>>("branch_id").is_some()
        || !matches!(
            row.get::<_, String>("status").as_str(),
            "proposed" | "prepared"
        )
        || &proposal.expires_at <= now
        || row.get::<_, String>("proposal_digest") != proposal.digest.as_str()
        || row.get::<_, String>("impact_digest") != proposal.impact.digest.as_str()
    {
        return Err(AuthorizationFailure::ApprovalDigestMismatch.into());
    }
    let contract = super::permit::action_contract(tx, &proposal.request.action).await?;
    use world_protocol::actions::ApprovalRequirement;
    let approval = crate::actions::effective_approval(tx, proposal_id).await?;
    if approval == ApprovalRequirement::None {
        return Err(AuthorizationFailure::ObligationUnsatisfied.into());
    }
    if !matches!(approver.invocation().actor, Actor::Human { .. }) {
        return Err(AuthorizationFailure::InvalidPrincipal.into());
    }
    let separate = approval == ApprovalRequirement::SeparateActor;
    let proposer: String = row.get("actor_id");
    if separate && proposer == actor_id(&approver.invocation().actor).as_str() {
        return Err(AuthorizationFailure::InvalidPrincipal.into());
    }
    let mut access = proposal.impact.access.clone();
    for scope in &mut access {
        scope.modes = vec![AccessMode::Approve];
    }
    let impact = super::actual_impact(
        access,
        proposal.impact.effects.clone(),
        proposal.impact.labels.clone(),
        proposal.impact.state.clone(),
        proposal.impact.source_ids.clone(),
    )?;
    let admission = super::admit(tx, approver, &impact, &[], None, now).await?;
    recheck(tx, &admission, now).await?;
    let binding = ApprovalBinding {
        approval_id,
        action_digest: proposal.digest.clone(),
        impact_digest: proposal.impact.digest.clone(),
        contract: proposal.request.action.clone(),
        expires_at: expires_at.clone().min(proposal.expires_at.clone()).min(
            admission
                .decision()
                .expires_at
                .clone()
                .ok_or(AuthorizationFailure::DeadlineExpired)?,
        ),
    };
    let record = ApprovalRecord {
        binding: binding.clone(),
        proposal_id: proposal_id.clone(),
        operation_id: operation_id.clone(),
        payload_digest: super::permit::payload_digest(
            &contract.source_operation,
            &proposal.request.arguments,
        )?,
        target_digest: super::digest(&proposal.request.targets)?,
        separate_actor: separate,
    };
    tx.execute(
        "INSERT INTO world_auth_approval(tenant_id,world_id,approval_id,actor_id,proposer_id,approver_id,binding,active,expires_at) VALUES($1,$2,$3,$4,$4,$5,$6,true,$7::text::timestamptz)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.approval_id.as_str(), &proposer, &actor_id(&approver.invocation().actor).as_str(), &encode(&record)?, &binding.expires_at.as_str()],
    ).await?;
    Ok(binding)
}
