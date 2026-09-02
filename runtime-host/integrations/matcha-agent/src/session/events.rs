use std::{collections::HashMap, fmt};

use serde_json::{Map, Value};

const MAX_PROJECTED_TEXT_DELTA_BYTES: usize = 16 * 1024;
const MAX_PROJECTED_MESSAGE_TEXT_BYTES: usize = 256 * 1024;
const MAX_PROJECTED_TOOL_NAME_BYTES: usize = 256;
const MAX_PROJECTED_TOOL_SUMMARY_BYTES: usize = 128 * 1024;
const MAX_PROJECTED_TOOL_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_PROJECTED_MESSAGE_COUNT: usize = 64;

use super::{
    model::{ApprovalId, MessageId, OptionId, RunId, Sequence, SessionId, ToolCallId, WorkerId},
    protocol_event::{Event, EventEnvelope},
};

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct TurnProjection<'event> {
    run_id: &'event RunId,
}

impl<'event> TurnProjection<'event> {
    pub fn run_id(self) -> &'event RunId {
        self.run_id
    }
}

impl fmt::Debug for TurnProjection<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TurnProjection")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunLifecycle {
    Queued,
    Started,
    WaitingForApproval,
    CancellationRequested,
    Cancelled,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessageLifecycle {
    Started,
    Delta,
    Completed,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProjectedMessageEvent {
    message_id: MessageId,
    lifecycle: MessageLifecycle,
    text_delta: Option<String>,
    thinking_delta: Option<String>,
    message_text: Option<String>,
    thinking_text: Option<String>,
}

impl ProjectedMessageEvent {
    pub fn message_id(&self) -> &MessageId {
        &self.message_id
    }

    pub fn lifecycle(&self) -> MessageLifecycle {
        self.lifecycle
    }

    pub fn text_delta(&self) -> Option<&str> {
        self.text_delta.as_deref()
    }

    pub fn thinking_delta(&self) -> Option<&str> {
        self.thinking_delta.as_deref()
    }

    pub fn message_text(&self) -> Option<&str> {
        self.message_text.as_deref()
    }

    pub fn thinking_text(&self) -> Option<&str> {
        self.thinking_text.as_deref()
    }
}

impl fmt::Debug for ProjectedMessageEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectedMessageEvent")
            .field("lifecycle", &self.lifecycle)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalAction {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProjectedApprovalOption {
    option_id: OptionId,
    action: ApprovalAction,
}

impl ProjectedApprovalOption {
    pub fn option_id(&self) -> &OptionId {
        &self.option_id
    }

    pub fn action(&self) -> ApprovalAction {
        self.action
    }
}

impl fmt::Debug for ProjectedApprovalOption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectedApprovalOption")
            .field("action", &self.action)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalCancellation {
    RunCancelled,
    WorkerExited,
}

#[derive(Clone, Eq, PartialEq)]
pub enum ApprovalResolution {
    Approved { option_id: OptionId },
    Denied,
    Cancelled(ApprovalCancellation),
    Expired,
}

impl fmt::Debug for ApprovalResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Approved { .. } => formatter.debug_struct("Approved").finish_non_exhaustive(),
            Self::Denied => formatter.debug_struct("Denied").finish(),
            Self::Cancelled(cancellation) => formatter
                .debug_struct("Cancelled")
                .field("cancellation", cancellation)
                .finish(),
            Self::Expired => formatter.debug_struct("Expired").finish(),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum ApprovalPhase {
    Requested {
        options: Vec<ProjectedApprovalOption>,
    },
    Resolved(ApprovalResolution),
}

impl fmt::Debug for ApprovalPhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Requested { options } => formatter
                .debug_struct("Requested")
                .field("option_count", &options.len())
                .finish(),
            Self::Resolved(resolution) => {
                formatter.debug_tuple("Resolved").field(resolution).finish()
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolActivityPhase {
    Started,
    Updated,
    Completed,
    Failed,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProjectedToolActivity {
    tool_call_id: ToolCallId,
    name: Option<String>,
    phase: ToolActivityPhase,
    input: Option<Value>,
    input_text: Option<String>,
    summary: Option<String>,
    output: Option<Value>,
    is_error: Option<bool>,
}

impl ProjectedToolActivity {
    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub fn phase(&self) -> ToolActivityPhase {
        self.phase
    }

    pub fn input(&self) -> Option<&Value> {
        self.input.as_ref()
    }

    pub fn input_text(&self) -> Option<&str> {
        self.input_text.as_deref()
    }

    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }

    pub fn output(&self) -> Option<&Value> {
        self.output.as_ref()
    }

    pub fn is_error(&self) -> Option<bool> {
        self.is_error
    }
}

impl fmt::Debug for ProjectedToolActivity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectedToolActivity")
            .field("phase", &self.phase)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProjectedApprovalEvent {
    approval_id: ApprovalId,
    phase: ApprovalPhase,
}

impl ProjectedApprovalEvent {
    pub fn approval_id(&self) -> &ApprovalId {
        &self.approval_id
    }

    pub fn phase(&self) -> &ApprovalPhase {
        &self.phase
    }
}

impl fmt::Debug for ProjectedApprovalEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectedApprovalEvent")
            .field("phase", &self.phase)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum EventActivity {
    Run(RunLifecycle),
    Message(ProjectedMessageEvent),
    Tool(ProjectedToolActivity),
    Approval(ProjectedApprovalEvent),
    Ignored,
}

impl fmt::Debug for EventActivity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Run(lifecycle) => formatter.debug_tuple("Run").field(lifecycle).finish(),
            Self::Message(message) => formatter.debug_tuple("Message").field(message).finish(),
            Self::Tool(tool) => formatter.debug_tuple("Tool").field(tool).finish(),
            Self::Approval(approval) => formatter.debug_tuple("Approval").field(approval).finish(),
            Self::Ignored => formatter.write_str("Ignored"),
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct ProjectedSessionEvent {
    sequence: Sequence,
    run_id: RunId,
    activity: EventActivity,
}

impl ProjectedSessionEvent {
    pub fn sequence(&self) -> Sequence {
        self.sequence
    }

    pub fn turn(&self) -> TurnProjection<'_> {
        TurnProjection {
            run_id: &self.run_id,
        }
    }

    pub fn activity(&self) -> &EventActivity {
        &self.activity
    }

    pub fn message_id(&self) -> Option<&MessageId> {
        match &self.activity {
            EventActivity::Message(message) => Some(message.message_id()),
            EventActivity::Run(_)
            | EventActivity::Tool(_)
            | EventActivity::Approval(_)
            | EventActivity::Ignored => None,
        }
    }
}

impl fmt::Debug for ProjectedSessionEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectedSessionEvent")
            .field("sequence", &self.sequence)
            .field("activity", &self.activity)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventRejection {
    Malformed,
    Unsupported,
}

#[derive(Clone, PartialEq)]
pub enum EventProjectionResult {
    Projected(ProjectedSessionEvent),
    Rejected {
        sequence: Sequence,
        reason: EventRejection,
    },
    Duplicate {
        sequence: Sequence,
    },
    Gap {
        expected: Sequence,
        received: Sequence,
    },
    Stale {
        cursor: Sequence,
        received: Sequence,
    },
    OutOfRun {
        sequence: Sequence,
    },
    OutOfSession {
        sequence: Sequence,
    },
}

impl fmt::Debug for EventProjectionResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Projected(event) => event.fmt(formatter),
            Self::Rejected { sequence, reason } => formatter
                .debug_struct("Rejected")
                .field("sequence", sequence)
                .field("reason", reason)
                .finish(),
            Self::Duplicate { sequence } => formatter
                .debug_struct("Duplicate")
                .field("sequence", sequence)
                .finish(),
            Self::Gap { expected, received } => formatter
                .debug_struct("Gap")
                .field("expected", expected)
                .field("received", received)
                .finish(),
            Self::Stale { cursor, received } => formatter
                .debug_struct("Stale")
                .field("cursor", cursor)
                .field("received", received)
                .finish(),
            Self::OutOfRun { sequence } => formatter
                .debug_struct("OutOfRun")
                .field("sequence", sequence)
                .finish(),
            Self::OutOfSession { sequence } => formatter
                .debug_struct("OutOfSession")
                .field("sequence", sequence)
                .finish(),
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SessionEventObservation {
    Accepted {
        sequence: Sequence,
    },
    Duplicate {
        sequence: Sequence,
    },
    Gap {
        expected: Sequence,
        received: Sequence,
    },
    Stale {
        cursor: Sequence,
        received: Sequence,
    },
    OutOfSession {
        sequence: Sequence,
    },
    Closed {
        cursor: Sequence,
    },
}

impl fmt::Debug for SessionEventObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Accepted { sequence } => formatter
                .debug_struct("Accepted")
                .field("sequence", sequence)
                .finish(),
            Self::Duplicate { sequence } => formatter
                .debug_struct("Duplicate")
                .field("sequence", sequence)
                .finish(),
            Self::Gap { expected, received } => formatter
                .debug_struct("Gap")
                .field("expected", expected)
                .field("received", received)
                .finish(),
            Self::Stale { cursor, received } => formatter
                .debug_struct("Stale")
                .field("cursor", cursor)
                .field("received", received)
                .finish(),
            Self::OutOfSession { sequence } => formatter
                .debug_struct("OutOfSession")
                .field("sequence", sequence)
                .finish(),
            Self::Closed { cursor } => formatter
                .debug_struct("Closed")
                .field("cursor", cursor)
                .finish(),
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct SessionEventUpdate {
    observation: SessionEventObservation,
    sequence: Option<Sequence>,
    has_run: bool,
    has_message: bool,
}

impl SessionEventUpdate {
    pub(crate) fn new(
        observation: SessionEventObservation,
        sequence: Option<Sequence>,
        has_run: bool,
        has_message: bool,
    ) -> Self {
        Self {
            observation,
            sequence,
            has_run,
            has_message,
        }
    }

    pub fn observation(&self) -> SessionEventObservation {
        self.observation
    }

    pub fn sequence(&self) -> Option<Sequence> {
        self.sequence
    }

    pub fn has_run(&self) -> bool {
        self.has_run
    }

    pub fn has_message(&self) -> bool {
        self.has_message
    }
}

impl fmt::Debug for SessionEventUpdate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEventUpdate")
            .field("observation", &self.observation)
            .field("sequence", &self.sequence)
            .field("has_run", &self.has_run)
            .field("has_message", &self.has_message)
            .finish()
    }
}

