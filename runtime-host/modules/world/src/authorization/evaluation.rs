use std::sync::Arc;

use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, ActualImpact, AuthorizationFailure, Invocation},
    bindings::ImplementationRef,
    evaluation::{EvaluationArm, TestRevision},
    expression::Effect,
    ids::*,
    learning::TaskRef,
    materials::AccessPolicyRef,
    releases::BranchRef,
    sources::RetentionPolicy,
    time::Timestamp,
};

use super::{
    AccessGrant, Admission, AuthError, AuthorityRoot, VerifiedInvocation, actor_id, admit, digest,
};
use crate::store::WorldTransaction;
use super::read::AuthorityRead;

/// Trusted configuration references existing principals and grants; it creates neither.
#[derive(Clone, Serialize, Deserialize)]
pub struct EvaluationPrincipal {
    pub issuer: String,
    pub subject: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct InitialEvaluation {
    pub execution: EvaluationPrincipal,
    pub oracle: EvaluationPrincipal,
    pub case_access: AccessPolicyRef,
    pub case_retention: RetentionPolicy,
}

/// Host-only capability, bound to the same root and one explicitly configured world.
#[derive(Clone)]
pub struct EvaluationAuthority {
    root: Arc<AuthorityRoot>,
    world: WorldRef,
    config: InitialEvaluation,
}

/// A real claimed evaluation step and the actual new case produced by that step.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EvaluationBinding {
    pub evaluation_id: EvaluationId,
    pub candidate_id: CandidateId,
    pub branch: BranchRef,
    pub task: TaskRef,
    pub arm: EvaluationArm,
    pub test: TestRevision,
    pub case_id: CaseId,
    pub run_id: RunId,
    pub step_id: StepId,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EvaluationContext {
    pub binding: EvaluationBinding,
    pub identity: Digest,
    pub oracle: bool,
    pub recording: bool,
    pub restriction: AccessGrant,
}

impl AuthorityRoot {
    pub fn evaluation_authority(
        self: &Arc<Self>,
        world: WorldRef,
        config: &InitialEvaluation,
    ) -> Result<EvaluationAuthority, AuthorizationFailure> {
        validate_config(config)?;
        Ok(EvaluationAuthority {
            root: self.clone(),
            world,
            config: config.clone(),
        })
    }

    pub(crate) async fn initialize_evaluation(
        &self,
        tx: &WorldTransaction<'_>,
        input: &InitialEvaluation,
        now: &Timestamp,
    ) -> Result<(), AuthError> {
        tx.require_provision()?;
        validate(tx, input, now).await
    }
}

impl EvaluationAuthority {
    pub fn world(&self) -> &WorldRef {
        &self.world
    }

    pub(crate) fn same_root(&self, root: &Arc<AuthorityRoot>) -> bool {
        Arc::ptr_eq(&self.root, root)
    }

    pub(crate) async fn require_manager(
        &self,
        tx: &WorldTransaction<'_>,
        admission: &Admission,
        now: &Timestamp,
    ) -> Result<(), AuthError> {
        let verified = admission.verified();
        if tx.world() != &self.world
            || admission.invocation().world != self.world
            || verified.issuer != self.config.oracle.issuer
            || verified.subject != self.config.oracle.subject
            || verified.evaluation.is_some()
            || verified.online_oracle.is_some()
            || admission.invocation().branch_id.is_some()
        {
            return Err(AuthorizationFailure::InvalidPrincipal.into());
        }
        let (_, oracle) = principals(tx, &self.config, now).await?;
        if actor_id(&oracle) != actor_id(&admission.invocation().actor) {
            return Err(AuthorizationFailure::InvalidPrincipal.into());
        }
        super::recheck(tx, admission, now).await?;
        Ok(())
    }

    pub(crate) async fn require_evaluation_recording(
        &self,
        tx: &WorldTransaction<'_>,
        admission: &Admission,
        binding: &EvaluationBinding,
        now: &Timestamp,
    ) -> Result<(), crate::evaluation::Error> {
        let verified = admission.verified();
        let context = verified
            .evaluation
            .as_ref()
            .ok_or(AuthorizationFailure::InvalidPrincipal)
            .map_err(AuthError::from)?;
        if tx.world() != &self.world
            || context.binding != *binding
            || !context.recording
            || context.oracle
            || verified.issuer != self.config.oracle.issuer
            || verified.subject != self.config.oracle.subject
        {
            return Err(AuthError::Denied(AuthorizationFailure::InvalidPrincipal).into());
        }
        crate::evaluation::require_execution_binding(tx, binding, now).await?;
        let (_, oracle) = principals(tx, &self.config, now).await?;
        if actor_id(&oracle) != actor_id(&admission.invocation().actor) {
            return Err(AuthError::Denied(AuthorizationFailure::InvalidPrincipal).into());
        }
        super::recheck(tx, admission, now).await?;
        Ok(())
    }

