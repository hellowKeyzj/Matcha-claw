use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use world_protocol::ids::{
    AgentId, BindingId, Digest, NativeEndpointId, NativeRunId, NativeSessionId, RequestId, ToolCallId,
};
use zeroize::Zeroizing;

const AUDIENCE: &str = "matcha.world.matcha-agent.v1";
const MAX_PROOF_BYTES: usize = 32_768;
const MAX_LIFETIME_MS: u64 = 60_000;

pub struct Verifier {
    key: Zeroizing<Vec<u8>>,
    runtime_instance: String,
    issuer: world::NativeProofIssuer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VerificationFailure {
    Configuration,
    Size,
    Encoding,
    Signature,
    Audience,
    RuntimeInstance,
    Endpoint,
    RequestDigest,
    Lifetime,
    NativeContext,
}
impl std::fmt::Display for VerificationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Matcha Agent World execution proof rejected")
    }
}
impl std::error::Error for VerificationFailure {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedProof {
    proof: String,
    signature: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claims {
    audience: String,
    runtime_instance: String,
    endpoint: String,
    tool_name: String,
    request_digest: String,
    nonce: RequestId,
    issued_at: u64,
    expires_at: u64,
    native: NativeExecution,
}

/// LaunchSpec owns Agent/session/instance; the permission-allowed CLI call owns run/tool/workspace.
/// A query chain is not an app-server durable run, and no OpenClaw session grammar applies.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeExecution {
    agent_id: AgentId,
    session_id: NativeSessionId,
    instance_id: String,
    run_id: NativeRunId,
    tool_call_id: ToolCallId,
    workspace: String,
    sandboxed: bool,
    world_investigation: Option<InvestigationContext>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InvestigationContext {
    binding_id: BindingId,
    accepted_request_id: String,
    accepted_run_id: String,
    accepted_input_id: String,
    content_budget_digest: Digest,
    native_attempt_id: String,
    native_instance_id: String,
}
impl InvestigationContext {
    fn valid(&self) -> bool {
        [&self.accepted_request_id, &self.accepted_run_id, &self.accepted_input_id,
            &self.native_attempt_id, &self.native_instance_id]
            .into_iter().all(|value| bounded(value, 256))
    }
    fn into_native(self) -> world::NativeWorldInvestigation {
        world::NativeWorldInvestigation {
            binding_id: self.binding_id,
            accepted_request_id: self.accepted_request_id,
            accepted_run_id: self.accepted_run_id,
            accepted_input_id: self.accepted_input_id,
            content_budget_digest: self.content_budget_digest,
            native_attempt_id: self.native_attempt_id,
            native_instance_id: self.native_instance_id,
        }
    }
}

impl Verifier {
    pub fn new(
        key: Zeroizing<Vec<u8>>,
        runtime_instance: String,
        issuer: world::NativeProofIssuer,
    ) -> Result<Self, VerificationFailure> {
        if key.len() != 32 || !bounded(&runtime_instance, 256) {
            return Err(VerificationFailure::Configuration);
        }
        Ok(Self {
            key,
            runtime_instance,
            issuer,
        })
    }

