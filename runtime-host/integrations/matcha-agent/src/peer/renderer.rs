use crate::session::{events::ProjectedRunError, recovery::SessionRecovery};
use serde_json::Value;
use std::fmt;

#[derive(Clone, Eq, PartialEq)]
pub enum RendererEvent {
    Run {
        sequence: u64,
        phase: RendererRunPhase,
    },
    RunFailed {
        sequence: u64,
        error: Option<ProjectedRunError>,
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
            Self::RunFailed { sequence, error } => formatter
                .debug_struct("RunFailed")
                .field("sequence", sequence)
                .field("error", error)
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
    identity: sessions_module::state::SessionIdentity,
    generation: u64,
    run_id: String,
    source_cursor: u64,
    source_epoch: Option<u64>,
    event: RendererEvent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionSubscriptionItem {
    Event(RendererEventEnvelope),
    Recovery {
        identity: sessions_module::state::SessionIdentity,
        generation: u64,
        run_id: Option<String>,
        recovery: SessionRecovery,
    },
}

impl RendererEventEnvelope {
    pub fn new(
        identity: sessions_module::state::SessionIdentity,
        generation: u64,
        run_id: String,
        source_cursor: u64,
        source_epoch: Option<u64>,
        event: RendererEvent,
    ) -> Self {
        Self {
            identity,
            generation,
            run_id,
            source_cursor,
            source_epoch,
            event,
        }
    }

    pub fn identity(&self) -> &sessions_module::state::SessionIdentity {
        &self.identity
    }

    pub const fn generation(&self) -> u64 {
        self.generation
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
            .field("identity", &self.identity)
            .field("generation", &self.generation)
            .field("run_id", &self.run_id)
            .field("source_cursor", &self.source_cursor)
            .field("source_epoch", &self.source_epoch)
            .field("event", &self.event)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RendererRunPhase {
    Queued,
    Started,
    WaitingForApproval,
    CancellationRequested,
    Completed,
    Cancelled,
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