    pub(crate) fn case_policies(&self) -> (&AccessPolicyRef, &RetentionPolicy) {
        (&self.config.case_access, &self.config.case_retention)
    }

    pub(super) async fn oracle_identity(
        &self,
        tx: &WorldTransaction<'_>,
        now: &Timestamp,
    ) -> Result<(&EvaluationPrincipal, world_protocol::authorization::Actor), AuthError> {
        if tx.world() != &self.world {
            return Err(AuthorizationFailure::InvalidPrincipal.into());
        }
        let (_, actor) = principals(tx, &self.config, now).await?;
        Ok((&self.config.oracle, actor))
    }

    pub(crate) async fn recording(
        &self,
        tx: &WorldTransaction<'_>,
        binding: &EvaluationBinding,
        impact: &ActualImpact,
        now: &Timestamp,
    ) -> Result<Admission, crate::evaluation::Error> {
        let admission = self.authorize(tx, binding, None, true, impact, now).await?;
        let (_, scope) =
            super::policies::case_policy(tx, &self.config.case_access, &self.config.case_retention)
                .await?;
        super::require_case_policies(
            tx,
            &admission,
            &binding.case_id,
            &scope,
            &self.config.case_access,
            &self.config.case_retention,
            now,
        )
        .await?;
        Ok(admission)
    }

    pub(crate) async fn execution(
        &self,
        tx: &WorldTransaction<'_>,
        binding: &EvaluationBinding,
        impact: &ActualImpact,
        now: &Timestamp,
    ) -> Result<Admission, crate::evaluation::Error> {
        self.authorize(tx, binding, None, false, impact, now).await
    }

    pub(crate) async fn oracle(
        &self,
        tx: &WorldTransaction<'_>,
        binding: &EvaluationBinding,
        implementation: &ImplementationRef,
        observed: &Digest,
        impact: &ActualImpact,
        now: &Timestamp,
    ) -> Result<Admission, crate::evaluation::Error> {
        self.authorize(
            tx,
            binding,
            Some((implementation, observed)),
            false,
            impact,
            now,
        )
        .await
    }

    async fn authorize(
        &self,
        tx: &WorldTransaction<'_>,
        binding: &EvaluationBinding,
        oracle: Option<(&ImplementationRef, &Digest)>,
        recording: bool,
        impact: &ActualImpact,
        now: &Timestamp,
    ) -> Result<Admission, crate::evaluation::Error> {
        if tx.world() != &self.world
            || binding.task.world != self.world
            || binding.branch.world != self.world
        {
            return Err(AuthError::Denied(AuthorizationFailure::InvalidPrincipal).into());
        }
        let bounds = crate::evaluation::require_execution_binding(tx, binding, now).await?;
        let (execution, evaluator) = principals(tx, &self.config, now).await?;
        let (principal, actor) = if oracle.is_some() || recording {
            (&self.config.oracle, evaluator)
        } else {
            (&self.config.execution, execution)
        };
        let request_digest = digest(&(
            "world.evaluation.invocation.v1",
            binding,
            oracle,
            recording,
            impact,
        ))?;
        let context = EvaluationContext {
            binding: binding.clone(),
            identity: request_digest.clone(),
            oracle: oracle.is_some(),
            recording,
            restriction: AccessGrant {
                access: impact.access.clone(),
                labels: impact.labels.clone(),
                effects: impact.effects.clone(),
            },
        };
        require_context(&context, impact)?;
        let verified = VerifiedInvocation {
            invocation: Invocation {
                id: InvocationId::try_new(uuid::Uuid::new_v4().to_string())
                    .expect("UUID identifier"),
                world: self.world.clone(),
                actor: actor.clone(),
                delegation: None,
                agent_id: None,
                task_id: Some(binding.task.id.clone()),
                branch_id: Some(binding.branch.id.clone()),
                native_session_id: None,
                native_run_id: None,
                audience: if recording {
                    "world.evaluation.recording"
                } else if oracle.is_some() {
                    "world.evaluation.oracle"
                } else {
                    "world.evaluation.execution"
                }
                .into(),
                request_digest,
                deadline: bounds.deadline,
                replay_id: RequestId::try_new(tx.commit_id().as_str())
                    .map_err(|_| AuthError::Denied(AuthorizationFailure::InternalFault))?,
            },
            issuer: principal.issuer.clone(),
            subject: principal.subject.clone(),
            transport_actor: actor_id(&actor).clone(),
            execution: None,
            evaluation: Some(context),
            online_oracle: None,
            investigation: None,
        };
        Ok(admit(tx, &verified, impact, &[], None, now).await?)
    }
}

pub(crate) fn require_evaluation_execution_model<'a>(
    admission: &'a Admission,
    evaluation: &EvaluationId,
    branch: &BranchRef,
    arm: &EvaluationArm,
) -> Result<&'a EvaluationBinding, AuthError> {
    let verified = admission.verified();
    let context = verified
        .evaluation
        .as_ref()
        .ok_or(AuthorizationFailure::InvalidPrincipal)?;
    let invocation = admission.invocation();
    if context.oracle
        || context.recording
        || &context.binding.evaluation_id != evaluation
        || &context.binding.branch != branch
        || &context.binding.arm != arm
        || invocation.world != branch.world
        || context.binding.task.world != invocation.world
        || invocation.task_id.as_ref() != Some(&context.binding.task.id)
        || invocation.branch_id.as_ref() != Some(&branch.id)
        || invocation.audience != "world.evaluation.execution"
        || invocation.request_digest != context.identity
    {
        return Err(AuthorizationFailure::InvalidPrincipal.into());
    }
    require_context(context, admission.impact())?;
    Ok(&context.binding)
}

