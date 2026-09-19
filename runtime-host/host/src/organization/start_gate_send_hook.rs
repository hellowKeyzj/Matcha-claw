use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use crate::{
    runtime::driver::RuntimeDriverIdentity,
    sessions::{
        SessionHandle,
        send::{NativeEndpoint, SessionSendCommand},
        send_hook::{
            SessionSendHook, SessionSendHookFuture, SessionSendHookPrepared, SessionSendHookState,
        },
    },
};

use super::{OrganizationHandle, start_gate_control};

#[derive(Clone)]
pub(crate) struct StartGateSendHook {
    organization: OrganizationHandle,
    start_gate: Arc<StartGateRegistry>,
}

impl StartGateSendHook {
    pub(crate) fn new(
        organization: OrganizationHandle,
        start_gate: Arc<StartGateRegistry>,
    ) -> Self {
        Self {
            organization,
            start_gate,
        }
    }
}

/// Shared `native_run_id -> (run_id, proposal_id)` registry for start-gate proposals. The send hook
/// registers a sent start-gate prompt; the organization session terminal consumes it when the
/// native run reaches a terminal phase.
#[derive(Default)]
pub(crate) struct StartGateRegistry {
    proposals: Mutex<BTreeMap<String, StartGateProposal>>,
}

struct StartGateProposal {
    run_id: organization::GraphRunId,
    proposal_id: String,
}

impl StartGateRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(super) fn register(
        &self,
        native_run_id: String,
        run_id: organization::GraphRunId,
        proposal_id: String,
    ) {
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

    pub(super) fn take(&self, native_run_id: &str) -> Option<(organization::GraphRunId, String)> {
        self.proposals
            .lock()
            .expect("start gate registry lock is never poisoned")
            .remove(native_run_id)
            .map(|proposal| (proposal.run_id, proposal.proposal_id))
    }
}

impl SessionSendHook for StartGateSendHook {
    fn before_send<'a>(
        &'a self,
        command: SessionSendCommand,
        now_millis: u64,
    ) -> SessionSendHookFuture<'a> {
        let start_gate = Arc::clone(&self.start_gate);
        Box::pin(async move {
            prepare_start_gate_send(self.organization.clone(), start_gate, command, now_millis)
                .await
        })
    }
}

async fn prepare_start_gate_send(
    organization: OrganizationHandle,
    start_gate: Arc<StartGateRegistry>,
    command: SessionSendCommand,
    now_millis: u64,
) -> Result<SessionSendHookPrepared, ()> {
    let TeamSessionPurpose::Intake(binding) =
        derive_team_session_purpose(organization, &command).await?
    else {
        return Ok(SessionSendHookPrepared::unchanged(command));
    };
    let proposal_id = start_gate_control::proposal_id(
        &binding,
        command
            .idempotency_key
            .as_deref()
            .or(command.run_id.as_deref()),
        now_millis,
    );
    let state = StartGateSendState {
        start_gate,
        run_id: binding.run_id.clone(),
        proposal_id,
    };
    let command = command
        .with_system_provenance_receipt(start_gate_control::TEAM_CONTROL_PROTOCOL.to_owned())
        .map_err(|_| ())?;
    Ok(SessionSendHookPrepared::with_state(
        command,
        Box::new(state),
    ))
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TeamSessionPurpose {
    Intake(start_gate_control::StartGateBinding),
    Role,
}

async fn derive_team_session_purpose(
    organization: OrganizationHandle,
    command: &SessionSendCommand,
) -> Result<TeamSessionPurpose, ()> {
    if command.delivery_context.is_some() {
        return Ok(TeamSessionPurpose::Role);
    }
    let Some(endpoint) = endpoint_reference(command.endpoint) else {
        return Ok(TeamSessionPurpose::Role);
    };
    let Some(endpoint_session_id) = command.endpoint_session_id.clone() else {
        return Ok(TeamSessionPurpose::Role);
    };
    let lookup = start_gate_control::StartGateSessionLookup {
        endpoint,
        session_key: command.session_key.clone(),
        endpoint_session_id,
    };
    let Some(binding) = organization
        .start_gate_session_binding(lookup)
        .await
        .map_err(|_| ())?
    else {
        return Ok(TeamSessionPurpose::Role);
    };
    if binding.is_leader_intake() {
        Ok(TeamSessionPurpose::Intake(binding))
    } else {
        Ok(TeamSessionPurpose::Role)
    }
}

struct StartGateSendState {
    start_gate: Arc<StartGateRegistry>,
    run_id: organization::GraphRunId,
    proposal_id: String,
}

impl SessionSendHookState for StartGateSendState {
    fn after_queued(self: Box<Self>, _session: SessionHandle, native_run_id: String) {
        let StartGateSendState {
            start_gate,
            run_id,
            proposal_id,
        } = *self;
        start_gate.register(native_run_id, run_id, proposal_id);
    }
}

fn endpoint_reference(endpoint: NativeEndpoint) -> Option<organization::RuntimeEndpointReference> {
    let endpoint = match endpoint {
        NativeEndpoint::OpenClawLocal => RuntimeDriverIdentity::open_claw(),
        NativeEndpoint::MatchaAgentLocal => RuntimeDriverIdentity::matcha_agent(),
        NativeEndpoint::Unsupported => return None,
    };
    organization::RuntimeEndpointReference::try_new(endpoint.runtime_endpoint_reference()).ok()
}
