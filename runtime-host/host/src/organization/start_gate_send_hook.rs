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
}

impl StartGateSendHook {
    pub(crate) fn new(organization: OrganizationHandle) -> Self {
        Self { organization }
    }
}

impl SessionSendHook for StartGateSendHook {
    fn before_send<'a>(
        &'a self,
        command: SessionSendCommand,
        now_millis: u64,
    ) -> SessionSendHookFuture<'a> {
        Box::pin(async move {
            prepare_start_gate_send(self.organization.clone(), command, now_millis).await
        })
    }
}

async fn prepare_start_gate_send(
    organization: OrganizationHandle,
    command: SessionSendCommand,
    now_millis: u64,
) -> Result<SessionSendHookPrepared, ()> {
    let Some(endpoint) = endpoint_reference(command.endpoint) else {
        return Ok(SessionSendHookPrepared::unchanged(command));
    };
    let Some(endpoint_session_id) = command.endpoint_session_id.clone() else {
        return Ok(SessionSendHookPrepared::unchanged(command));
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
        return Ok(SessionSendHookPrepared::unchanged(command));
    };
    if !binding.is_leader_intake() {
        return Ok(SessionSendHookPrepared::unchanged(command));
    }
    let proposal_id = start_gate_control::proposal_id(
        &binding,
        command
            .idempotency_key
            .as_deref()
            .or(command.run_id.as_deref()),
        now_millis,
    );
    let state = StartGateSendState {
        organization,
        endpoint: command.endpoint,
        endpoint_session_id: command.endpoint_session_id.clone(),
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

struct StartGateSendState {
    organization: OrganizationHandle,
    endpoint: NativeEndpoint,
    endpoint_session_id: Option<String>,
    run_id: organization::GraphRunId,
    proposal_id: String,
}

impl SessionSendHookState for StartGateSendState {
    fn after_queued(self: Box<Self>, session: SessionHandle, native_run_id: String) {
        tokio::spawn(watch_start_gate_control(session, *self, native_run_id));
    }
}

async fn watch_start_gate_control(
    session: SessionHandle,
    state: StartGateSendState,
    native_run_id: String,
) {
    let Some(settled) = session
        .wait_session_native_run(
            state.endpoint,
            state.endpoint_session_id,
            native_run_id.clone(),
        )
        .await
    else {
        return;
    };
    let Some(text) = settled.final_assistant_text else {
        return;
    };
    if !matches!(
        settled.status,
        organization::NativeTerminalStatus::Completed
    ) {
        return;
    }
    if let start_gate_control::TeamControl::ProposeRun(summary) =
        start_gate_control::parse_control(&text)
    {
        let _ = state
            .organization
            .run_start_proposal_set(state.run_id, state.proposal_id, summary, native_run_id)
            .await;
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