pub struct SessionEventCursor {
    session_id: SessionId,
    sequence: Sequence,
}

impl SessionEventCursor {
    pub fn new(session_id: SessionId) -> Self {
        Self::resume_after(
            session_id,
            Sequence::try_new(0).expect("zero is valid as an empty afterSeq cursor"),
        )
    }

    pub fn resume_after(session_id: SessionId, sequence: Sequence) -> Self {
        Self {
            session_id,
            sequence,
        }
    }

    pub(crate) fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub fn sequence(&self) -> Sequence {
        self.sequence
    }

    pub fn observe(&mut self, envelope: &EventEnvelope) -> SessionEventObservation {
        if envelope.session_id != self.session_id {
            return SessionEventObservation::OutOfSession {
                sequence: envelope.seq,
            };
        }

        let received = envelope.seq;
        if received.get() < self.sequence.get() {
            return SessionEventObservation::Stale {
                cursor: self.sequence,
                received,
            };
        }
        if received == self.sequence {
            return SessionEventObservation::Duplicate { sequence: received };
        }

        let expected = Sequence::try_new(self.sequence.get() + 1)
            .expect("a greater valid sequence proves the successor is valid");
        if received != expected {
            return SessionEventObservation::Gap { expected, received };
        }

        self.sequence = received;
        SessionEventObservation::Accepted { sequence: received }
    }
}

impl fmt::Debug for SessionEventCursor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEventCursor")
            .field("sequence", &self.sequence)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SdkAssistantTextState {
    AwaitingText,
    StreamTextProjected,
    FallbackTextProjected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SdkFullTextPolicy {
    ProjectFallback,
    Suppress,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SdkToolBlock {
    tool_call_id: ToolCallId,
    name: Option<String>,
    input: Option<Value>,
    input_text: String,
}

impl SdkToolBlock {
    fn update_input_from_text(&mut self) {
        if let Some(input) = projected_tool_input_from_text(&self.input_text) {
            self.input = Some(input);
        }
    }
}

impl SdkAssistantTextState {
    fn full_text_policy(self) -> SdkFullTextPolicy {
        match self {
            Self::AwaitingText => SdkFullTextPolicy::ProjectFallback,
            Self::StreamTextProjected | Self::FallbackTextProjected => SdkFullTextPolicy::Suppress,
        }
    }

    fn observe_projected_message(&mut self, message: &ProjectedMessageEvent) {
        if !matches!(message.message_text(), Some(text) if !text.is_empty()) {
            return;
        }
        if *self != Self::AwaitingText {
            return;
        }
        *self = if message.text_delta().is_some() {
            Self::StreamTextProjected
        } else {
            Self::FallbackTextProjected
        };
    }
}

impl SdkFullTextPolicy {
    fn projects_fallback(self) -> bool {
        self == Self::ProjectFallback
    }
}

pub struct SessionEventProjector {
    session_id: SessionId,
    run_id: RunId,
    cursor: Sequence,
    terminal: bool,
    message_text: HashMap<MessageId, String>,
    message_thinking: HashMap<MessageId, String>,
    current_sdk_assistant_message_id: Option<MessageId>,
    current_sdk_tool_blocks: HashMap<u64, SdkToolBlock>,
    sdk_tool_names: HashMap<ToolCallId, String>,
    sdk_text_state: SdkAssistantTextState,
}

impl SessionEventProjector {
    pub fn new(session_id: SessionId, run_id: RunId) -> Self {
        Self::resume_after(
            session_id,
            run_id,
            Sequence::try_new(0).expect("zero is valid"),
        )
    }

    pub fn resume_after(session_id: SessionId, run_id: RunId, cursor: Sequence) -> Self {
        Self {
            session_id,
            run_id,
            cursor,
            terminal: false,
            message_text: HashMap::new(),
            message_thinking: HashMap::new(),
            current_sdk_assistant_message_id: None,
            current_sdk_tool_blocks: HashMap::new(),
            sdk_tool_names: HashMap::new(),
            sdk_text_state: SdkAssistantTextState::AwaitingText,
        }
    }

    pub fn cursor(&self) -> Sequence {
        self.cursor
    }

    pub fn is_terminal(&self) -> bool {
        self.terminal
    }

    pub fn project(&mut self, envelope: EventEnvelope) -> EventProjectionResult {
        if envelope.session_id != self.session_id {
            return EventProjectionResult::OutOfSession {
                sequence: envelope.seq,
            };
        }

        let received = envelope.seq;
        if self.terminal {
            return EventProjectionResult::Stale {
                cursor: self.cursor,
                received,
            };
        }
        if received.get() < self.cursor.get() {
            return EventProjectionResult::Stale {
                cursor: self.cursor,
                received,
            };
        }
        if received == self.cursor {
            return EventProjectionResult::Duplicate { sequence: received };
        }

        let expected = Sequence::try_new(self.cursor.get() + 1)
            .expect("a greater valid sequence proves the successor is valid");
        if received != expected {
            return EventProjectionResult::Gap { expected, received };
        }

        self.cursor = received;
        if !self.owns_run(&envelope) {
            return EventProjectionResult::OutOfRun { sequence: received };
        }

        let is_sdk_message = envelope.event.event_type() == "sdk.message";
        let activity_result = if is_sdk_message {
            project_sdk_message(
                envelope.event.as_value(),
                &mut self.current_sdk_assistant_message_id,
                &mut self.current_sdk_tool_blocks,
                &mut self.sdk_tool_names,
                self.sdk_text_state.full_text_policy(),
            )
        } else {
            project_activity(
                &envelope.event,
                &self.session_id,
                &self.run_id,
                envelope.worker_id.as_ref(),
            )
        };

        match activity_result {
            Ok(mut activity) => {
                if let EventActivity::Message(message) = &mut activity {
                    let message_id = message.message_id().clone();
                    let text_delta = message.text_delta().map(str::to_owned);
                    let thinking_delta = message.thinking_delta().map(str::to_owned);
                    let (message_text, thinking_text) = match message.lifecycle() {
                        MessageLifecycle::Started => {
                            if !self.message_text.contains_key(&message_id)
                                && self.message_text.len() >= MAX_PROJECTED_MESSAGE_COUNT
                            {
                                return EventProjectionResult::Rejected {
                                    sequence: received,
                                    reason: EventRejection::Malformed,
                                };
                            }
                            self.message_text.insert(message_id.clone(), String::new());
                            self.message_thinking
                                .insert(message_id.clone(), String::new());
                            (Some(String::new()), None)
                        }
                        MessageLifecycle::Delta => {
                            if text_delta.is_none() && thinking_delta.is_none() {
                                return EventProjectionResult::Rejected {
                                    sequence: received,
                                    reason: EventRejection::Malformed,
                                };
                            }
                            if !self.message_text.contains_key(&message_id)
                                && self.message_text.len() >= MAX_PROJECTED_MESSAGE_COUNT
                            {
                                return EventProjectionResult::Rejected {
                                    sequence: received,
                                    reason: EventRejection::Malformed,
                                };
                            }
                            let text = self.message_text.entry(message_id.clone()).or_default();
                            if let Some(delta) = text_delta.as_deref() {
                                if text.len().saturating_add(delta.len())
                                    > MAX_PROJECTED_MESSAGE_TEXT_BYTES
                                {
                                    return EventProjectionResult::Rejected {
                                        sequence: received,
                                        reason: EventRejection::Malformed,
                                    };
                                }
                                text.push_str(delta);
                            }
                            let thinking =
                                self.message_thinking.entry(message_id.clone()).or_default();
                            if let Some(delta) = thinking_delta.as_deref() {
                                if thinking.len().saturating_add(delta.len())
                                    > MAX_PROJECTED_MESSAGE_TEXT_BYTES
                                {
                                    return EventProjectionResult::Rejected {
                                        sequence: received,
                                        reason: EventRejection::Malformed,
                                    };
                                }
                                thinking.push_str(delta);
                            }
                            let thinking_text = (!thinking.is_empty()).then(|| thinking.clone());
                            (Some(text.clone()), thinking_text)
                        }
                        MessageLifecycle::Completed => {
                            let text = message.message_text.take().unwrap_or_else(|| {
                                self.message_text.remove(&message_id).unwrap_or_default()
                            });
                            self.message_text.remove(&message_id);
                            let thinking = message
                                .thinking_text
                                .take()
                                .or_else(|| self.message_thinking.remove(&message_id))
                                .filter(|text| !text.is_empty());
                            self.message_thinking.remove(&message_id);
                            (Some(text), thinking)
                        }
                    };
                    message.message_text = message_text;
                    message.thinking_text = thinking_text;
                    if is_sdk_message {
                        self.sdk_text_state.observe_projected_message(message);
                    }
                }
                let terminal = matches!(
                    activity,
                    EventActivity::Run(
                        RunLifecycle::Cancelled
                            | RunLifecycle::Completed
                            | RunLifecycle::Failed
                            | RunLifecycle::Interrupted
                    )
                );
                self.terminal |= terminal;
                EventProjectionResult::Projected(ProjectedSessionEvent {
                    sequence: received,
                    run_id: self.run_id.clone(),
                    activity,
                })
            }
            Err(reason) => EventProjectionResult::Rejected {
                sequence: received,
                reason,
            },
        }
    }

    fn owns_run(&self, envelope: &EventEnvelope) -> bool {
        if envelope.run_id.as_ref() != Some(&self.run_id) {
            return false;
        }
        match embedded_run_id(&envelope.event) {
            Ok(Some(run_id)) => run_id == self.run_id.as_str(),
            Ok(None) => true,
            Err(()) => false,
        }
    }
}

impl fmt::Debug for SessionEventProjector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEventProjector")
            .field("cursor", &self.cursor)
            .finish_non_exhaustive()
    }
}

