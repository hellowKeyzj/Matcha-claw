use serde_json::Value;
use std::fmt;

use super::{
    events::{SessionEventProvenance, TerminalOutcome},
    facts::{
        BoundedHistoryFacts, LiveSessionFacts, NativeCursor, NativeFactGap, NativeFactRead,
        SessionIdentityFacts, SessionRuntimeFacts,
    },
    protocol::{
        ApprovalId, ApprovalOptionId, ChatState, ChatStatusPhase, MessageActivityLifecycle,
        MessageId, RunId, RuntimeActivityPhase, RuntimeFallbackDetail, RuntimeGuardianNotice,
        SessionActivityKind, SessionErrorKind, SessionEventEnvelope, SessionEventKind, SessionKey,
        SessionSummary, ToolActivityPhase, ToolId,
    },
};
use crate::session::window::Message;

#[derive(Clone, Eq, PartialEq)]
pub enum CanonicalIngressResult {
    Produced(CanonicalSessionDelta),
    Unknown { provenance: SessionEventProvenance },
}

impl fmt::Debug for CanonicalIngressResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Produced(delta) => formatter.debug_tuple("Produced").field(delta).finish(),
            Self::Unknown { provenance } => formatter
                .debug_struct("Unknown")
                .field("provenance", provenance)
                .finish(),
        }
    }
}

impl CanonicalIngressResult {
    pub(crate) fn from_transcript_message(
        session_key: SessionKey,
        source_epoch: Option<u64>,
        route_key: Option<String>,
        message: Message,
    ) -> Option<Self> {
        let run_id = message
            .run_id()
            .and_then(|run_id| RunId::try_new(run_id.to_owned()).ok());
        let message_id = message
            .message_id()
            .and_then(|message_id| MessageId::try_new(message_id.to_owned()).ok());
        let source_cursor = message.sequence();
        let provenance = SessionEventProvenance::from_replay_source(
            session_key.clone(),
            run_id.clone(),
            source_epoch,
            source_cursor,
            route_key.clone(),
            message_id,
        );
        Some(Self::Produced(CanonicalSessionDelta {
            session_key,
            route_key,
            source_epoch: provenance.source_epoch(),
            source_cursor: provenance.source_cursor(),
            run_id,
            provenance,
            changes: vec![CanonicalSessionChange::TranscriptMessage { message }],
        }))
    }

    pub(crate) fn from_replay_recovery(
        session_key: SessionKey,
        source_epoch: Option<u64>,
        source_cursor: u64,
        route_key: Option<String>,
    ) -> Self {
        let provenance = SessionEventProvenance::from_replay_source(
            session_key.clone(),
            None,
            source_epoch,
            Some(source_cursor),
            route_key.clone(),
            None,
        );
        Self::Produced(CanonicalSessionDelta {
            session_key,
            route_key,
            source_epoch: provenance.source_epoch(),
            source_cursor: provenance.source_cursor(),
            run_id: None,
            provenance,
            changes: vec![CanonicalSessionChange::RecoveryRequired {
                reason: CanonicalRecoveryReason::NativeUnknown,
            }],
        })
    }
}

/// A source-backed live delta draft. It is not the Host `SessionDelta` DTO:
/// source epoch/cursor stay optional and no Host sequence is synthesized.
#[derive(Clone, Eq, PartialEq)]
pub struct CanonicalSessionDelta {
    session_key: SessionKey,
    route_key: Option<String>,
    source_epoch: Option<u64>,
    source_cursor: Option<u64>,
    run_id: Option<RunId>,
    provenance: SessionEventProvenance,
    changes: Vec<CanonicalSessionChange>,
}

impl CanonicalSessionDelta {
    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn route_key(&self) -> Option<&str> {
        self.route_key.as_deref()
    }

    pub const fn source_epoch(&self) -> Option<u64> {
        self.source_epoch
    }

    pub const fn source_cursor(&self) -> Option<u64> {
        self.source_cursor
    }

    pub fn run_id(&self) -> Option<&RunId> {
        self.run_id.as_ref()
    }

    pub fn provenance(&self) -> &SessionEventProvenance {
        &self.provenance
    }

    pub fn changes(&self) -> &[CanonicalSessionChange] {
        &self.changes
    }
}

impl fmt::Debug for CanonicalSessionDelta {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalSessionDelta")
            .field("source_epoch", &self.source_epoch)
            .field("source_cursor", &self.source_cursor)
            .field("has_run_id", &self.run_id.is_some())
            .field("change_count", &self.changes.len())
            .field("provenance", &self.provenance)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssistantTurnStatus {
    Streaming,
    WaitingForTool,
    Final,
    Aborted,
    Error,
}

impl AssistantTurnStatus {
    pub const fn from_terminal_outcome(outcome: TerminalOutcome) -> Self {
        match outcome {
            TerminalOutcome::Completed => Self::Final,
            TerminalOutcome::Aborted => Self::Aborted,
            TerminalOutcome::Error => Self::Error,
        }
    }

    pub const fn from_message_lifecycle(lifecycle: MessageActivityLifecycle) -> Self {
        match lifecycle {
            MessageActivityLifecycle::Started | MessageActivityLifecycle::Delta => Self::Streaming,
            MessageActivityLifecycle::Completed => Self::Final,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssistantTurnChunkKind {
    Text,
    Thinking,
}

#[derive(Clone, Eq, PartialEq)]
pub enum AssistantTurnSegment {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolUse {
        tool_id: ToolId,
        tool_name: Option<String>,
    },
    ToolResult {
        tool_id: ToolId,
        summary: Option<String>,
        is_error: bool,
    },
}

impl fmt::Debug for AssistantTurnSegment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text { text } => formatter
                .debug_struct("Text")
                .field("text_bytes", &text.len())
                .finish(),
            Self::Thinking { text } => formatter
                .debug_struct("Thinking")
                .field("text_bytes", &text.len())
                .finish(),
            Self::ToolUse { tool_name, .. } => formatter
                .debug_struct("ToolUse")
                .field("has_tool_name", &tool_name.is_some())
                .finish(),
            Self::ToolResult {
                summary, is_error, ..
            } => formatter
                .debug_struct("ToolResult")
                .field("has_summary", &summary.is_some())
                .field("summary_bytes", &summary.as_ref().map_or(0, String::len))
                .field("is_error", is_error)
                .finish(),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct AssistantTurnSnapshot {
    pub run_id: RunId,
    pub message_id: Option<MessageId>,
    pub segments: Vec<AssistantTurnSegment>,
    pub text: String,
    pub thinking: Option<String>,
    pub status: AssistantTurnStatus,
}

impl AssistantTurnSnapshot {
    pub fn new(
        run_id: RunId,
        message_id: Option<MessageId>,
        segments: Vec<AssistantTurnSegment>,
        text: impl Into<String>,
        thinking: Option<String>,
        status: AssistantTurnStatus,
    ) -> Self {
        Self {
            run_id,
            message_id,
            segments,
            text: text.into(),
            thinking,
            status,
        }
    }

    pub fn from_text_parts(
        run_id: RunId,
        message_id: Option<MessageId>,
        text: impl Into<String>,
        thinking: Option<String>,
        status: AssistantTurnStatus,
    ) -> Self {
        let text = text.into();
        let thinking = thinking.filter(|thinking| !thinking.is_empty());
        let mut segments =
            Vec::with_capacity(usize::from(thinking.is_some()) + usize::from(!text.is_empty()));
        if let Some(thinking) = &thinking {
            segments.push(AssistantTurnSegment::Thinking {
                text: thinking.clone(),
            });
        }
        if !text.is_empty() {
            segments.push(AssistantTurnSegment::Text { text: text.clone() });
        }
        Self::new(run_id, message_id, segments, text, thinking, status)
    }

    pub fn final_text_for_run<'snapshot>(
        snapshots: impl IntoIterator<Item = &'snapshot Self>,
        run_id: &RunId,
    ) -> Option<&'snapshot str> {
        let mut final_text = None;
        for snapshot in snapshots {
            if snapshot.run_id == *run_id
                && snapshot.status == AssistantTurnStatus::Final
                && !snapshot.text.is_empty()
            {
                final_text = Some(snapshot.text.as_str());
            }
        }
        final_text
    }
}

impl fmt::Debug for AssistantTurnSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AssistantTurnSnapshot")
            .field("has_message_id", &self.message_id.is_some())
            .field("segment_count", &self.segments.len())
            .field("text_bytes", &self.text.len())
            .field(
                "thinking_bytes",
                &self.thinking.as_ref().map_or(0, String::len),
            )
            .field("status", &self.status)
            .finish()
    }
}

