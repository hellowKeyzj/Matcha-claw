use std::{future::Future, pin::Pin, sync::Arc};

use organization::{ActivityExecutionOutcome, ActivityExecutionRequest};
use runtime_directory::RuntimeDriverIdentity;
use sessions_module::{
    SessionHandle, SessionRunTerminalSnapshot, SessionTerminalHook,
    command::{SessionEnsureOutcome, role_session_route_key},
    send::{NativeEndpoint, SessionDeliveryContext, SessionSendCommand, SessionSendOutcome},
    send_hook::{
        SessionSendHook, SessionSendHookFuture, SessionSendHookPrepared, SessionSendHookState,
    },
    state::{RunPhase, SessionIdentity, SessionProvider, SessionSourceBinding},
};

use crate::{
    composition::runtime_ports::RuntimeDriverDirectory,
    composition::{HostAdmission, RequestAdmission},
};

pub(crate) struct OrganizationSessionTerminal {
    inner: organization::OrganizationSessionTerminal<SessionSourceBinding>,
}

impl OrganizationSessionTerminal {
    pub(crate) fn start(
        organization: organization::OrganizationHandle,
        observation: foundation::execution::ObservationSink,
    ) -> Self {
        Self {
            inner: organization::OrganizationSessionTerminal::start(organization, observation),
        }
    }

    pub(crate) fn start_gate_registry(&self) -> Arc<organization::StartGateRegistry> {
        self.inner.start_gate_registry()
    }

    pub(crate) fn bind_repair_session(
        &self,
        session: Arc<dyn organization::TeamMessageRepairSessionPort<SessionSourceBinding>>,
    ) {
        self.inner.bind_repair_session(session);
    }

    pub(crate) async fn close_and_join(&self) -> Result<(), tokio::task::JoinError> {
        self.inner.close_and_join().await
    }
}

impl SessionTerminalHook for OrganizationSessionTerminal {
    fn run_terminal(&self, snapshot: SessionRunTerminalSnapshot) {
        self.inner
            .run_terminal(organization::OrganizationRunTerminalSnapshot {
                provider: organization_session_provider(snapshot.provider),
                session_key: snapshot.session_key,
                route_key: snapshot.route_key,
                source_binding: snapshot.source_binding,
                native_run_id: snapshot.native_run_id,
                phase: run_phase(snapshot.phase),
                final_assistant_text: snapshot.final_assistant_text,
            });
    }
}

pub(crate) struct SessionRepairPort {
    session: SessionHandle,
}

impl SessionRepairPort {
    fn new(session: SessionHandle) -> Self {
        Self { session }
    }
}

impl organization::TeamMessageRepairSessionPort<SessionSourceBinding> for SessionRepairPort {
    fn send_repair<'a>(
        &'a self,
        request: organization::TeamMessageRepairSessionRequest<SessionSourceBinding>,
    ) -> Pin<Box<dyn Future<Output = organization::TeamMessageRepairSessionOutcome> + Send + 'a>>
    {
        Box::pin(async move {
            let Some(command) = repair_send_command(request) else {
                return organization::TeamMessageRepairSessionOutcome::Rejected;
            };
            match self.session.send_session(command).await {
                Ok(SessionSendOutcome::Queued { run_id })
                | Ok(SessionSendOutcome::Succeeded { run_id, .. }) => {
                    organization::TeamMessageRepairSessionOutcome::Queued {
                        native_run_id: run_id,
                    }
                }
                Ok(SessionSendOutcome::Rejected)
                | Ok(SessionSendOutcome::Unknown)
                | Ok(SessionSendOutcome::Unsupported)
                | Ok(SessionSendOutcome::Unavailable)
                | Err(_) => organization::TeamMessageRepairSessionOutcome::Rejected,
            }
        })
    }
}

pub(crate) fn repair_port(session: SessionHandle) -> Arc<SessionRepairPort> {
    Arc::new(SessionRepairPort::new(session))
}

#[derive(Clone)]
pub(crate) struct StartGateSessionSendHook {
    inner: organization::StartGateSendHook,
}

impl StartGateSessionSendHook {
    pub(crate) fn new(
        organization: organization::OrganizationHandle,
        start_gate: Arc<organization::StartGateRegistry>,
    ) -> Self {
        Self {
            inner: organization::StartGateSendHook::new(organization, start_gate),
        }
    }
}