pub(crate) fn project_native_activity(
    envelope: &EventEnvelope,
) -> Result<Option<EventActivity>, EventRejection> {
    let activity = match envelope.event.event_type() {
        "message.started" => project_native_message(&envelope.event, MessageLifecycle::Started),
        "message.delta" => project_native_message(&envelope.event, MessageLifecycle::Delta),
        "message.completed" => project_native_message(&envelope.event, MessageLifecycle::Completed),
        "tool.activity" => project_tool_activity(envelope.event.as_value()),
        "session.created"
        | "session.loaded"
        | "session.closed"
        | "worker.spawning"
        | "worker.ready"
        | "worker.heartbeat"
        | "worker.crashed"
        | "usage.updated"
        | "error.reported"
        | "snapshot.invalidated" => Ok(EventActivity::Ignored),
        // sdk.message requires stateful projection (current_sdk_assistant_message_id);
        // the stateless snapshot/replay path cannot project it correctly.
        "sdk.message" => Ok(EventActivity::Ignored),
        _ => {
            let Some(run_id) = envelope.run_id.as_ref() else {
                return Err(EventRejection::Malformed);
            };
            project_activity(
                &envelope.event,
                &envelope.session_id,
                run_id,
                envelope.worker_id.as_ref(),
            )
        }
    }?;
    Ok((!matches!(activity, EventActivity::Ignored)).then_some(activity))
}

fn project_activity(
    event: &Event,
    expected_session_id: &SessionId,
    expected_run_id: &RunId,
    expected_worker_id: Option<&WorkerId>,
) -> Result<EventActivity, EventRejection> {
    match event.event_type() {
        "run.queued" => project_queued_run(event.as_value(), &expected_session_id, expected_run_id),
        "run.started" => project_started_run(event.as_value(), expected_run_id, expected_worker_id),
        "run.waitingForApproval" => project_run(
            event.as_value(),
            expected_run_id,
            RunLifecycle::WaitingForApproval,
        ),
        "run.cancelRequested" => project_run(
            event.as_value(),
            expected_run_id,
            RunLifecycle::CancellationRequested,
        ),
        "run.cancelled" => project_run(event.as_value(), expected_run_id, RunLifecycle::Cancelled),
        "run.completed" => project_run(event.as_value(), expected_run_id, RunLifecycle::Completed),
        "run.failed" => project_run(event.as_value(), expected_run_id, RunLifecycle::Failed),
        "run.interrupted" => {
            project_run(event.as_value(), expected_run_id, RunLifecycle::Interrupted)
        }
        "message.started" => project_native_message(event, MessageLifecycle::Started),
        "message.delta" => project_native_message(event, MessageLifecycle::Delta),
        "message.completed" => project_native_message(event, MessageLifecycle::Completed),
        "tool.activity" => project_tool_activity(event.as_value()),
        "renderer.message.started"
        | "renderer.message.delta"
        | "renderer.message.completed"
        | "renderer.tool.activity" => Err(EventRejection::Unsupported),
        "run.trace" => project_run_trace(event.as_value(), expected_run_id),
        "approval.requested" => project_approval(
            event.as_value(),
            expected_session_id,
            expected_run_id,
            expected_worker_id,
            true,
        ),
        "approval.resolved" => project_approval(
            event.as_value(),
            expected_session_id,
            expected_run_id,
            expected_worker_id,
            false,
        ),
        _ => Err(EventRejection::Unsupported),
    }
}

fn project_queued_run(
    value: &Value,
    expected_session_id: &SessionId,
    expected_run_id: &RunId,
) -> Result<EventActivity, EventRejection> {
    let run = value.get("run").ok_or(EventRejection::Malformed)?;
    if run
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|session_id| *session_id == expected_session_id.as_str())
        .is_none()
        || run
            .get("runId")
            .and_then(Value::as_str)
            .filter(|run_id| *run_id == expected_run_id.as_str())
            .is_none()
    {
        return Err(EventRejection::Malformed);
    }
    Ok(EventActivity::Run(RunLifecycle::Queued))
}

fn project_started_run(
    value: &Value,
    expected_run_id: &RunId,
    expected_worker_id: Option<&WorkerId>,
) -> Result<EventActivity, EventRejection> {
    project_run(value, expected_run_id, RunLifecycle::Started)?;
    if !matches!(
        (expected_worker_id, value.get("workerId").and_then(Value::as_str)),
        (Some(expected), Some(actual)) if actual == expected.as_str()
    ) {
        return Err(EventRejection::Malformed);
    }
    Ok(EventActivity::Run(RunLifecycle::Started))
}

fn project_run(
    value: &Value,
    expected_run_id: &RunId,
    lifecycle: RunLifecycle,
) -> Result<EventActivity, EventRejection> {
    if value
        .get("runId")
        .and_then(Value::as_str)
        .filter(|run_id| *run_id == expected_run_id.as_str())
        .is_none()
    {
        return Err(EventRejection::Malformed);
    }
    Ok(EventActivity::Run(lifecycle))
}

fn project_run_trace(
    value: &Value,
    expected_run_id: &RunId,
) -> Result<EventActivity, EventRejection> {
    project_run(value, expected_run_id, RunLifecycle::Queued)?;
    Ok(EventActivity::Ignored)
}

fn project_native_message(
    event: &Event,
    lifecycle: MessageLifecycle,
) -> Result<EventActivity, EventRejection> {
    project_message_with_field(event, lifecycle, "delta")
}

fn project_message_with_field(
    event: &Event,
    lifecycle: MessageLifecycle,
    delta_field: &str,
) -> Result<EventActivity, EventRejection> {
    let message_id = event
        .message_id()
        .cloned()
        .ok_or(EventRejection::Malformed)?;
    let text_delta = match lifecycle {
        MessageLifecycle::Delta => Some(
            event
                .as_value()
                .get(delta_field)
                .and_then(Value::as_str)
                .filter(|text| text.len() <= MAX_PROJECTED_TEXT_DELTA_BYTES)
                .map(ToOwned::to_owned)
                .ok_or(EventRejection::Malformed)?,
        ),
        MessageLifecycle::Started | MessageLifecycle::Completed => None,
    };
    Ok(EventActivity::Message(ProjectedMessageEvent {
        message_id,
        lifecycle,
        text_delta,
        thinking_delta: None,
        message_text: None,
        thinking_text: None,
    }))
}

fn project_tool_activity(value: &Value) -> Result<EventActivity, EventRejection> {
    let tool_call_id = project_tool_call_id(value.get("toolCallId"))?;
    let phase = match value.get("phase").and_then(Value::as_str) {
        Some("started") => ToolActivityPhase::Started,
        Some("updated") => ToolActivityPhase::Updated,
        Some("completed") => ToolActivityPhase::Completed,
        Some("failed") => ToolActivityPhase::Failed,
        _ => return Err(EventRejection::Malformed),
    };
    let input = projected_tool_payload(value.get("input"));
    let input_text = projected_tool_payload_text(value.get("inputText"));
    Ok(project_tool_event(
        tool_call_id,
        projected_tool_name(value.get("toolName")),
        phase,
        input.clone(),
        projected_tool_input_text(input.as_ref(), input_text.as_deref()),
        projected_tool_summary(value.get("summary")),
        projected_tool_payload(value.get("output")),
        matches!(phase, ToolActivityPhase::Failed).then_some(true),
    ))
}