/// Typed changes that OpenClaw actually emitted. Assistant deltas carry only
/// newly observed text; full snapshots keep ordered non-text segments intact.
#[derive(Clone, Eq, PartialEq)]
pub enum CanonicalSessionChange {
    RunStarted {
        run_id: RunId,
    },
    AssistantTurnChunk {
        run_id: RunId,
        message_id: Option<MessageId>,
        kind: AssistantTurnChunkKind,
        text: String,
        replace: bool,
        status: AssistantTurnStatus,
    },
    AssistantTurnSnapshot {
        snapshot: AssistantTurnSnapshot,
    },
    ToolActivity {
        run_id: RunId,
        tool_id: ToolId,
        tool_name: Option<String>,
        phase: ToolActivityPhase,
        input: Option<Value>,
        input_text: Option<String>,
        summary: Option<String>,
        output: Option<Value>,
        details: Option<Value>,
        is_error: Option<bool>,
    },
    ApprovalRequested {
        run_id: RunId,
        approval_id: ApprovalId,
        option_ids: Vec<ApprovalOptionId>,
    },
    ApprovalResolved {
        run_id: RunId,
        approval_id: ApprovalId,
        option_ids: Vec<ApprovalOptionId>,
    },
    RuntimeActivity {
        run_id: RunId,
        activity: CanonicalRuntimeActivity,
    },
    RuntimeActivityCleared {
        run_id: RunId,
        activity: CanonicalRuntimeActivity,
        retrying_cleanup: bool,
    },
    RunProgress {
        run_id: RunId,
        progress: CanonicalRunProgress,
    },
    RuntimeFallback {
        run_id: RunId,
        detail: RuntimeFallbackDetail,
    },
    RuntimeFallbackCleared {
        run_id: RunId,
    },
    GuardianNotice {
        run_id: RunId,
        notice: RuntimeGuardianNotice,
    },
    Terminal {
        run_id: RunId,
        outcome: TerminalOutcome,
        message_id: Option<MessageId>,
        error_kind: Option<SessionErrorKind>,
        error_message: Option<String>,
        stop_reason: Option<String>,
        error_detail: Option<Value>,
    },
    RecoveryRequired {
        reason: CanonicalRecoveryReason,
    },
    TranscriptMessage {
        message: Message,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalRuntimeActivity {
    Compacting,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalRunProgress {
    Startup { phase: ChatStatusPhase },
    Retrying { attempt: u8, max_attempts: u8 },
}

impl fmt::Debug for CanonicalSessionChange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RunStarted { .. } => formatter.debug_struct("RunStarted").finish(),
            Self::AssistantTurnChunk {
                kind,
                text,
                replace,
                status,
                message_id,
                ..
            } => formatter
                .debug_struct("AssistantTurnChunk")
                .field("has_message_id", &message_id.is_some())
                .field("kind", kind)
                .field("text_bytes", &text.len())
                .field("replace", replace)
                .field("status", status)
                .finish(),
            Self::AssistantTurnSnapshot { snapshot } => formatter
                .debug_tuple("AssistantTurnSnapshot")
                .field(snapshot)
                .finish(),
            Self::ToolActivity {
                phase,
                tool_name,
                input,
                input_text,
                summary,
                output,
                details,
                is_error,
                ..
            } => formatter
                .debug_struct("ToolActivity")
                .field("phase", phase)
                .field("has_tool_name", &tool_name.is_some())
                .field("has_input", &input.is_some())
                .field(
                    "input_text_bytes",
                    &input_text.as_ref().map_or(0, String::len),
                )
                .field("has_summary", &summary.is_some())
                .field("has_output", &output.is_some())
                .field("has_details", &details.is_some())
                .field("is_error", is_error)
                .finish(),
            Self::ApprovalRequested { option_ids, .. } => formatter
                .debug_struct("ApprovalRequested")
                .field("option_count", &option_ids.len())
                .finish(),
            Self::ApprovalResolved { option_ids, .. } => formatter
                .debug_struct("ApprovalResolved")
                .field("option_count", &option_ids.len())
                .finish(),
            Self::RuntimeActivity { activity, .. } => formatter
                .debug_struct("RuntimeActivity")
                .field("activity", activity)
                .finish(),
            Self::RuntimeActivityCleared { activity, .. } => formatter
                .debug_struct("RuntimeActivityCleared")
                .field("activity", activity)
                .finish(),
            Self::RunProgress { progress, .. } => formatter
                .debug_struct("RunProgress")
                .field("progress", progress)
                .finish(),
            Self::RuntimeFallback { detail, .. } => formatter
                .debug_struct("RuntimeFallback")
                .field("has_failover_reason", &detail.failover_reason.is_some())
                .field(
                    "has_provider_runtime_failure_kind",
                    &detail.provider_runtime_failure_kind.is_some(),
                )
                .field(
                    "has_provider_error_type",
                    &detail.provider_error_type.is_some(),
                )
                .field(
                    "has_provider_error_message_preview",
                    &detail.provider_error_message_preview.is_some(),
                )
                .field("has_http_status", &detail.http_status.is_some())
                .finish(),
            Self::RuntimeFallbackCleared { .. } => {
                formatter.debug_struct("RuntimeFallbackCleared").finish()
            }
            Self::GuardianNotice { notice, .. } => formatter
                .debug_struct("GuardianNotice")
                .field("phase", &notice.phase)
                .field("has_command", &notice.command.is_some())
                .field("has_risk_level", &notice.risk_level.is_some())
                .field("has_rationale", &notice.rationale.is_some())
                .field("has_message", &notice.message.is_some())
                .finish(),
            Self::Terminal {
                outcome,
                message_id,
                error_kind,
                error_message,
                stop_reason,
                error_detail,
                ..
            } => formatter
                .debug_struct("Terminal")
                .field("outcome", outcome)
                .field("has_message_id", &message_id.is_some())
                .field("error_kind", error_kind)
                .field("has_error_message", &error_message.is_some())
                .field("has_stop_reason", &stop_reason.is_some())
                .field("has_error_detail", &error_detail.is_some())
                .finish(),
            Self::RecoveryRequired { reason } => formatter
                .debug_struct("RecoveryRequired")
                .field("reason", reason)
                .finish(),
            Self::TranscriptMessage { message } => formatter
                .debug_struct("TranscriptMessage")
                .field("role", &message.role())
                .field("has_message_id", &message.message_id().is_some())
                .field("content_count", &message.content().len())
                .finish(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalRecoveryReason {
    CursorGap,
    CursorStale,
    EpochChanged,
    EventOverflow,
    NativeUnavailable,
    NativeUnknown,
}

impl CanonicalRecoveryReason {
    pub(crate) const fn from_ingress_error(error: crate::gateway::ingress::IngressError) -> Self {
        match error {
            crate::gateway::ingress::IngressError::EpochNotActive => Self::EpochChanged,
            crate::gateway::ingress::IngressError::StaleEpoch
            | crate::gateway::ingress::IngressError::NonMonotonicSequence => Self::CursorStale,
            crate::gateway::ingress::IngressError::Backpressure => Self::EventOverflow,
            crate::gateway::ingress::IngressError::Closed => Self::NativeUnavailable,
        }
    }
}

/// Minimal stateless producer seam. Gateway ingress owns ordering; this seam
/// only maps one verified native event or an explicit recovery fact.
pub struct CanonicalSessionDeltaProducer;

impl CanonicalSessionDeltaProducer {
    pub fn from_facts(
        facts: &LiveSessionFacts,
        route_key: Option<String>,
    ) -> Option<CanonicalSessionDelta> {
        let cursor = facts.cursor();
        Self::from_native_event(facts.event(), cursor.gateway_epoch(), route_key)
    }

    pub(crate) fn from_native_changes(
        event: &SessionEventEnvelope,
        source_epoch: Option<crate::gateway::ingress::GatewayEpoch>,
        route_key: Option<String>,
        changes: Vec<CanonicalSessionChange>,
    ) -> Option<CanonicalSessionDelta> {
        if changes.is_empty() {
            return None;
        }
        let provenance = SessionEventProvenance::from_native_event(
            event,
            source_epoch.map(crate::gateway::ingress::GatewayEpoch::as_u64),
            route_key.clone(),
        );
        Some(CanonicalSessionDelta {
            session_key: event.session_key.clone(),
            route_key,
            source_epoch: provenance.source_epoch(),
            source_cursor: provenance.source_cursor(),
            run_id: event.run_id.clone(),
            provenance,
            changes,
        })
    }

    pub(crate) fn from_native_event(
        event: &SessionEventEnvelope,
        source_epoch: Option<crate::gateway::ingress::GatewayEpoch>,
        route_key: Option<String>,
    ) -> Option<CanonicalSessionDelta> {
        let run_id = event.run_id.clone();
        let change = match event.kind {
            SessionEventKind::Chat => {
                let chat = event.chat.as_ref()?;
                if event.session_key != chat.session_key || run_id.as_ref() != Some(&chat.run_id) {
                    return None;
                }
                match chat.state {
                    ChatState::Status => chat_status_change(chat)?,
                    ChatState::Delta => {
                        if chat.message_text.is_some() || chat.message_thinking.is_some() {
                            return Self::from_native_changes(
                                event,
                                source_epoch,
                                route_key,
                                chat_snapshot_chunks(event, chat),
                            );
                        }
                        return Self::from_native_changes(
                            event,
                            source_epoch,
                            route_key,
                            vec![CanonicalSessionChange::AssistantTurnChunk {
                                run_id: chat.run_id.clone(),
                                message_id: native_message_id(event),
                                kind: AssistantTurnChunkKind::Text,
                                text: chat.delta_text.clone()?,
                                replace: chat.replace,
                                status: AssistantTurnStatus::Streaming,
                            }],
                        );
                    }
                    state => {
                        let terminal = CanonicalSessionChange::Terminal {
                            run_id: chat.run_id.clone(),
                            outcome: terminal_outcome(state)?,
                            message_id: native_message_id(event),
                            error_kind: chat.error_kind,
                            error_message: chat.error_message.clone(),
                            stop_reason: chat.stop_reason.clone(),
                            error_detail: chat.error_detail.clone(),
                        };
                        let mut changes =
                            if chat.message_text.is_some() || chat.message_thinking.is_some() {
                                chat_snapshot_chunks(event, chat)
                            } else {
                                Vec::new()
                            };
                        changes.push(terminal);
                        return Self::from_native_changes(event, source_epoch, route_key, changes);
                    }
                }
            }
            SessionEventKind::Message | SessionEventKind::Tool | SessionEventKind::Agent => {
                let activity = event.activity.as_ref()?;
                if event.session_key != activity.session_key
                    || run_id.as_ref() != Some(&activity.run_id)
                {
                    return None;
                }
                match activity.kind() {
                    SessionActivityKind::Message {
                        message_id,
                        lifecycle,
                        text,
                    } => CanonicalSessionChange::AssistantTurnChunk {
                        run_id: activity.run_id.clone(),
                        message_id: Some(message_id.clone()),
                        kind: AssistantTurnChunkKind::Text,
                        text: text.clone().unwrap_or_default(),
                        replace: false,
                        status: AssistantTurnStatus::from_message_lifecycle(*lifecycle),
                    },
                    SessionActivityKind::Tool {
                        tool_id,
                        tool_name,
                        phase,
                        summary,
                    } => CanonicalSessionChange::ToolActivity {
                        run_id: activity.run_id.clone(),
                        tool_id: tool_id.clone(),
                        tool_name: tool_name.clone(),
                        phase: *phase,
                        input: activity.input().cloned(),
                        input_text: activity.input_text().map(str::to_owned),
                        summary: summary.clone(),
                        output: activity.output().cloned(),
                        details: activity.details().cloned(),
                        is_error: activity.is_error(),
                    },
                    SessionActivityKind::Thinking { text } => {
                        CanonicalSessionChange::AssistantTurnChunk {
                            run_id: activity.run_id.clone(),
                            message_id: event
                                .message_id
                                .clone()
                                .or_else(|| event.embedded_message_id.clone()),
                            kind: AssistantTurnChunkKind::Thinking,
                            text: text.clone(),
                            replace: false,
                            status: AssistantTurnStatus::Streaming,
                        }
                    }
                    SessionActivityKind::Compaction { phase } => match phase {
                        RuntimeActivityPhase::Started => CanonicalSessionChange::RuntimeActivity {
                            run_id: activity.run_id.clone(),
                            activity: CanonicalRuntimeActivity::Compacting,
                        },
                        RuntimeActivityPhase::Retrying => return None,
                        RuntimeActivityPhase::Completed
                        | RuntimeActivityPhase::CompletedIfRetrying => {
                            CanonicalSessionChange::RuntimeActivityCleared {
                                run_id: activity.run_id.clone(),
                                activity: CanonicalRuntimeActivity::Compacting,
                                retrying_cleanup: matches!(
                                    phase,
                                    RuntimeActivityPhase::CompletedIfRetrying
                                ),
                            }
                        }
                    },
                    SessionActivityKind::Fallback { detail } => {
                        CanonicalSessionChange::RuntimeFallback {
                            run_id: activity.run_id.clone(),
                            detail: detail.clone(),
                        }
                    }
                    SessionActivityKind::FallbackCleared => {
                        CanonicalSessionChange::RuntimeFallbackCleared {
                            run_id: activity.run_id.clone(),
                        }
                    }
                    SessionActivityKind::Guardian { notice } => {
                        CanonicalSessionChange::GuardianNotice {
                            run_id: activity.run_id.clone(),
                            notice: notice.clone(),
                        }
                    }
                }
            }
            SessionEventKind::ApprovalRequested | SessionEventKind::ApprovalResolved => {
                let approval = event.approval.as_ref()?;
                if event.session_key != approval.session_key
                    || !matches!(
                        (event.kind, approval.lifecycle),
                        (
                            SessionEventKind::ApprovalRequested,
                            super::protocol::SessionApprovalLifecycle::Requested
                        ) | (
                            SessionEventKind::ApprovalResolved,
                            super::protocol::SessionApprovalLifecycle::Resolved
                        )
                    )
                {
                    return None;
                }
                let run_id = approval.run_id.clone().or_else(|| event.run_id.clone())?;
                match approval.lifecycle {
                    super::protocol::SessionApprovalLifecycle::Requested => {
                        CanonicalSessionChange::ApprovalRequested {
                            run_id,
                            approval_id: approval.approval_id.clone(),
                            option_ids: approval.option_ids.clone(),
                        }
                    }
                    super::protocol::SessionApprovalLifecycle::Resolved => {
                        CanonicalSessionChange::ApprovalResolved {
                            run_id,
                            approval_id: approval.approval_id.clone(),
                            option_ids: approval.option_ids.clone(),
                        }
                    }
                }
            }
            SessionEventKind::Changed => return None,
        };
        Self::from_native_changes(event, source_epoch, route_key, vec![change])
    }

    pub(crate) fn recovery(
        session_key: SessionKey,
        route_key: Option<String>,
        source_epoch: Option<crate::gateway::ingress::GatewayEpoch>,
        reason: CanonicalRecoveryReason,
    ) -> CanonicalSessionDelta {
        let provenance = SessionEventProvenance::recovery(
            session_key.clone(),
            route_key.clone(),
            source_epoch.map(crate::gateway::ingress::GatewayEpoch::as_u64),
        );
        CanonicalSessionDelta {
            session_key,
            route_key,
            source_epoch: provenance.source_epoch(),
            source_cursor: None,
            run_id: None,
            provenance,
            changes: vec![CanonicalSessionChange::RecoveryRequired { reason }],
        }
    }
}

fn terminal_outcome(state: ChatState) -> Option<TerminalOutcome> {
    match state {
        ChatState::Final => Some(TerminalOutcome::Completed),
        ChatState::Aborted => Some(TerminalOutcome::Aborted),
        ChatState::Error => Some(TerminalOutcome::Error),
        ChatState::Status | ChatState::Delta => None,
    }
}

fn chat_status_change(chat: &super::protocol::ChatEvent) -> Option<CanonicalSessionChange> {
    let progress = if let Some(retry) = chat.status_retry {
        CanonicalRunProgress::Retrying {
            attempt: retry.attempt,
            max_attempts: retry.max_attempts,
        }
    } else {
        CanonicalRunProgress::Startup {
            phase: chat.status_phase?,
        }
    };
    Some(CanonicalSessionChange::RunProgress {
        run_id: chat.run_id.clone(),
        progress,
    })
}

fn chat_snapshot_chunks(
    event: &SessionEventEnvelope,
    chat: &super::protocol::ChatEvent,
) -> Vec<CanonicalSessionChange> {
    let mut changes = Vec::with_capacity(2);
    if let Some(text) = chat.message_thinking.clone() {
        changes.push(CanonicalSessionChange::AssistantTurnChunk {
            run_id: chat.run_id.clone(),
            message_id: native_message_id(event),
            kind: AssistantTurnChunkKind::Thinking,
            text,
            replace: chat.replace,
            status: AssistantTurnStatus::Streaming,
        });
    }
    if let Some(text) = chat.message_text.clone() {
        changes.push(CanonicalSessionChange::AssistantTurnChunk {
            run_id: chat.run_id.clone(),
            message_id: native_message_id(event),
            kind: AssistantTurnChunkKind::Text,
            text,
            replace: chat.replace,
            status: AssistantTurnStatus::Streaming,
        });
    }
    changes
}

fn native_message_id(event: &SessionEventEnvelope) -> Option<MessageId> {
    event
        .message_id
        .clone()
        .or_else(|| event.embedded_message_id.clone())
}

/// A field needed by the public Renderer snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SnapshotField {
    Catalog,
    Runtime,
    Usage,
    Window,
    Items,
    Tools,
    Approvals,
    Media,
    ReplayComplete,
    Snapshot,
}

/// The native producer required for a Renderer snapshot field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SnapshotProducer {
    SessionsListSummary,
    SessionSummaryRuntime,
    SessionSummaryUsage,
    ChatHistory,
    SessionEvent,
    RendererItemAssembler,
    SessionSnapshotProducer,
}

/// Why a source-backed native fact cannot satisfy a Renderer snapshot field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionGapReason {
    SourceUnavailable,
    SourceUnknown,
    Native(NativeFactGap),
    NotProduced,
}

/// A typed, explicit gap in the OpenClaw-to-Renderer projection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProjectionGap {
    field: SnapshotField,
    producer: SnapshotProducer,
    reason: ProjectionGapReason,
}

