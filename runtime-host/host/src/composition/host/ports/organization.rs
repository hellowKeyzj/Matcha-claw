use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};

use organization::{ActivityExecutionOutcome, ActivityExecutionRequest, RoleSessionIdentityResolver};
use platform::trace::{identifier_hash, runtime_trace, session_trace, with_session_trace};
use runtime_directory::RuntimeDriverIdentity;
use serde_json::json;
use sessions_module::{
    SessionHandle, SessionRunTerminalSnapshot, SessionTerminalHook,
    command::SessionEnsureOutcome,
    send::{SessionDeliveryContext, SessionSendCommand, SessionSendOutcome},
    send_hook::{
        SessionSendHook, SessionSendHookFuture, SessionSendHookPrepared,
    },
    state::{RunPhase, SessionEndpoint, SessionIdentity, SessionProvider, SessionSourceBinding},
};
use tokio_util::sync::CancellationToken;

use crate::{
    composition::runtime_ports::RuntimeDriverDirectory,
    composition::{HostAdmission, RequestAdmission},
};

pub(crate) struct OrganizationSessionOwnership {
    organization: organization::OrganizationHandle,
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

impl OrganizationSessionOwnership {
    pub(crate) fn new(
        organization: organization::OrganizationHandle,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        Self {
            organization,
            runtime_directory,
        }
    }
}

impl sessions_module::ports::SessionOwnershipReader for OrganizationSessionOwnership {
    fn lookup<'a>(
        &'a self,
        queries: Vec<sessions_module::ports::SessionOwnershipQuery>,
    ) -> sessions_module::ports::SessionFuture<
        'a,
        Option<HashMap<platform::endpoint::runtime_address::SessionIdentity, SessionSourceBinding>>,
    > {
        Box::pin(async move {
            let receipts = self
                .organization
                .session_ownership(
                    queries
                        .into_iter()
                        .map(|query| (query.identity, query.endpoint_session_id))
                        .collect(),
                    self.runtime_directory.clone(),
                )
                .await
                .ok()?
                .ok()??;
            Some(
                receipts
                    .into_iter()
                    .map(|(identity, receipt)| {
                        (identity, SessionSourceBinding::team_from_receipt(&receipt))
                    })
                    .collect(),
            )
        })
    }
}

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

    pub(crate) fn bind_repair_session(
        &self,
        session: Arc<dyn organization::TeamMessageRepairSessionPort<SessionSourceBinding>>,
    ) {
        self.inner.bind_repair_session(session);
    }

    pub(crate) async fn close_and_join_checked(
        &self,
    ) -> Result<(), organization::OrganizationTerminalCloseError> {
        self.inner.close_and_join_checked().await
    }
}

impl SessionTerminalHook for OrganizationSessionTerminal {
    fn run_terminal_async<'a>(
        &'a self,
        snapshot: SessionRunTerminalSnapshot,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<(), SessionRunTerminalSnapshot>> + Send + 'a>> {
        Box::pin(async move {
            let identity = snapshot.identity.clone();
            let phase = snapshot.phase;
            self.inner
                .run_terminal_async(organization_terminal_snapshot(snapshot), cancellation)
                .await
                .map_err(|snapshot| SessionRunTerminalSnapshot {
                    identity,
                    source_binding: snapshot.source_binding,
                    native_run_id: snapshot.native_run_id,
                    delivery_context: snapshot.delivery_context.map(|(delivery_id, endpoint_session_id)| {
                        SessionDeliveryContext { delivery_id, endpoint_session_id }
                    }),
                    phase,
                    assistant_texts: snapshot.assistant_texts,
                })
        })
    }
}

