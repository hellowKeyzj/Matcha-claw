use std::sync::Arc;

use platform::{
    endpoint::runtime_address::RuntimeEndpoint,
    trace::{identifier_hash, session_trace},
};
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

pub struct StartGateSendRequest {
    endpoint: RuntimeEndpoint,
    session_key: String,
    agent_id: String,
    endpoint_session_id: Option<String>,
    has_delivery_context: bool,
}

impl StartGateSendRequest {
    pub fn new(
        endpoint: RuntimeEndpoint,
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
    system_provenance_receipt: Option<String>,
    workspace: Option<crate::RunWorkspace>,
}

impl PreparedStartGateSend {
    pub fn system_provenance_receipt(&self) -> Option<&str> {
        self.system_provenance_receipt.as_deref()
    }

    pub fn workspace(&self) -> Option<&crate::RunWorkspace> {
        self.workspace.as_ref()
    }
}

async fn prepare_start_gate_send(
    organization: OrganizationHandle,
    resolver: Arc<dyn RoleSessionIdentityResolver>,
    request: StartGateSendRequest,
) -> Result<Option<PreparedStartGateSend>, ()> {
    session_trace("runtime.start-gate.input", || json!({
        "identityKind": match request.endpoint.runtime_adapter_id() {
            "openclaw" => "agent_scoped",
            "matcha-agent" => "native_session",
            _ => "unsupported",
        },
        "sessionKeyHash": identifier_hash(&request.session_key),
        "endpointSessionIdHash": request.endpoint_session_id.as_deref().map(identifier_hash),
    }));
    let Some(lookup) = start_gate_lookup(&request) else {
        session_trace("runtime.start-gate.prompt", || json!({
            "outcome": "skipped", "reason": "unsupported_or_invalid_identity",
        }));
        return Ok(None);
    };
    let Some(plan) = organization
        .start_gate_prompt_plan(lookup, resolver, !request.has_delivery_context)
        .await
        .map_err(|_| {
            eprintln!("[organization] phase=start-gate-prompt error=owner-request-failed");
        })?
    else {
        return Ok(None);
    };
    Ok(Some(PreparedStartGateSend {
        system_provenance_receipt: plan.system_provenance_receipt().map(str::to_owned),
        workspace: plan.workspace().cloned(),
    }))
}

fn start_gate_lookup(request: &StartGateSendRequest) -> Option<StartGateRuntimeBindingLookup> {
    let endpoint = RuntimeEndpointReference::try_new(
        runtime_directory::endpoint_reference(&request.endpoint),
    ).ok()?;
    match request.endpoint.runtime_adapter_id() {
        "openclaw" => Some(StartGateRuntimeBindingLookup::AgentScoped {
            endpoint,
            agent: ManagedAgentReference::try_new(request.agent_id.clone()).ok()?,
            session_key: request.session_key.clone(),
        }),
        "matcha-agent" => {
            Some(StartGateRuntimeBindingLookup::NativeSession {
                endpoint,
                endpoint_session_id: EndpointSessionId::try_new(request.endpoint_session_id.clone()?)
                    .ok()?,
            })
        }
        _ => None,
    }
}