impl ProjectionGap {
    const fn new(
        field: SnapshotField,
        producer: SnapshotProducer,
        reason: ProjectionGapReason,
    ) -> Self {
        Self {
            field,
            producer,
            reason,
        }
    }

    pub const fn field(self) -> SnapshotField {
        self.field
    }

    pub const fn producer(self) -> SnapshotProducer {
        self.producer
    }

    pub const fn reason(self) -> ProjectionGapReason {
        self.reason
    }
}

const RENDERER_SNAPSHOT_GAPS: &[ProjectionGap] = &[
    ProjectionGap::new(
        SnapshotField::Usage,
        SnapshotProducer::SessionSummaryUsage,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Window,
        SnapshotProducer::RendererItemAssembler,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Items,
        SnapshotProducer::RendererItemAssembler,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Tools,
        SnapshotProducer::SessionEvent,
        ProjectionGapReason::Native(NativeFactGap::ToolFacts),
    ),
    ProjectionGap::new(
        SnapshotField::Approvals,
        SnapshotProducer::SessionEvent,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Media,
        SnapshotProducer::RendererItemAssembler,
        ProjectionGapReason::Native(NativeFactGap::MediaFacts),
    ),
    ProjectionGap::new(
        SnapshotField::ReplayComplete,
        SnapshotProducer::SessionSnapshotProducer,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Snapshot,
        SnapshotProducer::SessionSnapshotProducer,
        ProjectionGapReason::NotProduced,
    ),
];

