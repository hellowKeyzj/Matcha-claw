use super::{AuthError, active, actor_id, bytes_digest, cap_expiry, decode, timestamp};
use crate::store::WorldTransaction;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use platform::capability::CapabilityDecisionVerifier;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use world_protocol::{
    authorization::{Actor, AuthorizationFailure, Invocation},
    ids::*,
    time::Timestamp,
};

#[derive(Clone)]
pub(crate) struct RequestBinding {
    world: WorldRef,
    pub(super) endpoint: &'static str,
    pub(super) operation: String,
    subject: String,
    digest: Digest,
}
impl RequestBinding {
    /// All metadata comes from the decoded operation and fixed route, not request claims.
    pub(crate) fn new(
        world: WorldRef,
        endpoint: &'static str,
        operation: &str,
        body: &[u8],
    ) -> Result<Self, AuthError> {
        if !matches!(
            endpoint,
            "/api/world/query" | "/api/world/command" | "/api/world/operation" | "/api/world/peer"
        ) || operation.is_empty()
            || operation.len() > 256
            || body.len() > world_protocol::api::MAX_REQUEST_BYTES
        {
            return Err(AuthorizationFailure::AudienceMismatch.into());
        }
        let subject = serde_json::to_string(&world).map_err(AuthError::Codec)?;
        Ok(Self {
            world,
            endpoint,
            operation: operation.into(),
            subject,
            digest: bytes_digest(body)?,
        })
    }
    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }
    pub(crate) fn request_digest(&self) -> &Digest {
        &self.digest
    }
}

/// No Deserialize, Serialize, or public constructor. Only trusted ingress can mint it.
#[derive(Clone)]
pub(crate) struct VerifiedInvocation {
    pub(super) invocation: Invocation,
    pub(super) issuer: String,
    pub(super) subject: String,
    pub(super) transport_actor: ActorId,
    pub(super) execution: Option<(BindingId, NativeContext)>,
    pub(super) evaluation: Option<super::evaluation::EvaluationContext>,
    pub(super) online_oracle: Option<super::online::OnlineOracleContext>,
    pub(super) investigation: Option<super::investigation::InvestigationChild>,
}
impl VerifiedInvocation {
    pub(crate) fn invocation(&self) -> &Invocation {
        &self.invocation
    }
    /// Confinement selected by the owning workflow, never a new transport/native fact.
    pub(crate) async fn bind_branch(
        &self,
        tx: &WorldTransaction<'_>,
        id: &BranchId,
    ) -> Result<Self, crate::releases::Error> {
        if tx.world() != &self.invocation.world
            || self.online_oracle.is_some()
            || self
                .invocation
                .branch_id
                .as_ref()
                .is_some_and(|current| current != id)
            || self
                .execution
                .as_ref()
                .and_then(|(_, context)| context.branch_id.as_ref())
                .is_some_and(|current| current != id)
            || self
                .evaluation
                .as_ref()
                .is_some_and(|context| &context.binding.branch.id != id)
        {
            return Err(AuthError::Denied(AuthorizationFailure::InvalidDelegation).into());
        }
        let branch = crate::releases::read_branch(tx, id)
            .await?
            .ok_or(AuthError::Denied(AuthorizationFailure::InsufficientScope))?;
        if branch.world != self.invocation.world || &branch.id != id {
            return Err(AuthError::Denied(AuthorizationFailure::InvalidDelegation).into());
        }
        let mut confined = self.clone();
        confined.invocation.branch_id = Some(id.clone());
        Ok(confined)
    }

    pub(crate) fn restart_identity(&self) -> RestartIdentity {
        RestartIdentity {
            world: self.invocation.world.clone(),
            issuer: self.issuer.clone(),
            subject: self.subject.clone(),
            actor_id: actor_id(&self.invocation.actor).clone(),
            actor_kind: super::actor_kind(&self.invocation.actor).into(),
            transport_actor: self.transport_actor.clone(),
            delegation: self.invocation.delegation.clone(),
            execution: self.execution.clone(),
            evaluation: self
                .evaluation
                .as_ref()
                .map(|context| context.identity.clone()),
            online_oracle: self
                .online_oracle
                .as_ref()
                .map(|context| context.identity.clone()),
            investigation: self.investigation.as_ref().map(|child| child.identity().clone()),
            branch_id: self.invocation.branch_id.clone(),
        }
    }
}
impl std::fmt::Debug for VerifiedInvocation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VerifiedInvocation")
    }
}

/// Durable identity binding for load/handoff only. It is not renewable authority and
/// cannot be converted into an invocation without a new verified transport/native call.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RestartIdentity {
    world: WorldRef,
    issuer: String,
    subject: String,
    actor_id: ActorId,
    actor_kind: String,
    transport_actor: ActorId,
    delegation: Option<DelegationId>,
    execution: Option<(BindingId, NativeContext)>,
    evaluation: Option<Digest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    online_oracle: Option<Digest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    investigation: Option<BindingId>,
    branch_id: Option<BranchId>,
}
impl std::fmt::Debug for RestartIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RestartIdentity")
    }
}
impl RestartIdentity {
    pub(crate) fn require_resume(&self, fresh: &VerifiedInvocation) -> Result<(), AuthError> {
        if self != &fresh.restart_identity() {
            return Err(AuthorizationFailure::InvalidPrincipal.into());
        }
        Ok(())
    }
}