    fn claims(
        &self,
        raw_proof: &[u8],
        raw_request: &[u8],
        route: &str,
        now_ms: u64,
    ) -> Result<(Claims, String), VerificationFailure> {
        if raw_proof.len() > MAX_PROOF_BYTES
            || raw_request.len() > world_protocol::api::MAX_REQUEST_BYTES
        {
            return Err(VerificationFailure::Size);
        }
        let signed: SignedProof = world_protocol::wire::decode(raw_proof, MAX_PROOF_BYTES)
            .map_err(|_| VerificationFailure::Encoding)?;
        let proof = URL_SAFE_NO_PAD
            .decode(signed.proof)
            .map_err(|_| VerificationFailure::Encoding)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signed.signature)
            .map_err(|_| VerificationFailure::Encoding)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key)
            .map_err(|_| VerificationFailure::Configuration)?;
        mac.update(&proof);
        mac.verify_slice(&signature)
            .map_err(|_| VerificationFailure::Signature)?;
        let claims: Claims = world_protocol::wire::decode(&proof, MAX_PROOF_BYTES)
            .map_err(|_| VerificationFailure::Encoding)?;
        if claims.audience != AUDIENCE {
            return Err(VerificationFailure::Audience);
        }
        if claims.runtime_instance != self.runtime_instance {
            return Err(VerificationFailure::RuntimeInstance);
        }
        if claims.endpoint != route || route != world_protocol::api::PEER_ENDPOINT {
            return Err(VerificationFailure::Endpoint);
        }
        if claims.request_digest != format!("sha256:{:x}", Sha256::digest(raw_request)) {
            return Err(VerificationFailure::RequestDigest);
        }
        let request: world_protocol::api::PeerRequest =
            world_protocol::wire::decode(raw_request, world_protocol::api::MAX_REQUEST_BYTES)
                .map_err(|_| VerificationFailure::Encoding)?;
        if !tool_operation(&claims.tool_name, &request.operation) {
            return Err(VerificationFailure::Endpoint);
        }
        if claims.issued_at > now_ms
            || claims.expires_at <= now_ms
            || claims.expires_at <= claims.issued_at
            || claims.expires_at - claims.issued_at > MAX_LIFETIME_MS
        {
            return Err(VerificationFailure::Lifetime);
        }
        let native = &claims.native;
        if uuid::Uuid::parse_str(native.session_id.as_str()).is_err()
            || uuid::Uuid::parse_str(&native.instance_id).is_err()
            || uuid::Uuid::parse_str(native.run_id.as_str()).is_err()
            || !bounded(&native.workspace, 32_768)
            || !std::path::Path::new(&native.workspace).is_absolute()
            // CLI shell sandboxing does not sandbox this native World transport.
            || native.sandboxed
            || native.world_investigation.as_ref().is_some_and(|investigation| {
                !investigation.valid() || investigation.native_instance_id != native.instance_id
            })
        {
            return Err(VerificationFailure::NativeContext);
        }
        Ok((claims, request.operation.operation_name().to_owned()))
    }
}

impl world::NativeVerifier for Verifier {
    fn verify(
        &self,
        raw_proof: &[u8],
        raw_request: &[u8],
        route: &str,
        now_ms: u64,
    ) -> Result<world::NativeProof, world::NativeVerificationError> {
        use world_protocol::authorization::AuthorizationFailure;
        let rejected = |error| {
            let reason = match error {
                VerificationFailure::Audience
                | VerificationFailure::RuntimeInstance
                | VerificationFailure::Endpoint => AuthorizationFailure::AudienceMismatch,
                VerificationFailure::RequestDigest => AuthorizationFailure::RequestDigestMismatch,
                VerificationFailure::Lifetime => AuthorizationFailure::DeadlineExpired,
                VerificationFailure::NativeContext => AuthorizationFailure::InvalidDelegation,
                _ => AuthorizationFailure::InvalidPrincipal,
            };
            world::NativeVerificationError::new(reason, error)
        };
        let (claims, operation) = self
            .claims(raw_proof, raw_request, route, now_ms)
            .map_err(rejected)?;
        let native = claims.native;
        self.issuer.issue(world::NativeClaims {
            runtime_instance: claims.runtime_instance,
            audience: claims.audience,
            endpoint: claims.endpoint,
            operation,
            request_digest: Digest::try_new(claims.request_digest)
                .map_err(|_| rejected(VerificationFailure::RequestDigest))?,
            nonce: claims.nonce,
            issued_at_ms: claims.issued_at,
            expires_at_ms: claims.expires_at,
            facts: world::NativeFacts {
                endpoint_id: NativeEndpointId::try_new("matcha-agent")
                    .expect("fixed native endpoint"),
                agent_id: native.agent_id,
                native_session_id: Some(native.session_id),
                native_run_id: native.run_id,
                tool_call_id: native.tool_call_id,
                workspace: native.workspace,
                session_key: None,
                sandboxed: false,
                requester: None,
                task_id: None,
                attempt_id: None,
                delegation_id: None,
                branch_id: None,
                evaluation: false,
                world_investigation: native.world_investigation.map(InvestigationContext::into_native),
            },
        })
    }
}
fn bounded(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}
fn tool_operation(tool: &str, operation: &world_protocol::api::PeerOperation) -> bool {
    use world_protocol::api::PeerOperation;
    matches!(
        (tool, operation),
        ("world_discover", PeerOperation::Discover(_))
            | ("world_query", PeerOperation::Query(_))
            | ("world_explain", PeerOperation::Explain(_))
            | ("world_action_propose", PeerOperation::ActionPropose(_))
            | ("world_action_submit", PeerOperation::ActionSubmit(_))
            | ("world_action_status", PeerOperation::ActionStatus(_))
            | ("world_observe", PeerOperation::Observe(_))
            | ("world_change_propose", PeerOperation::ChangePropose(_))
            | ("world_branch_test", PeerOperation::BranchTest(_))
    )
}