/// A conflicting native session key was supplied while composing a view.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionError {
    ConflictingSessionIdentity,
}

impl fmt::Display for ProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw session facts have conflicting session identities")
    }
}

impl std::error::Error for ProjectionError {}

/// A typed view over the Gateway fact families that are currently available.
///
/// This is deliberately not `SessionStateSnapshot`: OpenClaw exposes a session
/// summary, bounded history, and live events, but no complete snapshot producer.
/// The view preserves each source's status and never creates run/message/event
/// identity that the Gateway did not send.
#[derive(Clone, PartialEq)]
pub struct NativeSessionProjection {
    identity: NativeFactRead<SessionIdentityFacts>,
    runtime: NativeFactRead<SessionRuntimeFacts>,
    history: NativeFactRead<BoundedHistoryFacts>,
    live_event: NativeFactRead<LiveSessionFacts>,
    gaps: Vec<ProjectionGap>,
}

impl NativeSessionProjection {
    /// Composes independently read native facts after checking their session key.
    ///
    /// A missing key in a bounded history page is retained as a gap; it is never
    /// filled from another fact family.
    pub fn from_reads(
        identity: NativeFactRead<SessionIdentityFacts>,
        runtime: NativeFactRead<SessionRuntimeFacts>,
        history: NativeFactRead<BoundedHistoryFacts>,
        live_event: NativeFactRead<LiveSessionFacts>,
    ) -> Result<Self, ProjectionError> {
        let projection = Self {
            identity,
            runtime,
            history,
            live_event,
            gaps: Vec::new(),
        };
        projection.validate_session_identity()?;
        let gaps = projection.collect_gaps();
        Ok(Self { gaps, ..projection })
    }

