use std::{error::Error, fmt, sync::Arc};

use serde::Serialize;
use world_protocol::{
    authorization::{ActualImpact, AuthorizationFailure},
    ids::*,
    time::Timestamp,
};

use super::{
    AccessGrant, AuthError, AuthorityRoot, NativeContext, RequestBinding, VerifiedInvocation,
    active, actor_id, cap_expiry, decode, digest, encode,
};
use crate::store::WorldTransaction;

/// Only actual runtime verifiers receive the root-bound issuer from Host composition.
pub trait NativeVerifier: Send + Sync {
    fn verify(
        &self,
        raw_proof: &[u8],
        raw_request: &[u8],
        route: &str,
        now_ms: u64,
    ) -> Result<NativeProof, NativeVerificationError>;
}

#[derive(Clone)]
pub struct NativeVerificationError {
    reason: AuthorizationFailure,
    causes: Vec<Arc<dyn Error + Send + Sync>>,
}
impl NativeVerificationError {
    pub fn new(reason: AuthorizationFailure, cause: impl Error + Send + Sync + 'static) -> Self {
        Self {
            reason,
            causes: vec![Arc::new(cause)],
        }
    }
    pub fn reason(&self) -> &AuthorizationFailure {
        &self.reason
    }
    pub fn causes(&self) -> impl Iterator<Item = &(dyn Error + Send + Sync + 'static)> {
        self.causes.iter().map(Arc::as_ref)
    }
    pub(super) fn rejected(reason: AuthorizationFailure) -> Self {
        Self {
            reason,
            causes: Vec::new(),
        }
    }
}
impl fmt::Debug for NativeVerificationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeVerificationError")
            .field("reason", &self.reason)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for NativeVerificationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("world.native_proof_rejected")
    }
}
impl Error for NativeVerificationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.causes
            .first()
            .map(|cause| cause.as_ref() as &(dyn Error + 'static))
    }
}

/// Typed native facts, not deserializable authority or a second runtime permission model.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFacts {
    pub endpoint_id: NativeEndpointId,
    pub agent_id: AgentId,
    pub native_session_id: Option<NativeSessionId>,
    pub native_run_id: NativeRunId,
    pub tool_call_id: ToolCallId,
    pub workspace: String,
    pub session_key: Option<String>,
    pub sandboxed: bool,
    pub requester: Option<NativeRequester>,
    pub task_id: Option<TaskId>,
    pub attempt_id: Option<RequestId>,
    pub delegation_id: Option<DelegationId>,
    pub branch_id: Option<BranchId>,
    pub evaluation: bool,
    pub world_investigation: Option<NativeWorldInvestigation>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorldInvestigation {
    pub binding_id: BindingId,
    pub accepted_request_id: String,
    pub accepted_run_id: String,
    pub accepted_input_id: String,
    pub content_budget_digest: Digest,
    pub native_attempt_id: String,
    pub native_instance_id: String,
}