fn project_sdk_message(
    value: &Value,
    current_assistant_id: &mut Option<MessageId>,
    current_tool_blocks: &mut HashMap<u64, SdkToolBlock>,
    tool_names: &mut HashMap<ToolCallId, String>,
    full_text_policy: SdkFullTextPolicy,
) -> Result<EventActivity, EventRejection> {
    if value.get("sdkMessageVersion").and_then(Value::as_str) != Some("claude-code-sdk-message-v1")
    {
        return Err(EventRejection::Malformed);
    }
    let sdk_message = value
        .get("sdkMessage")
        .and_then(Value::as_object)
        .ok_or(EventRejection::Malformed)?;

    let uuid = sdk_message.get("uuid").and_then(Value::as_str);
    let sdk_type = sdk_message.get("type").and_then(Value::as_str);

    if let Some(stream_event) = sdk_message.get("event").and_then(Value::as_object) {
        match stream_event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                let id = stream_event
                    .get("message")
                    .and_then(Value::as_object)
                    .and_then(|message| message.get("id"))
                    .and_then(Value::as_str)
                    .or(uuid)
                    .ok_or(EventRejection::Malformed)?;
                let message_id = MessageId::try_new(id).map_err(|_| EventRejection::Malformed)?;
                *current_assistant_id = Some(message_id.clone());
                current_tool_blocks.clear();
                return Ok(EventActivity::Message(ProjectedMessageEvent {
                    message_id,
                    lifecycle: MessageLifecycle::Started,
                    text_delta: None,
                    thinking_delta: None,
                    message_text: None,
                    thinking_text: None,
                }));
            }
            Some("content_block_start") => {
                let Some(block) = stream_event.get("content_block").and_then(Value::as_object)
                else {
                    return Ok(EventActivity::Ignored);
                };
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    return Ok(EventActivity::Ignored);
                }
                let tool_call_id = project_tool_call_id(block.get("id"))?;
                let name = projected_tool_name(block.get("name"));
                let input = projected_tool_payload(block.get("input"));
                let input_text = projected_tool_input_text(input.as_ref(), None);
                if let Some(index) = stream_event.get("index").and_then(Value::as_u64) {
                    current_tool_blocks.insert(
                        index,
                        SdkToolBlock {
                            tool_call_id: tool_call_id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                            input_text: String::new(),
                        },
                    );
                }
                if let Some(name) = name.as_ref() {
                    tool_names.insert(tool_call_id.clone(), name.clone());
                }
                return Ok(project_tool_event(
                    tool_call_id,
                    name,
                    ToolActivityPhase::Started,
                    input,
                    input_text,
                    None,
                    None,
                    None,
                ));
            }
            Some("content_block_delta") => {
                let Some(delta) = stream_event.get("delta").and_then(Value::as_object) else {
                    return Ok(EventActivity::Ignored);
                };
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = projected_text_delta(delta.get("text"))?;
                        let message_id = current_sdk_message_id(current_assistant_id, uuid)?;
                        return Ok(EventActivity::Message(ProjectedMessageEvent {
                            message_id,
                            lifecycle: MessageLifecycle::Delta,
                            text_delta: Some(text),
                            thinking_delta: None,
                            message_text: None,
                            thinking_text: None,
                        }));
                    }
                    Some("thinking_delta") => {
                        let thinking = projected_text_delta(
                            delta.get("thinking").or_else(|| delta.get("text")),
                        )?;
                        let message_id = current_sdk_message_id(current_assistant_id, uuid)?;
                        return Ok(EventActivity::Message(ProjectedMessageEvent {
                            message_id,
                            lifecycle: MessageLifecycle::Delta,
                            text_delta: None,
                            thinking_delta: Some(thinking),
                            message_text: None,
                            thinking_text: None,
                        }));
                    }
                    Some("input_json_delta") => {
                        let Some(tool) = stream_event
                            .get("index")
                            .and_then(Value::as_u64)
                            .and_then(|index| current_tool_blocks.get_mut(&index))
                        else {
                            return Ok(EventActivity::Ignored);
                        };
                        let partial_json = projected_tool_payload_text(delta.get("partial_json"));
                        if let Some(partial_json) = partial_json.as_deref()
                            && !append_projected_text(
                                &mut tool.input_text,
                                partial_json,
                                MAX_PROJECTED_TOOL_PAYLOAD_BYTES,
                            )
                        {
                            return Err(EventRejection::Malformed);
                        }
                        tool.update_input_from_text();
                        return Ok(project_tool_event(
                            tool.tool_call_id.clone(),
                            tool.name.clone(),
                            ToolActivityPhase::Updated,
                            tool.input.clone(),
                            projected_tool_input_text(None, Some(&tool.input_text)),
                            None,
                            None,
                            None,
                        ));
                    }
                    _ => return Ok(EventActivity::Ignored),
                }
            }
            Some("content_block_stop") => {
                let Some(tool) = stream_event
                    .get("index")
                    .and_then(Value::as_u64)
                    .and_then(|index| current_tool_blocks.remove(&index))
                else {
                    return Ok(EventActivity::Ignored);
                };
                let mut tool = tool;
                tool.update_input_from_text();
                return Ok(project_tool_event(
                    tool.tool_call_id,
                    tool.name,
                    ToolActivityPhase::Updated,
                    tool.input,
                    projected_tool_input_text(None, Some(&tool.input_text)),
                    None,
                    None,
                    None,
                ));
            }
            Some("message_stop") => {
                let message_id = current_sdk_message_id(current_assistant_id, uuid)?;
                *current_assistant_id = None;
                current_tool_blocks.clear();
                return Ok(EventActivity::Message(ProjectedMessageEvent {
                    message_id,
                    lifecycle: MessageLifecycle::Completed,
                    text_delta: None,
                    thinking_delta: None,
                    message_text: None,
                    thinking_text: None,
                }));
            }
            _ => return Ok(EventActivity::Ignored),
        }
    }

    match sdk_type {
        Some("tool_progress") => {
            let tool_call_id = project_tool_call_id(sdk_message.get("tool_use_id"))?;
            let name = projected_tool_name(sdk_message.get("tool_name"))
                .or_else(|| tool_names.get(&tool_call_id).cloned());
            if let Some(name) = name.as_ref() {
                tool_names.insert(tool_call_id.clone(), name.clone());
            }
            Ok(project_tool_event(
                tool_call_id,
                name,
                ToolActivityPhase::Updated,
                None,
                None,
                None,
                None,
                None,
            ))
        }
        Some("assistant") => {
            let content = sdk_message
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
                .or_else(|| sdk_message.get("content").and_then(Value::as_array));
            let Some(content) = content else {
                return Ok(EventActivity::Ignored);
            };
            for block in content {
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let tool_call_id = project_tool_call_id(block.get("id"))?;
                    let name = projected_tool_name(block.get("name"));
                    if let Some(name) = name.as_ref() {
                        tool_names.insert(tool_call_id.clone(), name.clone());
                    }
                    let input = projected_tool_payload(block.get("input"));
                    return Ok(project_tool_event(
                        tool_call_id,
                        name,
                        ToolActivityPhase::Started,
                        input.clone(),
                        projected_tool_input_text(input.as_ref(), None),
                        None,
                        None,
                        None,
                    ));
                }
            }
            if !full_text_policy.projects_fallback() {
                return Ok(EventActivity::Ignored);
            }
            let message_text = projected_message_text(content, "text")?;
            let thinking_text = projected_thinking_text(content)?;
            if message_text.is_none() && thinking_text.is_none() {
                return Ok(EventActivity::Ignored);
            }
            let id = uuid.ok_or(EventRejection::Malformed)?;
            let message_id = MessageId::try_new(id).map_err(|_| EventRejection::Malformed)?;
            Ok(EventActivity::Message(ProjectedMessageEvent {
                message_id,
                lifecycle: MessageLifecycle::Completed,
                text_delta: None,
                thinking_delta: None,
                message_text,
                thinking_text,
            }))
        }
        Some("user") => {
            let content = sdk_message
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
                .or_else(|| sdk_message.get("content").and_then(Value::as_array));
            let Some(content) = content else {
                return Ok(EventActivity::Ignored);
            };
            for block in content {
                let block_type = block.get("type").and_then(Value::as_str);
                if block_type == Some("tool_result") || block_type == Some("tool_use_result") {
                    let tool_call_id = project_tool_call_id(
                        block
                            .get("tool_use_id")
                            .or_else(|| block.get("toolUseId"))
                            .or_else(|| block.get("id")),
                    )?;
                    let name = tool_names.get(&tool_call_id).cloned();
                    let is_error = block
                        .get("is_error")
                        .or_else(|| block.get("isError"))
                        .and_then(Value::as_bool)
                        == Some(true);
                    let output = projected_tool_result_output(block);
                    return Ok(project_tool_event(
                        tool_call_id,
                        name,
                        if is_error {
                            ToolActivityPhase::Failed
                        } else {
                            ToolActivityPhase::Completed
                        },
                        None,
                        None,
                        projected_tool_result_summary(block),
                        output,
                        Some(is_error),
                    ));
                }
            }
            Ok(EventActivity::Ignored)
        }
        Some("result") => {
            *current_assistant_id = None;
            current_tool_blocks.clear();
            if !full_text_policy.projects_fallback() {
                return Ok(EventActivity::Ignored);
            }
            let Some(message_text) = projected_non_empty_text(
                sdk_message.get("result"),
                MAX_PROJECTED_MESSAGE_TEXT_BYTES,
            ) else {
                return Ok(EventActivity::Ignored);
            };
            let id = uuid.ok_or(EventRejection::Malformed)?;
            let message_id = MessageId::try_new(id).map_err(|_| EventRejection::Malformed)?;
            Ok(EventActivity::Message(ProjectedMessageEvent {
                message_id,
                lifecycle: MessageLifecycle::Completed,
                text_delta: None,
                thinking_delta: None,
                message_text: Some(message_text),
                thinking_text: None,
            }))
        }
        _ => Ok(EventActivity::Ignored),
    }
}

fn project_tool_event(
    tool_call_id: ToolCallId,
    name: Option<String>,
    phase: ToolActivityPhase,
    input: Option<Value>,
    input_text: Option<String>,
    summary: Option<String>,
    output: Option<Value>,
    is_error: Option<bool>,
) -> EventActivity {
    EventActivity::Tool(ProjectedToolActivity {
        tool_call_id,
        name,
        phase,
        input,
        input_text,
        summary,
        output,
        is_error,
    })
}

fn current_sdk_message_id(
    current_assistant_id: &Option<MessageId>,
    uuid: Option<&str>,
) -> Result<MessageId, EventRejection> {
    let id = current_assistant_id
        .as_ref()
        .map(|id| id.as_str())
        .or(uuid)
        .ok_or(EventRejection::Malformed)?;
    MessageId::try_new(id).map_err(|_| EventRejection::Malformed)
}

fn project_tool_call_id(value: Option<&Value>) -> Result<ToolCallId, EventRejection> {
    value
        .and_then(Value::as_str)
        .ok_or(EventRejection::Malformed)
        .and_then(|value| ToolCallId::try_new(value).map_err(|_| EventRejection::Malformed))
}

fn projected_text_delta(value: Option<&Value>) -> Result<String, EventRejection> {
    value
        .and_then(Value::as_str)
        .filter(|text| text.len() <= MAX_PROJECTED_TEXT_DELTA_BYTES && !text.contains('\0'))
        .map(ToOwned::to_owned)
        .ok_or(EventRejection::Malformed)
}

fn projected_message_text(
    content: &[Value],
    field: &str,
) -> Result<Option<String>, EventRejection> {
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let part = block
            .get(field)
            .and_then(Value::as_str)
            .ok_or(EventRejection::Malformed)?;
        if !append_projected_text(&mut text, part, MAX_PROJECTED_MESSAGE_TEXT_BYTES) {
            return Err(EventRejection::Malformed);
        }
    }
    Ok((!text.is_empty()).then_some(text))
}

fn projected_thinking_text(content: &[Value]) -> Result<Option<String>, EventRejection> {
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("thinking") {
            continue;
        }
        let Some(part) = block
            .get("thinking")
            .or_else(|| block.get("text"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if !append_projected_text(&mut text, part, MAX_PROJECTED_MESSAGE_TEXT_BYTES) {
            return Err(EventRejection::Malformed);
        }
    }
    Ok((!text.is_empty()).then_some(text))
}

fn projected_tool_name(value: Option<&Value>) -> Option<String> {
    let name = value?.as_str()?;
    (!name.is_empty()
        && name.len() <= MAX_PROJECTED_TOOL_NAME_BYTES
        && name.trim() == name
        && !name.chars().any(char::is_control))
    .then(|| name.to_owned())
}

fn projected_tool_summary(value: Option<&Value>) -> Option<String> {
    projected_non_empty_text(value, MAX_PROJECTED_TOOL_SUMMARY_BYTES)
}

fn projected_tool_payload(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let text = serde_json::to_string(value).ok()?;
    (text.len() <= MAX_PROJECTED_TOOL_PAYLOAD_BYTES && !payload_contains_nul(value))
        .then(|| value.clone())
}

fn projected_tool_payload_text(value: Option<&Value>) -> Option<String> {
    projected_non_empty_text(value, MAX_PROJECTED_TOOL_PAYLOAD_BYTES)
}

fn projected_tool_input_text(input: Option<&Value>, text: Option<&str>) -> Option<String> {
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        return Some(text.to_owned());
    }
    match input? {
        Value::String(_) => projected_non_empty_text(input, MAX_PROJECTED_TOOL_PAYLOAD_BYTES),
        value => projected_json_payload_text(value),
    }
}