    /// Builds the available summary projection. History and event facts remain
    /// unavailable until the corresponding Gateway operation/event is read.
    pub fn from_summary(summary: &SessionSummary) -> Self {
        Self::from_reads(
            SessionIdentityFacts::from_native(summary),
            SessionRuntimeFacts::from_native(summary),
            NativeFactRead::Unavailable,
            NativeFactRead::Unavailable,
        )
        .expect("identity and runtime facts from one summary have one session key")
    }

    pub fn identity(&self) -> &NativeFactRead<SessionIdentityFacts> {
        &self.identity
    }

    pub fn runtime(&self) -> &NativeFactRead<SessionRuntimeFacts> {
        &self.runtime
    }

    pub fn history(&self) -> &NativeFactRead<BoundedHistoryFacts> {
        &self.history
    }

    pub fn live_event(&self) -> &NativeFactRead<LiveSessionFacts> {
        &self.live_event
    }

    /// Returns cursor facts only when the native event supplied them.
    /// Host epoch/seq/cursor values must not be inferred from this value.
    pub fn native_cursor(&self) -> NativeFactRead<NativeCursor> {
        match &self.live_event {
            NativeFactRead::Complete(facts) => NativeFactRead::Complete(facts.cursor()),
            NativeFactRead::Incomplete { facts, gaps } => NativeFactRead::Incomplete {
                facts: facts.cursor(),
                gaps: gaps.clone(),
            },
            NativeFactRead::Unavailable => NativeFactRead::Unavailable,
            NativeFactRead::Unknown => NativeFactRead::Unknown,
        }
    }

    /// Returns only a session key explicitly supplied by one native fact.
    pub fn session_key(&self) -> Option<&SessionKey> {
        self.identity
            .facts()
            .map(SessionIdentityFacts::session_key)
            .or_else(|| self.runtime.facts().map(SessionRuntimeFacts::session_key))
            .or_else(|| {
                self.history
                    .facts()
                    .and_then(BoundedHistoryFacts::session_key)
            })
            .or_else(|| self.live_event.facts().map(LiveSessionFacts::session_key))
    }

    pub fn gaps(&self) -> &[ProjectionGap] {
        &self.gaps
    }

    pub const fn can_build_renderer_snapshot() -> bool {
        false
    }

    pub const fn renderer_snapshot_gaps() -> &'static [ProjectionGap] {
        RENDERER_SNAPSHOT_GAPS
    }

    fn validate_session_identity(&self) -> Result<(), ProjectionError> {
        let mut expected = None;
        for key in [
            self.identity.facts().map(SessionIdentityFacts::session_key),
            self.runtime.facts().map(SessionRuntimeFacts::session_key),
            self.history
                .facts()
                .and_then(BoundedHistoryFacts::session_key),
            self.live_event.facts().map(LiveSessionFacts::session_key),
        ] {
            let Some(key) = key else {
                continue;
            };
            if expected.is_some_and(|expected: &SessionKey| expected != key) {
                return Err(ProjectionError::ConflictingSessionIdentity);
            }
            expected = Some(key);
        }
        Ok(())
    }

    fn collect_gaps(&self) -> Vec<ProjectionGap> {
        let mut gaps = Vec::with_capacity(RENDERER_SNAPSHOT_GAPS.len() + 4);
        append_read_gaps(
            &self.identity,
            SnapshotField::Catalog,
            SnapshotProducer::SessionsListSummary,
            &mut gaps,
        );
        append_read_gaps(
            &self.runtime,
            SnapshotField::Runtime,
            SnapshotProducer::SessionSummaryRuntime,
            &mut gaps,
        );
        append_read_gaps(
            &self.history,
            SnapshotField::Window,
            SnapshotProducer::ChatHistory,
            &mut gaps,
        );
        append_read_gaps(
            &self.live_event,
            SnapshotField::Runtime,
            SnapshotProducer::SessionEvent,
            &mut gaps,
        );
        gaps.extend_from_slice(RENDERER_SNAPSHOT_GAPS);
        gaps
    }
}

fn append_read_gaps<T>(
    read: &NativeFactRead<T>,
    field: SnapshotField,
    producer: SnapshotProducer,
    gaps: &mut Vec<ProjectionGap>,
) {
    match read {
        NativeFactRead::Complete(_) => {}
        NativeFactRead::Incomplete { gaps: native, .. } => {
            gaps.extend(native.iter().copied().map(|reason| {
                ProjectionGap::new(field, producer, ProjectionGapReason::Native(reason))
            }))
        }
        NativeFactRead::Unavailable => gaps.push(ProjectionGap::new(
            field,
            producer,
            ProjectionGapReason::SourceUnavailable,
        )),
        NativeFactRead::Unknown => gaps.push(ProjectionGap::new(
            field,
            producer,
            ProjectionGapReason::SourceUnknown,
        )),
    }
}

