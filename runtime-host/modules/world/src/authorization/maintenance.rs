use std::sync::Arc;

use serde::Serialize;
use world_protocol::{
    authorization::{ActualImpact, AuthorizationFailure, Invocation},
    ids::*,
    time::Timestamp,
};

use super::{Admission, AuthError, AuthorityRoot, VerifiedInvocation, actor_id, admit, digest};
use crate::store::WorldTransaction;

/// Explicit private configuration names an existing principal, never a grant.
#[derive(Clone, Serialize)]
pub struct InitialMaintenance {
    pub issuer: String,
    pub subject: String,
}

#[derive(Clone)]
pub struct MaintenanceAuthority {
    root: Arc<AuthorityRoot>,
    world: WorldRef,
    config: InitialMaintenance,
}

/// Read preflight identity, usable for final admission only in its original transaction.
pub(crate) struct MaintenanceVerification {
    root: Arc<AuthorityRoot>,
    transaction: Arc<()>,
    verified: VerifiedInvocation,
}
impl MaintenanceVerification {
    pub(crate) fn verified(&self) -> &VerifiedInvocation {
        &self.verified
    }
}

impl AuthorityRoot {
    pub fn maintenance_authority(
        self: &Arc<Self>,
        world: WorldRef,
        config: &InitialMaintenance,
    ) -> Result<MaintenanceAuthority, AuthorizationFailure> {
        validate(config)?;
        Ok(MaintenanceAuthority {
            root: self.clone(),
            world,
            config: config.clone(),
        })
    }

    pub(crate) async fn initialize_maintenance(
        &self,
        tx: &WorldTransaction<'_>,
        config: &InitialMaintenance,
        now: &Timestamp,
    ) -> Result<(), AuthError> {
        tx.require_provision()?;
        validate(config)?;
        let mut until = now.clone();
        super::ingress::principal(tx, &config.issuer, &config.subject, now, &mut until).await?;
        Ok(())
    }
}

impl MaintenanceAuthority {
    pub fn world(&self) -> &WorldRef {
        &self.world
    }

    pub(crate) fn same_root(&self, root: &Arc<AuthorityRoot>) -> bool {
        Arc::ptr_eq(&self.root, root)
    }

    pub(crate) async fn admit(
        &self,
        tx: &WorldTransaction<'_>,
        impact: &ActualImpact,
        deadline: &Timestamp,
        now: &Timestamp,
    ) -> Result<Admission, AuthError> {
        let verified = self.verify(tx, deadline, now).await?;
        self.admit_verified(tx, verified, impact, now).await
    }

    pub(crate) async fn verify(
        &self,
        tx: &WorldTransaction<'_>,
        deadline: &Timestamp,
        now: &Timestamp,
    ) -> Result<MaintenanceVerification, AuthError> {
        if tx.world() != &self.world {
            return Err(AuthorizationFailure::InvalidPrincipal.into());
        }
        if deadline <= now {
            return Err(AuthorizationFailure::DeadlineExpired.into());
        }
        let mut deadline = deadline.clone();
        let actor = super::ingress::principal(
            tx,
            &self.config.issuer,
            &self.config.subject,
            now,
            &mut deadline,
        )
        .await?;
        let request_digest = digest(&(
            "world.maintenance.preflight.v1",
            tx.world(),
            tx.commit_id(),
            &deadline,
        ))?;
        let verified = VerifiedInvocation {
            invocation: Invocation {
                id: InvocationId::try_new(uuid::Uuid::new_v4().to_string())
                    .expect("UUID identifier"),
                world: self.world.clone(),
                actor: actor.clone(),
                delegation: None,
                agent_id: None,
                task_id: None,
                branch_id: None,
                native_session_id: None,
                native_run_id: None,
                audience: "world.maintenance".into(),
                request_digest,
                deadline,
                replay_id: RequestId::try_new(tx.commit_id().as_str())
                    .map_err(|_| AuthorizationFailure::InternalFault)?,
            },
            issuer: self.config.issuer.clone(),
            subject: self.config.subject.clone(),
            transport_actor: actor_id(&actor).clone(),
            execution: None,
            evaluation: None,
            online_oracle: None,
            investigation: None,
        };
        Ok(MaintenanceVerification {
            root: self.root.clone(),
            transaction: tx.transaction_token(),
            verified,
        })
    }

    pub(crate) async fn admit_verified(
        &self,
        tx: &WorldTransaction<'_>,
        verification: MaintenanceVerification,
        impact: &ActualImpact,
        now: &Timestamp,
    ) -> Result<Admission, AuthError> {
        if !Arc::ptr_eq(&self.root, &verification.root)
            || !Arc::ptr_eq(&tx.transaction_token(), &verification.transaction)
            || tx.world() != &self.world
            || verification.verified.invocation.world != self.world
            || verification.verified.issuer != self.config.issuer
            || verification.verified.subject != self.config.subject
            || verification.verified.invocation.replay_id.as_str() != tx.commit_id().as_str()
        {
            return Err(AuthorizationFailure::InvalidPrincipal.into());
        }
        let mut verified = verification.verified;
        verified.invocation.request_digest = digest(&(
            "world.maintenance.invocation.v1",
            tx.world(),
            tx.commit_id(),
            impact,
            &verified.invocation.deadline,
        ))?;
        // Normal admission checks the current exact scopes, modes, labels, effects and time.
        admit(tx, &verified, impact, &[], None, now).await
    }
}

fn validate(config: &InitialMaintenance) -> Result<(), AuthorizationFailure> {
    if [&config.issuer, &config.subject]
        .iter()
        .any(|value| value.is_empty() || value.len() > 256 || value.chars().any(char::is_control))
    {
        return Err(AuthorizationFailure::InvalidPrincipal);
    }
    Ok(())
}