/// Host injects its existing shared verifier. No second verifier/replay map is created.
pub(crate) struct ServiceIngress {
    issuer: String,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
}
impl ServiceIngress {
    pub(crate) fn new(issuer: String, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> Self {
        Self { issuer, verifier }
    }
    /// Host-private directory lookup only; current principal/grants/policies are still checked.
    pub(crate) async fn desktop_directory(
        &self, _root: &super::AuthorityRoot, tx: &WorldTransaction<'_>, now: &Timestamp,
    ) -> Result<VerifiedInvocation, AuthError> {
        let mut deadline = timestamp(now.unix_millis().checked_add(30_000).ok_or(AuthorizationFailure::DeadlineExpired)?)?;
        let subject = "electron-main-local";
        let actor = principal(tx, &self.issuer, subject, now, &mut deadline).await?;
        let request_digest = super::digest(&("world.storage.directory.v1", tx.world()))?;
        Ok(VerifiedInvocation {
            invocation: Invocation {
                id: InvocationId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
                world: tx.world().clone(), actor: actor.clone(), delegation: None, agent_id: None,
                task_id: None, branch_id: None, native_session_id: None, native_run_id: None,
                audience: "world.storage.directory".into(), request_digest, deadline,
                replay_id: RequestId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
            },
            issuer: self.issuer.clone(), subject: subject.into(), transport_actor: actor_id(&actor).clone(),
            execution: None, evaluation: None, online_oracle: None, investigation: None,
        })
    }

    pub(crate) async fn authenticate(
        &self,
        tx: &WorldTransaction<'_>,
        token: &str,
        binding: RequestBinding,
        now: &Timestamp,
    ) -> Result<VerifiedInvocation, AuthError> {
        if tx.world() != &binding.world || token.len() > 16_384 {
            return Err(AuthorizationFailure::InvalidPrincipal.into());
        }
        let millis =
            u64::try_from(now.unix_millis()).map_err(|_| AuthorizationFailure::DeadlineExpired)?;
        // Hold the common transport replay lock only for signature verification, never SQL.
        let decision = self
            .verifier
            .lock()
            .await
            .verify(
                token,
                millis,
                binding.endpoint,
                "world",
                &binding.operation,
                &binding.subject,
            )
            .map_err(|_| AuthorizationFailure::InvalidPrincipal)?;
        if decision.revision() != binding.digest.as_str() {
            return Err(AuthorizationFailure::RequestDigestMismatch.into());
        }
        // This is the SAME signed payload just verified above. Never parse an unverified
        // deadline out of a business request or invent one from the verification result.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SignedExpiry {
            expires_at: u64,
        }
        let payload = token
            .split('.')
            .nth(2)
            .ok_or(AuthorizationFailure::InvalidPrincipal)?;
        let wire: SignedExpiry = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| AuthorizationFailure::InvalidPrincipal)?,
        )
        .map_err(|_| AuthorizationFailure::InvalidPrincipal)?;
        let mut deadline = timestamp(
            i64::try_from(wire.expires_at).map_err(|_| AuthorizationFailure::DeadlineExpired)?,
        )?;
        let actor = principal(tx, &self.issuer, decision.principal(), now, &mut deadline).await?;
        let replay_id = RequestId::try_new(decision.correlation())
            .map_err(|_| AuthorizationFailure::InvalidPrincipal)?;
        redeem(tx, &self.issuer, &replay_id, &binding.digest, &deadline).await?;
        let invocation = Invocation {
            id: InvocationId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
            world: binding.world,
            actor: actor.clone(),
            delegation: None,
            agent_id: None,
            task_id: None,
            branch_id: None,
            native_session_id: None,
            native_run_id: None,
            audience: binding.endpoint.into(),
            request_digest: binding.digest,
            deadline,
            replay_id,
        };
        Ok(VerifiedInvocation {
            invocation,
            issuer: self.issuer.clone(),
            subject: decision.principal().into(),
            transport_actor: actor_id(&actor).clone(),
            execution: None,
            evaluation: None,
            online_oracle: None,
            investigation: None,
        })
    }
}

/// Facts supplied by the actual native producer, compared with its durable mapping.
/// Optional fields stay absent for entry points which do not have those facts.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeContext {
    pub endpoint_id: NativeEndpointId,
    pub agent_id: Option<AgentId>,
    pub task_id: Option<TaskId>,
    pub attempt_id: Option<RequestId>,
    pub native_session_id: Option<NativeSessionId>,
    pub native_run_id: Option<NativeRunId>,
    pub tool_call_id: Option<ToolCallId>,
    pub delegation_id: Option<DelegationId>,
    pub branch_id: Option<BranchId>,
    pub evaluation: bool,
    pub native_facts: Option<serde_json::Value>,
}