fn organization_terminal_snapshot(
    snapshot: SessionRunTerminalSnapshot,
) -> organization::OrganizationRunTerminalSnapshot<SessionSourceBinding> {
    runtime_trace("runtime.team_run.terminal.bridge", || json!({
        "nativeRunHash": identifier_hash(&snapshot.native_run_id),
        "deliveryHash": snapshot.delivery_context.as_ref().map(|context| identifier_hash(context.delivery_id.as_str())),
        "phase": format!("{:?}", snapshot.phase),
        "candidateCount": snapshot.assistant_texts.len(),
        "hasDeliveryContext": snapshot.delivery_context.is_some(),
    }));
    organization::OrganizationRunTerminalSnapshot {
        identity: platform::endpoint::runtime_address::SessionIdentity::try_new(
            platform::endpoint::runtime_address::RuntimeEndpoint::try_new(
                snapshot.identity.provider().as_str(),
                snapshot.identity.endpoint.runtime_instance_id,
            )
            .expect("validated session endpoint"),
            snapshot.identity.agent_id,
            snapshot.identity.session_key,
        )
        .expect("validated session identity"),
        source_binding: snapshot.source_binding,
        native_run_id: snapshot.native_run_id,
        delivery_context: snapshot
            .delivery_context
            .map(|context| (context.delivery_id, context.endpoint_session_id)),
        phase: run_phase(snapshot.phase),
        assistant_texts: snapshot.assistant_texts,
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
        self.send_repair_cancellable(request, CancellationToken::new())
    }

    fn send_repair_cancellable<'a>(
        &'a self,
        request: organization::TeamMessageRepairSessionRequest<SessionSourceBinding>,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = organization::TeamMessageRepairSessionOutcome> + Send + 'a>>
    {
        Box::pin(async move {
            let started = platform::trace::enabled().then(std::time::Instant::now);
            let native_run_hash = platform::trace::enabled().then(|| identifier_hash(&request.requested_run_id));
            runtime_trace("runtime.team_run.repair.send.begin", || json!({
                "nativeRunHash": native_run_hash,
            }));
            let Some(command) = repair_send_command(request) else {
                runtime_trace("runtime.team_run.repair.send.result", || json!({
                    "nativeRunHash": native_run_hash, "outcome": "rejected",
                    "error": "invalid_repair_command", "elapsedMs": started.map(|start| start.elapsed().as_millis()),
                }));
                return organization::TeamMessageRepairSessionOutcome::Rejected;
            };
            let result = self.session.send_session_cancellable(command, cancellation).await;
            runtime_trace("runtime.team_run.repair.send.result", || json!({
                "nativeRunHash": native_run_hash,
                "actualNativeRunHash": match &result {
                    Ok(SessionSendOutcome::Queued { run_id } | SessionSendOutcome::Succeeded { run_id, .. }) => Some(identifier_hash(run_id)),
                    _ => None,
                },
                "outcome": match &result {
                    Ok(SessionSendOutcome::Queued { .. }) => "queued",
                    Ok(SessionSendOutcome::Succeeded { .. }) => "succeeded",
                    Ok(SessionSendOutcome::Rejected) => "rejected",
                    Ok(SessionSendOutcome::Unsupported) => "unsupported",
                    Ok(SessionSendOutcome::Unavailable) => "unavailable",
                    Ok(SessionSendOutcome::Unknown) => "unknown",
                    Err(_) => "admission_or_reply_closed",
                },
                "elapsedMs": started.map(|start| start.elapsed().as_millis()),
            }));
            match result {
                Ok(SessionSendOutcome::Queued { run_id })
                | Ok(SessionSendOutcome::Succeeded { run_id, .. }) => {
                    organization::TeamMessageRepairSessionOutcome::Queued {
                        native_run_id: run_id,
                    }
                }
                Ok(SessionSendOutcome::Rejected) | Ok(SessionSendOutcome::Unsupported) => {
                    organization::TeamMessageRepairSessionOutcome::Rejected
                }
                Ok(SessionSendOutcome::Unavailable) => {
                    organization::TeamMessageRepairSessionOutcome::NotDelivered
                }
                Ok(SessionSendOutcome::Unknown) | Err(_) => {
                    organization::TeamMessageRepairSessionOutcome::Unknown
                }
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
        resolver: Arc<dyn RoleSessionIdentityResolver>,
    ) -> Self {
        Self {
            inner: organization::StartGateSendHook::new(organization, resolver),
        }
    }
}

impl SessionSendHook for StartGateSessionSendHook {
    fn before_send<'a>(
        &'a self,
        command: SessionSendCommand,
        _now_millis: u64,
    ) -> SessionSendHookFuture<'a> {
        Box::pin(with_session_trace(command.trace_id().map(str::to_owned), async move {
            let request = organization::StartGateSendRequest::new(
                start_gate_native_endpoint(command.identity.provider()),
                command.identity.session_key.clone(),
                command.identity.agent_id.clone(),
                command.endpoint_session_id.clone(),
                command.delivery_context.is_some(),
            );
            let Some(prepared) = self.inner.prepare(request).await? else {
                return Ok(SessionSendHookPrepared::unchanged(command));
            };
            let command = command
                .with_system_provenance_receipt(prepared.system_provenance_receipt().to_owned())
                .map_err(|_| {
                    session_trace("runtime.start-gate.injected", || json!({
                        "outcome": "error", "reason": "invalid_provenance_receipt",
                    }));
                })?;
            session_trace("runtime.start-gate.injected", || json!({ "outcome": "injected" }));
            Ok(SessionSendHookPrepared::unchanged(command))
        }))
    }
}

#[derive(Clone)]
pub(in crate::composition::host) struct TeamSessionExecutor {
    admission: Arc<HostAdmission>,
    session: sessions_module::SessionHandle,
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

impl TeamSessionExecutor {
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

    fn activity_session_identity(&self, request: &ActivityExecutionRequest) -> Option<(SessionIdentity, String)> {
        let binding = request.binding();
        let failed = |kind| {
            runtime_trace("runtime.team_run.activity.resolve", || json!({
                "runHash": identifier_hash(&request.delivery_request().run_id),
                "activityHash": identifier_hash(request.delivery_request().delivery_id.as_str()),
                "outcome": "error", "kind": kind,
            }));
            None
        };
        let Some(identity) = RuntimeDriverIdentity::from_reference(binding.endpoint().as_str()) else {
            return failed("invalid_runtime_reference");
        };
        let Some(driver) = self.runtime_directory.lookup(&identity.endpoint()) else {
            return failed("driver_not_found");
        };
        let Some(session_ops) = driver.session_ops() else {
            return failed("session_unsupported");
        };
        let Some(session_key) = session_ops.agent_scoped_session_key(binding.agent().as_str(), binding.endpoint_session_id().as_str()) else {
            return failed("session_key_unresolved");
        };
        let Some(session_identity) = SessionIdentity::new(session_key.clone(), session_provider_from_identity(identity), binding.agent().as_str().to_owned()) else {
            return failed("invalid_session_identity");
        };
        Some((session_identity, session_key))
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
    let provider = match request.identity.endpoint().runtime_adapter_id() {
        "openclaw" => SessionProvider::OpenClaw,
        "matcha-agent" => SessionProvider::MatchaAgent,
        _ => return None,
    };
    let identity = SessionIdentity::with_endpoint(
        request.identity.session_key(),
        SessionEndpoint {
            kind: "native-runtime".to_owned(),
            runtime_adapter_id: provider,
            runtime_instance_id: request.identity.endpoint().runtime_instance_id().to_owned(),
        },
        request.identity.agent_id().to_owned(),
    )
    .ok()?;
    SessionSendCommand::try_new(
        identity,
        Some(request.endpoint_session_id.as_str().to_owned()),
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
    provider: SessionProvider,
) -> organization::StartGateNativeEndpoint {
    match provider {
        SessionProvider::OpenClaw => organization::StartGateNativeEndpoint::OpenClawLocal,
        SessionProvider::MatchaAgent => organization::StartGateNativeEndpoint::MatchaAgentLocal,
    }
}

fn session_provider_from_identity(identity: RuntimeDriverIdentity) -> SessionProvider {
    if identity == RuntimeDriverIdentity::open_claw() {
        SessionProvider::OpenClaw
    } else {
        SessionProvider::MatchaAgent
    }
}

impl organization::TeamActivityExecutor for TeamSessionExecutor {
    fn prepare_cancellable(
        &self,
        request: ActivityExecutionRequest,
        cancellation: CancellationToken,
    ) -> runtime_directory::OwnedRuntimeFuture<Result<(), ActivityExecutionOutcome>> {
        let executor = self.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ActivityExecutionOutcome::Rejected { rejection: organization::DeliveryRejection::Retryable });
            }
            let Some((identity, _)) = executor.activity_session_identity(&request) else {
                return Err(ActivityExecutionOutcome::Unknown);
            };
            runtime_trace("runtime.team_run.activity.ensure", || json!({
                "runHash": identifier_hash(&request.delivery_request().run_id),
                "activityHash": identifier_hash(request.delivery_request().delivery_id.as_str()),
                "outcome": "begin",
            }));
            let result = executor.session.ensure_bound_session(identity, SessionSourceBinding::team_from_receipt(request.binding())).await;
            runtime_trace("runtime.team_run.activity.ensure", || json!({
                "runHash": identifier_hash(&request.delivery_request().run_id),
                "activityHash": identifier_hash(request.delivery_request().delivery_id.as_str()),
                "outcome": match &result {
                    Ok(SessionEnsureOutcome::Created(_) | SessionEnsureOutcome::Existing(_)) => "success",
                    Ok(SessionEnsureOutcome::RuntimeNotFound | SessionEnsureOutcome::RuntimeNoSessionSupport) => "error",
                    Ok(SessionEnsureOutcome::Failed) | Err(_) => "unknown",
                },
            }));
            match result {
                Ok(SessionEnsureOutcome::Created(_)) | Ok(SessionEnsureOutcome::Existing(_)) => Ok(()),
                Ok(SessionEnsureOutcome::RuntimeNotFound | SessionEnsureOutcome::RuntimeNoSessionSupport) => Err(ActivityExecutionOutcome::Rejected {
                    rejection: organization::DeliveryRejection::Permanent,
                }),
                Ok(SessionEnsureOutcome::Failed) | Err(_) => Err(ActivityExecutionOutcome::Unknown),
            }
        })
    }

    fn execute(
        &self,
        request: ActivityExecutionRequest,
    ) -> runtime_directory::OwnedRuntimeFuture<ActivityExecutionOutcome> {
        self.execute_cancellable(request, CancellationToken::new())
    }

    fn execute_cancellable(
        &self,
        request: ActivityExecutionRequest,
        cancellation: CancellationToken,
    ) -> runtime_directory::OwnedRuntimeFuture<ActivityExecutionOutcome> {
        let session = self.session.clone();
        let executor = self.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return ActivityExecutionOutcome::Rejected {
                    rejection: organization::DeliveryRejection::Retryable,
                };
            }
            let trace = |stage: &'static str, outcome: &'static str, kind: &'static str| {
                runtime_trace(stage, || json!({
                    "runHash": identifier_hash(&request.delivery_request().run_id),
                    "activityHash": identifier_hash(request.delivery_request().delivery_id.as_str()),
                    "nodeHash": identifier_hash(&request.delivery_request().node_id),
                    "endpointSessionHash": identifier_hash(request.binding().endpoint_session_id().as_str()),
                    "outcome": outcome,
                    "kind": kind,
                }));
            };
            let delivery = request.delivery_request().clone();
            let binding = request.binding().clone();
            let Some((session_identity, session_key)) = executor.activity_session_identity(&request) else {
                return ActivityExecutionOutcome::Unknown;
            };
            runtime_trace("runtime.team_run.activity.resolve", || json!({
                "runHash": identifier_hash(&delivery.run_id),
                "activityHash": identifier_hash(delivery.delivery_id.as_str()),
                "nodeHash": identifier_hash(&delivery.node_id),
                "sessionHash": identifier_hash(&session_key),
                "endpointSessionHash": identifier_hash(binding.endpoint_session_id().as_str()),
                "outcome": "success",
            }));
            let source_binding = SessionSourceBinding::team_from_receipt(&binding);
            let command = match SessionSendCommand::try_new(
                session_identity,
                Some(binding.endpoint_session_id().as_str().to_owned()),
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
                Err(_) => {
                    trace("runtime.team_run.activity.send", "error", "invalid_send_command");
                    return ActivityExecutionOutcome::Unknown;
                }
            };
            trace("runtime.team_run.activity.send", "begin", "send");
            let result = session.send_session_cancellable(command, cancellation).await;
            runtime_trace("runtime.team_run.activity.send", || json!({
                "runHash": identifier_hash(&request.delivery_request().run_id),
                "activityHash": identifier_hash(request.delivery_request().delivery_id.as_str()),
                "sessionHash": identifier_hash(&session_key),
                "nativeRunHash": match &result {
                    Ok(SessionSendOutcome::Queued { run_id } | SessionSendOutcome::Succeeded { run_id, .. }) => Some(identifier_hash(run_id)),
                    _ => None,
                },
                "outcome": match &result {
                    Ok(SessionSendOutcome::Queued { .. }) => "queued",
                    Ok(SessionSendOutcome::Succeeded { .. }) => "native_receipt",
                    Ok(SessionSendOutcome::Rejected | SessionSendOutcome::Unsupported) => "rejected",
                    Ok(SessionSendOutcome::Unavailable) => "unavailable",
                    Ok(SessionSendOutcome::Unknown) | Err(_) => "unknown",
                },
                "nativeReceiptObserved": matches!(&result, Ok(SessionSendOutcome::Succeeded { .. })),
            }));
            match result {
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
