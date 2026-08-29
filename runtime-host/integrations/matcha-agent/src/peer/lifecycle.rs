use std::{
    fmt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use tokio::sync::{broadcast, mpsc};

use foundation::process::{
    ShutdownOutcome,
    supervision::{
        CommandReceipt, CompletionError, RestartOutcome, StartOutcome, Supervisor,
        SupervisorHandle, SupervisorRejection, SupervisorSnapshot, TerminationCompletion,
    },
};
use platform::exchange::InvocationOutcome;

use crate::{
    lifecycle::secret::Secret,
    session::{
        canonical::{CanonicalSessionReadResult, read as read_canonical_session},
        client::{
            AppServerClient, AppServerClientError, AppServerEndpoint, EventSubscription,
            EventSubscriptionCursor, RawEvent,
        },
        close::SessionCloseParams,
        events::{
            ApprovalPhase, EventActivity, EventProjectionResult, EventRejection, MessageLifecycle,
            RunLifecycle, SessionEventObservation, SessionEventProjector, SessionEventUpdate,
            ToolActivityPhase,
        },
        history::{HistoryListResult, HistoryLoadResult},
        hydration::HydrationWindowRequest,
        model::{ApprovalId, OptionId, RunId, Sequence, SessionId},
        receipt::{TerminalRunReceipt, TerminalRunReceiptConsumer, TerminalRunStatus},
        recovery::{ProjectionRecoveryReason, SessionRecovery},
        request::{
            SessionCancelParams, SessionLoadParams, SessionSetModelParams, SessionSnapshotParams,
        },
        role::{RolePrompt, RoleRunId, RoleSessionCwd, RoleSessionId},
        watcher::{TerminalEventWatcher, TerminalWatchStep},
    },
};

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
}

#[derive(Clone)]
pub struct RoleSessionNativeHandle {
    handle: SupervisorHandle,
    endpoint: AppServerEndpoint,
    secret: Arc<Secret>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
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
        message_text: Option<String>,
    },
    Tool {
        sequence: u64,
        tool_call_id: String,
        phase: RendererToolPhase,
    },
    Approval {
        sequence: u64,
        approval_id: String,
        phase: RendererApprovalPhase,
        option_ids: Vec<String>,
    },
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

pub struct RoleTerminalWatch {
    endpoint: AppServerEndpoint,
    secret: Arc<Secret>,
    session_id: SessionId,
    run_id: RunId,
}

impl RoleTerminalWatch {
    pub async fn wait(self) -> Option<TerminalRunStatus> {
        let Ok((client, _)) =
            AppServerClient::connect_and_initialize_raw_only(self.endpoint, &self.secret).await
        else {
            return None;
        };
        let terminal = watch_terminal(&client, self.session_id, self.run_id).await;
        let close = client.close().await;
        terminal_watch_outcome(terminal, close)
    }
}

fn terminal_watch_outcome(
    terminal: Option<TerminalRunStatus>,
    close: Result<(), AppServerClientError>,
) -> Option<TerminalRunStatus> {
    close.ok()?;
    terminal
}

impl fmt::Debug for RoleTerminalWatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoleTerminalWatch(<redacted>)")
    }
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

async fn watch_terminal(
    client: &AppServerClient,
    session_id: SessionId,
    run_id: RunId,
) -> Option<TerminalRunStatus> {
    let mut events = client.raw_events();
    terminal_watch_subscription(
        client
            .subscribe_events(session_id.clone(), None)
            .await
            .ok()?,
    )?;
    watch_terminal_events(&mut events, TerminalEventWatcher::new(session_id, run_id)).await
}

fn terminal_watch_subscription(subscription: EventSubscription) -> Option<()> {
    (subscription == EventSubscription::Subscribed).then_some(())
}

async fn watch_terminal_events(
    events: &mut broadcast::Receiver<crate::session::client::RawEvent>,
    mut watcher: TerminalEventWatcher,
) -> Option<TerminalRunStatus> {
    loop {
        match events.recv().await {
            Ok(crate::session::client::RawEvent::Envelope(event)) => match watcher.observe(event) {
                TerminalWatchStep::Pending => {}
                TerminalWatchStep::Terminal(status) => return Some(status),
                TerminalWatchStep::Stop => return None,
            },
            Ok(crate::session::client::RawEvent::Overflow)
            | Ok(crate::session::client::RawEvent::Closed)
            | Err(broadcast::error::RecvError::Lagged(_))
            | Err(broadcast::error::RecvError::Closed) => return None,
        }
    }
}