impl SessionSendHook for StartGateSessionSendHook {
    fn before_send<'a>(
        &'a self,
        command: SessionSendCommand,
        now_millis: u64,
    ) -> SessionSendHookFuture<'a> {
        Box::pin(async move {
            let request = organization::StartGateSendRequest::new(
                start_gate_native_endpoint(command.endpoint),
                command.session_key.clone(),
                command.endpoint_session_id.clone(),
                command.run_id.clone(),
                command.idempotency_key.clone(),
                command.delivery_context.is_some(),
            );
            let Some(prepared) = self.inner.prepare(request, now_millis).await? else {
                return Ok(SessionSendHookPrepared::unchanged(command));
            };
            let command = command
                .with_system_provenance_receipt(prepared.system_provenance_receipt().to_owned())
                .map_err(|_| ())?;
            Ok(SessionSendHookPrepared::with_state(
                command,
                Box::new(StartGateSendState(prepared.into_state())),
            ))
        })
    }
}

struct StartGateSendState(organization::StartGateSendState);

impl SessionSendHookState for StartGateSendState {
    fn after_queued(self: Box<Self>, _session: SessionHandle, native_run_id: String) {
        self.0.after_queued(native_run_id);
    }
}

#[derive(Clone)]
pub(in crate::composition::host) struct HostTeamActivityExecutor {
    admission: Arc<HostAdmission>,
    session: sessions_module::SessionHandle,
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

impl HostTeamActivityExecutor {
    pub(in crate::composition::host) fn new(
        admission: Arc<HostAdmission>,
        session: sessions_module::SessionHandle,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        Self {
            admission,
            session,
            runtime_directory,
        }
    }
}

impl organization::TeamRunAdmission for HostAdmission {
    fn is_admitted(&self) -> bool {
        self.state().request_admission() == RequestAdmission::Accepting
    }
}

fn repair_send_command(
    request: organization::TeamMessageRepairSessionRequest<SessionSourceBinding>,
) -> Option<SessionSendCommand> {
    let route_key = request
        .route_key
        .unwrap_or_else(|| role_session_route_key(&request.session_key));
    SessionSendCommand::try_new(
        native_endpoint(request.provider),
        request.session_key,
        Some(request.endpoint_session_id.as_str().to_owned()),
        route_key,
        request.prompt,
        Some(request.requested_run_id),
        None,
        Some(true),
        Vec::new(),
        None,
    )
    .ok()
    .map(|command| command.with_source_binding(request.source_binding))
}

const fn native_endpoint(provider: organization::OrganizationSessionProvider) -> NativeEndpoint {
    match provider {
        organization::OrganizationSessionProvider::OpenClaw => NativeEndpoint::OpenClawLocal,
        organization::OrganizationSessionProvider::MatchaAgent => NativeEndpoint::MatchaAgentLocal,
    }
}

const fn organization_session_provider(
    provider: SessionProvider,
) -> organization::OrganizationSessionProvider {
    match provider {
        SessionProvider::OpenClaw => organization::OrganizationSessionProvider::OpenClaw,
        SessionProvider::MatchaAgent => organization::OrganizationSessionProvider::MatchaAgent,
    }
}

const fn run_phase(phase: RunPhase) -> organization::OrganizationRunPhase {
    match phase {
        RunPhase::Queued => organization::OrganizationRunPhase::Queued,
        RunPhase::Started => organization::OrganizationRunPhase::Started,
        RunPhase::WaitingForApproval => organization::OrganizationRunPhase::WaitingForApproval,
        RunPhase::CancellationRequested => {
            organization::OrganizationRunPhase::CancellationRequested
        }
        RunPhase::Cancelled => organization::OrganizationRunPhase::Cancelled,
        RunPhase::Completed => organization::OrganizationRunPhase::Completed,
        RunPhase::Failed => organization::OrganizationRunPhase::Failed,
        RunPhase::Interrupted => organization::OrganizationRunPhase::Interrupted,
    }
}

const fn start_gate_native_endpoint(
    endpoint: NativeEndpoint,
) -> organization::StartGateNativeEndpoint {
    match endpoint {
        NativeEndpoint::OpenClawLocal => organization::StartGateNativeEndpoint::OpenClawLocal,
        NativeEndpoint::MatchaAgentLocal => organization::StartGateNativeEndpoint::MatchaAgentLocal,
        NativeEndpoint::Unsupported => organization::StartGateNativeEndpoint::Unsupported,
    }
}

fn rendered_session_key(
    identity: RuntimeDriverIdentity,
    agent_id: &str,
    endpoint_session_id: &str,
) -> Option<String> {
    match identity {
        value if value == RuntimeDriverIdentity::open_claw() => {
            Some(format!("agent:{agent_id}:{endpoint_session_id}"))
        }
        value if value == RuntimeDriverIdentity::matcha_agent() => {
            Some(format!("matcha-agent:{agent_id}:{endpoint_session_id}"))
        }
        _ => None,
    }
}

fn session_provider_from_identity(identity: RuntimeDriverIdentity) -> SessionProvider {
    if identity == RuntimeDriverIdentity::open_claw() {
        SessionProvider::OpenClaw
    } else {
        SessionProvider::MatchaAgent
    }
}

impl organization::TeamActivityExecutor for HostTeamActivityExecutor {
    fn execute(
        &self,
        request: ActivityExecutionRequest,
    ) -> runtime_directory::OwnedRuntimeFuture<ActivityExecutionOutcome> {
        let session = self.session.clone();
        Box::pin(async move {
            let delivery = request.delivery_request().clone();
            let binding = request.binding().clone();
            let Some(identity) = RuntimeDriverIdentity::from_reference(binding.endpoint().as_str())
            else {
                return ActivityExecutionOutcome::Unknown;
            };
            let Some(session_key) = rendered_session_key(
                identity,
                binding.agent().as_str(),
                binding.endpoint_session_id().as_str(),
            ) else {
                return ActivityExecutionOutcome::Unknown;
            };
            let Some(session_identity) = SessionIdentity::new(
                session_key.clone(),
                session_provider_from_identity(identity),
                Some(binding.agent().as_str().to_owned()),
            ) else {
                return ActivityExecutionOutcome::Unknown;
            };
            let source_binding = SessionSourceBinding::team_from_receipt(&binding);
            match session
                .ensure_bound_session(session_identity, source_binding.clone())
                .await
            {
                Ok(SessionEnsureOutcome::Created(_)) | Ok(SessionEnsureOutcome::Existing(_)) => {}
                Ok(SessionEnsureOutcome::RuntimeNotFound)
                | Ok(SessionEnsureOutcome::RuntimeNoSessionSupport) => {
                    return ActivityExecutionOutcome::Rejected {
                        rejection: organization::DeliveryRejection::Permanent,
                    };
                }
                Ok(SessionEnsureOutcome::Failed) | Err(_) => {
                    return ActivityExecutionOutcome::Unknown;
                }
            }
            let route_key = role_session_route_key(&session_key);
            let command = match SessionSendCommand::try_new(
                NativeEndpoint::from_runtime_endpoint(identity.endpoint()),
                session_key,
                Some(binding.endpoint_session_id().as_str().to_owned()),
                route_key,
                delivery.message,
                None,
                Some(delivery.idempotency_key),
                Some(true),
                Vec::new(),
                None,
            ) {
                Ok(command) => command
                    .with_source_binding(source_binding)
                    .with_delivery_context(SessionDeliveryContext {
                        delivery_id: delivery.delivery_id,
                        endpoint_session_id: binding.endpoint_session_id().clone(),
                    }),
                Err(_) => return ActivityExecutionOutcome::Unknown,
            };
            match session.send_session(command).await {
                Ok(SessionSendOutcome::Queued { run_id })
                | Ok(SessionSendOutcome::Succeeded { run_id, .. }) => {
                    ActivityExecutionOutcome::accepted(
                        binding.endpoint_session_id().clone(),
                        run_id,
                    )
                }
                Ok(SessionSendOutcome::Rejected) | Ok(SessionSendOutcome::Unsupported) => {
                    ActivityExecutionOutcome::Rejected {
                        rejection: organization::DeliveryRejection::Permanent,
                    }
                }
                Ok(SessionSendOutcome::Unavailable) => ActivityExecutionOutcome::Rejected {
                    rejection: organization::DeliveryRejection::Retryable,
                },
                Ok(SessionSendOutcome::Unknown) | Err(_) => ActivityExecutionOutcome::Unknown,
            }
        })
    }

    fn open_claw_ready(&self) -> bool {
        if self.admission.state().request_admission() != RequestAdmission::Accepting {
            return false;
        }
        self.runtime_directory
            .lookup(&RuntimeDriverIdentity::open_claw().endpoint())
            .and_then(|driver| driver.host_lifecycle_ops().map(|ops| ops.readiness()))
            .unwrap_or(false)
    }
}
