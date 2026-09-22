use std::{
    fmt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use tokio::sync::{broadcast, mpsc};

use serde_json::{Map, Value};

use foundation::process::{
    ShutdownOutcome,
    supervision::{
        CommandReceipt, CompletionError, RestartOutcome, StartOutcome, Supervisor,
        SupervisorHandle, SupervisorRejection, SupervisorSnapshot, TerminationCompletion,
    },
};
use platform::exchange::InvocationOutcome;
use sessions_module::command::SessionIngressEvent;

use crate::{
    driver::matcha_session_event,
    lifecycle::secret::Secret,
    session::{
        canonical::{CanonicalSessionReadResult, read as read_canonical_session},
        client::{
            AppServerClient, AppServerClientError, AppServerEndpoint, EventSubscriptionCursor,
            RawEvent,
        },
        close::SessionCloseParams,
        events::{
            ApprovalPhase, EventActivity, EventProjectionResult, EventRejection, MessageLifecycle,
            RunLifecycle, SessionEventObservation, SessionEventProjector, SessionEventUpdate,
            ToolActivityPhase,
        },
        history::{HistoryContentResult, HistoryListResult, HistoryLoadResult},
        hydration::HydrationWindowRequest,
        model::{ApprovalId, OptionId, RunId, Sequence, SessionId},
        recovery::{ProjectionRecoveryReason, SessionRecovery},
        request::{
            SessionCancelParams, SessionLoadParams, SessionSetModelParams, SessionSnapshotParams,
        },
        role::{RolePrompt, RoleRunId, RoleSessionCwd, RoleSessionId},
    },
};

const MATCHACLAW_SESSION_TRACE: &str = "MATCHACLAW_SESSION_TRACE";
const MATCHA_AGENT_RUN_TRACE: &str = "MATCHA_AGENT_RUN_TRACE";

pub struct MatchaPeer {
    pub(super) handle: SupervisorHandle,
    pub(super) supervisor: Supervisor,
    pub(super) working_directory: PathBuf,
    pub(super) endpoint: AppServerEndpoint,
    pub(super) secret: Arc<Secret>,
    source_epoch: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct MatchaPeerLifecycleHandle {
    handle: SupervisorHandle,
    source_epoch: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct MatchaPeerSessionHandle {
    handle: SupervisorHandle,
    working_directory: PathBuf,
    endpoint: AppServerEndpoint,
    secret: Arc<Secret>,
    source_epoch: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct RoleSessionPromptHandle {
    handle: SupervisorHandle,
    endpoint: AppServerEndpoint,
    secret: Arc<Secret>,
    source_epoch: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct RoleSessionNativeHandle {
    handle: SupervisorHandle,
    endpoint: AppServerEndpoint,
    secret: Arc<Secret>,
}

#[derive(Clone, Eq, PartialEq)]
pub enum RendererEvent {
    Run {
        sequence: u64,
        phase: RendererRunPhase,
    },
    Message {
        sequence: u64,
        message_id: String,
        lifecycle: RendererMessageLifecycle,
        text_delta: Option<String>,
        thinking_delta: Option<String>,
        message_text: Option<String>,
        thinking_text: Option<String>,
    },
    Tool {
        sequence: u64,
        tool_call_id: String,
        name: Option<String>,
        phase: RendererToolPhase,
        input: Option<Value>,
        input_text: Option<String>,
        summary: Option<String>,
        output: Option<Value>,
        is_error: Option<bool>,
    },
    Approval {
        sequence: u64,
        approval_id: String,
        phase: RendererApprovalPhase,
        option_ids: Vec<String>,
    },
}

impl fmt::Debug for RendererEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Run { sequence, phase } => formatter
                .debug_struct("Run")
                .field("sequence", sequence)
                .field("phase", phase)
                .finish(),
            Self::Message {
                sequence,
                lifecycle,
                text_delta,
                thinking_delta,
                message_text,
                thinking_text,
                ..
            } => formatter
                .debug_struct("Message")
                .field("sequence", sequence)
                .field("lifecycle", lifecycle)
                .field("has_text_delta", &text_delta.is_some())
                .field("has_thinking_delta", &thinking_delta.is_some())
                .field(
                    "message_text_len",
                    &message_text.as_ref().map_or(0, String::len),
                )
                .field(
                    "thinking_text_len",
                    &thinking_text.as_ref().map_or(0, String::len),
                )
                .finish_non_exhaustive(),
            Self::Tool {
                sequence,
                phase,
                name,
                input,
                input_text,
                summary,
                output,
                is_error,
                ..
            } => formatter
                .debug_struct("Tool")
                .field("sequence", sequence)
                .field("phase", phase)
                .field("has_name", &name.is_some())
                .field("has_input", &input.is_some())
                .field(
                    "input_text_len",
                    &input_text.as_ref().map_or(0, String::len),
                )
                .field("summary_len", &summary.as_ref().map_or(0, String::len))
                .field("has_output", &output.is_some())
                .field("is_error", is_error)
                .finish_non_exhaustive(),
            Self::Approval {
                sequence,
                phase,
                option_ids,
                ..
            } => formatter
                .debug_struct("Approval")
                .field("sequence", sequence)
                .field("phase", phase)
                .field("option_count", &option_ids.len())
                .finish_non_exhaustive(),
        }
    }
}

/// A renderer-safe event together with the native source identity that produced it.
///
/// Only the bounded [`RendererEvent`] projection crosses this seam; native event
/// envelopes and their payloads are never carried by this type.
#[derive(Clone, Eq, PartialEq)]
pub struct RendererEventEnvelope {
    route_key: String,
    session_key: String,
    run_id: String,
    source_cursor: u64,
    source_epoch: Option<u64>,
    event: RendererEvent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionSubscriptionItem {
    Event(RendererEventEnvelope),
    Recovery {
        route_key: String,
        session_key: String,
        run_id: String,
        recovery: SessionRecovery,
    },
}

impl RendererEventEnvelope {
    pub fn new(
        route_key: String,
        session_key: String,
        run_id: String,
        source_cursor: u64,
        source_epoch: Option<u64>,
        event: RendererEvent,
    ) -> Self {
        Self {
            route_key,
            session_key,
            run_id,
            source_cursor,
            source_epoch,
            event,
        }
    }

    pub fn route_key(&self) -> &str {
        &self.route_key
    }

    pub fn session_key(&self) -> &str {
        &self.session_key
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn source_cursor(&self) -> u64 {
        self.source_cursor
    }

    pub const fn source_epoch(&self) -> Option<u64> {
        self.source_epoch
    }

    pub fn event(&self) -> &RendererEvent {
        &self.event
    }

    pub fn into_event(self) -> RendererEvent {
        self.event
    }
}

impl fmt::Debug for RendererEventEnvelope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RendererEventEnvelope")
            .field("route_key", &self.route_key)
            .field("session_key", &self.session_key)
            .field("run_id", &self.run_id)
            .field("source_cursor", &self.source_cursor)
            .field("source_epoch", &self.source_epoch)
            .field("event", &self.event)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RendererRunPhase {
    Started,
    WaitingForApproval,
    CancellationRequested,
    Completed,
    Cancelled,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RendererMessageLifecycle {
    Started,
    Delta,
    Completed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RendererToolPhase {
    Started,
    Updated,
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RendererApprovalPhase {
    Requested,
    Resolved,
}

impl RendererEvent {
    fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Run {
                phase: RendererRunPhase::Completed
                    | RendererRunPhase::Cancelled
                    | RendererRunPhase::Failed
                    | RendererRunPhase::Interrupted,
                ..
            }
        )
    }
}

fn receipt_reading_admitted(phase: foundation::process::supervision::SupervisorPhase) -> bool {
    phase == foundation::process::supervision::SupervisorPhase::Running
}

fn pending_approvals_from_snapshot(
    approvals: Vec<crate::session::approval::ApprovalRecord>,
) -> Vec<(ApprovalId, Vec<OptionId>)> {
    approvals
        .into_iter()
        .map(|approval| {
            (
                approval.approval_id().clone(),
                approval.option_ids().to_vec(),
            )
        })
        .collect()
}

async fn load_or_create_role_session(
    client: &AppServerClient,
    session_id: RoleSessionId,
    cwd: RoleSessionCwd,
) -> InvocationOutcome<RoleSessionOwnership, RoleSessionError> {
    match client
        .load_session(SessionLoadParams::new(session_id.native()))
        .await
    {
        Ok(session) if session.session_id == session_id.native() => InvocationOutcome::Succeeded(
            RoleSessionOwnership::Existing(RoleSessionId::from_native(session.session_id)),
        ),
        Ok(_) => InvocationOutcome::Unknown,
        Err(AppServerClientError::SessionNotFound) => {
            match client.create_session(cwd.create_params(&session_id)).await {
                InvocationOutcome::Succeeded(session)
                    if session.session_id == session_id.native() =>
                {
                    InvocationOutcome::Succeeded(RoleSessionOwnership::Created(
                        RoleSessionId::from_native(session.session_id),
                    ))
                }
                InvocationOutcome::Succeeded(_)
                | InvocationOutcome::Cancelled
                | InvocationOutcome::Unknown => InvocationOutcome::Unknown,
                InvocationOutcome::TargetRejected(error) => {
                    InvocationOutcome::TargetRejected(RoleSessionError::Client(error))
                }
            }
        }
        Err(AppServerClientError::ConnectionClosed | AppServerClientError::Protocol) => {
            InvocationOutcome::Unknown
        }
        Err(error) => InvocationOutcome::TargetRejected(RoleSessionError::Client(error)),
    }
}

struct RendererProjection {
    run_id: String,
    source_cursor: u64,
    event: RendererEvent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RendererProjectionFailure {
    Gap {
        expected: Sequence,
        received: Sequence,
    },
    Stale {
        cursor: Sequence,
        received: Sequence,
    },
    Rejected {
        sequence: Sequence,
        reason: ProjectionRecoveryReason,
    },
}

#[cfg(test)]
fn renderer_event_step(
    projector: &mut SessionEventProjector,
    envelope: crate::session::protocol_event::EventEnvelope,
) -> Result<Option<RendererEvent>, ()> {
    Ok(renderer_projection_step(projector, envelope)
        .map_err(|_| ())?
        .map(|projection| projection.event))
}

fn renderer_projection_step(
    projector: &mut SessionEventProjector,
    envelope: crate::session::protocol_event::EventEnvelope,
) -> Result<Option<RendererProjection>, RendererProjectionFailure> {
    let run_id = envelope
        .run_id
        .as_ref()
        .map(|run_id| run_id.as_str().to_owned());
    log_model_run_trace(&envelope);
    match projector.project(envelope) {
        EventProjectionResult::Projected(projected) => Ok(renderer_event(
            projected.sequence().get(),
            projected.activity(),
        )
        .and_then(|event| {
            run_id.map(|run_id| RendererProjection {
                run_id,
                source_cursor: projected.sequence().get(),
                event,
            })
        })),
        EventProjectionResult::OutOfRun { .. }
        | EventProjectionResult::Duplicate { .. }
        | EventProjectionResult::Rejected {
            reason: EventRejection::Unsupported,
            ..
        } => Ok(None),
        EventProjectionResult::Rejected {
            sequence,
            reason: EventRejection::Malformed,
        } => Err(RendererProjectionFailure::Rejected {
            sequence,
            reason: ProjectionRecoveryReason::Malformed,
        }),
        EventProjectionResult::Gap { expected, received } => {
            Err(RendererProjectionFailure::Gap { expected, received })
        }
        EventProjectionResult::Stale { cursor, received } => {
            Err(RendererProjectionFailure::Stale { cursor, received })
        }
        EventProjectionResult::OutOfSession { sequence } => {
            Err(RendererProjectionFailure::Rejected {
                sequence,
                reason: ProjectionRecoveryReason::OutOfSession,
            })
        }
    }
}

fn log_model_run_trace(envelope: &crate::session::protocol_event::EventEnvelope) {
    if !matcha_trace_enabled() || envelope.event.event_type() != "run.trace" {
        return;
    }

    let value = envelope.event.as_value();
    let Some(stage) = value.get("stage").and_then(Value::as_str) else {
        return;
    };
    if !matches!(
        stage,
        "worker.session.initialize.model"
            | "query_engine.model.resolved"
            | "query.api.loop.start"
            | "query.api.streaming.start"
            | "api.request.sent"
            | "api.response.headers"
            | "api.stream.first_chunk"
            | "api.stream.message_start"
            | "api.stream.content_block_start"
            | "api.stream.first_content_delta"
            | "api.stream.first_text_delta"
            | "api.stream.content_block_stop"
            | "api.stream.message_delta.stop_reason"
            | "api.stream.message_stop"
            | "api.stream.watchdog.timeout"
            | "api.stream.loop.end"
            | "api.stream.error"
    ) {
        return;
    }

    let mut details = Map::new();
    for key in [
        "model",
        "configuredModel",
        "promptModelOverride",
        "mainLoopModel",
        "currentModel",
        "queryDepth",
        "attempt",
        "requestId",
        "eventType",
        "blockIndex",
        "blockType",
        "deltaType",
        "textLength",
        "stopReason",
        "timeoutMs",
        "errorName",
        "hasProviderRuntime",
        "providerRuntimeKind",
        "hasBaseUrl",
        "hasApiKey",
        "provider",
        "wireProtocol",
        "transport",
        "phase",
        "elapsedMs",
        "rawEventType",
        "adapterEventType",
        "rawChunkBytes",
        "rawFrameCount",
        "bodyChunkCount",
        "rawDone",
        "deltaChars",
        "emittedEventCount",
    ] {
        if let Some(value) = safe_trace_detail(value, key) {
            details.insert(key.to_owned(), value);
        }
    }

    eprintln!(
        "{}",
        serde_json::json!({
            "prefix": "session-trace",
            "source": "runtime-host",
            "stage": stage,
            "payload": {
                "bridgeStage": "runtime.matcha.run-trace.model",
                "sessionKey": bounded_renderer_id(envelope.session_id.as_str()),
                "runId": envelope.run_id.as_ref().and_then(|run_id| bounded_renderer_id(run_id.as_str())),
                "workerId": envelope.worker_id.as_ref().and_then(|worker_id| bounded_renderer_id(worker_id.as_str())),
                "seq": envelope.seq.get(),
                "nativeStage": stage,
                "details": details,
            }
        })
    );
}

fn matcha_trace_enabled() -> bool {
    std::env::var(MATCHACLAW_SESSION_TRACE).as_deref() == Ok("1")
        || std::env::var(MATCHA_AGENT_RUN_TRACE).as_deref() == Ok("1")
}

fn log_renderer_subscription_trace(trace_id: Option<&str>, stage: &str, payload: Value) {
    if trace_id.is_none() || !matcha_trace_enabled() {
        return;
    }
    let mut event = Map::new();
    event.insert("prefix".into(), Value::String("session-trace".into()));
    event.insert("source".into(), Value::String("runtime-host".into()));
    event.insert(
        "traceId".into(),
        Value::String(trace_id.expect("checked trace id").to_owned()),
    );
    event.insert("stage".into(), Value::String(stage.to_owned()));
    event.insert("at".into(), Value::Number(now_millis().into()));
    if let Value::Object(fields) = payload {
        event.extend(fields);
    }
    eprintln!("{}", Value::Object(event));
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn app_server_client_error_trace_kind(error: AppServerClientError) -> &'static str {
    match error {
        AppServerClientError::InvalidEndpoint => "invalid-endpoint",
        AppServerClientError::HealthDeadline => "health-deadline",
        AppServerClientError::HealthFailed => "health-failed",
        AppServerClientError::UpgradeDeadline => "upgrade-deadline",
        AppServerClientError::UpgradeFailed => "upgrade-failed",
        AppServerClientError::InitializeFailed => "initialize-failed",
        AppServerClientError::RequestDeadline => "request-deadline",
        AppServerClientError::ConnectionClosed => "connection-closed",
        AppServerClientError::UnknownResponse => "unknown-response",
        AppServerClientError::Transport => "transport",
        AppServerClientError::Protocol => "protocol",
        AppServerClientError::PeerRejected => "peer-rejected",
        AppServerClientError::SessionNotFound => "session-not-found",
        AppServerClientError::EventRecoveryRequired => "event-recovery-required",
        AppServerClientError::CloseFailed => "close-failed",
    }
}

fn safe_trace_detail(event: &Value, key: &str) -> Option<Value> {
    let value = event.get("details")?.get(key)?;
    match value {
        Value::String(text) if text.len() <= 256 && !text.chars().any(char::is_control) => {
            Some(Value::String(text.clone()))
        }
        Value::Number(number) => Some(Value::Number(number.clone())),
        Value::Bool(value) => Some(Value::Bool(*value)),
        Value::Null => Some(Value::Null),
        _ => None,
    }
}

fn renderer_subscription_projection_step(
    projector: &mut SessionEventProjector,
    replay_cursor: Sequence,
    envelope: crate::session::protocol_event::EventEnvelope,
) -> Result<Option<RendererProjection>, RendererProjectionFailure> {
    if envelope.seq.get() <= replay_cursor.get() {
        return Ok(None);
    }
    let event_type = envelope.event.event_type().to_owned();
    let seq = envelope.seq.get();
    let session_key = envelope.session_id.as_str().to_owned();
    let run_id = envelope.run_id.as_ref().map(|r| r.as_str().to_owned());
    let result = renderer_projection_step(projector, envelope);

    let log_json = match &result {
        Ok(Some(p)) => serde_json::json!({
            "sessionKey": session_key,
            "runId": run_id,
            "seq": seq,
            "eventType": event_type,
            "result": "Projected",
            "eventKind": match &p.event {
                RendererEvent::Run { .. } => "run",
                RendererEvent::Message { .. } => "message",
                RendererEvent::Tool { .. } => "tool",
                RendererEvent::Approval { .. } => "approval",
            }
        }),
        Ok(None) => serde_json::json!({
            "sessionKey": session_key,
            "runId": run_id,
            "seq": seq,
            "eventType": event_type,
            "result": "None"
        }),
        Err(e) => serde_json::json!({
            "sessionKey": session_key,
            "runId": run_id,
            "seq": seq,
            "eventType": event_type,
            "result": "Err",
            "error": format!("{:?}", e)
        }),
    };

    eprintln!(
        "{}",
        serde_json::json!({
            "prefix": "session-trace",
            "source": "runtime-host",
            "stage": "runtime.matcha.renderer-projection",
            "payload": log_json
        })
    );

    result
}

fn renderer_projection_recovery(
    session_id: SessionId,
    native_cursor: Sequence,
    source_epoch: u64,
    failure: RendererProjectionFailure,
) -> SessionRecovery {
    match failure {
        RendererProjectionFailure::Gap { expected, received } => SessionRecovery::from_observation(
            session_id,
            SessionEventObservation::Gap { expected, received },
        )
        .expect("gap projection failure always produces recovery"),
        RendererProjectionFailure::Stale { cursor, received } => SessionRecovery::from_observation(
            session_id,
            SessionEventObservation::Stale { cursor, received },
        )
        .expect("stale projection failure always produces recovery"),
        RendererProjectionFailure::Rejected { sequence, reason } => {
            SessionRecovery::from_projection_rejection(session_id, sequence, native_cursor, reason)
        }
    }
    .with_source_epoch(source_epoch)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SubscriptionDelivery {
    Sent,
    Recovering,
    Closed,
}

async fn send_renderer_event(
    events: &mpsc::Sender<SessionIngressEvent>,
    event: RendererEventEnvelope,
    session_id: SessionId,
    native_cursor: Sequence,
    source_epoch: u64,
) -> SubscriptionDelivery {
    let route_key = event.route_key().to_owned();
    let session_key = event.session_key().to_owned();
    let run_id = event.run_id().to_owned();
    let Some(event) = matcha_session_event(SessionSubscriptionItem::Event(event)) else {
        return SubscriptionDelivery::Sent;
    };
    match events.try_send(event) {
        Ok(()) => SubscriptionDelivery::Sent,
        Err(mpsc::error::TrySendError::Closed(_)) => SubscriptionDelivery::Closed,
        Err(mpsc::error::TrySendError::Full(_)) => {
            let recovery = SessionRecovery::from_raw_event(
                session_id.clone(),
                native_cursor,
                &RawEvent::Overflow,
            )
            .expect("overflow raw event always produces recovery")
            .with_source_epoch(source_epoch);
            if send_recovery(events, &route_key, &session_key, &run_id, recovery).await {
                SubscriptionDelivery::Recovering
            } else {
                SubscriptionDelivery::Closed
            }
        }
    }
}

async fn send_recovery(
    events: &mpsc::Sender<SessionIngressEvent>,
    route_key: &str,
    session_key: &str,
    run_id: &str,
    recovery: SessionRecovery,
) -> bool {
    let Some(event) = matcha_session_event(SessionSubscriptionItem::Recovery {
        route_key: route_key.to_owned(),
        session_key: session_key.to_owned(),
        run_id: run_id.to_owned(),
        recovery,
    }) else {
        return false;
    };
    match events.try_send(event) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Closed(_)) => false,
        Err(mpsc::error::TrySendError::Full(item)) => events.send(item).await.is_ok(),
    }
}

fn bounded_renderer_id(value: &str) -> Option<String> {
    (value.len() <= 128 && !value.chars().any(char::is_control)).then(|| value.to_owned())
}

fn renderer_event(sequence: u64, activity: &EventActivity) -> Option<RendererEvent> {
    match activity {
        EventActivity::Run(RunLifecycle::Started) => Some(RendererEvent::Run {
            sequence,
            phase: RendererRunPhase::Started,
        }),
        EventActivity::Run(RunLifecycle::WaitingForApproval) => Some(RendererEvent::Run {
            sequence,
            phase: RendererRunPhase::WaitingForApproval,
        }),
        EventActivity::Run(RunLifecycle::CancellationRequested) => Some(RendererEvent::Run {
            sequence,
            phase: RendererRunPhase::CancellationRequested,
        }),
        EventActivity::Run(RunLifecycle::Completed) => Some(RendererEvent::Run {
            sequence,
            phase: RendererRunPhase::Completed,
        }),
        EventActivity::Run(RunLifecycle::Cancelled) => Some(RendererEvent::Run {
            sequence,
            phase: RendererRunPhase::Cancelled,
        }),
        EventActivity::Run(RunLifecycle::Failed) => Some(RendererEvent::Run {
            sequence,
            phase: RendererRunPhase::Failed,
        }),
        EventActivity::Run(RunLifecycle::Interrupted) => Some(RendererEvent::Run {
            sequence,
            phase: RendererRunPhase::Interrupted,
        }),
        EventActivity::Message(message) => Some(RendererEvent::Message {
            sequence,
            message_id: bounded_renderer_id(message.message_id().as_str())?,
            lifecycle: match message.lifecycle() {
                MessageLifecycle::Started => RendererMessageLifecycle::Started,
                MessageLifecycle::Delta => RendererMessageLifecycle::Delta,
                MessageLifecycle::Completed => RendererMessageLifecycle::Completed,
            },
            text_delta: message.text_delta().map(ToOwned::to_owned),
            thinking_delta: message.thinking_delta().map(ToOwned::to_owned),
            message_text: message.message_text().map(ToOwned::to_owned),
            thinking_text: message.thinking_text().map(ToOwned::to_owned),
        }),
        EventActivity::Tool(tool) => Some(RendererEvent::Tool {
            sequence,
            tool_call_id: bounded_renderer_id(tool.tool_call_id().as_str())?,
            name: tool.name().and_then(bounded_renderer_id),
            phase: match tool.phase() {
                ToolActivityPhase::Started => RendererToolPhase::Started,
                ToolActivityPhase::Updated => RendererToolPhase::Updated,
                ToolActivityPhase::Completed => RendererToolPhase::Completed,
                ToolActivityPhase::Failed => RendererToolPhase::Failed,
            },
            input: tool.input().cloned(),
            input_text: tool.input_text().map(ToOwned::to_owned),
            summary: tool.summary().map(ToOwned::to_owned),
            output: tool.output().cloned(),
            is_error: tool.is_error(),
        }),
        EventActivity::Approval(approval) => {
            let (phase, option_ids) = match approval.phase() {
                ApprovalPhase::Requested { options } => (
                    RendererApprovalPhase::Requested,
                    options
                        .iter()
                        .map(|option| bounded_renderer_id(option.option_id().as_str()))
                        .collect::<Option<Vec<_>>>()?,
                ),
                ApprovalPhase::Resolved(_) => (RendererApprovalPhase::Resolved, Vec::new()),
            };
            Some(RendererEvent::Approval {
                sequence,
                approval_id: bounded_renderer_id(approval.approval_id().as_str())?,
                phase,
                option_ids,
            })
        }
        EventActivity::Run(RunLifecycle::Queued) | EventActivity::Ignored => None,
    }
}

impl MatchaPeer {
    pub(super) fn new(
        handle: SupervisorHandle,
        supervisor: Supervisor,
        working_directory: PathBuf,
        endpoint: AppServerEndpoint,
        secret: Arc<Secret>,
    ) -> Self {
        Self {
            handle,
            supervisor,
            working_directory,
            endpoint,
            secret,
            source_epoch: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.handle.snapshot()
    }

    fn current_source_epoch(&self) -> u64 {
        self.source_epoch.load(Ordering::Relaxed)
    }

    pub fn advance_source_epoch(&self) -> u64 {
        self.source_epoch.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn role_session_prompt_handle(&self) -> RoleSessionPromptHandle {
        RoleSessionPromptHandle {
            handle: self.handle.clone(),
            endpoint: self.endpoint,
            secret: Arc::clone(&self.secret),
            source_epoch: Arc::clone(&self.source_epoch),
        }
    }

    pub fn session_handle(&self) -> MatchaPeerSessionHandle {
        MatchaPeerSessionHandle {
            handle: self.handle.clone(),
            working_directory: self.working_directory.clone(),
            endpoint: self.endpoint,
            secret: Arc::clone(&self.secret),
            source_epoch: Arc::clone(&self.source_epoch),
        }
    }

    pub fn role_session_native_handle(&self) -> RoleSessionNativeHandle {
        RoleSessionNativeHandle {
            handle: self.handle.clone(),
            endpoint: self.endpoint,
            secret: Arc::clone(&self.secret),
        }
    }

    pub async fn list_history(&self) -> HistoryListResult {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return crate::session::history::HistoryResult::Unavailable;
        }
        crate::session::history::list(self.endpoint, &self.secret).await
    }

    pub async fn load_history(
        &self,
        session_id: SessionId,
        request: HydrationWindowRequest,
    ) -> HistoryLoadResult {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return crate::session::history::HistoryResult::Unavailable;
        }
        crate::session::history::load(self.endpoint, &self.secret, session_id, request).await
    }

    /// Reads the native canonical facts required to rebuild session state.
    pub async fn read_canonical_session(
        &self,
        session_id: SessionId,
        request: HydrationWindowRequest,
    ) -> CanonicalSessionReadResult {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return crate::session::history::HistoryResult::Unavailable;
        }
        read_canonical_session(self.endpoint, &self.secret, session_id, request).await
    }

    pub async fn create_session(
        &self,
        session_id: SessionId,
    ) -> InvocationOutcome<SessionId, AppServerClientError> {
        super::session_create::create(self, session_id).await
    }

    pub(super) fn is_running(&self) -> bool {
        receipt_reading_admitted(self.snapshot().phase())
    }

    pub async fn create_role_session(
        &self,
        session_id: RoleSessionId,
    ) -> InvocationOutcome<RoleSessionOwnership, RoleSessionError> {
        let Some(working_directory) = self.working_directory.to_str() else {
            return InvocationOutcome::TargetRejected(RoleSessionError::Client(
                AppServerClientError::Protocol,
            ));
        };
        let cwd = match RoleSessionCwd::try_new(working_directory.to_owned()) {
            Ok(cwd) => cwd,
            Err(_) => {
                return InvocationOutcome::TargetRejected(RoleSessionError::Client(
                    AppServerClientError::Protocol,
                ));
            }
        };
        let client = match self.connect_role_session_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = load_or_create_role_session(&client, session_id, cwd).await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn subscribe_renderer_events(
        &self,
        session_id: SessionId,
        renderer_session_key: String,
        run_id: RunId,
        route_key: String,
        events: mpsc::Sender<SessionIngressEvent>,
        trace_id: Option<String>,
    ) -> Result<tokio::task::JoinHandle<()>, RendererSubscriptionError> {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return Err(RendererSubscriptionError::RuntimeUnavailable);
        }
        subscribe_renderer_events_raw(
            self.endpoint,
            &self.secret,
            self.current_source_epoch(),
            session_id,
            renderer_session_key,
            run_id,
            route_key,
            events,
            trace_id,
        )
        .await
    }

    pub async fn prompt_session(
        &self,
        params: crate::session::request::SessionPromptParams,
    ) -> InvocationOutcome<crate::session::model::SessionPromptResult, AppServerClientError> {
        let (events, _updates) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        let client = match AppServerClient::connect_and_initialize(
            self.endpoint,
            &self.secret,
            events,
        )
        .await
        {
            Ok((client, _)) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = client.prompt_session(params).await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn pending_approvals(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<(ApprovalId, Vec<OptionId>)>, AppServerClientError> {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return Err(AppServerClientError::ConnectionClosed);
        }
        let (events, _updates) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        let (client, _) =
            AppServerClient::connect_and_initialize(self.endpoint, &self.secret, events).await?;
        let approvals = client
            .snapshot_session(SessionSnapshotParams::new(session_id))
            .await
            .map(|snapshot| pending_approvals_from_snapshot(snapshot.pending_approvals));
        client.finish_with_cleanup(approvals).await
    }

    pub async fn respond_to_approval(
        &self,
        params: crate::session::approval::ApprovalRespondParams,
    ) -> InvocationOutcome<(), AppServerClientError> {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return InvocationOutcome::TargetRejected(AppServerClientError::ConnectionClosed);
        }
        let (events, _updates) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        let client = match AppServerClient::connect_and_initialize(
            self.endpoint,
            &self.secret,
            events,
        )
        .await
        {
            Ok((client, _)) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = client.respond_to_approval(params).await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn set_session_model(
        &self,
        params: SessionSetModelParams,
    ) -> InvocationOutcome<crate::session::model::SessionRecord, AppServerClientError> {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return InvocationOutcome::TargetRejected(AppServerClientError::ConnectionClosed);
        }
        let (events, _updates) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        let client = match AppServerClient::connect_and_initialize(
            self.endpoint,
            &self.secret,
            events,
        )
        .await
        {
            Ok((client, _)) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = client.set_session_model(params).await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn cancel_session(
        &self,
        params: crate::session::request::SessionCancelParams,
    ) -> InvocationOutcome<crate::session::model::SessionCancelResult, AppServerClientError> {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return InvocationOutcome::TargetRejected(AppServerClientError::ConnectionClosed);
        }
        let (events, _updates) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        let client = match AppServerClient::connect_and_initialize(
            self.endpoint,
            &self.secret,
            events,
        )
        .await
        {
            Ok((client, _)) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = client.cancel_session(params).await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn close_role_session(
        &self,
        session_id: RoleSessionId,
    ) -> InvocationOutcome<(), RoleSessionError> {
        let client = match self.connect_role_session_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = client
            .close_session(SessionCloseParams::new(session_id.native()))
            .await;
        let outcome = match outcome {
            InvocationOutcome::Succeeded(_) => InvocationOutcome::Succeeded(()),
            InvocationOutcome::TargetRejected(error) => {
                InvocationOutcome::TargetRejected(RoleSessionError::Client(error))
            }
            InvocationOutcome::Cancelled => InvocationOutcome::Cancelled,
            InvocationOutcome::Unknown => InvocationOutcome::Unknown,
        };
        client.finish_with_cleanup(outcome).await
    }

    pub async fn prompt_role_session(
        &self,
        session_id: &RoleSessionId,
        prompt: RolePrompt,
    ) -> InvocationOutcome<RoleRunId, RoleSessionError> {
        self.prompt_role_session_with_run_id(session_id, prompt, None)
            .await
    }

    pub async fn prompt_role_session_with_run_id(
        &self,
        session_id: &RoleSessionId,
        prompt: RolePrompt,
        run_id: Option<RoleRunId>,
    ) -> InvocationOutcome<RoleRunId, RoleSessionError> {
        let client = match self.connect_role_session_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let params = prompt.into_params(session_id);
        let params = match run_id {
            Some(run_id) => params.with_run_id(run_id.native()),
            None => params,
        };
        let outcome = match client.prompt_session(params).await {
            InvocationOutcome::Succeeded(result) => {
                InvocationOutcome::Succeeded(RoleRunId::from_native(result.run_id))
            }
            InvocationOutcome::TargetRejected(error) => {
                InvocationOutcome::TargetRejected(RoleSessionError::Client(error))
            }
            InvocationOutcome::Cancelled => InvocationOutcome::Cancelled,
            InvocationOutcome::Unknown => InvocationOutcome::Unknown,
        };
        client.finish_with_cleanup(outcome).await
    }

    async fn connect_role_session_client(&self) -> Result<AppServerClient, RoleSessionError> {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return Err(RoleSessionError::RuntimeUnavailable);
        }
        let (events, _updates) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        AppServerClient::connect_and_initialize(self.endpoint, &self.secret, events)
            .await
            .map(|(client, _)| client)
            .map_err(RoleSessionError::Client)
    }

    pub fn lifecycle_handle(&self) -> MatchaPeerLifecycleHandle {
        MatchaPeerLifecycleHandle {
            handle: self.handle.clone(),
            source_epoch: Arc::clone(&self.source_epoch),
        }
    }

    pub async fn request_start(&self) -> Result<(), LifecycleError> {
        self.lifecycle_handle().request_start().await
    }

    pub async fn start(&self) -> Result<StartOutcome, LifecycleError> {
        self.lifecycle_handle().start().await
    }

    pub async fn stop(&self) -> Result<TerminationCompletion, LifecycleError> {
        self.lifecycle_handle().stop().await
    }

    pub async fn restart(&self) -> Result<RestartOutcome, LifecycleError> {
        self.lifecycle_handle().restart().await
    }

    pub async fn confirm_shutdown(&self) -> Result<ShutdownOutcome, ShutdownError> {
        match self.handle.shutdown().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.map_err(ShutdownError::from)
            }
            CommandReceipt::AlreadySatisfied => self.confirmed_shutdown_outcome(),
            CommandReceipt::Busy => Err(ShutdownError::Busy),
            CommandReceipt::Rejected(rejection) => Err(ShutdownError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(ShutdownError::ShuttingDown),
        }
    }

    pub async fn join(mut self) -> Result<(), JoinError> {
        self.supervisor.join().await.map_err(JoinError::from)
    }

    fn confirmed_shutdown_outcome(&self) -> Result<ShutdownOutcome, ShutdownError> {
        match self.handle.snapshot().last_outcome() {
            Some(foundation::process::supervision::SupervisorOutcome::ShutDown(outcome)) => {
                Ok(outcome.clone())
            }
            _ => Err(ShutdownError::MissingOutcome),
        }
    }
}

impl MatchaPeerLifecycleHandle {
    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.handle.snapshot()
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.handle.subscribe()
    }

    pub fn advance_source_epoch(&self) -> u64 {
        self.source_epoch.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn request_start(&self) -> Result<(), LifecycleError> {
        match self.handle.start().await {
            CommandReceipt::Accepted(_)
            | CommandReceipt::Shared(_)
            | CommandReceipt::AlreadySatisfied => Ok(()),
            CommandReceipt::Busy => Err(LifecycleError::Busy),
            CommandReceipt::Rejected(rejection) => Err(LifecycleError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(LifecycleError::ShuttingDown),
        }
    }

    pub async fn start(&self) -> Result<StartOutcome, LifecycleError> {
        match self.handle.start().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.map_err(LifecycleError::from)
            }
            CommandReceipt::AlreadySatisfied => Ok(StartOutcome::Started),
            CommandReceipt::Busy => Err(LifecycleError::Busy),
            CommandReceipt::Rejected(rejection) => Err(LifecycleError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(LifecycleError::ShuttingDown),
        }
    }

    pub async fn stop(&self) -> Result<TerminationCompletion, LifecycleError> {
        match self.handle.stop().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.map_err(LifecycleError::from)
            }
            CommandReceipt::AlreadySatisfied => Err(LifecycleError::AlreadySatisfied),
            CommandReceipt::Busy => Err(LifecycleError::Busy),
            CommandReceipt::Rejected(rejection) => Err(LifecycleError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(LifecycleError::ShuttingDown),
        }
    }

    pub async fn restart(&self) -> Result<RestartOutcome, LifecycleError> {
        match self.handle.restart().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.map_err(LifecycleError::from)
            }
            CommandReceipt::AlreadySatisfied => Err(LifecycleError::AlreadySatisfied),
            CommandReceipt::Busy => Err(LifecycleError::Busy),
            CommandReceipt::Rejected(rejection) => Err(LifecycleError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(LifecycleError::ShuttingDown),
        }
    }
}

async fn subscribe_renderer_events_raw(
    endpoint: AppServerEndpoint,
    secret: &Arc<Secret>,
    source_epoch: u64,
    session_id: SessionId,
    renderer_session_key: String,
    run_id: RunId,
    route_key: String,
    events: mpsc::Sender<SessionIngressEvent>,
    trace_id: Option<String>,
) -> Result<tokio::task::JoinHandle<()>, RendererSubscriptionError> {
    log_renderer_subscription_trace(
        trace_id.as_deref(),
        "runtime.matcha.renderer-subscribe.connect-start",
        serde_json::json!({
            "sessionId": session_id.as_str(),
            "runId": run_id.as_str(),
            "routeKey": route_key.as_str(),
            "sourceEpoch": source_epoch,
        }),
    );
    let (client, _) = match AppServerClient::connect_and_initialize_raw_only(endpoint, secret).await
    {
        Ok(connected) => connected,
        Err(error) => {
            log_renderer_subscription_trace(
                trace_id.as_deref(),
                "runtime.matcha.renderer-subscribe.connect-failed",
                serde_json::json!({ "error": app_server_client_error_trace_kind(error) }),
            );
            return Err(RendererSubscriptionError::Client(error));
        }
    };
    log_renderer_subscription_trace(
        trace_id.as_deref(),
        "runtime.matcha.renderer-subscribe.connect-ready",
        serde_json::json!({}),
    );
    let mut raw_events = client.raw_events();
    log_renderer_subscription_trace(
        trace_id.as_deref(),
        "runtime.matcha.renderer-subscribe.request-start",
        serde_json::json!({
            "sessionId": session_id.as_str(),
            "afterSeq": null,
        }),
    );
    let subscription = match client
        .subscribe_events_with_cursor(session_id.clone(), None)
        .await
    {
        Ok(subscription) => subscription,
        Err(error) => {
            log_renderer_subscription_trace(
                trace_id.as_deref(),
                "runtime.matcha.renderer-subscribe.request-failed",
                serde_json::json!({ "error": app_server_client_error_trace_kind(error) }),
            );
            return Err(RendererSubscriptionError::Client(error));
        }
    };
    let cursor = match subscription {
        EventSubscriptionCursor::Subscribed(replay) => {
            log_renderer_subscription_trace(
                trace_id.as_deref(),
                "runtime.matcha.renderer-subscribe.response",
                serde_json::json!({
                    "result": "subscribed",
                    "cursor": replay.cursor().get(),
                }),
            );
            replay.cursor()
        }
        EventSubscriptionCursor::ClientNotFound => {
            log_renderer_subscription_trace(
                trace_id.as_deref(),
                "runtime.matcha.renderer-subscribe.response",
                serde_json::json!({ "result": "client-not-found" }),
            );
            let _ = client.close().await;
            return Err(RendererSubscriptionError::Client(
                AppServerClientError::SessionNotFound,
            ));
        }
        EventSubscriptionCursor::ClientRequired => {
            log_renderer_subscription_trace(
                trace_id.as_deref(),
                "runtime.matcha.renderer-subscribe.response",
                serde_json::json!({ "result": "client-required" }),
            );
            let _ = client.close().await;
            return Err(RendererSubscriptionError::Client(
                AppServerClientError::PeerRejected,
            ));
        }
    };
    let task_trace_id = trace_id;
    Ok(tokio::spawn(async move {
        let mut replay_cursor = cursor;
        let mut projector =
            SessionEventProjector::resume_after(session_id.clone(), run_id.clone(), replay_cursor);
        loop {
            if client.is_closed() {
                log_renderer_subscription_trace(
                    task_trace_id.as_deref(),
                    "runtime.matcha.renderer-subscribe.stream-closed",
                    serde_json::json!({
                        "reason": "client-closed",
                        "cursor": projector.cursor().get(),
                    }),
                );
                let recovery = SessionRecovery::from_raw_event(
                    session_id.clone(),
                    projector.cursor(),
                    &RawEvent::Closed,
                )
                .expect("closed raw event always produces recovery")
                .with_source_epoch(source_epoch);
                let _ = send_recovery(
                    &events,
                    &route_key,
                    &renderer_session_key,
                    run_id.as_str(),
                    recovery,
                )
                .await;
                break;
            }
            let recovery = match raw_events.recv().await {
                Ok(RawEvent::Envelope(event)) => {
                    match renderer_subscription_projection_step(
                        &mut projector,
                        replay_cursor,
                        event,
                    ) {
                        Ok(Some(projection)) => {
                            let terminal = projection.event.is_terminal();
                            let event = RendererEventEnvelope::new(
                                route_key.clone(),
                                renderer_session_key.clone(),
                                projection.run_id,
                                projection.source_cursor,
                                Some(source_epoch),
                                projection.event,
                            );
                            match send_renderer_event(
                                &events,
                                event,
                                session_id.clone(),
                                projector.cursor(),
                                source_epoch,
                            )
                            .await
                            {
                                SubscriptionDelivery::Sent if !terminal => continue,
                                SubscriptionDelivery::Sent
                                | SubscriptionDelivery::Recovering
                                | SubscriptionDelivery::Closed => break,
                            }
                        }
                        Ok(None) => {
                            continue;
                        }
                        Err(failure) => renderer_projection_recovery(
                            session_id.clone(),
                            projector.cursor(),
                            source_epoch,
                            failure,
                        ),
                    }
                }
                Ok(raw @ (RawEvent::Overflow | RawEvent::Closed)) => {
                    log_renderer_subscription_trace(
                        task_trace_id.as_deref(),
                        "runtime.matcha.renderer-subscribe.stream-closed",
                        serde_json::json!({
                            "reason": match &raw {
                                RawEvent::Overflow => "overflow",
                                RawEvent::Closed => "raw-closed",
                                RawEvent::Envelope(_) => "envelope",
                            },
                            "cursor": projector.cursor().get(),
                        }),
                    );
                    let Some(recovery) = SessionRecovery::from_raw_event(
                        session_id.clone(),
                        projector.cursor(),
                        &raw,
                    ) else {
                        break;
                    };
                    recovery.with_source_epoch(source_epoch)
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    log_renderer_subscription_trace(
                        task_trace_id.as_deref(),
                        "runtime.matcha.renderer-subscribe.stream-closed",
                        serde_json::json!({
                            "reason": "lagged",
                            "skipped": skipped,
                            "cursor": projector.cursor().get(),
                        }),
                    );
                    SessionRecovery::from_broadcast_lagged(
                        session_id.clone(),
                        projector.cursor(),
                        skipped,
                    )
                    .with_source_epoch(source_epoch)
                }
                Err(broadcast::error::RecvError::Closed) => {
                    log_renderer_subscription_trace(
                        task_trace_id.as_deref(),
                        "runtime.matcha.renderer-subscribe.stream-closed",
                        serde_json::json!({
                            "reason": "broadcast-closed",
                            "cursor": projector.cursor().get(),
                        }),
                    );
                    SessionRecovery::from_raw_event(
                        session_id.clone(),
                        projector.cursor(),
                        &RawEvent::Closed,
                    )
                    .expect("closed raw event always produces recovery")
                    .with_source_epoch(source_epoch)
                }
            };
            let should_recover = matches!(recovery, SessionRecovery::RecoveryRequired { .. });
            if !send_recovery(
                &events,
                &route_key,
                &renderer_session_key,
                run_id.as_str(),
                recovery,
            )
            .await
            {
                break;
            }
            if !should_recover {
                break;
            }
            match client
                .recover_events(
                    crate::session::client::EventRecoveryCursor::resume_after(
                        session_id.clone(),
                        projector.cursor(),
                    ),
                    None,
                )
                .await
            {
                Ok(recovered) => {
                    replay_cursor = recovered.cursor().sequence();
                    projector = SessionEventProjector::resume_after(
                        session_id.clone(),
                        run_id.clone(),
                        replay_cursor,
                    );
                }
                Err(error) => {
                    log_renderer_subscription_trace(
                        task_trace_id.as_deref(),
                        "runtime.matcha.renderer-subscribe.recover-failed",
                        serde_json::json!({ "error": app_server_client_error_trace_kind(error) }),
                    );
                    break;
                }
            }
        }
        let _ = client.close().await;
    }))
}

impl MatchaPeerSessionHandle {
    pub async fn subscribe_renderer_events(
        &self,
        session_id: SessionId,
        renderer_session_key: String,
        run_id: RunId,
        route_key: String,
        events: mpsc::Sender<SessionIngressEvent>,
        trace_id: Option<String>,
    ) -> Result<tokio::task::JoinHandle<()>, RendererSubscriptionError> {
        if !receipt_reading_admitted(self.handle.snapshot().phase()) {
            return Err(RendererSubscriptionError::RuntimeUnavailable);
        }
        subscribe_renderer_events_raw(
            self.endpoint,
            &self.secret,
            self.source_epoch.load(Ordering::Relaxed),
            session_id,
            renderer_session_key,
            run_id,
            route_key,
            events,
            trace_id,
        )
        .await
    }

    async fn connect_client(&self) -> Result<AppServerClient, AppServerClientError> {
        if !receipt_reading_admitted(self.handle.snapshot().phase()) {
            return Err(AppServerClientError::ConnectionClosed);
        }
        let (events, _updates) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        AppServerClient::connect_and_initialize(self.endpoint, &self.secret, events)
            .await
            .map(|(client, _)| client)
    }

    pub async fn list_history(&self) -> HistoryListResult {
        if !receipt_reading_admitted(self.handle.snapshot().phase()) {
            return crate::session::history::HistoryResult::Unavailable;
        }
        crate::session::history::list(self.endpoint, &self.secret).await
    }

    pub async fn list_local_history(
        &self,
    ) -> crate::session::history::HistoryResult<crate::session::history::local::LocalHistoryCatalog>
    {
        crate::session::history::local::LocalHistoryReader::for_workspace(
            self.working_directory.clone(),
        )
        .list()
        .await
    }

    pub async fn load_local_history(
        &self,
        session_id: SessionId,
        request: HydrationWindowRequest,
    ) -> HistoryLoadResult {
        crate::session::history::local::LocalHistoryReader::from_environment()
            .load(session_id, request)
            .await
    }

    pub async fn load_local_history_content(
        &self,
        session_id: SessionId,
        content_ref: String,
        offset: u64,
        limit: usize,
    ) -> HistoryContentResult {
        crate::session::history::local::LocalHistoryReader::from_environment()
            .load_content(session_id, content_ref, offset, limit)
            .await
    }

    pub async fn read_canonical_session(
        &self,
        session_id: SessionId,
        request: HydrationWindowRequest,
    ) -> CanonicalSessionReadResult {
        if !receipt_reading_admitted(self.handle.snapshot().phase()) {
            return crate::session::history::HistoryResult::Unavailable;
        }
        read_canonical_session(self.endpoint, &self.secret, session_id, request).await
    }

    pub async fn create_session(
        &self,
        session_id: SessionId,
    ) -> InvocationOutcome<SessionId, AppServerClientError> {
        let client = match self.connect_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome =
            super::session_create::create_native(&client, &self.working_directory, session_id)
                .await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn load_session(
        &self,
        session_id: SessionId,
    ) -> Result<crate::session::model::SessionRecord, AppServerClientError> {
        let client = self.connect_client().await?;
        let outcome = client
            .load_session(SessionLoadParams::new(session_id))
            .await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn prompt_session(
        &self,
        params: crate::session::request::SessionPromptParams,
    ) -> InvocationOutcome<crate::session::model::SessionPromptResult, AppServerClientError> {
        let client = match self.connect_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = client.prompt_session(params).await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn pending_approvals(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<(ApprovalId, Vec<OptionId>)>, AppServerClientError> {
        let client = self.connect_client().await?;
        let approvals = client
            .snapshot_session(SessionSnapshotParams::new(session_id))
            .await
            .map(|snapshot| pending_approvals_from_snapshot(snapshot.pending_approvals));
        client.finish_with_cleanup(approvals).await
    }

    pub async fn respond_to_approval(
        &self,
        params: crate::session::approval::ApprovalRespondParams,
    ) -> InvocationOutcome<(), AppServerClientError> {
        let client = match self.connect_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = client.respond_to_approval(params).await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn set_session_model(
        &self,
        params: SessionSetModelParams,
    ) -> InvocationOutcome<crate::session::model::SessionRecord, AppServerClientError> {
        let client = match self.connect_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = client.set_session_model(params).await;
        client.finish_with_cleanup(outcome).await
    }

    pub async fn cancel_session(
        &self,
        params: crate::session::request::SessionCancelParams,
    ) -> InvocationOutcome<crate::session::model::SessionCancelResult, AppServerClientError> {
        let client = match self.connect_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = client.cancel_session(params).await;
        client.finish_with_cleanup(outcome).await
    }
}

impl RoleSessionNativeHandle {
    async fn connect_client(&self) -> Result<AppServerClient, RoleSessionError> {
        if !receipt_reading_admitted(self.handle.snapshot().phase()) {
            return Err(RoleSessionError::RuntimeUnavailable);
        }
        let (events, _updates) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        AppServerClient::connect_and_initialize(self.endpoint, &self.secret, events)
            .await
            .map(|(client, _)| client)
            .map_err(RoleSessionError::Client)
    }

    pub async fn cancel_role_session(
        &self,
        session_id: RoleSessionId,
    ) -> InvocationOutcome<(), RoleSessionError> {
        let client = match self.connect_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = match client
            .cancel_session(SessionCancelParams::new(session_id.native()))
            .await
        {
            InvocationOutcome::Succeeded(_) => InvocationOutcome::Succeeded(()),
            InvocationOutcome::TargetRejected(error) => {
                InvocationOutcome::TargetRejected(RoleSessionError::Client(error))
            }
            InvocationOutcome::Cancelled => InvocationOutcome::Cancelled,
            InvocationOutcome::Unknown => InvocationOutcome::Unknown,
        };
        client.finish_with_cleanup(outcome).await
    }

    pub async fn close_role_session(
        &self,
        session_id: RoleSessionId,
    ) -> InvocationOutcome<(), RoleSessionError> {
        let client = match self.connect_client().await {
            Ok(client) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let outcome = match client
            .close_session(SessionCloseParams::new(session_id.native()))
            .await
        {
            InvocationOutcome::Succeeded(_) => InvocationOutcome::Succeeded(()),
            InvocationOutcome::TargetRejected(error) => {
                InvocationOutcome::TargetRejected(RoleSessionError::Client(error))
            }
            InvocationOutcome::Cancelled => InvocationOutcome::Cancelled,
            InvocationOutcome::Unknown => InvocationOutcome::Unknown,
        };
        client.finish_with_cleanup(outcome).await
    }
}

impl RoleSessionPromptHandle {
    pub async fn prompt_role_session_with_run_id(
        &self,
        session_id: &RoleSessionId,
        prompt: RolePrompt,
        run_id: RoleRunId,
        renderer_session_key: String,
        route_key: String,
        events: mpsc::Sender<SessionIngressEvent>,
    ) -> InvocationOutcome<RoleRunId, RoleSessionError> {
        if !receipt_reading_admitted(self.handle.snapshot().phase()) {
            return InvocationOutcome::TargetRejected(RoleSessionError::RuntimeUnavailable);
        }
        let (updates, _updates_rx) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        let client =
            match AppServerClient::connect_and_initialize(self.endpoint, &self.secret, updates)
                .await
            {
                Ok((client, _)) => client,
                Err(error) => {
                    return InvocationOutcome::TargetRejected(RoleSessionError::Client(error));
                }
            };
        let params = prompt.into_params(session_id).with_run_id(run_id.native());
        let subscription = match subscribe_renderer_events_raw(
            self.endpoint,
            &self.secret,
            self.source_epoch.load(Ordering::Relaxed),
            session_id.native(),
            renderer_session_key,
            run_id.native(),
            route_key,
            events,
            None,
        )
        .await
        {
            Ok(subscription) => subscription,
            Err(error) => {
                let error = match error {
                    RendererSubscriptionError::RuntimeUnavailable => {
                        RoleSessionError::RuntimeUnavailable
                    }
                    RendererSubscriptionError::Client(error) => RoleSessionError::Client(error),
                };
                return client
                    .finish_with_cleanup(InvocationOutcome::TargetRejected(error))
                    .await;
            }
        };
        let outcome = match client.prompt_session(params).await {
            InvocationOutcome::Succeeded(result) => {
                InvocationOutcome::Succeeded(RoleRunId::from_native(result.run_id))
            }
            InvocationOutcome::TargetRejected(error) => {
                subscription.abort();
                InvocationOutcome::TargetRejected(RoleSessionError::Client(error))
            }
            InvocationOutcome::Cancelled => {
                subscription.abort();
                InvocationOutcome::Cancelled
            }
            InvocationOutcome::Unknown => {
                subscription.abort();
                InvocationOutcome::Unknown
            }
        };
        client.finish_with_cleanup(outcome).await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RendererSubscriptionError {
    RuntimeUnavailable,
    Client(AppServerClientError),
}

impl fmt::Display for RendererSubscriptionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RuntimeUnavailable => {
                formatter.write_str("matcha peer renderer subscription is unavailable")
            }
            Self::Client(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for RendererSubscriptionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::RuntimeUnavailable => None,
            Self::Client(error) => Some(error),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleSessionOwnership {
    Created(RoleSessionId),
    Existing(RoleSessionId),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoleSessionError {
    RuntimeUnavailable,
    Client(AppServerClientError),
}

impl fmt::Display for RoleSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RuntimeUnavailable => {
                formatter.write_str("matcha peer role-session producer is unavailable")
            }
            Self::Client(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for RoleSessionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::RuntimeUnavailable => None,
            Self::Client(error) => Some(error),
        }
    }
}

#[cfg(test)]
mod role_session_tests {
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::{
        net::{TcpListener, TcpStream},
        sync::mpsc,
    };
    use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

    use super::*;
    use crate::{
        lifecycle::secret::Secret,
        peer::session_create::create_native,
        session::{
            client::AppServerEndpoint,
            model::SessionId,
            role::{RoleSessionCwd, RoleSessionId},
        },
    };

    fn role_session_id() -> RoleSessionId {
        RoleSessionId::try_new("role-session-canary").unwrap()
    }

    fn role_session_cwd() -> RoleSessionCwd {
        RoleSessionCwd::try_new("E:/role-workspace-canary").unwrap()
    }

    async fn serve_role_lifecycle(
        listener: TcpListener,
        handler: impl AsyncFnOnce(&mut WebSocketStream<TcpStream>),
    ) {
        let mut socket = accept_app_server(&listener).await;
        initialize(&mut socket).await;
        handler(&mut socket).await;
    }

    async fn connected_client(endpoint: AppServerEndpoint) -> AppServerClient {
        let (updates, _receiver) = mpsc::channel(1);
        AppServerClient::connect_and_initialize(
            endpoint,
            &Secret::new("role-session-token".into()).unwrap(),
            updates,
        )
        .await
        .unwrap()
        .0
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_create_uses_the_peer_owned_cwd_and_confirms_the_requested_native_session() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(serve_role_lifecycle(listener, async |socket| {
            let load = read_json(socket).await;
            assert_eq!(load["method"], "session.load");
            assert_eq!(load["params"], json!({"sessionId": "matcha-chat-session"}));
            send_json(
                socket,
                json!({"jsonrpc":"2.0","id":load["id"],"error":{"code":-32001,"message":"Session not found: role-session-canary"}}),
            )
            .await;
            let create = read_json(socket).await;
            assert_eq!(create["method"], "session.create");
            assert_eq!(
                create["params"],
                json!({"sessionId": "matcha-chat-session", "cwd": "E:/matcha-chat-workspace"})
            );
            send_json(socket, json!({"jsonrpc":"2.0","id":create["id"],"result":session_record("matcha-chat-session")})).await;
        }));

        let client = connected_client(endpoint).await;
        let outcome = create_native(
            &client,
            std::path::Path::new("E:/matcha-chat-workspace"),
            SessionId::try_new("matcha-chat-session").unwrap(),
        )
        .await;

        assert_eq!(
            outcome,
            InvocationOutcome::Succeeded(SessionId::try_new("matcha-chat-session").unwrap())
        );
        drop(client);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn missing_role_session_creates_the_requested_native_session() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(serve_role_lifecycle(listener, async |socket| {
            let load = read_json(socket).await;
            assert_eq!(load["method"], "session.load");
            assert_eq!(load["params"], json!({"sessionId": "role-session-canary"}));
            send_json(socket, json!({"jsonrpc":"2.0","id":load["id"],"error":{"code":-32001,"message":"Session not found: role-session-canary"}})).await;
            let create = read_json(socket).await;
            assert_eq!(create["method"], "session.create");
            assert_eq!(
                create["params"],
                json!({"sessionId": "role-session-canary", "cwd": "E:/role-workspace-canary"})
            );
            send_json(socket, json!({"jsonrpc":"2.0","id":create["id"],"result":session_record("role-session-canary")})).await;
        }));

        let client = connected_client(endpoint).await;
        let outcome =
            load_or_create_role_session(&client, role_session_id(), role_session_cwd()).await;

        assert_eq!(
            outcome,
            InvocationOutcome::Succeeded(RoleSessionOwnership::Created(
                RoleSessionId::try_new("role-session-canary").unwrap(),
            ))
        );
        drop(client);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn existing_role_session_is_not_marked_created() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(serve_role_lifecycle(listener, async |socket| {
            let load = read_json(socket).await;
            assert_eq!(load["method"], "session.load");
            assert_eq!(load["params"], json!({"sessionId": "role-session-canary"}));
            send_json(
                socket,
                json!({"jsonrpc":"2.0","id":load["id"],"result":session_record("role-session-canary")}),
            )
            .await;
        }));

        let client = connected_client(endpoint).await;
        assert_eq!(
            load_or_create_role_session(&client, role_session_id(), role_session_cwd()).await,
            InvocationOutcome::Succeeded(RoleSessionOwnership::Existing(
                RoleSessionId::try_new("role-session-canary").unwrap(),
            ))
        );
        drop(client);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn create_role_session_identity_mismatch_is_unknown_without_reload() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(serve_role_lifecycle(listener, async |socket| {
            let load = read_json(socket).await;
            assert_eq!(load["method"], "session.load");
            send_json(socket, json!({"jsonrpc":"2.0","id":load["id"],"error":{"code":-32603,"message":"Session not found: role-session-canary"}})).await;
            let create = read_json(socket).await;
            assert_eq!(create["method"], "session.create");
            send_json(socket, json!({"jsonrpc":"2.0","id":create["id"],"result":session_record("replacement-session-canary")})).await;
        }));

        let client = connected_client(endpoint).await;
        assert_eq!(
            load_or_create_role_session(
                &client,
                role_session_id(),
                RoleSessionCwd::try_new("E:/replacement-workspace-canary").unwrap(),
            )
            .await,
            InvocationOutcome::Unknown
        );
        drop(client);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn duplicate_role_create_rejection_does_not_reload() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(serve_role_lifecycle(listener, async |socket| {
            let load = read_json(socket).await;
            send_json(socket, json!({"jsonrpc":"2.0","id":load["id"],"error":{"code":-32603,"message":"Session not found: role-session-canary"}})).await;
            let create = read_json(socket).await;
            assert_eq!(create["method"], "session.create");
            send_json(socket, json!({"jsonrpc":"2.0","id":create["id"],"error":{"code":-32603,"message":"Session cwd unavailable"}})).await;
        }));

        let client = connected_client(endpoint).await;
        assert_eq!(
            load_or_create_role_session(&client, role_session_id(), role_session_cwd()).await,
            InvocationOutcome::TargetRejected(RoleSessionError::Client(
                AppServerClientError::PeerRejected,
            ))
        );
        drop(client);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn role_create_with_malformed_native_success_is_unknown_without_reload_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(serve_role_lifecycle(listener, async |socket| {
            let load = read_json(socket).await;
            send_json(socket, json!({"jsonrpc":"2.0","id":load["id"],"error":{"code":-32001,"message":"Session not found: role-session-canary"}})).await;
            let create = read_json(socket).await;
            assert_eq!(create["method"], "session.create");
            send_json(
                socket,
                json!({"jsonrpc":"2.0","id":create["id"],"result":{"private":"malformed"}}),
            )
            .await;
        }));

        let client = connected_client(endpoint).await;
        assert_eq!(
            load_or_create_role_session(&client, role_session_id(), role_session_cwd()).await,
            InvocationOutcome::Unknown
        );
        drop(client);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn initial_role_load_connection_loss_is_unknown_without_create_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(serve_role_lifecycle(listener, async |socket| {
            let load = read_json(socket).await;
            assert_eq!(load["method"], "session.load");
            socket.close(None).await.unwrap();
        }));

        let client = connected_client(endpoint).await;
        assert_eq!(
            load_or_create_role_session(&client, role_session_id(), role_session_cwd()).await,
            InvocationOutcome::Unknown
        );
        assert!(client.is_closed());
        drop(client);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn malformed_initial_role_load_is_unknown_without_create_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(serve_role_lifecycle(listener, async |socket| {
            let load = read_json(socket).await;
            assert_eq!(load["method"], "session.load");
            send_json(
                socket,
                json!({"jsonrpc":"2.0","id":load["id"],"result":{"private":"malformed"}}),
            )
            .await;
        }));

        let client = connected_client(endpoint).await;
        assert_eq!(
            load_or_create_role_session(&client, role_session_id(), role_session_cwd()).await,
            InvocationOutcome::Unknown
        );
        drop(client);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn role_create_after_write_connection_loss_is_unknown_without_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(serve_role_lifecycle(listener, async |socket| {
            let load = read_json(socket).await;
            send_json(socket, json!({"jsonrpc":"2.0","id":load["id"],"error":{"code":-32001,"message":"Session not found: role-session-canary"}})).await;
            let create = read_json(socket).await;
            assert_eq!(create["method"], "session.create");
            socket.close(None).await.unwrap();
        }));

        let client = connected_client(endpoint).await;
        assert_eq!(
            load_or_create_role_session(&client, role_session_id(), role_session_cwd()).await,
            InvocationOutcome::Unknown
        );
        assert!(client.is_closed());
        drop(client);
        server.await.unwrap();
    }

    async fn accept_app_server(listener: &TcpListener) -> WebSocketStream<TcpStream> {
        let (stream, _) = listener.accept().await.unwrap();
        accept_async(stream).await.unwrap()
    }

    async fn initialize(socket: &mut WebSocketStream<TcpStream>) {
        let request = read_json(socket).await;
        assert_eq!(request["method"], "initialize");
        send_json(
            socket,
            json!({
                "jsonrpc":"2.0",
                "id":request["id"],
                "result":{
                    "protocolVersion":"matcha-agent-app-server-v1",
                    "serverVersion":"2.2.1",
                    "capabilities":{
                        "eventReplay":true,
                        "snapshots":true,
                        "approvals":true,
                        "sdkMessageEnvelope":true,
                        "blobStore":true,
                        "sessionTranscript":true
                    }
                }
            }),
        )
        .await;
    }

    async fn read_json(socket: &mut WebSocketStream<TcpStream>) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected text frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn send_json(socket: &mut WebSocketStream<TcpStream>, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    fn session_record(session_id: &str) -> Value {
        json!({
            "sessionId": session_id,
            "createdAt": "created",
            "updatedAt": "updated",
            "runtime": "matcha-agent",
            "lastSeq": 0,
            "lastSnapshotVersion": 0,
            "workerState": {"state": "unloaded", "reason": "notStarted"}
        })
    }

    #[test]
    fn role_session_debug_display_and_errors_redact_private_values() {
        let cwd = RoleSessionCwd::try_new("E:/role-workspace-canary").unwrap();
        let session = RoleSessionId::try_new("role-session-canary").unwrap();
        let run = RoleRunId::try_new("role-run-canary").unwrap();
        let error = RoleSessionError::Client(AppServerClientError::Protocol);
        let rendered = format!("{cwd:?} {session:?} {run:?} {error:?} {error}");

        for canary in [
            "role-workspace-canary",
            "role-session-canary",
            "role-run-canary",
            "role-prompt-canary",
        ] {
            assert!(!rendered.contains(canary), "role lifecycle leaked {canary}");
        }
    }
}

#[cfg(test)]
mod renderer_tests {
    use foundation::process::supervision::SupervisorPhase;
    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::*;
    use crate::session::{
        approval::ApprovalRecord,
        model::EventId,
        protocol_event::{Event, EventEnvelope},
    };

    #[test]
    fn renderer_event_envelope_exposes_only_safe_provenance_and_projection() {
        let event = RendererEventEnvelope::new(
            "route-1".to_owned(),
            "matcha-agent:matcha:native-session-1".to_owned(),
            "run-1".to_owned(),
            7,
            None,
            RendererEvent::Run {
                sequence: 7,
                phase: RendererRunPhase::Started,
            },
        );

        assert_eq!(event.route_key(), "route-1");
        assert_eq!(event.session_key(), "matcha-agent:matcha:native-session-1");
        assert_eq!(event.run_id(), "run-1");
        assert_eq!(event.source_cursor(), 7);
        assert_eq!(event.source_epoch(), None);
        assert!(matches!(
            event.event(),
            RendererEvent::Run { sequence: 7, .. }
        ));
        let debug = format!("{event:?}");
        assert!(!debug.contains("raw"));
        assert!(!debug.contains("private"));
    }

    #[test]
    fn renderer_subscription_skips_replay_cursor_before_projecting_live_events() {
        let replay_cursor = Sequence::try_new(2).unwrap();
        let mut projector = SessionEventProjector::resume_after(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
            replay_cursor,
        );

        assert!(
            renderer_subscription_projection_step(
                &mut projector,
                replay_cursor,
                renderer_envelope(1, json!({"type":"run.started","runId":"run-1"})),
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(projector.cursor().get(), 2);
        assert!(
            renderer_subscription_projection_step(
                &mut projector,
                replay_cursor,
                renderer_envelope(2, json!({"type":"run.started","runId":"run-1"})),
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(projector.cursor().get(), 2);

        let event = renderer_subscription_projection_step(
            &mut projector,
            replay_cursor,
            renderer_envelope(3, json!({"type":"run.completed","runId":"run-1"})),
        )
        .unwrap()
        .unwrap();

        assert!(event.event.is_terminal());
        assert_eq!(event.source_cursor, 3);
        assert_eq!(projector.cursor().get(), 3);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn full_renderer_channel_reports_recovery_without_dropping_silently() {
        let public_session_key = "matcha-agent:matcha:native-session-1";
        let native_session_id = "native-session-1";
        let (events, mut receiver) = mpsc::channel(1);
        let event =
            matcha_session_event(SessionSubscriptionItem::Event(RendererEventEnvelope::new(
                "renderer-route:1".to_owned(),
                public_session_key.to_owned(),
                "run-1".to_owned(),
                1,
                None,
                RendererEvent::Run {
                    sequence: 1,
                    phase: RendererRunPhase::Started,
                },
            )))
            .unwrap();
        assert!(events.try_send(event).is_ok());
        let received = tokio::spawn(async move {
            let _ = receiver.recv().await.unwrap();
            receiver.recv().await.unwrap()
        });

        let delivery = send_renderer_event(
            &events,
            RendererEventEnvelope::new(
                "renderer-route:1".to_owned(),
                public_session_key.to_owned(),
                "run-1".to_owned(),
                2,
                None,
                RendererEvent::Run {
                    sequence: 2,
                    phase: RendererRunPhase::Completed,
                },
            ),
            SessionId::try_new(native_session_id).unwrap(),
            Sequence::try_new(2).unwrap(),
            7,
        )
        .await;

        assert_eq!(delivery, SubscriptionDelivery::Recovering);
        let (identity, event) = received.await.unwrap().into_parts();
        assert_eq!(identity.session_key(), public_session_key);
        assert_eq!(event.binding.session_key(), public_session_key);
        assert_eq!(event.binding.route_key(), Some("renderer-route:1"));
        assert_eq!(event.binding.source_epoch(), Some(7));
        assert_eq!(event.run_id.as_deref(), Some("run-1"));
        assert_eq!(event.cursor, Some(2));
        assert_eq!(
            event.changes,
            vec![sessions_module::state::SessionChange::RecoveryRequired {
                reason: sessions_module::state::RecoveryReason::EventOverflow,
            }],
        );
    }

    #[test]
    fn cleanup_close_failure_preserves_pending_approval_snapshot() {
        let approvals = pending_approvals_from_snapshot(vec![approval_record()]);
        assert_eq!(
            crate::session::client::outcome_after_cleanup(
                Ok::<_, AppServerClientError>(approvals),
                Err(AppServerClientError::CloseFailed),
            )
            .unwrap()[0]
                .1[0]
                .as_str(),
            "option-1"
        );
    }

    #[test]
    fn role_cleanup_close_failure_preserves_confirmed_outcome() {
        assert_eq!(
            crate::session::client::outcome_after_cleanup(
                InvocationOutcome::<(), RoleSessionError>::Succeeded(()),
                Err(AppServerClientError::CloseFailed),
            ),
            InvocationOutcome::Succeeded(())
        );
    }

    fn approval_record() -> ApprovalRecord {
        serde_json::from_value(json!({
            "approvalId": "approval-1",
            "options": [{
                "optionId": "option-1",
                "label": "Allow",
                "kind": "allow_once"
            }],
            "status": {
                "type": "pending",
                "requestedAt": "now"
            }
        }))
        .unwrap()
    }

    fn renderer_envelope(sequence: u64, event: Value) -> EventEnvelope {
        replay_envelope(sequence, "run-1", event)
    }

    fn replay_envelope(sequence: u64, run_id: &str, event: Value) -> EventEnvelope {
        EventEnvelope {
            event_id: EventId::try_new(format!("event-{sequence}")).unwrap(),
            session_id: SessionId::try_new("session-1").unwrap(),
            seq: Sequence::try_new(sequence).unwrap(),
            run_id: Some(RunId::try_new(run_id).unwrap()),
            worker_id: None,
            created_at: "now".to_owned(),
            event: Event::try_new(event).unwrap(),
        }
    }

    #[test]
    fn renderer_projects_message_tool_and_approval_activity_with_sequence_and_redaction() {
        let mut message_projector = SessionEventProjector::new(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
        );
        let message = renderer_event_step(
            &mut message_projector,
            renderer_envelope(
                1,
                json!({
                    "type":"message.delta",
                    "messageId":"message-1",
                    "delta":"safe delta",
                    "private":"must not cross seam"
                }),
            ),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            message,
            RendererEvent::Message {
                sequence: 1,
                message_id: "message-1".to_owned(),
                lifecycle: RendererMessageLifecycle::Delta,
                text_delta: Some("safe delta".to_owned()),
                thinking_delta: None,
                message_text: Some("safe delta".to_owned()),
                thinking_text: None,
            }
        );
        let debug = format!("{message:?}");
        assert!(!debug.contains("must not cross seam"));

        let mut tool_projector = SessionEventProjector::new(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
        );
        let tool = renderer_event_step(
            &mut tool_projector,
            renderer_envelope(
                1,
                json!({
                    "type":"tool.activity",
                    "toolCallId":"tool-call-1",
                    "phase":"failed",
                    "input":{"secret":"private"}
                }),
            ),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            tool,
            RendererEvent::Tool {
                sequence: 1,
                tool_call_id: "tool-call-1".to_owned(),
                name: None,
                phase: RendererToolPhase::Failed,
                input: Some(json!({"secret":"private"})),
                input_text: Some("{\n  \"secret\": \"private\"\n}".to_owned()),
                summary: None,
                output: None,
                is_error: Some(true),
            }
        );

        let mut approval_projector = SessionEventProjector::new(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
        );
        let mut approval_envelope = renderer_envelope(
            1,
            json!({
                "type":"approval.resolved",
                "approval": {
                    "approvalId":"approval-1",
                    "sessionId":"session-1",
                    "runId":"run-1",
                    "workerId":"worker-1",
                    "options":[{"optionId":"allow-once","kind":"allow_once"}],
                    "status":{"type":"approved","optionId":"allow-once"},
                    "prompt":"private prompt"
                }
            }),
        );
        approval_envelope.worker_id =
            Some(crate::session::model::WorkerId::try_new("worker-1").unwrap());
        let approval = renderer_event_step(&mut approval_projector, approval_envelope)
            .unwrap()
            .unwrap();
        assert_eq!(
            approval,
            RendererEvent::Approval {
                sequence: 1,
                approval_id: "approval-1".to_owned(),
                phase: RendererApprovalPhase::Resolved,
                option_ids: Vec::new(),
            }
        );
        let debug = format!("{approval:?}");
        assert!(!debug.contains("private prompt"));

        let mut requested_projector = SessionEventProjector::new(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
        );
        let mut requested_envelope = renderer_envelope(
            1,
            json!({
                "type":"approval.requested",
                "approval": {
                    "approvalId":"approval-1",
                    "sessionId":"session-1",
                    "runId":"run-1",
                    "workerId":"worker-1",
                    "options":[{"optionId":"allow-once","kind":"allow_once"}],
                    "status":{"type":"pending"}
                }
            }),
        );
        requested_envelope.worker_id =
            Some(crate::session::model::WorkerId::try_new("worker-1").unwrap());
        assert_eq!(
            renderer_event_step(&mut requested_projector, requested_envelope)
                .unwrap()
                .unwrap(),
            RendererEvent::Approval {
                sequence: 1,
                approval_id: "approval-1".to_owned(),
                phase: RendererApprovalPhase::Requested,
                option_ids: vec!["allow-once".to_owned()],
            }
        );
    }

    #[test]
    fn renderer_checkpoint_stops_on_gap_or_invalid_projection() {
        let mut projector = SessionEventProjector::new(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
        );

        assert!(
            renderer_event_step(
                &mut projector,
                renderer_envelope(2, json!({"type":"run.completed","runId":"run-1"})),
            )
            .is_err()
        );
        assert_eq!(projector.cursor().get(), 0);

        assert!(
            renderer_event_step(
                &mut projector,
                renderer_envelope(
                    1,
                    json!({
                        "type":"approval.requested",
                        "approval": {"approvalId":"approval-1"}
                    }),
                ),
            )
            .is_err()
        );
        assert_eq!(projector.cursor().get(), 1);
    }

    #[test]
    fn renderer_checkpoint_projects_terminal_once_after_contiguous_delivery() {
        let mut projector = SessionEventProjector::new(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
        );

        let event = renderer_event_step(
            &mut projector,
            renderer_envelope(1, json!({"type":"run.completed","runId":"run-1"})),
        )
        .unwrap()
        .unwrap();

        assert!(event.is_terminal());
        assert_eq!(projector.cursor().get(), 1);
    }

    #[test]
    fn renderer_checkpoint_skips_unsupported_owned_events() {
        let mut projector = SessionEventProjector::new(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
        );

        assert_eq!(
            renderer_event_step(
                &mut projector,
                renderer_envelope(
                    1,
                    json!({"type":"run.trace","runId":"run-1","stage":"safe-stage"}),
                ),
            )
            .unwrap(),
            None,
        );
        assert_eq!(projector.cursor().get(), 1);
    }

    #[test]
    fn renderer_checkpoint_skips_non_renderer_events_and_keeps_following_terminal_delivery() {
        let mut projector = SessionEventProjector::new(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
        );

        assert_eq!(
            renderer_event_step(
                &mut projector,
                renderer_envelope(
                    1,
                    json!({
                        "type":"sdk.message",
                        "sdkMessageVersion":"claude-code-sdk-message-v1",
                        "sdkMessage":{}
                    }),
                ),
            )
            .unwrap(),
            None,
        );
        let terminal = renderer_event_step(
            &mut projector,
            renderer_envelope(2, json!({"type":"run.completed","runId":"run-1"})),
        )
        .unwrap()
        .unwrap();

        assert!(terminal.is_terminal());
        assert_eq!(projector.cursor().get(), 2);
    }

    #[test]
    fn receipt_reading_is_admitted_only_for_a_running_peer() {
        assert!(receipt_reading_admitted(SupervisorPhase::Running));
        for phase in [
            SupervisorPhase::Idle,
            SupervisorPhase::Starting,
            SupervisorPhase::Stopping,
            SupervisorPhase::WaitingToRestart,
            SupervisorPhase::OperationFailed,
            SupervisorPhase::ShutDown,
        ] {
            assert!(!receipt_reading_admitted(phase));
        }
    }

    #[test]
    fn role_session_errors_are_fixed_and_redacted() {
        let error = RoleSessionError::Client(AppServerClientError::PeerRejected);
        let rendered = format!("{error:?} {error}");
        assert_eq!(error.to_string(), "app-server rejected request");
        for canary in [
            "role-session-canary",
            "role-run-canary",
            "role-secret-canary",
            "127.0.0.1:19002",
        ] {
            assert!(!rendered.contains(canary));
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleError {
    CompletionFailed,
    SupervisorStopped,
    AlreadySatisfied,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
}

impl From<CompletionError> for LifecycleError {
    fn from(error: CompletionError) -> Self {
        match error {
            CompletionError::Failed(_) => Self::CompletionFailed,
            CompletionError::SupervisorStopped => Self::SupervisorStopped,
        }
    }
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CompletionFailed => formatter.write_str("matcha peer lifecycle command failed"),
            Self::SupervisorStopped => {
                formatter.write_str("matcha peer stopped before lifecycle command completed")
            }
            Self::AlreadySatisfied => {
                formatter.write_str("matcha peer lifecycle command was already satisfied")
            }
            Self::Busy => formatter.write_str("matcha peer lifecycle command was busy"),
            Self::Rejected(_) => formatter.write_str("matcha peer lifecycle command was rejected"),
            Self::ShuttingDown => {
                formatter.write_str("matcha peer stopped accepting lifecycle commands")
            }
        }
    }
}

impl std::error::Error for LifecycleError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownError {
    CompletionFailed,
    SupervisorStopped,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
    MissingOutcome,
}

impl From<CompletionError> for ShutdownError {
    fn from(error: CompletionError) -> Self {
        match error {
            CompletionError::Failed(_) => Self::CompletionFailed,
            CompletionError::SupervisorStopped => Self::SupervisorStopped,
        }
    }
}

impl fmt::Display for ShutdownError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CompletionFailed => formatter.write_str("matcha peer shutdown failed"),
            Self::SupervisorStopped => {
                formatter.write_str("matcha peer stopped before shutdown completed")
            }
            Self::Busy => formatter.write_str("matcha peer shutdown was busy"),
            Self::Rejected(_) => formatter.write_str("matcha peer shutdown was rejected"),
            Self::ShuttingDown => formatter.write_str("matcha peer stopped accepting shutdown"),
            Self::MissingOutcome => {
                formatter.write_str("matcha peer shutdown outcome was unavailable")
            }
        }
    }
}

impl std::error::Error for ShutdownError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JoinError {
    Cancelled,
    Panicked,
}

impl From<tokio::task::JoinError> for JoinError {
    fn from(error: tokio::task::JoinError) -> Self {
        if error.is_cancelled() {
            Self::Cancelled
        } else {
            Self::Panicked
        }
    }
}

impl fmt::Display for JoinError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("matcha peer supervisor task was cancelled"),
            Self::Panicked => formatter.write_str("matcha peer supervisor task panicked"),
        }
    }
}

impl std::error::Error for JoinError {}