pub(super) async fn require_invocation(
    reader: AuthorityRead<'_, '_>,
    verified: &VerifiedInvocation,
    context: &EvaluationContext,
    impact: &ActualImpact,
    now: &Timestamp,
    until: &mut Timestamp,
) -> Result<(), AuthError> {
    let invocation = verified.invocation();
    let audience = if context.recording {
        "world.evaluation.recording"
    } else if context.oracle {
        "world.evaluation.oracle"
    } else {
        "world.evaluation.execution"
    };
    if verified.execution.is_some() || verified.online_oracle.is_some()
        || verified.investigation.is_some()
        || invocation.agent_id.is_some() || invocation.native_run_id.is_some()
        || invocation.native_session_id.is_some() || invocation.delegation.is_some()
        || context.binding.task.world != invocation.world
        || context.binding.branch.world != invocation.world
        || invocation.task_id.as_ref() != Some(&context.binding.task.id)
        || invocation.branch_id.as_ref() != Some(&context.binding.branch.id)
        || invocation.audience != audience || invocation.request_digest != context.identity
    {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    require_context(context, impact)?;
    let bounds = match reader {
        AuthorityRead::Transaction(tx) => crate::evaluation::require_execution_binding(tx, &context.binding, now).await,
        AuthorityRead::Snapshot(snapshot) => crate::evaluation::require_execution_binding_snapshot(snapshot, &context.binding, now).await,
    }.map_err(|error| match error {
        crate::evaluation::Error::Store(error) => AuthError::Store(error),
        crate::evaluation::Error::Authorization(error) => error,
        _ => AuthorizationFailure::InvalidDelegation.into(),
    })?;
    if invocation.deadline > bounds.deadline {
        return Err(AuthorizationFailure::DeadlineExpired.into());
    }
    super::cap_expiry(until, Some(bounds.deadline));
    if context.oracle || context.recording {
        finite_grant(reader, &invocation.actor, Some(impact), now, until).await?;
    }
    Ok(())
}

impl EvaluationContext {
    /// Only this claimed step's result identities; all other resources/modes need grants.
    pub(super) fn owns_result(&self, resource: &ResourceRef, mode: &AccessMode) -> bool {
        match (resource, mode) {
            (ResourceRef::Case { id }, AccessMode::Read) => self.oracle && id == &self.binding.case_id,
            (ResourceRef::Evaluation { id }, AccessMode::Write) => self.oracle && id == &self.binding.evaluation_id,
            (ResourceRef::Case { id }, AccessMode::Write) => self.recording && id == &self.binding.case_id,
            _ => false,
        }
    }
}

pub(super) fn require_context(
    context: &EvaluationContext,
    impact: &ActualImpact,
) -> Result<(), AuthError> {
    if context.recording
        && (context.oracle
            || !impact.effects.is_empty()
            || !impact.state.is_empty()
            || !impact.source_ids.is_empty()
            || impact.access.iter().any(|access| {
                access.resources
                    != [ResourceRef::Case {
                        id: context.binding.case_id.clone(),
                    }]
                    || access.modes != [AccessMode::Write]
                    || !access.fields.is_empty()
            }))
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    if impact.effects.contains(&Effect::ExternalWrite)
        || !super::scope::permits(&context.restriction, impact)
        || (!context.oracle
            && impact.access.iter().any(|access| {
                access.resources.is_empty()
                    || access.resources.iter().any(|resource| match resource {
                        ResourceRef::Case { .. } => !context.recording,
                        ResourceRef::Task { .. }
                        | ResourceRef::TestCase { .. }
                        | ResourceRef::Suite { .. }
                        | ResourceRef::Evaluation { .. } => true,
                        _ => false,
                    })
            }))
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    Ok(())
}

async fn principals(
    tx: &WorldTransaction<'_>,
    config: &InitialEvaluation,
    now: &Timestamp,
) -> Result<
    (
        world_protocol::authorization::Actor,
        world_protocol::authorization::Actor,
    ),
    AuthError,
> {
    let mut until = now.clone();
    let execution = super::ingress::principal(
        tx,
        &config.execution.issuer,
        &config.execution.subject,
        now,
        &mut until,
    )
    .await?;
    let oracle = super::ingress::principal(
        tx,
        &config.oracle.issuer,
        &config.oracle.subject,
        now,
        &mut until,
    )
    .await?;
    if actor_id(&execution) == actor_id(&oracle) {
        return Err(AuthorizationFailure::InvalidPrincipal.into());
    }
    for actor in [&execution, &oracle] {
        require_finite_grant(tx, actor, now).await?;
    }
    Ok((execution, oracle))
}

pub(super) async fn require_finite_grant(
    tx: &WorldTransaction<'_>,
    actor: &world_protocol::authorization::Actor,
    now: &Timestamp,
) -> Result<(), AuthError> {
    let mut until = now.clone();
    finite_grant(AuthorityRead::Transaction(tx), actor, None, now, &mut until).await
}

async fn finite_grant(
    reader: AuthorityRead<'_, '_>,
    actor: &world_protocol::authorization::Actor,
    impact: Option<&ActualImpact>,
    now: &Timestamp,
    until: &mut Timestamp,
) -> Result<(), AuthError> {
    let world = reader.world();
    let rows = reader.query(
        "SELECT \"grant\",active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_grant WHERE tenant_id=$1 AND world_id=$2 AND actor_id=$3 ORDER BY grant_id FOR SHARE",
        "SELECT \"grant\",active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_grant WHERE tenant_id=$1 AND world_id=$2 AND actor_id=$3 ORDER BY grant_id",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &actor_id(actor).as_str()],
    ).await?;
    for row in rows {
        let expires = match super::active(&row, now, AuthorizationFailure::Revoked) {
            Ok(expires) => expires,
            Err(AuthError::Denied(AuthorizationFailure::Revoked)) => continue,
            Err(error) => return Err(error),
        };
        let grant: AccessGrant = super::decode(row.get("grant"))?;
        if !grant.access.is_empty()
            && grant.access.iter().all(|access| !access.modes.is_empty() && !access.resources.is_empty())
            && impact.is_none_or(|impact| impact.labels.iter().all(|label| grant.labels.contains(label))
                && impact.effects.iter().all(|effect| *effect == Effect::Pure || grant.effects.contains(effect)))
        {
            super::cap_expiry(until, expires);
            return Ok(());
        }
    }
    Err(AuthorizationFailure::InsufficientScope.into())
}

pub(super) async fn validate(
    tx: &WorldTransaction<'_>,
    config: &InitialEvaluation,
    now: &Timestamp,
) -> Result<(), AuthError> {
    validate_config(config)?;
    principals(tx, config, now).await?;
    super::policies::case_policy(tx, &config.case_access, &config.case_retention).await?;
    Ok(())
}

pub(super) fn validate_config(config: &InitialEvaluation) -> Result<(), AuthorizationFailure> {
    let valid = |value: &str| {
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
    };
    if [
        &config.execution.issuer,
        &config.execution.subject,
        &config.oracle.issuer,
        &config.oracle.subject,
    ]
    .iter()
    .any(|value| !valid(value))
        || (config.execution.issuer == config.oracle.issuer
            && config.execution.subject == config.oracle.subject)
    {
        return Err(AuthorizationFailure::InvalidPrincipal);
    }
    Ok(())
}