impl NativeWorldInvestigation {
    pub(crate) fn validate(&self) -> Result<(), AuthError> {
        if [&self.accepted_request_id, &self.accepted_run_id, &self.accepted_input_id,
            &self.native_attempt_id, &self.native_instance_id].iter().any(|value| !bounded(value, 256)) {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRequester {
    pub channel: Option<String>,
    pub account_id: Option<String>,
    pub sender_id: Option<String>,
    pub sender_is_owner: Option<bool>,
    pub role_ids: Option<Vec<String>>,
}

/// Constructed only inside the registered native verifier after checking its real proof.
pub struct NativeClaims {
    pub runtime_instance: String,
    pub audience: String,
    pub endpoint: String,
    pub operation: String,
    pub request_digest: Digest,
    pub nonce: RequestId,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub facts: NativeFacts,
}

/// No Clone, Deserialize, or constructor. It conveys facts, never a grant or actor.
pub struct NativeProof {
    root: Arc<AuthorityRoot>,
    issuer: String,
    claims: NativeClaims,
}
impl NativeProof {
    pub fn facts(&self) -> &NativeFacts {
        &self.claims.facts
    }
    pub(super) fn runtime_instance(&self) -> &str {
        &self.claims.runtime_instance
    }
}

pub struct NativeProofIssuer {
    root: Arc<AuthorityRoot>,
    issuer: String,
    runtime_instance: String,
    audience: String,
}
impl AuthorityRoot {
    pub fn native_proof_issuer(
        self: &Arc<Self>,
        issuer: String,
        runtime_instance: String,
        audience: String,
    ) -> Result<NativeProofIssuer, NativeVerificationError> {
        if !bounded(&issuer, 256) || !bounded(&runtime_instance, 256) || !bounded(&audience, 256) {
            return Err(NativeVerificationError::rejected(
                AuthorizationFailure::InvalidPrincipal,
            ));
        }
        Ok(NativeProofIssuer {
            root: self.clone(),
            issuer,
            runtime_instance,
            audience,
        })
    }
}
impl NativeProofIssuer {
    pub fn issue(&self, claims: NativeClaims) -> Result<NativeProof, NativeVerificationError> {
        if claims.runtime_instance != self.runtime_instance || claims.audience != self.audience {
            return Err(NativeVerificationError::rejected(
                AuthorizationFailure::AudienceMismatch,
            ));
        }
        validate(&claims)?;
        Ok(NativeProof {
            root: self.root.clone(),
            issuer: self.issuer.clone(),
            claims,
        })
    }
}

/// A fixed composition-time list of actual peer verifiers, not a plugin registry.
pub(crate) struct NativeIngress {
    root: Arc<AuthorityRoot>,
    verifiers: Vec<Result<Arc<dyn NativeVerifier>, NativeVerificationError>>,
}
impl NativeIngress {
    pub(crate) fn new(
        root: Arc<AuthorityRoot>,
        verifiers: Vec<Result<Arc<dyn NativeVerifier>, NativeVerificationError>>,
    ) -> Self {
        Self { root, verifiers }
    }
    pub(crate) fn verify(
        &self,
        raw_proof: &[u8],
        raw_request: &[u8],
        route: &str,
        now: &Timestamp,
    ) -> Result<NativeProof, NativeVerificationError> {
        let now_ms = u64::try_from(now.unix_millis()).map_err(|_| {
            NativeVerificationError::rejected(AuthorizationFailure::DeadlineExpired)
        })?;
        if route != world_protocol::api::PEER_ENDPOINT
            || raw_proof.len() > 32_768
            || raw_request.len() > world_protocol::api::MAX_REQUEST_BYTES
        {
            return Err(NativeVerificationError::rejected(
                AuthorizationFailure::AudienceMismatch,
            ));
        }
        let expected = super::bytes_digest(raw_request)
            .map_err(|_| NativeVerificationError::rejected(AuthorizationFailure::InternalFault))?;
        let mut rejected =
            NativeVerificationError::rejected(AuthorizationFailure::InvalidPrincipal);
        for verifier in &self.verifiers {
            let result = match verifier {
                Ok(verifier) => verifier
                    .verify(raw_proof, raw_request, route, now_ms)
                    .and_then(|proof| {
                        self.require_proof(&proof, route, &expected, now_ms)?;
                        Ok(proof)
                    }),
                Err(error) => Err(error.clone()),
            };
            match result {
                Ok(proof) => return Ok(proof),
                Err(error) => {
                    rejected.reason = error.reason.clone();
                    rejected.causes.push(Arc::new(error));
                }
            }
        }
        Err(rejected)
    }

    fn require_proof(
        &self,
        proof: &NativeProof,
        route: &str,
        expected: &Digest,
        now_ms: u64,
    ) -> Result<(), NativeVerificationError> {
        if !Arc::ptr_eq(&self.root, &proof.root) {
            return Err(NativeVerificationError::rejected(
                AuthorizationFailure::InvalidPrincipal,
            ));
        }
        validate(&proof.claims)?;
        if proof.claims.endpoint != route {
            return Err(NativeVerificationError::rejected(
                AuthorizationFailure::AudienceMismatch,
            ));
        }
        if &proof.claims.request_digest != expected {
            return Err(NativeVerificationError::rejected(
                AuthorizationFailure::RequestDigestMismatch,
            ));
        }
        if proof.claims.issued_at_ms > now_ms || proof.claims.expires_at_ms <= now_ms {
            return Err(NativeVerificationError::rejected(
                AuthorizationFailure::DeadlineExpired,
            ));
        }
        Ok(())
    }

    /// Current source identity for an owned-intent lookup in the same transaction. No nonce is redeemed.
    pub(crate) async fn current_actor(
        &self,
        tx: &WorldTransaction<'_>,
        proof: &NativeProof,
        binding: &RequestBinding,
        now: &Timestamp,
    ) -> Result<world_protocol::authorization::Actor, AuthError> {
        let now_ms = u64::try_from(now.unix_millis())
            .map_err(|_| AuthorizationFailure::DeadlineExpired)?;
        self.require_proof(proof, binding.endpoint, binding.request_digest(), now_ms)
            .map_err(|error| AuthError::Denied(error.reason))?;
        if tx.world() != binding.world() || binding.operation != proof.claims.operation {
            return Err(AuthorizationFailure::AudienceMismatch.into());
        }
        super::authority::lock(tx).await?;
        let mut deadline = super::timestamp(i64::try_from(proof.claims.expires_at_ms)
            .map_err(|_| AuthorizationFailure::DeadlineExpired)?)?;
        native_actor(tx, proof, now, &mut deadline).await
    }

    /// Resolve only current source grant candidates before recording a discovery restriction.
    /// This authenticates no request and redeems no nonce; normal authenticate still follows.
    pub(crate) async fn discovery_impact(
        &self,
        tx: &WorldTransaction<'_>,
        proof: &NativeProof,
        investigation: Option<Arc<super::InvestigationBinding>>,
        now: &Timestamp,
    ) -> Result<ActualImpact, AuthError> {
        let now_ms =
            u64::try_from(now.unix_millis()).map_err(|_| AuthorizationFailure::DeadlineExpired)?;
        self.require_proof(
            proof,
            world_protocol::api::PEER_ENDPOINT,
            &proof.claims.request_digest,
            now_ms,
        )
        .map_err(|error| AuthError::Denied(error.reason))?;
        if proof.claims.operation != "world.discover" {
            return Err(AuthorizationFailure::AudienceMismatch.into());
        }
        super::authority::lock(tx).await?;
        let mut deadline = super::timestamp(
            i64::try_from(proof.claims.expires_at_ms)
                .map_err(|_| AuthorizationFailure::DeadlineExpired)?,
        )?;
        let actor = native_actor(tx, proof, now, &mut deadline).await?;
        let mut candidates = super::policies::actor_candidates(tx, actor_id(&actor), now).await?;
        if let Some(id) = &proof.claims.facts.delegation_id {
            let world = tx.world();
            let row = tx.query_opt(
                "SELECT restriction FROM world_auth_delegation WHERE tenant_id=$1 AND world_id=$2 AND delegation_id=$3 FOR SHARE",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
            ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
            candidates =
                super::policies::restrict_candidates(candidates, &decode(row.get("restriction"))?);
        }
        match (proof.facts().world_investigation.as_ref(), investigation) {
            (None, None) => {},
            (Some(_), Some(binding)) => {
                let child = binding.child(&self.root, proof)?;
                binding.check_current(tx, now).await?;
                candidates = child.restrict_candidates(candidates);
            },
            _ => return Err(AuthorizationFailure::InvalidDelegation.into()),
        }
        let mut access = Vec::new();
        let mut labels = Vec::new();
        for candidate in candidates {
            access.extend(candidate.access);
            labels.extend(candidate.labels);
        }
        super::actual_impact(access, Vec::new(), labels, Vec::new(), Vec::new())
    }

    /// The owner resolves impact in this same transaction. This records only a restriction;
    /// the current principal, delegation, grants, policies and source/native rights still apply.
    pub(crate) async fn authenticate(
        &self,
        tx: &WorldTransaction<'_>,
        proof: &NativeProof,
        binding: RequestBinding,
        impact: &ActualImpact,
        investigation: Option<Arc<super::InvestigationBinding>>,
        now: &Timestamp,
    ) -> Result<VerifiedInvocation, AuthError> {
        let now_ms =
            u64::try_from(now.unix_millis()).map_err(|_| AuthorizationFailure::DeadlineExpired)?;
        self.require_proof(proof, binding.endpoint, binding.request_digest(), now_ms)
            .map_err(|error| AuthError::Denied(error.reason))?;
        if tx.world() != binding.world() || binding.operation != proof.claims.operation {
            return Err(AuthorizationFailure::AudienceMismatch.into());
        }
        super::scope::validate_impact(impact)?;
        let facts = &proof.claims.facts;
        let child = match (facts.world_investigation.as_ref(), investigation) {
            (None, None) => None,
            (Some(_), Some(binding)) => {
                let child = binding.child(&self.root, proof)?;
                child.current(super::read::AuthorityRead::Transaction(tx), impact, now).await?;
                Some(child)
            },
            _ => return Err(AuthorizationFailure::InvalidDelegation.into()),
        };
        let subject = facts.agent_id.as_str();
        let mut deadline = super::timestamp(
            i64::try_from(proof.claims.expires_at_ms)
                .map_err(|_| AuthorizationFailure::DeadlineExpired)?,
        )?;
        super::authority::lock(tx).await?;
        let actor = native_actor(tx, proof, now, &mut deadline).await?;
        let identity = digest(&(
            &proof.issuer,
            &proof.claims.runtime_instance,
            &facts.agent_id,
            &facts.native_run_id,
            &facts.tool_call_id,
        ))?;
        let execution_id = BindingId::try_new(identity.as_str())
            .map_err(|_| AuthorizationFailure::InternalFault)?;
        let context = NativeContext {
            endpoint_id: facts.endpoint_id.clone(),
            agent_id: Some(facts.agent_id.clone()),
            task_id: facts.task_id.clone(),
            attempt_id: facts.attempt_id.clone(),
            native_session_id: facts.native_session_id.clone(),
            native_run_id: Some(facts.native_run_id.clone()),
            tool_call_id: Some(facts.tool_call_id.clone()),
            delegation_id: facts.delegation_id.clone(),
            branch_id: facts.branch_id.clone(),
            evaluation: facts.evaluation,
            native_facts: Some(encode(&(
                &proof.claims.runtime_instance,
                &proof.claims.audience,
                &proof.claims.endpoint,
                &proof.claims.operation,
                &proof.claims.request_digest,
                facts,
            ))?),
        };
        let restriction = AccessGrant {
            access: impact.access.clone(),
            labels: impact.labels.clone(),
            effects: impact.effects.clone(),
        };
        let world = tx.world();
        let row = tx.query_opt(
            "SELECT issuer,subject,actor_id,agent_id,task_id,context,restriction,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_execution WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &execution_id.as_str()],
        ).await?;
        if let Some(row) = row {
            let current: NativeContext = decode(row.get("context"))?;
            let current_restriction: AccessGrant = decode(row.get("restriction"))?;
            if row.get::<_, String>("issuer") != proof.issuer
                || row.get::<_, String>("subject") != subject
                || row.get::<_, String>("actor_id") != actor_id(&actor).as_str()
                || row.get::<_, Option<String>>("agent_id").as_deref() != Some(subject)
                || row.get::<_, Option<String>>("task_id").as_deref()
                    != facts.task_id.as_ref().map(TaskId::as_str)
                || current != context
                || current_restriction != restriction
            {
                return Err(AuthorizationFailure::InvalidDelegation.into());
            }
            cap_expiry(
                &mut deadline,
                active(&row, now, AuthorizationFailure::Revoked)?,
            );
        } else {
            self.root
                .execution(
                    tx,
                    &execution_id,
                    &proof.issuer,
                    subject,
                    actor_id(&actor),
                    &context,
                    &restriction,
                    &deadline,
                )
                .await?;
        }
        let mut invocation = super::ingress::authenticate_native(
            tx,
            &proof.issuer,
            subject,
            &execution_id,
            context,
            binding,
            proof.claims.nonce.clone(),
            deadline,
            now,
        )
        .await?;
        invocation.investigation = child;
        Ok(invocation)
    }
}

async fn native_actor(
    tx: &WorldTransaction<'_>,
    proof: &NativeProof,
    now: &Timestamp,
    deadline: &mut Timestamp,
) -> Result<world_protocol::authorization::Actor, AuthError> {
    let transport = super::ingress::principal(
        tx,
        &proof.issuer,
        proof.claims.facts.agent_id.as_str(),
        now,
        deadline,
    )
    .await?;
    let Some(id) = &proof.claims.facts.delegation_id else {
        return Ok(transport);
    };
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT actor_id,delegate_id,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_delegation WHERE tenant_id=$1 AND world_id=$2 AND delegation_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
    cap_expiry(
        deadline,
        active(&row, now, AuthorizationFailure::InvalidDelegation)?,
    );
    if row.get::<_, String>("delegate_id") != actor_id(&transport).as_str() {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    let represented = ActorId::try_new(row.get::<_, String>("actor_id"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    super::ingress::represented_actor(tx, &represented, now, deadline).await
}

fn validate(claims: &NativeClaims) -> Result<(), NativeVerificationError> {
    let failure = |reason| NativeVerificationError::rejected(reason);
    if !bounded(&claims.runtime_instance, 256)
        || !bounded(&claims.audience, 256)
        || claims.endpoint != world_protocol::api::PEER_ENDPOINT
        || !world_protocol::api::PeerOperation::OPERATIONS
            .iter()
            .any(|(_, name)| *name == claims.operation)
    {
        return Err(failure(AuthorizationFailure::AudienceMismatch));
    }
    if claims.expires_at_ms <= claims.issued_at_ms
        || claims.expires_at_ms - claims.issued_at_ms > 60_000
    {
        return Err(failure(AuthorizationFailure::DeadlineExpired));
    }
    let facts = &claims.facts;
    if let Some(investigation) = &facts.world_investigation {
        investigation.validate().map_err(|_| failure(AuthorizationFailure::InvalidDelegation))?;
    }
    if !bounded(&facts.workspace, 32_768)
        || facts
            .session_key
            .as_ref()
            .is_some_and(|key| !bounded(key, 1024))
        || (facts.task_id.is_some() && facts.attempt_id.is_none())
        || facts.requester.as_ref().is_some_and(|requester| {
            [
                &requester.channel,
                &requester.account_id,
                &requester.sender_id,
            ]
            .iter()
            .any(|value| value.as_ref().is_some_and(|value| !bounded(value, 1024)))
                || requester.role_ids.as_ref().is_some_and(|roles| {
                    roles.len() > 256 || roles.iter().any(|role| !bounded(role, 256))
                })
        })
    {
        return Err(failure(AuthorizationFailure::InvalidDelegation));
    }
    Ok(())
}
pub(super) fn bounded(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}
