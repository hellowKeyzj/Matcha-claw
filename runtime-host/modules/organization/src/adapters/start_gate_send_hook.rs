use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use runtime_directory::RuntimeDriverIdentity;

use crate::{
    EndpointSessionId, GraphRunId, ManagedAgentReference, OrganizationHandle,
    RuntimeEndpointReference, StartGateRuntimeBindingLookup,
};

#[derive(Clone)]
pub struct StartGateSendHook {
    organization: OrganizationHandle,
    start_gate: Arc<StartGateRegistry>,
}

impl StartGateSendHook {
    pub fn new(organization: OrganizationHandle, start_gate: Arc<StartGateRegistry>) -> Self {
        Self {
            organization,
            start_gate,
        }
    }

    pub async fn prepare(
        &self,
        request: StartGateSendRequest,
        now_millis: u64,
    ) -> Result<Option<PreparedStartGateSend>, ()> {
        prepare_start_gate_send(
            self.organization.clone(),
            Arc::clone(&self.start_gate),
            request,
            now_millis,
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
    endpoint_session_id: Option<String>,
    run_id: Option<String>,
    idempotency_key: Option<String>,
    has_delivery_context: bool,
}

impl StartGateSendRequest {
    pub fn new(
        endpoint: StartGateNativeEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        run_id: Option<String>,
        idempotency_key: Option<String>,
        has_delivery_context: bool,
    ) -> Self {
        Self {
            endpoint,
            session_key,
            endpoint_session_id,
            run_id,
            idempotency_key,
            has_delivery_context,
        }
    }
}

pub struct PreparedStartGateSend {
    system_provenance_receipt: String,
    state: StartGateSendState,
}

impl PreparedStartGateSend {
    pub fn system_provenance_receipt(&self) -> &str {
        &self.system_provenance_receipt
    }

    pub fn into_state(self) -> StartGateSendState {
        self.state
    }
}

/// Shared `native_run_id -> (run_id, proposal_id)` registry for start-gate proposals. The send hook
/// registers a sent start-gate prompt; the organization session terminal consumes it when the
/// native run reaches a terminal phase.
#[derive(Default)]
pub struct StartGateRegistry {
    proposals: Mutex<BTreeMap<String, StartGateProposal>>,
}

struct StartGateProposal {
    run_id: GraphRunId,
    proposal_id: String,
}

impl StartGateRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn register(&self, native_run_id: String, run_id: GraphRunId, proposal_id: String) {
        self.proposals
            .lock()
            .expect("start gate registry lock is never poisoned")
            .insert(
                native_run_id,
                StartGateProposal {
                    run_id,
                    proposal_id,
                },
            );
    }

    pub(crate) fn take(&self, native_run_id: &str) -> Option<(GraphRunId, String)> {
        self.proposals
            .lock()
            .expect("start gate registry lock is never poisoned")
            .remove(native_run_id)
            .map(|proposal| (proposal.run_id, proposal.proposal_id))
    }
}

async fn prepare_start_gate_send(
    organization: OrganizationHandle,
    start_gate: Arc<StartGateRegistry>,
    request: StartGateSendRequest,
    now_millis: u64,
) -> Result<Option<PreparedStartGateSend>, ()> {
    if request.has_delivery_context {
        return Ok(None);
    }
    let Some(lookup) = start_gate_lookup(&request) else {
        return Ok(None);
    };
    let proposal_id_seed = request
        .idempotency_key
        .clone()
        .or_else(|| request.run_id.clone());
    let Some(plan) = organization
        .start_gate_prompt_plan(lookup, proposal_id_seed, now_millis)
        .await
        .map_err(|_| ())?
    else {
        return Ok(None);
    };
    let system_provenance_receipt = plan.system_provenance_receipt().to_owned();
    let (run_id, proposal_id) = plan.into_registry_parts();
    let state = StartGateSendState {
        start_gate,
        run_id,
        proposal_id,
    };
    Ok(Some(PreparedStartGateSend {
        system_provenance_receipt,
        state,
    }))
}

fn start_gate_lookup(request: &StartGateSendRequest) -> Option<StartGateRuntimeBindingLookup> {
    let endpoint = endpoint_reference(request.endpoint)?;
    let agent = agent_from_session_key(&request.session_key)?;
    let endpoint_session_id =
        EndpointSessionId::try_new(request.endpoint_session_id.clone()?).ok()?;
    Some(StartGateRuntimeBindingLookup::new(
        endpoint,
        agent,
        endpoint_session_id,
    ))
}

pub struct StartGateSendState {
    start_gate: Arc<StartGateRegistry>,
    run_id: GraphRunId,
    proposal_id: String,
}

impl StartGateSendState {
    pub fn after_queued(self, native_run_id: String) {
        let Self {
            start_gate,
            run_id,
            proposal_id,
        } = self;
        start_gate.register(native_run_id, run_id, proposal_id);
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

fn agent_from_session_key(session_key: &str) -> Option<ManagedAgentReference> {
    let (agent_id, suffix) = session_key.strip_prefix("agent:")?.split_once(':')?;
    if agent_id.is_empty() || suffix.is_empty() {
        return None;
    }
    ManagedAgentReference::try_new(agent_id).ok()
}