fn projected_json_payload_text(value: &Value) -> Option<String> {
    let text = serde_json::to_string_pretty(value).ok()?;
    (text.len() <= MAX_PROJECTED_TOOL_PAYLOAD_BYTES && !payload_contains_nul(value)).then_some(text)
}

fn projected_tool_input_from_text(text: &str) -> Option<Value> {
    let input: Value = serde_json::from_str(text).ok()?;
    projected_tool_payload(Some(&input))
}

fn payload_contains_nul(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\0'),
        Value::Array(values) => values.iter().any(payload_contains_nul),
        Value::Object(object) => object
            .iter()
            .any(|(key, value)| key.contains('\0') || payload_contains_nul(value)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn projected_tool_result_output(block: &Value) -> Option<Value> {
    block
        .get("content")
        .or_else(|| block.get("result"))
        .and_then(|value| projected_tool_payload(Some(value)))
}

fn projected_tool_result_summary(block: &Value) -> Option<String> {
    match block.get("content")? {
        Value::String(_) => projected_tool_summary(block.get("content")),
        Value::Array(blocks) => {
            let mut text = String::new();
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                let Some(part) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if !append_projected_text(&mut text, part, MAX_PROJECTED_TOOL_SUMMARY_BYTES) {
                    return None;
                }
            }
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn projected_non_empty_text(value: Option<&Value>, max_bytes: usize) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty() && text.len() <= max_bytes && !text.contains('\0')).then(|| text.to_owned())
}

fn append_projected_text(output: &mut String, text: &str, max_bytes: usize) -> bool {
    if text.contains('\0') || output.len().saturating_add(text.len()) > max_bytes {
        return false;
    }
    output.push_str(text);
    true
}

fn project_approval(
    value: &Value,
    expected_session_id: &SessionId,
    expected_run_id: &RunId,
    expected_worker_id: Option<&WorkerId>,
    requested: bool,
) -> Result<EventActivity, EventRejection> {
    let approval = value
        .get("approval")
        .and_then(Value::as_object)
        .ok_or(EventRejection::Malformed)?;
    let approval_id = approval
        .get("approvalId")
        .and_then(Value::as_str)
        .ok_or(EventRejection::Malformed)
        .and_then(|value| ApprovalId::try_new(value).map_err(|_| EventRejection::Malformed))?;
    if approval
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|session_id| *session_id == expected_session_id.as_str())
        .is_none()
        || approval
            .get("runId")
            .and_then(Value::as_str)
            .filter(|run_id| *run_id == expected_run_id.as_str())
            .is_none()
        || !matches!(
            (expected_worker_id, approval.get("workerId").and_then(Value::as_str)),
            (Some(expected), Some(actual)) if actual == expected.as_str()
        )
    {
        return Err(EventRejection::Malformed);
    }

    let options = project_approval_options(approval)?;
    let phase = if requested {
        if approval
            .get("status")
            .and_then(Value::as_object)
            .and_then(|status| status.get("type"))
            .and_then(Value::as_str)
            != Some("pending")
        {
            return Err(EventRejection::Malformed);
        }
        ApprovalPhase::Requested { options }
    } else {
        ApprovalPhase::Resolved(project_approval_resolution(approval, &options)?)
    };
    Ok(EventActivity::Approval(ProjectedApprovalEvent {
        approval_id,
        phase,
    }))
}

fn project_approval_options(
    approval: &Map<String, Value>,
) -> Result<Vec<ProjectedApprovalOption>, EventRejection> {
    let options = approval
        .get("options")
        .and_then(Value::as_array)
        .ok_or(EventRejection::Malformed)?
        .iter()
        .map(|option| {
            let option = option.as_object().ok_or(EventRejection::Malformed)?;
            let option_id = option
                .get("optionId")
                .and_then(Value::as_str)
                .ok_or(EventRejection::Malformed)
                .and_then(|value| {
                    OptionId::try_new(value).map_err(|_| EventRejection::Malformed)
                })?;
            let action = match option.get("kind").and_then(Value::as_str) {
                Some("allow_once") => ApprovalAction::AllowOnce,
                Some("allow_always") => ApprovalAction::AllowAlways,
                Some("reject_once") => ApprovalAction::RejectOnce,
                Some("reject_always") => ApprovalAction::RejectAlways,
                _ => return Err(EventRejection::Malformed),
            };
            Ok(ProjectedApprovalOption { option_id, action })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if options.iter().enumerate().any(|(index, option)| {
        options[..index]
            .iter()
            .any(|previous| previous.option_id() == option.option_id())
    }) {
        return Err(EventRejection::Malformed);
    }
    Ok(options)
}

fn project_approval_resolution(
    approval: &Map<String, Value>,
    options: &[ProjectedApprovalOption],
) -> Result<ApprovalResolution, EventRejection> {
    let status = approval
        .get("status")
        .and_then(Value::as_object)
        .ok_or(EventRejection::Malformed)?;
    match status.get("type").and_then(Value::as_str) {
        Some("approved") => {
            let option_id = status
                .get("optionId")
                .and_then(Value::as_str)
                .ok_or(EventRejection::Malformed)
                .and_then(|value| {
                    OptionId::try_new(value).map_err(|_| EventRejection::Malformed)
                })?;
            if options
                .iter()
                .filter(|option| option.option_id() == &option_id)
                .any(|option| {
                    matches!(
                        option.action(),
                        ApprovalAction::AllowOnce | ApprovalAction::AllowAlways
                    )
                })
            {
                Ok(ApprovalResolution::Approved { option_id })
            } else {
                Err(EventRejection::Malformed)
            }
        }
        Some("denied") => Ok(ApprovalResolution::Denied),
        Some("cancelled") => match status.get("reason").and_then(Value::as_str) {
            Some("runCancelled") => Ok(ApprovalResolution::Cancelled(
                ApprovalCancellation::RunCancelled,
            )),
            Some("workerExited") => Ok(ApprovalResolution::Cancelled(
                ApprovalCancellation::WorkerExited,
            )),
            _ => Err(EventRejection::Malformed),
        },
        Some("expired") => Ok(ApprovalResolution::Expired),
        _ => Err(EventRejection::Malformed),
    }
}

fn embedded_run_id(event: &Event) -> Result<Option<&str>, ()> {
    let value = event.as_value();
    let candidates = [
        value.get("runId"),
        value.get("run").and_then(|run| run.get("runId")),
        value
            .get("approval")
            .and_then(|approval| approval.get("runId")),
    ];
    let mut run_id = None;
    for candidate in candidates.into_iter().flatten() {
        let candidate = candidate
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or(())?;
        if let Some(previous) = run_id
            && previous != candidate
        {
            return Err(());
        }
        run_id = Some(candidate);
    }
    Ok(run_id)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::session::model::{EventId, WorkerId};

    fn sequence(value: u64) -> Sequence {
        Sequence::try_new(value).unwrap()
    }

    fn projector(after: u64) -> SessionEventProjector {
        SessionEventProjector::resume_after(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
            sequence(after),
        )
    }

    fn envelope(seq: u64, session_id: &str, run_id: Option<&str>, event: Value) -> EventEnvelope {
        EventEnvelope {
            event_id: EventId::try_new(format!("event-{seq}")).unwrap(),
            session_id: SessionId::try_new(session_id).unwrap(),
            seq: sequence(seq),
            run_id: run_id.map(|value| RunId::try_new(value).unwrap()),
            worker_id: None::<WorkerId>,
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            event: Event::try_new(event).unwrap(),
        }
    }

    fn message_event(
        seq: u64,
        session_id: &str,
        run_id: Option<&str>,
        event_type: &str,
        message_id: &str,
        text: Option<&str>,
    ) -> EventEnvelope {
        let mut event = json!({"type":event_type,"messageId":message_id});
        if let Some(text) = text {
            event["delta"] = json!(text);
        }
        envelope(seq, session_id, run_id, event)
    }

    fn delta(seq: u64, session_id: &str, run_id: Option<&str>, message_id: &str) -> EventEnvelope {
        message_event(
            seq,
            session_id,
            run_id,
            "message.delta",
            message_id,
            Some("safe body"),
        )
    }

    fn sdk_message(seq: u64, sdk_message: Value) -> EventEnvelope {
        envelope(
            seq,
            "session-1",
            Some("run-1"),
            json!({
                "type": "sdk.message",
                "sdkMessageVersion": "claude-code-sdk-message-v1",
                "sdkMessage": sdk_message,
            }),
        )
    }

    fn sdk_stream_start(seq: u64, message_id: &str) -> EventEnvelope {
        sdk_message(
            seq,
            json!({
                "uuid": message_id,
                "event": {"type": "message_start", "message": {"id": message_id}}
            }),
        )
    }

    fn sdk_stream_delta(seq: u64, text: &str) -> EventEnvelope {
        sdk_message(
            seq,
            json!({
                "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}
            }),
        )
    }

    fn sdk_stream_stop(seq: u64) -> EventEnvelope {
        sdk_message(seq, json!({"event": {"type": "message_stop"}}))
    }

    fn sdk_assistant_text(seq: u64, message_id: &str, text: &str) -> EventEnvelope {
        sdk_message(
            seq,
            json!({
                "type": "assistant",
                "uuid": message_id,
                "message": {"content": [{"type": "text", "text": text}]}
            }),
        )
    }

    fn sdk_result_text(seq: u64, message_id: &str, text: &str) -> EventEnvelope {
        sdk_message(
            seq,
            json!({
                "type": "result",
                "uuid": message_id,
                "result": text
            }),
        )
    }

    fn approval_requested(seq: u64) -> EventEnvelope {
        approval_requested_with(seq, "session-1", "worker-1", Some("worker-1"))
    }

    fn approval_requested_with(
        seq: u64,
        approval_session_id: &str,
        approval_worker_id: &str,
        envelope_worker_id: Option<&str>,
    ) -> EventEnvelope {
        let mut envelope = envelope(
            seq,
            "session-1",
            Some("run-1"),
            json!({
                "type": "approval.requested",
                "approval": {
                    "approvalId": "approval-1",
                    "sessionId": approval_session_id,
                    "runId": "run-1",
                    "workerId": approval_worker_id,
                    "toolCallId": "tool-call-secret",
                    "toolName": "tool-secret",
                    "prompt": "approval prompt secret",
                    "options": [
                        {"optionId": "allow-once", "label": "Allow secret", "kind": "allow_once"},
                        {"optionId": "reject-always", "label": "Reject secret", "kind": "reject_always"}
                    ],
                    "status": {"type": "pending", "requestedAt": "when-secret"},
                    "input": {"token": "token-secret", "path": "/private/path"}
                }
            }),
        );
        envelope.worker_id = envelope_worker_id.map(|value| WorkerId::try_new(value).unwrap());
        envelope
    }

    #[test]
    fn accumulates_bounded_message_text_while_preserving_each_delta() {
        let mut projector = projector(0);
        let started = projector.project(message_event(
            1,
            "session-1",
            Some("run-1"),
            "message.started",
            "message-1",
            None,
        ));
        let first = projector.project(message_event(
            2,
            "session-1",
            Some("run-1"),
            "message.delta",
            "message-1",
            Some("hello "),
        ));
        let second = projector.project(message_event(
            3,
            "session-1",
            Some("run-1"),
            "message.delta",
            "message-1",
            Some("world"),
        ));
        let completed = projector.project(message_event(
            4,
            "session-1",
            Some("run-1"),
            "message.completed",
            "message-1",
            None,
        ));

        assert!(matches!(
            started,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.message_text() == Some(""))
        ));
        assert!(matches!(
            first,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.text_delta() == Some("hello ")
                        && message.message_text() == Some("hello "))
        ));
        assert!(matches!(
            second,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.text_delta() == Some("world")
                        && message.message_text() == Some("hello world"))
        ));
        assert!(matches!(
            completed,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.text_delta().is_none()
                        && message.message_text() == Some("hello world"))
        ));
    }

    #[test]
    fn sdk_stream_completion_suppresses_later_result_summary() {
        let mut projector = projector(0);
        assert!(matches!(
            projector.project(sdk_stream_start(1, "assistant-message-1")),
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.lifecycle() == MessageLifecycle::Started
                        && message.message_id().as_str() == "assistant-message-1"
                        && message.message_text() == Some(""))
        ));
        assert!(matches!(
            projector.project(sdk_stream_delta(2, "hello")),
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.lifecycle() == MessageLifecycle::Delta
                        && message.message_id().as_str() == "assistant-message-1"
                        && message.text_delta() == Some("hello")
                        && message.message_text() == Some("hello"))
        ));
        assert!(matches!(
            projector.project(sdk_stream_stop(3)),
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.lifecycle() == MessageLifecycle::Completed
                        && message.message_id().as_str() == "assistant-message-1"
                        && message.message_text() == Some("hello"))
        ));
        assert!(matches!(
            projector.project(sdk_result_text(4, "result-message-1", "hello")),
            EventProjectionResult::Projected(ref event)
                if event.sequence() == sequence(4)
                    && matches!(event.activity(), EventActivity::Ignored)
        ));
    }

    #[test]
    fn sdk_stream_completion_suppresses_later_full_assistant_text() {
        let mut projector = projector(0);
        assert!(matches!(
            projector.project(sdk_stream_start(1, "assistant-message-1")),
            EventProjectionResult::Projected(_)
        ));
        assert!(matches!(
            projector.project(sdk_stream_delta(2, "hello")),
            EventProjectionResult::Projected(_)
        ));
        assert!(matches!(
            projector.project(sdk_stream_stop(3)),
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.lifecycle() == MessageLifecycle::Completed
                        && message.message_text() == Some("hello"))
        ));
        assert!(matches!(
            projector.project(sdk_assistant_text(4, "assistant-message-2", "hello")),
            EventProjectionResult::Projected(ref event)
                if event.sequence() == sequence(4)
                    && matches!(event.activity(), EventActivity::Ignored)
        ));
    }

    #[test]
    fn sdk_empty_stream_keeps_result_fallback_available() {
        let mut projector = projector(0);
        assert!(matches!(
            projector.project(sdk_stream_start(1, "assistant-message-1")),
            EventProjectionResult::Projected(_)
        ));
        assert!(matches!(
            projector.project(sdk_stream_stop(2)),
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.lifecycle() == MessageLifecycle::Completed
                        && message.message_text() == Some(""))
        ));
        assert!(matches!(
            projector.project(sdk_result_text(3, "result-message-1", "fallback result")),
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.lifecycle() == MessageLifecycle::Completed
                        && message.message_id().as_str() == "result-message-1"
                        && message.message_text() == Some("fallback result"))
        ));
    }

    #[test]
    fn sdk_result_summary_is_hidden_after_visible_assistant_text() {
        let mut projector = projector(0);
        let assistant = projector.project(sdk_message(
            1,
            json!({
                "type": "assistant",
                "uuid": "assistant-message-1",
                "message": {"content": [{"type": "text", "text": "assistant text"}]}
            }),
        ));
        let result = projector.project(sdk_message(
            2,
            json!({
                "type": "result",
                "uuid": "result-message-1",
                "result": "different terminal summary"
            }),
        ));

        assert!(matches!(
            assistant,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.lifecycle() == MessageLifecycle::Completed
                        && message.message_id().as_str() == "assistant-message-1"
                        && message.message_text() == Some("assistant text"))
        ));
        assert!(matches!(
            result,
            EventProjectionResult::Projected(ref event)
                if event.sequence() == sequence(2)
                    && matches!(event.activity(), EventActivity::Ignored)
        ));
    }

    #[test]
    fn sdk_result_projects_as_visible_fallback_without_assistant_text() {
        let mut projector = projector(0);
        let result = projector.project(sdk_message(
            1,
            json!({
                "type": "result",
                "uuid": "result-message-1",
                "result": "fallback result"
            }),
        ));

        assert!(matches!(
            result,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.lifecycle() == MessageLifecycle::Completed
                        && message.message_id().as_str() == "result-message-1"
                        && message.text_delta().is_none()
                        && message.message_text() == Some("fallback result"))
        ));
    }

    #[test]
    fn empty_sdk_result_without_assistant_text_is_ignored() {
        let mut projector = projector(0);
        let result = projector.project(sdk_message(
            1,
            json!({
                "type": "result",
                "uuid": "result-message-1",
                "result": ""
            }),
        ));

        assert!(matches!(
            result,
            EventProjectionResult::Projected(ref event)
                if event.sequence() == sequence(1)
                    && matches!(event.activity(), EventActivity::Ignored)
        ));
    }

    #[test]
    fn sdk_stream_projects_thinking_delta_as_bounded_message_activity() {
        let mut projector = projector(0);
        assert!(matches!(
            projector.project(sdk_stream_start(1, "assistant-message-1")),
            EventProjectionResult::Projected(_)
        ));

        let delta = projector.project(sdk_message(
            2,
            json!({
                "event": {
                    "type": "content_block_delta",
                    "delta": {
                        "type": "thinking_delta",
                        "thinking": "safe thinking",
                        "signature": "private-signature"
                    }
                }
            }),
        ));

        assert!(matches!(
            delta,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Message(message)
                    if message.lifecycle() == MessageLifecycle::Delta
                        && message.text_delta().is_none()
                        && message.thinking_delta() == Some("safe thinking")
                        && message.message_text() == Some("")
                        && message.thinking_text() == Some("safe thinking"))
        ));
        assert!(!format!("{delta:?}").contains("private-signature"));
    }

    #[test]
    fn sdk_stream_tool_input_delta_projects_visible_tool_payload() {
        let mut projector = projector(0);
        let started = projector.project(sdk_message(
            1,
            json!({
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {
                        "type": "tool_use",
                        "id": "tool-call-1",
                        "name": "Read",
                        "input": {"file_path":"private-path"}
                    }
                }
            }),
        ));
        let input_delta = projector.project(sdk_message(
            2,
            json!({
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": "{\"secret\":true}"
                    }
                }
            }),
        ));

        assert!(matches!(
            started,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Tool(tool)
                    if tool.tool_call_id().as_str() == "tool-call-1"
                        && tool.name() == Some("Read")
                        && tool.phase() == ToolActivityPhase::Started
                        && tool.input() == Some(&json!({"file_path":"private-path"}))
                        && tool.input_text() == Some("{\n  \"file_path\": \"private-path\"\n}")
                        && tool.summary().is_none())
        ));
        assert!(matches!(
            input_delta,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Tool(tool)
                    if tool.tool_call_id().as_str() == "tool-call-1"
                        && tool.name() == Some("Read")
                        && tool.phase() == ToolActivityPhase::Updated
                        && tool.input() == Some(&json!({"secret":true}))
                        && tool.input_text() == Some("{\"secret\":true}")
                        && tool.summary().is_none())
        ));
        let debug = format!("{started:?} {input_delta:?}");
        assert!(!debug.contains("private-path"));
        assert!(!debug.contains("secret"));
    }

    #[test]
    fn sdk_user_tool_result_projects_visible_summary_and_output() {
        let mut projector = projector(0);
        assert!(matches!(
            projector.project(sdk_message(
                1,
                json!({
                    "event": {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {
                            "type": "tool_use",
                            "id": "tool-call-1",
                            "name": "Read"
                        }
                    }
                }),
            )),
            EventProjectionResult::Projected(_)
        ));

        let result = projector.project(sdk_message(
            2,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "tool-call-1",
                        "content": [
                            {"type":"text", "text":"done"},
                            {"type":"json", "value":{"secret":"raw-result"}}
                        ],
                        "is_error": false
                    }]
                }
            }),
        ));

        assert!(matches!(
            result,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Tool(tool)
                    if tool.tool_call_id().as_str() == "tool-call-1"
                        && tool.name() == Some("Read")
                        && tool.phase() == ToolActivityPhase::Completed
                        && tool.summary() == Some("done")
                        && tool.output() == Some(&json!([
                            {"type":"text", "text":"done"},
                            {"type":"json", "value":{"secret":"raw-result"}}
                        ]))
                        && tool.is_error() == Some(false))
        ));
        let debug = format!("{result:?}");
        assert!(!debug.contains("raw-result"));
        assert!(!debug.contains("done"));
    }

    #[test]
    fn sdk_private_stream_deltas_stay_ignored() {
        let mut projector = projector(0);
        assert!(matches!(
            projector.project(sdk_stream_start(1, "assistant-message-1")),
            EventProjectionResult::Projected(_)
        ));

        let signature = projector.project(sdk_message(
            2,
            json!({
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "signature_delta", "signature":"private-signature"}
                }
            }),
        ));
        let message_delta = projector.project(sdk_message(
            3,
            json!({
                "event": {
                    "type": "message_delta",
                    "delta": {"stop_reason":"end_turn"},
                    "usage": {"private":"usage"}
                }
            }),
        ));

        assert!(matches!(
            signature,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Ignored)
        ));
        assert!(matches!(
            message_delta,
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Ignored)
        ));
        let debug = format!("{signature:?} {message_delta:?}");
        assert!(!debug.contains("private-signature"));
        assert!(!debug.contains("usage"));
    }

    #[test]
    fn rejects_message_text_overflow_without_emitting_partial_canonical_text() {
        let mut projector = projector(0);
        assert!(matches!(
            projector.project(message_event(
                1,
                "session-1",
                Some("run-1"),
                "message.started",
                "message-1",
                None,
            )),
            EventProjectionResult::Projected(_)
        ));
        let overflow = "x".repeat(MAX_PROJECTED_MESSAGE_TEXT_BYTES + 1);
        assert_eq!(
            projector.project(message_event(
                2,
                "session-1",
                Some("run-1"),
                "message.delta",
                "message-1",
                Some(overflow.as_str()),
            )),
            EventProjectionResult::Rejected {
                sequence: sequence(2),
                reason: EventRejection::Malformed,
            }
        );
    }

    #[test]
    fn projects_native_message_activity_without_retaining_payload() {
        let mut projector = projector(0);
        let projected = projector.project(delta(1, "session-1", Some("run-1"), "message-1"));

        let EventProjectionResult::Projected(projected) = projected else {
            panic!("expected projected event");
        };
        assert_eq!(projected.sequence(), sequence(1));
        assert_eq!(projected.turn().run_id().as_str(), "run-1");
        assert_eq!(projected.message_id().unwrap().as_str(), "message-1");
        assert!(matches!(
            projected.activity(),
            EventActivity::Message(message) if message.lifecycle() == MessageLifecycle::Delta
        ));
        let debug = format!("{projected:?}");
        for secret in ["secret body", "session-1", "run-1", "message-1"] {
            assert!(!debug.contains(secret));
        }
    }

    #[test]
    fn projects_approval_options_without_prompt_tool_or_worker_data() {
        let mut projector = projector(0);
        let projected = projector.project(approval_requested(1));

        let EventProjectionResult::Projected(projected) = projected else {
            panic!("expected projected approval");
        };
        let EventActivity::Approval(approval) = projected.activity() else {
            panic!("expected approval activity");
        };
        assert_eq!(approval.approval_id().as_str(), "approval-1");
        let ApprovalPhase::Requested { options } = approval.phase() else {
            panic!("expected requested approval");
        };
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].option_id().as_str(), "allow-once");
        assert_eq!(options[0].action(), ApprovalAction::AllowOnce);
        assert_eq!(options[1].action(), ApprovalAction::RejectAlways);

        let debug = format!("{projected:?}");
        for secret in [
            "approval-1",
            "allow-once",
            "worker-1",
            "tool-call-secret",
            "tool-secret",
            "approval prompt secret",
            "Allow secret",
            "token-secret",
            "/private/path",
            "when-secret",
        ] {
            assert!(!debug.contains(secret));
        }
    }

    #[test]
    fn projects_durable_approval_wait_as_run_lifecycle() {
        let mut projector = projector(0);
        let waiting = envelope(
            1,
            "session-1",
            Some("run-1"),
            json!({"type":"run.waitingForApproval","runId":"run-1","approvalIds":["approval-1"]}),
        );

        assert!(matches!(
            projector.project(waiting),
            EventProjectionResult::Projected(projected)
                if matches!(projected.activity(), EventActivity::Run(RunLifecycle::WaitingForApproval))
        ));
    }

    #[test]
    fn projects_native_run_order_and_terminal_lifecycle() {
        let mut projector = projector(0);
        let queued = projector.project(envelope(
            1,
            "session-1",
            Some("run-1"),
            json!({
                "type":"run.queued",
                "run":{"sessionId":"session-1","runId":"run-1"}
            }),
        ));
        let mut started = envelope(
            2,
            "session-1",
            Some("run-1"),
            json!({"type":"run.started","runId":"run-1","workerId":"worker-1"}),
        );
        started.worker_id = Some(WorkerId::try_new("worker-1").unwrap());
        let started = projector.project(started);
        let completed = projector.project(envelope(
            3,
            "session-1",
            Some("run-1"),
            json!({"type":"run.completed","runId":"run-1","usage":{"totalTokens":1}}),
        ));

        assert!(matches!(
            queued,
            EventProjectionResult::Projected(ref event)
                if event.sequence() == sequence(1)
                    && matches!(event.activity(), EventActivity::Run(RunLifecycle::Queued))
        ));
        assert!(matches!(
            started,
            EventProjectionResult::Projected(ref event)
                if event.sequence() == sequence(2)
                    && matches!(event.activity(), EventActivity::Run(RunLifecycle::Started))
        ));
        assert!(matches!(
            completed,
            EventProjectionResult::Projected(ref event)
                if event.sequence() == sequence(3)
                    && matches!(event.activity(), EventActivity::Run(RunLifecycle::Completed))
        ));
    }

    #[test]
    fn projects_approved_approval_from_matching_allow_option() {
        let mut projector = projector(0);
        let mut resolved = envelope(
            1,
            "session-1",
            Some("run-1"),
            json!({
                "type":"approval.resolved",
                "approval":{
                    "approvalId":"approval-1",
                    "sessionId":"session-1",
                    "runId":"run-1",
                    "workerId":"worker-1",
                    "options":[{"optionId":"allow-once","kind":"allow_once"}],
                    "status":{"type":"approved","optionId":"allow-once"}
                }
            }),
        );
        resolved.worker_id = Some(WorkerId::try_new("worker-1").unwrap());
        let EventProjectionResult::Projected(projected) = projector.project(resolved) else {
            panic!("expected approved approval");
        };
        assert!(matches!(
            projected.activity(),
            EventActivity::Approval(approval)
                if matches!(
                    approval.phase(),
                    ApprovalPhase::Resolved(ApprovalResolution::Approved { option_id })
                        if option_id.as_str() == "allow-once"
                )
        ));
    }

    #[test]
    fn rejects_queued_run_or_started_worker_identity_mismatches() {
        let mut projector = projector(0);
        let wrong_session = projector.project(envelope(
            1,
            "session-1",
            Some("run-1"),
            json!({
                "type":"run.queued",
                "run":{"sessionId":"session-2","runId":"run-1"}
            }),
        ));
        assert_eq!(
            wrong_session,
            EventProjectionResult::Rejected {
                sequence: sequence(1),
                reason: EventRejection::Malformed,
            }
        );

        let mut wrong_worker = envelope(
            2,
            "session-1",
            Some("run-1"),
            json!({"type":"run.started","runId":"run-1","workerId":"worker-2"}),
        );
        wrong_worker.worker_id = Some(WorkerId::try_new("worker-1").unwrap());
        assert_eq!(
            projector.project(wrong_worker),
            EventProjectionResult::Rejected {
                sequence: sequence(2),
                reason: EventRejection::Malformed,
            }
        );
        assert_eq!(projector.cursor(), sequence(2));
    }

    #[test]
    fn rejects_approved_approval_without_a_matching_allow_option() {
        let mut projector = projector(0);
        for (sequence_value, option, status_option) in [
            (
                1,
                json!({"optionId":"allow-once","kind":"allow_once"}),
                "allow-always",
            ),
            (
                2,
                json!({"optionId":"reject-once","kind":"reject_once"}),
                "reject-once",
            ),
            (
                3,
                json!({"optionId":"allow-once","kind":"allow_once"}),
                "allow-once",
            ),
        ] {
            let options = if sequence_value == 3 {
                json!([option.clone(), option])
            } else {
                json!([option])
            };
            let mut resolved = envelope(
                sequence_value,
                "session-1",
                Some("run-1"),
                json!({
                    "type":"approval.resolved",
                    "approval":{
                        "approvalId":"approval-1",
                        "sessionId":"session-1",
                        "runId":"run-1",
                        "workerId":"worker-1",
                        "options":options,
                        "status":{"type":"approved","optionId":status_option}
                    }
                }),
            );
            resolved.worker_id = Some(WorkerId::try_new("worker-1").unwrap());
            assert_eq!(
                projector.project(resolved),
                EventProjectionResult::Rejected {
                    sequence: sequence(sequence_value),
                    reason: EventRejection::Malformed,
                }
            );
        }
    }

    #[test]
    fn projects_run_and_approval_cancellation_as_native_lifecycle() {
        let mut projector = projector(0);
        let requested = projector.project(envelope(
            1,
            "session-1",
            Some("run-1"),
            json!({"type":"run.cancelRequested","runId":"run-1","reason":"private reason"}),
        ));
        let mut resolved = envelope(
            2,
            "session-1",
            Some("run-1"),
            json!({
                "type": "approval.resolved",
                "approval": {
                    "approvalId": "approval-1",
                    "sessionId": "session-1",
                    "runId": "run-1",
                    "workerId": "worker-1",
                    "prompt": "private prompt",
                    "options": [],
                    "status": {"type":"cancelled","resolvedAt":"private time","reason":"runCancelled"}
                }
            }),
        );
        resolved.worker_id = Some(WorkerId::try_new("worker-1").unwrap());
        let resolved = projector.project(resolved);

        let EventProjectionResult::Projected(requested) = requested else {
            panic!("expected cancellation request");
        };
        assert!(matches!(
            requested.activity(),
            EventActivity::Run(RunLifecycle::CancellationRequested)
        ));
        let EventProjectionResult::Projected(resolved) = resolved else {
            panic!("expected cancelled approval");
        };
        let EventActivity::Approval(approval) = resolved.activity() else {
            panic!("expected approval activity");
        };
        assert!(matches!(
            approval.phase(),
            ApprovalPhase::Resolved(ApprovalResolution::Cancelled(
                ApprovalCancellation::RunCancelled
            ))
        ));
        let debug = format!("{resolved:?}");
        for secret in ["approval-1", "private prompt", "private time", "run-1"] {
            assert!(!debug.contains(secret));
        }
    }

    #[test]
    fn rejects_approval_with_missing_or_conflicting_envelope_identities() {
        let mut projector = projector(0);

        assert_eq!(
            projector.project(approval_requested_with(
                1,
                "session-2",
                "worker-1",
                Some("worker-1")
            )),
            EventProjectionResult::Rejected {
                sequence: sequence(1),
                reason: EventRejection::Malformed,
            }
        );
        assert_eq!(
            projector.project(approval_requested_with(
                2,
                "session-1",
                "worker-2",
                Some("worker-1")
            )),
            EventProjectionResult::Rejected {
                sequence: sequence(2),
                reason: EventRejection::Malformed,
            }
        );
        assert_eq!(
            projector.project(approval_requested_with(3, "session-1", "worker-1", None)),
            EventProjectionResult::Rejected {
                sequence: sequence(3),
                reason: EventRejection::Malformed,
            }
        );
        assert_eq!(projector.cursor(), sequence(3));
    }

    #[test]
    fn unsafe_or_malformed_events_are_rejected_after_advancing_the_replay_cursor() {
        let mut projector = projector(0);
        let unsupported = projector.project(envelope(
            1,
            "session-1",
            Some("run-1"),
            json!({"type":"run.trace","runId":"run-1","details":{"token":"secret"}}),
        ));
        assert!(matches!(
            unsupported,
            EventProjectionResult::Projected(ref event)
                if event.sequence() == sequence(1)
                    && matches!(event.activity(), EventActivity::Ignored)
        ));

        let native_worker_crash = projector.project(envelope(
            2,
            "session-1",
            Some("run-1"),
            json!({"type":"worker.crashed","workerId":"worker-1","exitCode":1}),
        ));
        assert_eq!(
            native_worker_crash,
            EventProjectionResult::Rejected {
                sequence: sequence(2),
                reason: EventRejection::Unsupported,
            }
        );

        let malformed = projector.project(envelope(
            3,
            "session-1",
            Some("run-1"),
            json!({
                "type": "approval.requested",
                "approval": {
                    "approvalId": "approval-1",
                    "runId": "run-1",
                    "options": [{"optionId":"option-1","kind":"unknown"}],
                    "status": {"type":"pending"}
                }
            }),
        ));
        assert_eq!(
            malformed,
            EventProjectionResult::Rejected {
                sequence: sequence(3),
                reason: EventRejection::Malformed,
            }
        );
        assert_eq!(projector.cursor(), sequence(3));
        assert!(matches!(
            projector.project(delta(4, "session-1", Some("run-1"), "message-1")),
            EventProjectionResult::Projected(_)
        ));
    }

    #[test]
    fn duplicate_stale_and_gap_do_not_advance_the_cursor() {
        let mut projector = projector(4);

        assert_eq!(
            projector.project(delta(4, "session-1", Some("run-1"), "duplicate")),
            EventProjectionResult::Duplicate {
                sequence: sequence(4)
            }
        );
        assert_eq!(
            projector.project(delta(3, "session-1", Some("run-1"), "stale")),
            EventProjectionResult::Stale {
                cursor: sequence(4),
                received: sequence(3)
            }
        );
        assert_eq!(
            projector.project(delta(6, "session-1", Some("run-1"), "gap")),
            EventProjectionResult::Gap {
                expected: sequence(5),
                received: sequence(6)
            }
        );
        assert_eq!(projector.cursor(), sequence(4));
        assert!(matches!(
            projector.project(delta(5, "session-1", Some("run-1"), "next")),
            EventProjectionResult::Projected(_)
        ));
    }

    #[test]
    fn terminal_event_fences_late_events_without_reopening_projection() {
        let mut projector = projector(0);
        assert!(matches!(
            projector.project(envelope(
                1,
                "session-1",
                Some("run-1"),
                json!({"type":"run.completed","runId":"run-1"}),
            )),
            EventProjectionResult::Projected(ref event)
                if matches!(event.activity(), EventActivity::Run(RunLifecycle::Completed))
        ));
        assert!(projector.is_terminal());

        assert_eq!(
            projector.project(delta(2, "session-1", Some("run-1"), "late-active")),
            EventProjectionResult::Stale {
                cursor: sequence(1),
                received: sequence(2)
            }
        );
        assert_eq!(projector.cursor(), sequence(1));
        assert!(projector.is_terminal());
    }

    #[test]
    fn out_of_run_event_advances_the_session_replay_cursor() {
        let mut projector = projector(0);

        assert_eq!(
            projector.project(delta(1, "session-1", Some("run-2"), "foreign")),
            EventProjectionResult::OutOfRun {
                sequence: sequence(1)
            }
        );
        assert_eq!(projector.cursor(), sequence(1));
        assert!(matches!(
            projector.project(delta(2, "session-1", Some("run-1"), "owned")),
            EventProjectionResult::Projected(_)
        ));
    }

    #[test]
    fn missing_or_conflicting_run_ownership_is_out_of_run() {
        let mut projector = projector(0);

        assert!(matches!(
            projector.project(delta(1, "session-1", None, "unowned")),
            EventProjectionResult::OutOfRun { .. }
        ));
        let conflict = envelope(
            2,
            "session-1",
            Some("run-1"),
            json!({
                "type":"approval.resolved",
                "runId":"run-1",
                "approval":{"approvalId":"approval-1","runId":"run-2","status":{"type":"expired"}}
            }),
        );
        assert!(matches!(
            projector.project(conflict),
            EventProjectionResult::OutOfRun { .. }
        ));
        assert_eq!(projector.cursor(), sequence(2));
    }

    #[test]
    fn out_of_session_event_never_mutates_the_cursor() {
        let mut projector = projector(7);
        assert_eq!(
            projector.project(delta(8, "session-2", Some("run-1"), "foreign")),
            EventProjectionResult::OutOfSession {
                sequence: sequence(8)
            }
        );
        assert_eq!(projector.cursor(), sequence(7));
    }

    #[test]
    fn session_cursor_observes_replay_and_live_duplicates_without_event_id_semantics() {
        let mut cursor =
            SessionEventCursor::resume_after(SessionId::try_new("session-1").unwrap(), sequence(4));
        let replay = delta(5, "session-1", Some("run-1"), "replay-message");
        assert_eq!(
            cursor.observe(&replay),
            SessionEventObservation::Accepted {
                sequence: sequence(5)
            }
        );

        let mut live_duplicate = delta(5, "session-1", Some("run-1"), "live-message");
        live_duplicate.event_id = EventId::try_new("different-event-id").unwrap();
        assert_eq!(
            cursor.observe(&live_duplicate),
            SessionEventObservation::Duplicate {
                sequence: sequence(5)
            }
        );
        assert_eq!(cursor.sequence(), sequence(5));
    }

    #[test]
    fn session_cursor_rejects_gaps_and_wrong_sessions_without_advancing() {
        let mut cursor = SessionEventCursor::new(SessionId::try_new("session-1").unwrap());
        assert_eq!(cursor.sequence(), sequence(0));
        assert_eq!(
            cursor.observe(&delta(2, "session-1", Some("run-1"), "gap")),
            SessionEventObservation::Gap {
                expected: sequence(1),
                received: sequence(2)
            }
        );
        assert_eq!(
            cursor.observe(&delta(1, "session-2", Some("run-1"), "foreign")),
            SessionEventObservation::OutOfSession {
                sequence: sequence(1)
            }
        );
        assert_eq!(cursor.sequence(), sequence(0));
        assert_eq!(
            cursor.observe(&delta(1, "session-1", Some("run-1"), "first")),
            SessionEventObservation::Accepted {
                sequence: sequence(1)
            }
        );
    }

    #[test]
    fn session_cursor_distinguishes_stale_from_duplicate() {
        let mut cursor =
            SessionEventCursor::resume_after(SessionId::try_new("session-1").unwrap(), sequence(3));
        assert_eq!(
            cursor.observe(&delta(2, "session-1", Some("run-1"), "stale")),
            SessionEventObservation::Stale {
                cursor: sequence(3),
                received: sequence(2)
            }
        );
        assert_eq!(
            cursor.observe(&delta(3, "session-1", Some("run-1"), "duplicate")),
            SessionEventObservation::Duplicate {
                sequence: sequence(3)
            }
        );
        assert_eq!(cursor.sequence(), sequence(3));
    }

    #[test]
    fn result_debug_output_never_contains_payload_or_identities() {
        let secret = "secret body";
        let mut projector = projector(0);
        let projected = projector.project(delta(1, "session-1", Some("run-1"), "message-secret"));
        let projected_debug = format!("{projected:?}");
        let projector_debug = format!("{projector:?}");

        for output in [projected_debug, projector_debug] {
            assert!(!output.contains(secret));
            assert!(!output.contains("session-1"));
            assert!(!output.contains("run-1"));
            assert!(!output.contains("message-secret"));
        }
    }
}
