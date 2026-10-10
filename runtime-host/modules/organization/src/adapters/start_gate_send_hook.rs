use std::sync::Arc;

use platform::trace::{identifier_hash, session_trace};
use runtime_directory::RuntimeDriverIdentity;
use serde_json::json;

use crate::{
    EndpointSessionId, ManagedAgentReference, OrganizationHandle,
    RoleSessionIdentityResolver, RuntimeEndpointReference, StartGateRuntimeBindingLookup,
};

#[derive(Clone)]
pub struct StartGateSendHook {
    organization: OrganizationHandle,
    resolver: Arc<dyn RoleSessionIdentityResolver>,
}

impl StartGateSendHook {
    pub fn new(
        organization: OrganizationHandle,
        resolver: Arc<dyn RoleSessionIdentityResolver>,
    ) -> Self {
        Self {
            organization,
            resolver,
        }
    }

    pub async fn prepare(
        &self,
        request: StartGateSendRequest,
    ) -> Result<Option<PreparedStartGateSend>, ()> {
        prepare_start_gate_send(
            self.organization.clone(),
            Arc::clone(&self.resolver),
            request,
        )
        .await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartGateNativeEndpoint {
    OpenClawLocal,
    MatchaAgentLocal,
    Unsupported,
}

pub struct StartGateSendRequest {
    endpoint: StartGateNativeEndpoint,
    session_key: String,
    agent_id: String,
    endpoint_session_id: Option<String>,
    has_delivery_context: bool,
}

impl StartGateSendRequest {
    pub fn new(
        endpoint: StartGateNativeEndpoint,
        session_key: String,
        agent_id: String,
        endpoint_session_id: Option<String>,
        has_delivery_context: bool,
    ) -> Self {
        Self {
            endpoint,
            session_key,
            agent_id,
            endpoint_session_id,
            has_delivery_context,
        }
    }
}

pub struct PreparedStartGateSend {
    system_provenance_receipt: String,
}

impl PreparedStartGateSend {
    pub fn system_provenance_receipt(&self) -> &str {
        &self.system_provenance_receipt
    }
}

async fn prepare_start_gate_send(
    organization: OrganizationHandle,
    resolver: Arc<dyn RoleSessionIdentityResolver>,
    request: StartGateSendRequest,
) -> Result<Option<PreparedStartGateSend>, ()> {
    session_trace("runtime.start-gate.input", json!({
        "identityKind": match request.endpoint {
            StartGateNativeEndpoint::OpenClawLocal => "agent_scoped",
            StartGateNativeEndpoint::MatchaAgentLocal => "native_session",
            StartGateNativeEndpoint::Unsupported => "unsupported",
        },
        "sessionKeyHash": identifier_hash(&request.session_key),
        "endpointSessionIdHash": request.endpoint_session_id.as_deref().map(identifier_hash),
    }));
    if request.has_delivery_context {
        session_trace("runtime.start-gate.prompt", json!({
            "outcome": "skipped", "reason": "delivery_context",
        }));
        return Ok(None);
    }
    let Some(lookup) = start_gate_lookup(&request) else {
        session_trace("runtime.start-gate.prompt", json!({
            "outcome": "skipped", "reason": "unsupported_or_invalid_identity",
        }));
        return Ok(None);
    };
    let Some(plan) = organization
        .start_gate_prompt_plan(lookup, resolver)
        .await
        .map_err(|_| {
            session_trace("runtime.start-gate.prompt", json!({
                "outcome": "error", "reason": "owner_request_failed",
            }));
        })?
    else {
        return Ok(None);
    };
    let system_provenance_receipt = plan.system_provenance_receipt().to_owned();
    Ok(Some(PreparedStartGateSend {
        system_provenance_receipt,
    }))
}

fn start_gate_lookup(request: &StartGateSendRequest) -> Option<StartGateRuntimeBindingLookup> {
    let endpoint = endpoint_reference(request.endpoint)?;
    match request.endpoint {
        StartGateNativeEndpoint::OpenClawLocal => Some(StartGateRuntimeBindingLookup::AgentScoped {
            endpoint,
            agent: ManagedAgentReference::try_new(request.agent_id.clone()).ok()?,
            session_key: request.session_key.clone(),
        }),
        StartGateNativeEndpoint::MatchaAgentLocal => {
            Some(StartGateRuntimeBindingLookup::NativeSession {
                endpoint,
                endpoint_session_id: EndpointSessionId::try_new(request.endpoint_session_id.clone()?)
                    .ok()?,
            })
        }
        StartGateNativeEndpoint::Unsupported => None,
    }
}

fn endpoint_reference(endpoint: StartGateNativeEndpoint) -> Option<RuntimeEndpointReference> {
    let endpoint = match endpoint {
        StartGateNativeEndpoint::OpenClawLocal => RuntimeDriverIdentity::open_claw(),
        StartGateNativeEndpoint::MatchaAgentLocal => RuntimeDriverIdentity::matcha_agent(),
        StartGateNativeEndpoint::Unsupported => return None,
    };
    RuntimeEndpointReference::try_new(endpoint.runtime_endpoint_reference()).ok()
}
