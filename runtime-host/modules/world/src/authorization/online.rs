use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, ActualImpact, AuthorizationFailure, Invocation},
    bindings::ImplementationRef,
    evaluation::TestRevision,
    expression::Effect,
    ids::*,
    learning::TaskRef,
    time::Timestamp,
};

use super::{
    AccessGrant, Admission, AuthError, EvaluationAuthority, VerifiedInvocation, actor_id, admit,
    digest,
};
use crate::store::WorldTransaction;

/// Owner checkpoint identity for one online result, never a public authority claim.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OnlineOracleBinding {
    pub operation_id: OperationId,
    pub run_id: RunId,
    pub step_id: StepId,
    pub task: TaskRef,
    pub test: TestRevision,
    pub case_id: CaseId,
    pub release_id: ReleaseId,
    pub activation_lock_id: ActivationLockId,
    pub input_digest: Digest,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OnlineOracleContext {
    binding: OnlineOracleBinding,
    implementation: ImplementationRef,
    observed: Digest,
    pub(super) identity: Digest,
    restriction: AccessGrant,
}

impl EvaluationAuthority {
    pub(crate) async fn online_oracle(
        &self,
        tx: &WorldTransaction<'_>,
        binding: &OnlineOracleBinding,
        implementation: &ImplementationRef,
        observed: &Digest,
        impact: &ActualImpact,
        now: &Timestamp,
    ) -> Result<Admission, crate::evaluation::Error> {
        if binding.task.world != *self.world() {
            return Err(AuthError::from(AuthorizationFailure::InvalidPrincipal).into());
        }
        let (principal, actor) = self.oracle_identity(tx, now).await?;
        let deadline = crate::learning::require_online_oracle_binding(
            tx,
            binding,
            implementation,
            observed,
            now,
        )
        .await?;
        if &deadline <= now {
            return Err(AuthError::from(AuthorizationFailure::DeadlineExpired).into());
        }
        let request_digest = digest(&(
            "world.online.oracle.invocation.v1",
            binding,
            implementation,
            observed,
            impact,
        ))?;
        let context = OnlineOracleContext {
            binding: binding.clone(),
            implementation: implementation.clone(),
            observed: observed.clone(),
            identity: request_digest.clone(),
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
                world: self.world().clone(),
                actor: actor.clone(),
                delegation: None,
                agent_id: None,
                task_id: Some(binding.task.id.clone()),
                branch_id: None,
                native_session_id: None,
                native_run_id: None,
                audience: "world.online.oracle".into(),
                request_digest,
                deadline,
                replay_id: RequestId::try_new(tx.commit_id().as_str())
                    .map_err(|_| AuthError::from(AuthorizationFailure::InternalFault))?,
            },
            issuer: principal.issuer.clone(),
            subject: principal.subject.clone(),
            transport_actor: actor_id(&actor).clone(),
            execution: None,
            evaluation: None,
            online_oracle: Some(context),
            investigation: None,
        };
        Ok(admit(tx, &verified, impact, &[], None, now).await?)
    }

    pub(crate) async fn recheck_online_oracle(
        &self,
        tx: &WorldTransaction<'_>,
        admission: &Admission,
        binding: &OnlineOracleBinding,
        implementation: &ImplementationRef,
        observed: &Digest,
        now: &Timestamp,
    ) -> Result<(), crate::evaluation::Error> {
        let verified = admission.verified();
        let context = verified
            .online_oracle
            .as_ref()
            .ok_or_else(|| AuthError::from(AuthorizationFailure::InvalidPrincipal))?;
        let (principal, actor) = self.oracle_identity(tx, now).await?;
        if binding.task.world != *self.world()
            || context.binding != *binding
            || context.implementation != *implementation
            || context.observed != *observed
            || context.identity != admission.invocation().request_digest
            || verified.issuer != principal.issuer
            || verified.subject != principal.subject
            || admission.invocation().actor != actor
        {
            return Err(AuthError::from(AuthorizationFailure::InvalidPrincipal).into());
        }
        let deadline = crate::learning::require_online_oracle_binding(
            tx,
            binding,
            implementation,
            observed,
            now,
        )
        .await?;
        if &deadline <= now || admission.invocation().deadline > deadline {
            return Err(AuthError::from(AuthorizationFailure::DeadlineExpired).into());
        }
        super::recheck(tx, admission, now).await?;
        Ok(())
    }
}

pub(super) fn require_invocation(
    context: &OnlineOracleContext,
    invocation: &Invocation,
    impact: &ActualImpact,
) -> Result<(), AuthError> {
    if context.binding.task.world != invocation.world
        || invocation.task_id.as_ref() != Some(&context.binding.task.id)
        || invocation.branch_id.is_some()
        || invocation.agent_id.is_some()
        || invocation.native_run_id.is_some()
        || invocation.native_session_id.is_some()
        || invocation.delegation.is_some()
        || invocation.audience != "world.online.oracle"
        || invocation.request_digest != context.identity
    {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    require_context(context, impact)
}

fn require_context(context: &OnlineOracleContext, impact: &ActualImpact) -> Result<(), AuthError> {
    if !super::scope::permits(&context.restriction, impact)
        || impact
            .effects
            .iter()
            .any(|effect| !matches!(effect, Effect::Pure | Effect::SourceRead))
        || impact.access.iter().any(|access| {
            access.resources.is_empty()
                || access.modes.iter().any(|mode| {
                    !matches!(mode, AccessMode::Read | AccessMode::Execute)
                        || access.resources.iter().any(|resource| match resource {
                            ResourceRef::Task { id } => {
                                id != &context.binding.task.id || *mode != AccessMode::Read
                            }
                            ResourceRef::TestCase { id } => {
                                id != &context.binding.test.id || *mode != AccessMode::Read
                            }
                            ResourceRef::Case { id } => {
                                id != &context.binding.case_id || *mode != AccessMode::Read
                            }
                            ResourceRef::Binding { .. } => false,
                            ResourceRef::State { .. }
                            | ResourceRef::Evidence { .. }
                            | ResourceRef::Definition { .. }
                            | ResourceRef::Source { .. } => *mode != AccessMode::Read,
                            _ => true,
                        })
                })
        })
        || impact.state.iter().any(|state| {
            !impact.access.iter().any(|access| {
                access.modes.contains(&AccessMode::Read)
                    && access.resources.contains(&ResourceRef::State {
                        id: state.id.clone(),
                    })
            })
        })
        || impact.source_ids.iter().any(|source| {
            !impact.access.iter().any(|access| {
                access.modes.contains(&AccessMode::Read)
                    && access
                        .resources
                        .contains(&ResourceRef::Source { id: source.clone() })
            })
        })
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    Ok(())
}