struct RendererProjection {
    session_key: String,
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
    let session_key = envelope.session_id.as_str().to_owned();
    let run_id = envelope
        .run_id
        .as_ref()
        .map(|run_id| run_id.as_str().to_owned());
    match projector.project(envelope) {
        EventProjectionResult::Projected(projected) => Ok(renderer_event(
            projected.sequence().get(),
            projected.activity(),
        )
        .and_then(|event| {
            run_id.map(|run_id| RendererProjection {
                session_key,
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
    events: &mpsc::Sender<SessionSubscriptionItem>,
    event: RendererEventEnvelope,
    session_id: SessionId,
    native_cursor: Sequence,
    source_epoch: u64,
) -> SubscriptionDelivery {
    let route_key = event.route_key().to_owned();
    let run_id = event.run_id().to_owned();
    match events.try_send(SessionSubscriptionItem::Event(event)) {
        Ok(()) => SubscriptionDelivery::Sent,
        Err(mpsc::error::TrySendError::Closed(_)) => SubscriptionDelivery::Closed,
        Err(mpsc::error::TrySendError::Full(_)) => {
            let recovery =
                SessionRecovery::from_raw_event(session_id, native_cursor, &RawEvent::Overflow)
                    .expect("overflow raw event always produces recovery")
                    .with_source_epoch(source_epoch);
            if send_recovery(events, &route_key, &run_id, recovery).await {
                SubscriptionDelivery::Recovering
            } else {
                SubscriptionDelivery::Closed
            }
        }
    }
}

async fn send_recovery(
    events: &mpsc::Sender<SessionSubscriptionItem>,
    route_key: &str,
    run_id: &str,
    recovery: SessionRecovery,
) -> bool {
    match events.try_send(SessionSubscriptionItem::Recovery {
        route_key: route_key.to_owned(),
        run_id: run_id.to_owned(),
        recovery,
    }) {
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
            message_text: message.message_text().map(ToOwned::to_owned),
        }),
        EventActivity::Tool(tool) => Some(RendererEvent::Tool {
            sequence,
            tool_call_id: bounded_renderer_id(tool.tool_call_id().as_str())?,
            phase: match tool.phase() {
                ToolActivityPhase::Started => RendererToolPhase::Started,
                ToolActivityPhase::Updated => RendererToolPhase::Updated,
                ToolActivityPhase::Completed => RendererToolPhase::Completed,
                ToolActivityPhase::Failed => RendererToolPhase::Failed,
            },
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
        EventActivity::Run(RunLifecycle::Queued | RunLifecycle::CancellationRequested)
        | EventActivity::Ignored => None,
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

    fn next_source_epoch(&self) -> u64 {
        self.source_epoch.fetch_add(1, Ordering::Relaxed)
    }

    pub fn advance_source_epoch(&self) -> u64 {
        self.source_epoch.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn role_session_prompt_handle(&self) -> RoleSessionPromptHandle {
        RoleSessionPromptHandle {
            handle: self.handle.clone(),
            endpoint: self.endpoint,
            secret: Arc::clone(&self.secret),
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

    /// Reads one terminal receipt through a new authenticated native-edge connection.
    ///
    /// The operation is admitted only while this peer supervisor is running. Pending,
    /// not-found, connection, deadline, and protocol observations are returned without
    /// synthesizing a terminal fact.
    pub async fn read_terminal_receipt(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<TerminalRunReceipt, TerminalReceiptReadError> {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return Err(TerminalReceiptReadError::RuntimeUnavailable);
        }
        let (events, _updates) = tokio::sync::mpsc::channel::<SessionEventUpdate>(1);
        let (client, _) =
            AppServerClient::connect_and_initialize(self.endpoint, &self.secret, events)
                .await
                .map_err(TerminalReceiptReadError::Client)?;
        let receipt = TerminalRunReceiptConsumer::new(&client)
            .read(session_id, run_id)
            .await
            .map_err(TerminalReceiptReadError::Client);
        let close = client.close().await;
        match (receipt, close) {
            (Ok(receipt), Ok(())) => Ok(receipt),
            (Ok(_), Err(error)) => Err(TerminalReceiptReadError::Client(error)),
            (Err(error), _) => Err(error),
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
    }

    pub async fn subscribe_renderer_events(
        &self,
        session_id: SessionId,
        run_id: RunId,
        route_key: String,
        events: mpsc::Sender<SessionSubscriptionItem>,
    ) -> Result<tokio::task::JoinHandle<()>, RendererSubscriptionError> {
        if !receipt_reading_admitted(self.snapshot().phase()) {
            return Err(RendererSubscriptionError::RuntimeUnavailable);
        }
        subscribe_renderer_events_raw(
            self.endpoint,
            &self.secret,
            self.next_source_epoch(),
            session_id,
            run_id,
            route_key,
            events,
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        let snapshot = client
            .snapshot_session(SessionSnapshotParams::new(session_id))
            .await;
        let close = client.close().await;
        match (snapshot, close) {
            (Ok(snapshot), Ok(())) => Ok(snapshot
                .pending_approvals
                .into_iter()
                .map(|approval| {
                    (
                        approval.approval_id().clone(),
                        approval.option_ids().to_vec(),
                    )
                })
                .collect()),
            (Ok(_), Err(error)) => Err(error),
            (Err(error), _) => Err(error),
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
    }

    pub fn watch_role_terminal(
        &self,
        session_id: RoleSessionId,
        run_id: RoleRunId,
    ) -> Option<RoleTerminalWatch> {
        receipt_reading_admitted(self.snapshot().phase()).then(|| RoleTerminalWatch {
            endpoint: self.endpoint,
            secret: Arc::clone(&self.secret),
            session_id: session_id.native(),
            run_id: run_id.native(),
        })
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
    run_id: RunId,
    route_key: String,
    events: mpsc::Sender<SessionSubscriptionItem>,
) -> Result<tokio::task::JoinHandle<()>, RendererSubscriptionError> {
    let (client, _) = AppServerClient::connect_and_initialize_raw_only(endpoint, secret)
        .await
        .map_err(RendererSubscriptionError::Client)?;
    let mut raw_events = client.raw_events();
    let subscription = client
        .subscribe_events_with_cursor(session_id.clone(), None)
        .await
        .map_err(RendererSubscriptionError::Client)?;
    let cursor = match subscription {
        EventSubscriptionCursor::Subscribed(replay) => replay.cursor(),
        EventSubscriptionCursor::ClientNotFound => {
            let _ = client.close().await;
            return Err(RendererSubscriptionError::Client(
                AppServerClientError::SessionNotFound,
            ));
        }
        EventSubscriptionCursor::ClientRequired => {
            let _ = client.close().await;
            return Err(RendererSubscriptionError::Client(
                AppServerClientError::PeerRejected,
            ));
        }
    };
    Ok(tokio::spawn(async move {
        let mut replay_cursor = cursor;
        let mut projector =
            SessionEventProjector::resume_after(session_id.clone(), run_id.clone(), replay_cursor);
        loop {
            if client.is_closed() {
                let recovery = SessionRecovery::from_raw_event(
                    session_id.clone(),
                    projector.cursor(),
                    &RawEvent::Closed,
                )
                .expect("closed raw event always produces recovery")
                .with_source_epoch(source_epoch);
                let _ = send_recovery(&events, &route_key, run_id.as_str(), recovery).await;
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
                                projection.session_key,
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
                    SessionRecovery::from_broadcast_lagged(
                        session_id.clone(),
                        projector.cursor(),
                        skipped,
                    )
                    .with_source_epoch(source_epoch)
                }
                Err(broadcast::error::RecvError::Closed) => SessionRecovery::from_raw_event(
                    session_id.clone(),
                    projector.cursor(),
                    &RawEvent::Closed,
                )
                .expect("closed raw event always produces recovery")
                .with_source_epoch(source_epoch),
            };
            let should_recover = matches!(recovery, SessionRecovery::RecoveryRequired { .. });
            if !send_recovery(&events, &route_key, run_id.as_str(), recovery).await {
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
                Err(_) => break,
            }
        }
        let _ = client.close().await;
    }))
}

impl MatchaPeerSessionHandle {
    pub async fn subscribe_renderer_events(
        &self,
        session_id: SessionId,
        run_id: RunId,
        route_key: String,
        events: mpsc::Sender<SessionSubscriptionItem>,
    ) -> Result<tokio::task::JoinHandle<()>, RendererSubscriptionError> {
        if !receipt_reading_admitted(self.handle.snapshot().phase()) {
            return Err(RendererSubscriptionError::RuntimeUnavailable);
        }
        subscribe_renderer_events_raw(
            self.endpoint,
            &self.secret,
            self.source_epoch.fetch_add(1, Ordering::Relaxed),
            session_id,
            run_id,
            route_key,
            events,
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
    }

    pub async fn pending_approvals(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<(ApprovalId, Vec<OptionId>)>, AppServerClientError> {
        let client = self.connect_client().await?;
        let snapshot = client
            .snapshot_session(SessionSnapshotParams::new(session_id))
            .await;
        let close = client.close().await;
        match (snapshot, close) {
            (Ok(snapshot), Ok(())) => Ok(snapshot
                .pending_approvals
                .into_iter()
                .map(|approval| {
                    (
                        approval.approval_id().clone(),
                        approval.option_ids().to_vec(),
                    )
                })
                .collect()),
            (Ok(_), Err(error)) => Err(error),
            (Err(error), _) => Err(error),
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
    }

    pub async fn watch_role_terminal(
        &self,
        session_id: RoleSessionId,
        run_id: RoleRunId,
    ) -> Option<TerminalRunStatus> {
        receipt_reading_admitted(self.handle.snapshot().phase())
            .then_some(RoleTerminalWatch {
                endpoint: self.endpoint,
                secret: Arc::clone(&self.secret),
                session_id: session_id.native(),
                run_id: run_id.native(),
            })?
            .wait()
            .await
    }
}

impl RoleSessionPromptHandle {
    pub async fn prompt_role_session_with_run_id(
        &self,
        session_id: &RoleSessionId,
        prompt: RolePrompt,
        run_id: Option<RoleRunId>,
    ) -> InvocationOutcome<RoleRunId, RoleSessionError> {
        if !receipt_reading_admitted(self.handle.snapshot().phase()) {
            return InvocationOutcome::TargetRejected(RoleSessionError::RuntimeUnavailable);
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
            Err(error) => {
                return InvocationOutcome::TargetRejected(RoleSessionError::Client(error));
            }
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
        match client.close().await {
            Ok(()) => outcome,
            Err(_) => InvocationOutcome::Unknown,
        }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalReceiptReadError {
    RuntimeUnavailable,
    Client(AppServerClientError),
}

impl fmt::Display for TerminalReceiptReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RuntimeUnavailable => {
                formatter.write_str("matcha peer receipt reader is unavailable")
            }
            Self::Client(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for TerminalReceiptReadError {
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
mod receipt_tests {
    use foundation::process::supervision::SupervisorPhase;
    use serde_json::{Value, json};

    use super::*;
    use crate::session::{
        model::EventId,
        protocol_event::{Event, EventEnvelope},
    };

    fn watcher() -> TerminalEventWatcher {
        TerminalEventWatcher::new(
            SessionId::try_new("watch-session").unwrap(),
            RunId::try_new("watch-run").unwrap(),
        )
    }

    #[tokio::test(flavor = "current_thread")]
    async fn terminal_watcher_stops_on_closed_or_overflowed_raw_stream() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(1);
        sender
            .send(crate::session::client::RawEvent::Closed)
            .unwrap();
        assert_eq!(watch_terminal_events(&mut receiver, watcher()).await, None);

        let (sender, mut receiver) = tokio::sync::broadcast::channel(1);
        sender
            .send(crate::session::client::RawEvent::Overflow)
            .unwrap();
        assert_eq!(watch_terminal_events(&mut receiver, watcher()).await, None);
    }

    #[test]
    fn renderer_event_envelope_exposes_only_safe_provenance_and_projection() {
        let event = RendererEventEnvelope::new(
            "route-1".to_owned(),
            "session-1".to_owned(),
            "run-1".to_owned(),
            7,
            None,
            RendererEvent::Run {
                sequence: 7,
                phase: RendererRunPhase::Started,
            },
        );

        assert_eq!(event.route_key(), "route-1");
        assert_eq!(event.session_key(), "session-1");
        assert_eq!(event.run_id(), "run-1");
        assert_eq!(event.source_cursor(), 7);
        assert_eq!(event.source_epoch(), None);
        assert!(matches!(
            event.event(),
            RendererEvent::Run { sequence: 7, .. }
        ));
        let debug = format!("{event:?}");
        assert!(!debug.contains("native"));
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
        let (events, mut receiver) = mpsc::channel(1);
        events
            .try_send(SessionSubscriptionItem::Event(RendererEventEnvelope::new(
                "route-1".to_owned(),
                "session-1".to_owned(),
                "run-1".to_owned(),
                1,
                None,
                RendererEvent::Run {
                    sequence: 1,
                    phase: RendererRunPhase::Started,
                },
            )))
            .unwrap();
        let received = tokio::spawn(async move {
            let _ = receiver.recv().await.unwrap();
            receiver.recv().await.unwrap()
        });

        let delivery = send_renderer_event(
            &events,
            RendererEventEnvelope::new(
                "route-1".to_owned(),
                "session-1".to_owned(),
                "run-1".to_owned(),
                2,
                None,
                RendererEvent::Run {
                    sequence: 2,
                    phase: RendererRunPhase::Completed,
                },
            ),
            SessionId::try_new("session-1").unwrap(),
            Sequence::try_new(2).unwrap(),
            7,
        )
        .await;

        assert_eq!(delivery, SubscriptionDelivery::Recovering);
        assert!(matches!(
            received.await.unwrap(),
            SessionSubscriptionItem::Recovery {
                recovery: SessionRecovery::RecoveryRequired {
                    reason: crate::session::recovery::RecoveryReason::EventOverflow,
                    ..
                },
                ..
            }
        ));
    }

    #[test]
    fn close_failure_overrides_an_observed_terminal_event() {
        assert_eq!(
            terminal_watch_outcome(
                Some(TerminalRunStatus::Completed),
                Err(AppServerClientError::CloseFailed),
            ),
            None
        );
    }

    #[test]
    fn role_terminal_watch_debug_is_redacted() {
        let output = format!(
            "{:?}",
            RoleTerminalWatch {
                endpoint: AppServerEndpoint::try_new("127.0.0.1:19003".parse().unwrap()).unwrap(),
                secret: Arc::new(Secret::new("secret-canary".into()).unwrap()),
                session_id: SessionId::try_new("session-canary").unwrap(),
                run_id: RunId::try_new("run-canary").unwrap(),
            }
        );

        assert_eq!(output, "RoleTerminalWatch(<redacted>)");
        for canary in [
            "session-canary",
            "run-canary",
            "secret-canary",
            "127.0.0.1:19003",
        ] {
            assert!(!output.contains(canary));
        }
    }

    fn renderer_envelope(sequence: u64, event: Value) -> EventEnvelope {
        EventEnvelope {
            event_id: EventId::try_new(format!("event-{sequence}")).unwrap(),
            session_id: SessionId::try_new("session-1").unwrap(),
            seq: Sequence::try_new(sequence).unwrap(),
            run_id: Some(RunId::try_new("run-1").unwrap()),
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
                message_text: Some("safe delta".to_owned()),
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
                phase: RendererToolPhase::Failed,
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
    fn receipt_read_errors_are_fixed_and_redacted() {
        let error = TerminalReceiptReadError::Client(AppServerClientError::PeerRejected);
        let rendered = format!("{error:?} {error}");
        assert_eq!(error.to_string(), "app-server rejected request");
        for canary in [
            "receipt-session-canary",
            "receipt-run-canary",
            "receipt-secret-canary",
            "127.0.0.1:19001",
        ] {
            assert!(!rendered.contains(canary));
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