impl fmt::Debug for NativeSessionProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeSessionProjection")
            .field("identity_status", &self.identity.status())
            .field("runtime_status", &self.runtime.status())
            .field("history_status", &self.history.status())
            .field("live_event_status", &self.live_event.status())
            .field("gap_count", &self.gaps.len())
            .finish()
    }
}

/// The result of attempting to assemble a public Renderer snapshot.
///
/// There is intentionally no complete variant until OpenClaw supplies a real
/// snapshot producer and a renderer-item assembler.
#[derive(Clone, PartialEq)]
pub enum SnapshotAssembly {
    Incomplete {
        projection: NativeSessionProjection,
        gaps: Vec<ProjectionGap>,
    },
}

impl SnapshotAssembly {
    pub fn projection(&self) -> &NativeSessionProjection {
        match self {
            Self::Incomplete { projection, .. } => projection,
        }
    }

    pub fn gaps(&self) -> &[ProjectionGap] {
        match self {
            Self::Incomplete { gaps, .. } => gaps,
        }
    }

    pub const fn is_incomplete(&self) -> bool {
        true
    }
}

impl fmt::Debug for SnapshotAssembly {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SnapshotAssembly::Incomplete")
            .field("gap_count", &self.gaps().len())
            .field("projection", self.projection())
            .finish()
    }
}

/// Keeps the incomplete boundary explicit for callers that need a snapshot seam.
#[derive(Clone, Copy, Debug, Default)]
pub struct SnapshotAssembler;

impl SnapshotAssembler {
    pub const fn new() -> Self {
        Self
    }