pub(super) async fn authenticate_native(
    tx: &WorldTransaction<'_>,
    issuer: &str,
    subject: &str,
    execution_id: &BindingId,
    context: NativeContext,
    binding: RequestBinding,
    replay_id: RequestId,
    producer_deadline: Timestamp,
    now: &Timestamp,
) -> Result<VerifiedInvocation, AuthError> {
    if tx.world() != &binding.world || producer_deadline <= *now {
        return Err(AuthorizationFailure::DeadlineExpired.into());
    }
    let mut deadline = producer_deadline;
    let transport = principal(tx, issuer, subject, now, &mut deadline).await?;
    let row = tx.query_opt(
            "SELECT actor_id,agent_id,task_id,context,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_execution WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 AND issuer=$4 AND subject=$5 FOR SHARE",
            &[&binding.world.tenant_id.as_str(), &binding.world.world_id.as_str(), &execution_id.as_str(), &issuer, &subject],
        ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
    cap_expiry(
        &mut deadline,
        active(&row, now, AuthorizationFailure::Revoked)?,
    );
    let recorded: NativeContext = decode(row.get("context"))?;
    if recorded != context
        || row.get::<_, Option<String>>("agent_id").as_deref()
            != context.agent_id.as_ref().map(AgentId::as_str)
        || row.get::<_, Option<String>>("task_id").as_deref()
            != context.task_id.as_ref().map(TaskId::as_str)
    {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    let represented = ActorId::try_new(row.get::<_, String>("actor_id"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    let actor = if &represented == actor_id(&transport) {
        transport.clone()
    } else {
        if context.delegation_id.is_none() {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        represented_actor(tx, &represented, now, &mut deadline).await?
    };
    redeem(tx, issuer, &replay_id, &binding.digest, &deadline).await?;
    Ok(VerifiedInvocation {
        invocation: Invocation {
            id: InvocationId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
            world: binding.world,
            actor,
            delegation: context.delegation_id.clone(),
            agent_id: context.agent_id.clone(),
            task_id: context.task_id.clone(),
            branch_id: context.branch_id.clone(),
            native_session_id: context.native_session_id.clone(),
            native_run_id: context.native_run_id.clone(),
            audience: binding.endpoint.into(),
            request_digest: binding.digest,
            deadline,
            replay_id,
        },
        issuer: issuer.into(),
        subject: subject.into(),
        transport_actor: actor_id(&transport).clone(),
        execution: Some((execution_id.clone(), context)),
        evaluation: None,
        online_oracle: None,
        investigation: None,
    })
}

pub(super) async fn principal(
    tx: &WorldTransaction<'_>,
    issuer: &str,
    subject: &str,
    now: &Timestamp,
    deadline: &mut Timestamp,
) -> Result<Actor, AuthError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT actor_id,actor_kind,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_principal WHERE tenant_id=$1 AND world_id=$2 AND issuer=$3 AND subject=$4 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &issuer, &subject],
    ).await?.ok_or(AuthorizationFailure::InvalidPrincipal)?;
    cap_expiry(deadline, active(&row, now, AuthorizationFailure::Revoked)?);
    actor_from_row(&row)
}
pub(super) async fn represented_actor(
    tx: &WorldTransaction<'_>,
    id: &ActorId,
    now: &Timestamp,
    deadline: &mut Timestamp,
) -> Result<Actor, AuthError> {
    let world = tx.world();
    let rows = tx.query(
        "SELECT actor_id,actor_kind,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_principal WHERE tenant_id=$1 AND world_id=$2 AND actor_id=$3 ORDER BY issuer,subject FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?;
    for row in rows {
        match active(&row, now, AuthorizationFailure::Revoked) {
            Ok(until) => {
                cap_expiry(deadline, until);
                return actor_from_row(&row);
            }
            Err(AuthError::Denied(AuthorizationFailure::Revoked)) => {}
            Err(error) => return Err(error),
        }
    }
    Err(AuthorizationFailure::Revoked.into())
}
fn actor_from_row(row: &tokio_postgres::Row) -> Result<Actor, AuthError> {
    let id = ActorId::try_new(row.get::<_, String>("actor_id"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    match row.get::<_, String>("actor_kind").as_str() {
        "human" => Ok(Actor::Human { id }),
        "service" => Ok(Actor::Service { id }),
        _ => Err(AuthorizationFailure::InternalFault.into()),
    }
}
async fn redeem(
    tx: &WorldTransaction<'_>,
    issuer: &str,
    replay: &RequestId,
    digest: &Digest,
    deadline: &Timestamp,
) -> Result<(), AuthError> {
    let world = tx.world();
    let inserted = tx.execute(
        "INSERT INTO world_auth_replay(tenant_id,world_id,issuer,request_id,input_digest,expires_at) VALUES($1,$2,$3,$4,$5,$6::text::timestamptz) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &issuer, &replay.as_str(), &digest.as_str(), &deadline.as_str()],
    ).await?;
    if inserted != 1 {
        return Err(AuthorizationFailure::Replay.into());
    }
    Ok(())
}