    pub const fn renderer_snapshot_gaps() -> &'static [ProjectionGap] {
        RENDERER_SNAPSHOT_GAPS
    }

    pub const fn can_build_renderer_snapshot() -> bool {
        false
    }

    pub fn assemble(projection: NativeSessionProjection) -> SnapshotAssembly {
        SnapshotAssembly::Incomplete {
            gaps: projection.gaps.clone(),
            projection,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        gateway::{ingress::GatewayEpoch, wire::GatewayEvent},
        session::{
            facts::{BoundedHistoryFacts, LiveSessionFacts, NativeFactStatus},
            protocol::{ChatState, SessionEventKind, decode_session_event},
        },
        session_window::PageRequest,
    };

    fn summary() -> SessionSummary {
        SessionSummary {
            key: SessionKey::try_new("agent:main:session-1").unwrap(),
            kind: super::super::protocol::SessionKind::Direct,
            agent_id: None,
            label: Some("review".into()),
            display_name: Some("Review".into()),
            derived_title: Some("Native title".into()),
            updated_at: Some(42),
            status: Some("idle".into()),
            has_active_run: Some(false),
            model: Some("provider/model".into()),
            model_provider: None,
            active_model: None,
            active_model_provider: None,
            model_override_source: None,
            permission_mode: None,
            permission_mode_pending: None,
        }
    }

    fn event(
        name: &str,
        payload: serde_json::Value,
    ) -> super::super::protocol::SessionEventEnvelope {
        decode_session_event(GatewayEvent {
            name: name.into(),
            payload: Some(payload),
            sequence: Some(8),
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    #[test]
    fn summary_projection_preserves_native_facts_and_marks_missing_producers() {
        let projection = NativeSessionProjection::from_summary(&summary());
        assert_eq!(
            projection.session_key().unwrap().as_str(),
            "agent:main:session-1"
        );
        assert_eq!(projection.identity().status(), NativeFactStatus::Complete);
        assert_eq!(projection.runtime().status(), NativeFactStatus::Complete);
        assert_eq!(projection.history().status(), NativeFactStatus::Unavailable);
        assert_eq!(
            projection.live_event().status(),
            NativeFactStatus::Unavailable
        );
        assert!(!NativeSessionProjection::can_build_renderer_snapshot());
        assert!(projection.gaps().iter().any(|gap| {
            gap.field() == SnapshotField::Usage
                && gap.producer() == SnapshotProducer::SessionSummaryUsage
                && gap.reason() == ProjectionGapReason::NotProduced
        }));
        assert!(projection.gaps().iter().any(|gap| {
            gap.field() == SnapshotField::Items && gap.reason() == ProjectionGapReason::NotProduced
        }));
        assert!(
            projection
                .gaps()
                .iter()
                .any(|gap| { gap.field() == SnapshotField::Window })
        );
    }

    #[test]
    fn history_and_live_facts_remain_source_backed_and_identity_checked() {
        let history = BoundedHistoryFacts::decode(
            json!({
                "sessionKey":"agent:main:session-1",
                "messages":[
                    {"role":"user","messageId":"message-1","runId":"run-1","seq":7,"content":"hello"}
                ]
            }),
            PageRequest::latest(),
        )
        .unwrap();
        let live = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":7,
                    "state":"delta",
                    "deltaText":"partial"
                }),
            ),
            Some(GatewayEpoch::try_new(1).unwrap()),
        );
        let projection = NativeSessionProjection::from_reads(
            SessionIdentityFacts::from_native(&summary()),
            SessionRuntimeFacts::from_native(&summary()),
            history,
            live,
        )
        .unwrap();
        assert_eq!(
            projection
                .history()
                .facts()
                .unwrap()
                .window()
                .messages()
                .len(),
            1
        );
        assert_eq!(
            projection.live_event().facts().unwrap().chat_state(),
            Some(ChatState::Delta)
        );
        assert_eq!(
            projection.live_event().facts().unwrap().event().kind,
            SessionEventKind::Chat
        );
        assert_eq!(
            projection
                .live_event()
                .facts()
                .unwrap()
                .run_id()
                .unwrap()
                .as_str(),
            "run-1"
        );
        assert_eq!(
            projection.live_event().facts().unwrap().gateway_sequence(),
            Some(8)
        );
    }

    #[test]
    fn conflicting_native_session_keys_fail_without_crosswalk() {
        let mut other = summary();
        other.key = SessionKey::try_new("agent:main:other-session").unwrap();
        let result = NativeSessionProjection::from_reads(
            SessionIdentityFacts::from_native(&summary()),
            SessionRuntimeFacts::from_native(&other),
            NativeFactRead::Unavailable,
            NativeFactRead::Unavailable,
        );
        assert_eq!(result, Err(ProjectionError::ConflictingSessionIdentity));
    }

    #[test]
    fn canonical_delta_preserves_native_chat_cursor_and_provenance() {
        let read = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":7,
                    "state":"delta",
                    "deltaText":"private delta"
                }),
            ),
            Some(GatewayEpoch::try_new(4).unwrap()),
        );
        let delta =
            CanonicalSessionDeltaProducer::from_facts(read.facts().unwrap(), Some("route".into()))
                .expect("native chat delta has a typed change");
        assert_eq!(delta.source_epoch(), Some(4));
        assert_eq!(delta.source_cursor(), Some(8));
        assert_eq!(delta.run_id().unwrap().as_str(), "run-1");
        assert_eq!(delta.provenance().source_epoch(), Some(4));
        assert_eq!(delta.provenance().source_cursor(), Some(8));
        assert!(matches!(
            delta.changes(),
            [CanonicalSessionChange::AssistantTurnChunk {
                run_id,
                message_id: None,
                kind: AssistantTurnChunkKind::Text,
                text,
                replace: false,
                status: AssistantTurnStatus::Streaming,
            }] if run_id.as_str() == "run-1" && text == "private delta"
        ));
        let debug = format!("{delta:?}");
        for private_value in ["agent:main:session-1", "run-1", "private delta"] {
            assert!(!debug.contains(private_value));
        }
    }

    #[test]
    fn canonical_delta_projects_real_message_tool_and_terminal_facts() {
        let message = LiveSessionFacts::from_native_at_epoch(
            event(
                "session.message",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "messageId":"message-1",
                    "lifecycle":"delta",
                    "message":{"content":"message text"}
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let message_delta =
            CanonicalSessionDeltaProducer::from_facts(message.facts().unwrap(), None)
                .expect("native message activity has a typed change");
        assert!(matches!(
            message_delta.changes(),
            [CanonicalSessionChange::AssistantTurnChunk {
                run_id,
                message_id: Some(message_id),
                kind: AssistantTurnChunkKind::Text,
                text,
                replace: false,
                status: AssistantTurnStatus::Streaming,
            }] if run_id.as_str() == "run-1"
                && message_id.as_str() == "message-1"
                && text == "message text"
        ));
        assert_eq!(message_delta.source_epoch(), Some(5));
        assert_eq!(message_delta.source_cursor(), Some(8));

        let tool = LiveSessionFacts::from_native_at_epoch(
            event(
                "session.tool",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "phase":"failed",
                    "toolCallId":"tool-1",
                    "toolName":"read",
                    "summary":"tool summary"
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let tool_delta = CanonicalSessionDeltaProducer::from_facts(tool.facts().unwrap(), None)
            .expect("native tool activity has a typed change");
        assert!(matches!(
            tool_delta.changes(),
            [CanonicalSessionChange::ToolActivity {
                run_id,
                tool_id,
                tool_name: Some(tool_name),
                phase: ToolActivityPhase::Failed,
                input,
                input_text,
                summary: Some(summary),
                output,
                details,
                is_error,
            }] if run_id.as_str() == "run-1"
                && tool_id.as_str() == "tool-1"
                && tool_name == "read"
                && input.is_none()
                && input_text.is_none()
                && summary == "tool summary"
                && output.is_none()
                && details.is_none()
                && is_error == &None
        ));

        let detailed_tool = LiveSessionFacts::from_native_at_epoch(
            event(
                "session.tool",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "phase":"result",
                    "toolCallId":"tool-1",
                    "result":{"details":{"browserTab":{"title":"safe"},"privatePayload":{"secret":true}}},
                    "output":""
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let detailed_tool_delta =
            CanonicalSessionDeltaProducer::from_facts(detailed_tool.facts().unwrap(), None)
                .expect("native tool result details have a typed change");
        assert!(matches!(
            detailed_tool_delta.changes(),
            [CanonicalSessionChange::ToolActivity {
                phase: ToolActivityPhase::Completed,
                details: Some(details),
                ..
            }] if details == &json!({"browserTab":{"title":"safe"}})
        ));

        let terminal = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":8,
                    "state":"final"
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let terminal_delta =
            CanonicalSessionDeltaProducer::from_facts(terminal.facts().unwrap(), None)
                .expect("native terminal has a typed change");
        assert!(matches!(
            terminal_delta.changes(),
            [CanonicalSessionChange::Terminal {
                run_id,
                outcome: TerminalOutcome::Completed,
                message_id: None,
                error_kind: None,
                error_message: None,
                stop_reason: None,
                error_detail: None
            }] if run_id.as_str() == "run-1"
        ));

        let compacting = LiveSessionFacts::from_native_at_epoch(
            event(
                "agent",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "stream":"compaction",
                    "data":{"phase":"start"}
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let compacting_delta =
            CanonicalSessionDeltaProducer::from_facts(compacting.facts().unwrap(), None)
                .expect("native compaction stream has a typed change");
        assert!(matches!(
            compacting_delta.changes(),
            [CanonicalSessionChange::RuntimeActivity {
                run_id,
                activity: CanonicalRuntimeActivity::Compacting,
            }] if run_id.as_str() == "run-1"
        ));

        let message_only_error_terminal = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":9,
                    "state":"error",
                    "errorMessage":"provider overloaded",
                    "errorKind":"rate_limit",
                    "stopReason":"gateway_error"
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let message_only_error_terminal_delta = CanonicalSessionDeltaProducer::from_facts(
            message_only_error_terminal.facts().unwrap(),
            None,
        )
        .expect("native terminal error message has a typed change");
        assert!(matches!(
            message_only_error_terminal_delta.changes(),
            [CanonicalSessionChange::Terminal {
                outcome: TerminalOutcome::Error,
                error_kind: Some(SessionErrorKind::RateLimit),
                error_message: Some(error_message),
                stop_reason: Some(stop_reason),
                error_detail: None,
                ..
            }] if error_message == "provider overloaded" && stop_reason == "gateway_error"
        ));

        let error_terminal = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":10,
                    "state":"error",
                    "errorMessage":"provider overloaded",
                    "errorKind":"rate_limit",
                    "stopReason":"gateway_error",
                    "errorDetail":{
                        "provider":"private-provider",
                        "failoverReason":"rate_limit",
                        "providerErrorType":"overloaded",
                        "providerErrorMessagePreview":"safe preview",
                        "httpStatus":429
                    }
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let error_terminal_delta =
            CanonicalSessionDeltaProducer::from_facts(error_terminal.facts().unwrap(), None)
                .expect("native terminal error detail has a typed change");
        assert!(matches!(
            error_terminal_delta.changes(),
            [CanonicalSessionChange::Terminal {
                outcome: TerminalOutcome::Error,
                error_kind: Some(SessionErrorKind::RateLimit),
                error_message: Some(error_message),
                stop_reason: Some(stop_reason),
                error_detail: Some(error_detail),
                ..
            }] if error_message == "provider overloaded"
                && stop_reason == "gateway_error"
                && error_detail.get("provider").is_none()
                && error_detail.get("failoverReason").and_then(Value::as_str) == Some("rate_limit")
                && error_detail.get("httpStatus").and_then(Value::as_u64) == Some(429)
        ));
    }

    #[test]
    fn canonical_delta_keeps_missing_gateway_position_unknown() {
        let event = decode_session_event(GatewayEvent {
            name: "chat".into(),
            payload: Some(json!({
                "sessionKey":"agent:main:session-1",
                "runId":"run-1",
                "seq":7,
                "state":"delta",
                "deltaText":"delta"
            })),
            sequence: None,
            state_version: None,
        })
        .unwrap()
        .unwrap();
        let delta = CanonicalSessionDeltaProducer::from_native_event(&event, None, None)
            .expect("chat sequence is enough for the typed chat change");
        assert_eq!(delta.source_epoch(), None);
        assert_eq!(delta.source_cursor(), None);
        assert_eq!(delta.provenance().source_epoch(), None);
        assert_eq!(delta.provenance().source_cursor(), None);
    }

    #[test]
    fn chat_snapshot_delta_projects_text_and_thinking_deltas_without_raw_payload() {
        let delta = CanonicalSessionDeltaProducer::from_native_event(
            &event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":7,
                    "state":"delta",
                    "message":{
                        "id":"message-1",
                        "role":"assistant",
                        "content":[
                            {"type":"thinking","thinking":"plan"},
                            {"type":"text","text":"answer"}
                        ]
                    }
                }),
            ),
            None,
            None,
        )
        .expect("chat message snapshot has typed deltas");

        assert!(matches!(
            delta.changes(),
            [
                CanonicalSessionChange::AssistantTurnChunk {
                    run_id: thinking_run_id,
                    message_id: Some(thinking_message_id),
                    kind: AssistantTurnChunkKind::Thinking,
                    text: thinking,
                    replace: false,
                    status: AssistantTurnStatus::Streaming,
                },
                CanonicalSessionChange::AssistantTurnChunk {
                    run_id: text_run_id,
                    message_id: Some(text_message_id),
                    kind: AssistantTurnChunkKind::Text,
                    text,
                    replace: false,
                    status: AssistantTurnStatus::Streaming,
                }
            ] if thinking_run_id.as_str() == "run-1"
                && text_run_id.as_str() == "run-1"
                && thinking_message_id.as_str() == "message-1"
                && text_message_id.as_str() == "message-1"
                && thinking == "plan"
                && text == "answer"
        ));
        let debug = format!("{:?}", delta.changes());
        for private_value in [
            "plan",
            "answer",
            "agent:main:session-1",
            "run-1",
            "message-1",
        ] {
            assert!(!debug.contains(private_value));
        }
    }

    #[test]
    fn assistant_turn_final_text_filters_by_run_id() {
        let run_1 = RunId::try_new("run-1").unwrap();
        let run_2 = RunId::try_new("run-2").unwrap();
        let snapshots = [
            AssistantTurnSnapshot::from_text_parts(
                run_2.clone(),
                None,
                "other final",
                None,
                AssistantTurnStatus::Final,
            ),
            AssistantTurnSnapshot::from_text_parts(
                run_1.clone(),
                None,
                "streaming text",
                None,
                AssistantTurnStatus::Streaming,
            ),
            AssistantTurnSnapshot::from_text_parts(
                run_1.clone(),
                None,
                "canonical final",
                None,
                AssistantTurnStatus::Final,
            ),
        ];

        assert_eq!(
            AssistantTurnSnapshot::final_text_for_run(snapshots.iter(), &run_1),
            Some("canonical final")
        );
        assert_eq!(
            AssistantTurnSnapshot::final_text_for_run(snapshots.iter(), &run_2),
            Some("other final")
        );
        assert_eq!(
            AssistantTurnSnapshot::final_text_for_run(
                snapshots.iter(),
                &RunId::try_new("missing-run").unwrap()
            ),
            None
        );
    }

    #[test]
    fn changed_event_is_not_promoted_and_recovery_is_explicit() {
        let changed = event(
            "sessions.changed",
            json!({"sessionKey":"agent:main:session-1"}),
        );
        assert!(
            CanonicalSessionDeltaProducer::from_native_event(
                &changed,
                Some(crate::gateway::ingress::GatewayEpoch::try_new(2).unwrap()),
                None,
            )
            .is_none()
        );

        for reason in [
            CanonicalRecoveryReason::CursorGap,
            CanonicalRecoveryReason::CursorStale,
            CanonicalRecoveryReason::EpochChanged,
            CanonicalRecoveryReason::EventOverflow,
            CanonicalRecoveryReason::NativeUnavailable,
            CanonicalRecoveryReason::NativeUnknown,
        ] {
            let recovery = CanonicalSessionDeltaProducer::recovery(
                SessionKey::try_new("agent:main:session-1").unwrap(),
                Some("route".into()),
                Some(crate::gateway::ingress::GatewayEpoch::try_new(3).unwrap()),
                reason,
            );
            assert_eq!(recovery.source_epoch(), Some(3));
            assert_eq!(recovery.source_cursor(), None);
            assert_eq!(recovery.run_id(), None);
            assert!(matches!(
                recovery.changes(),
                [CanonicalSessionChange::RecoveryRequired { reason: actual }] if *actual == reason
            ));
        }
    }

    #[test]
    fn ingress_faults_become_source_backed_recovery_deltas() {
        for (error, expected_reason) in [
            (
                crate::gateway::ingress::IngressError::EpochNotActive,
                CanonicalRecoveryReason::EpochChanged,
            ),
            (
                crate::gateway::ingress::IngressError::StaleEpoch,
                CanonicalRecoveryReason::CursorStale,
            ),
            (
                crate::gateway::ingress::IngressError::NonMonotonicSequence,
                CanonicalRecoveryReason::CursorStale,
            ),
            (
                crate::gateway::ingress::IngressError::Backpressure,
                CanonicalRecoveryReason::EventOverflow,
            ),
            (
                crate::gateway::ingress::IngressError::Closed,
                CanonicalRecoveryReason::NativeUnavailable,
            ),
        ] {
            let reason = CanonicalRecoveryReason::from_ingress_error(error);
            assert_eq!(reason, expected_reason);
            let recovery = CanonicalSessionDeltaProducer::recovery(
                SessionKey::try_new("agent:main:session-1").unwrap(),
                Some("route".into()),
                Some(GatewayEpoch::try_new(9).unwrap()),
                reason,
            );
            assert_eq!(recovery.source_epoch(), Some(9));
            assert_eq!(recovery.source_cursor(), None);
            assert_eq!(recovery.run_id(), None);
            assert!(matches!(
                recovery.changes(),
                [CanonicalSessionChange::RecoveryRequired { reason }] if reason == &expected_reason
            ));
        }
    }

    #[test]
    fn incomplete_snapshot_is_the_only_assembly_result() {
        let assembly =
            SnapshotAssembler::assemble(NativeSessionProjection::from_summary(&summary()));
        assert!(assembly.is_incomplete());
        assert!(!SnapshotAssembler::can_build_renderer_snapshot());
        assert!(assembly.gaps().iter().any(|gap| {
            gap.field() == SnapshotField::Snapshot
                && gap.producer() == SnapshotProducer::SessionSnapshotProducer
        }));
        let debug = format!("{assembly:?}");
        assert!(!debug.contains("agent:main:session-1"));
        assert!(!debug.contains("provider/model"));
    }
}
