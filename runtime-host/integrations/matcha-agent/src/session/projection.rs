use std::fmt;

use super::{
    approval::ApprovalRecord,
    catalog::SessionCatalogFacts,
    client::EventRecoveryCursor,
    events::{EventActivity, RunLifecycle},
    facts::{NativeEventFact, NativeEventSource, NativeSessionFacts},
    hydration::{
        HydratedContentBlock, HydratedImage, HydratedMessage, HydratedMessageRole,
        HydratedToolResult, HydratedToolUse, HydrationSnapshot, HydrationWindow,
    },
    model::{
        RunId, RunRecord, RunStatus, Sequence, SessionId, SessionRecord, UsageSummary,
        WorkerRuntimeState,
    },
};

/// Provenance for an ordered native fact. Transcript positions and native
/// event sequences are separate coordinates and are never substituted for one
/// another.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeFactProvenance {
    Transcript { source_index: Option<usize> },
    SnapshotEvent { sequence: Sequence },
    ReplayEvent { sequence: Sequence },
    SnapshotRun,
    SnapshotApproval,
}

impl NativeFactProvenance {
    pub const fn source_index(self) -> Option<usize> {
        match self {
            Self::Transcript { source_index } => source_index,
            Self::SnapshotEvent { .. }
            | Self::ReplayEvent { .. }
            | Self::SnapshotRun
            | Self::SnapshotApproval => None,
        }
    }

    pub const fn native_sequence(self) -> Option<Sequence> {
        match self {
            Self::SnapshotEvent { sequence } | Self::ReplayEvent { sequence } => Some(sequence),
            Self::Transcript { .. } | Self::SnapshotRun | Self::SnapshotApproval => None,
        }
    }

    pub const fn event_source(self) -> Option<NativeEventSource> {
        match self {
            Self::SnapshotEvent { .. } => Some(NativeEventSource::Snapshot),
            Self::ReplayEvent { .. } => Some(NativeEventSource::Replay),
            Self::Transcript { .. } | Self::SnapshotRun | Self::SnapshotApproval => None,
        }
    }
}

/// An ordered fact assembled from the existing native transcript, snapshot,
/// and replay owners. It is integration-local and deliberately not a Renderer
/// item or Host event type.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NativeOrderedFact<'facts> {
    Message {
        provenance: NativeFactProvenance,
        message: &'facts HydratedMessage,
    },
    AssistantTurn {
        provenance: NativeFactProvenance,
        message: &'facts HydratedMessage,
    },
    ToolUse {
        provenance: NativeFactProvenance,
        message: &'facts HydratedMessage,
        block_index: usize,
        tool: &'facts HydratedToolUse,
    },
    ToolResult {
        provenance: NativeFactProvenance,
        message: &'facts HydratedMessage,
        block_index: usize,
        result: &'facts HydratedToolResult,
    },
    Media {
        provenance: NativeFactProvenance,
        message: &'facts HydratedMessage,
        block_index: usize,
        image: &'facts HydratedImage,
    },
    EventMessage {
        provenance: NativeFactProvenance,
        event: &'facts NativeEventFact,
    },
    EventTool {
        provenance: NativeFactProvenance,
        event: &'facts NativeEventFact,
    },
    PendingApproval {
        provenance: NativeFactProvenance,
        approval: &'facts ApprovalRecord,
    },
    ApprovalEvent {
        provenance: NativeFactProvenance,
        event: &'facts NativeEventFact,
    },
    SnapshotTerminal {
        provenance: NativeFactProvenance,
        run: &'facts RunRecord,
    },
    TerminalEvent {
        provenance: NativeFactProvenance,
        event: &'facts NativeEventFact,
    },
}

impl NativeOrderedFact<'_> {
    pub const fn provenance(&self) -> NativeFactProvenance {
        match self {
            Self::Message { provenance, .. }
            | Self::AssistantTurn { provenance, .. }
            | Self::ToolUse { provenance, .. }
            | Self::ToolResult { provenance, .. }
            | Self::Media { provenance, .. }
            | Self::EventMessage { provenance, .. }
            | Self::EventTool { provenance, .. }
            | Self::PendingApproval { provenance, .. }
            | Self::ApprovalEvent { provenance, .. }
            | Self::SnapshotTerminal { provenance, .. }
            | Self::TerminalEvent { provenance, .. } => *provenance,
        }
    }

    pub const fn source_index(&self) -> Option<usize> {
        self.provenance().source_index()
    }

    pub const fn native_sequence(&self) -> Option<Sequence> {
        self.provenance().native_sequence()
    }
}

/// Native ordered facts retain their source cursor and completeness boundary.
/// No cross-source chronology is inferred between transcript indexes and event
/// sequences.
pub struct NativeOrderedFacts<'facts> {
    facts: Vec<NativeOrderedFact<'facts>>,
    replay_cursor: &'facts EventRecoveryCursor,
    replay_boundary_complete: bool,
    transcript_source_order: bool,
    bounded_transcript: bool,
}

impl NativeOrderedFacts<'_> {
    pub fn facts(&self) -> &[NativeOrderedFact<'_>] {
        &self.facts
    }

    pub fn replay_cursor(&self) -> &EventRecoveryCursor {
        self.replay_cursor
    }

    pub const fn source_epoch(&self) -> Option<u64> {
        None
    }

    pub const fn replay_boundary_complete(&self) -> bool {
        self.replay_boundary_complete
    }

    pub const fn transcript_source_order_complete(&self) -> bool {
        self.transcript_source_order
    }

    pub const fn is_incomplete(&self) -> bool {
        self.bounded_transcript || !self.transcript_source_order || !self.replay_boundary_complete
    }
}

impl fmt::Debug for NativeOrderedFacts<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeOrderedFacts")
            .field("fact_count", &self.facts.len())
            .field("replay_boundary_complete", &self.replay_boundary_complete)
            .field("transcript_source_order", &self.transcript_source_order)
            .field("bounded_transcript", &self.bounded_transcript)
            .field("replay_cursor", &self.replay_cursor)
            .finish()
    }
}

/// Module-local assembly over the single validated Matcha facts owner.
struct NativeFactAssembler;

impl NativeFactAssembler {
    fn assemble<'facts>(facts: &'facts NativeSessionFacts) -> NativeOrderedFacts<'facts> {
        let transcript = facts.transcript();
        let mut ordered = Vec::new();

        for message in transcript.ordered_messages() {
            let provenance = NativeFactProvenance::Transcript {
                source_index: message.source_index(),
            };
            ordered.push(NativeOrderedFact::Message {
                provenance,
                message,
            });
            if message.role() == HydratedMessageRole::Assistant {
                ordered.push(NativeOrderedFact::AssistantTurn {
                    provenance,
                    message,
                });
            }
            for (block_index, block) in message.content().iter().enumerate() {
                match block {
                    HydratedContentBlock::ToolUse(tool) => {
                        ordered.push(NativeOrderedFact::ToolUse {
                            provenance,
                            message,
                            block_index,
                            tool,
                        });
                    }
                    HydratedContentBlock::ToolResult(result) => {
                        ordered.push(NativeOrderedFact::ToolResult {
                            provenance,
                            message,
                            block_index,
                            result,
                        });
                    }
                    HydratedContentBlock::Image(image) => {
                        ordered.push(NativeOrderedFact::Media {
                            provenance,
                            message,
                            block_index,
                            image,
                        });
                    }
                    HydratedContentBlock::Text { .. }
                    | HydratedContentBlock::LargeText(_)
                    | HydratedContentBlock::Thinking { .. } => {}
                }
            }
        }

        for run in facts.runs() {
            if is_terminal_run_status(&run.status) {
                ordered.push(NativeOrderedFact::SnapshotTerminal {
                    provenance: NativeFactProvenance::SnapshotRun,
                    run,
                });
            }
        }
        for approval in facts.pending_approvals() {
            ordered.push(NativeOrderedFact::PendingApproval {
                provenance: NativeFactProvenance::SnapshotApproval,
                approval,
            });
        }
        append_event_facts(facts.snapshot_events(), &mut ordered);
        append_event_facts(facts.replay_events(), &mut ordered);

        NativeOrderedFacts {
            facts: ordered,
            replay_cursor: facts.replay_cursor(),
            replay_boundary_complete: facts.has_complete_replay_boundary(),
            transcript_source_order: transcript.has_source_order(),
            bounded_transcript: transcript.window().has_more() || transcript.window().has_newer(),
        }
    }
}

fn append_event_facts<'facts>(
    events: &'facts [NativeEventFact],
    ordered: &mut Vec<NativeOrderedFact<'facts>>,
) {
    for event in events {
        let provenance = match event.source() {
            NativeEventSource::Snapshot => NativeFactProvenance::SnapshotEvent {
                sequence: event.sequence(),
            },
            NativeEventSource::Replay => NativeFactProvenance::ReplayEvent {
                sequence: event.sequence(),
            },
        };
        match event.activity() {
            EventActivity::Message(_) => {
                ordered.push(NativeOrderedFact::EventMessage { provenance, event });
            }
            EventActivity::Tool(_) => {
                ordered.push(NativeOrderedFact::EventTool { provenance, event });
            }
            EventActivity::Approval(_) => {
                ordered.push(NativeOrderedFact::ApprovalEvent { provenance, event });
            }
            EventActivity::RunFailed { .. } => {
                ordered.push(NativeOrderedFact::TerminalEvent { provenance, event });
            }
            EventActivity::Run(lifecycle) if is_terminal_lifecycle(*lifecycle) => {
                ordered.push(NativeOrderedFact::TerminalEvent { provenance, event });
            }
            EventActivity::Run(_) | EventActivity::Ignored => {}
        }
    }
}

fn is_terminal_lifecycle(lifecycle: RunLifecycle) -> bool {
    matches!(
        lifecycle,
        RunLifecycle::Cancelled | RunLifecycle::Completed | RunLifecycle::Interrupted
    )
}

fn is_terminal_run_status(status: &RunStatus) -> bool {
    matches!(
        status,
        RunStatus::Completed { .. }
            | RunStatus::Cancelled { .. }
            | RunStatus::Failed { .. }
            | RunStatus::Interrupted { .. }
    )
}

/// Status of one integration-local native fact read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeFactStatus {
    Complete,
    Incomplete,
    Unavailable,
    Unknown,
}

/// A source-backed fact read. `Incomplete` retains only facts that were
/// actually observed and names the producer or guarantee still missing.
#[derive(Clone, PartialEq)]
pub enum NativeFactRead<T> {
    Complete(T),
    Incomplete {
        facts: T,
        gaps: &'static [ProjectionGap],
    },
    Unavailable,
    Unknown,
}

impl<T> NativeFactRead<T> {
    pub const fn status(&self) -> NativeFactStatus {
        match self {
            Self::Complete(_) => NativeFactStatus::Complete,
            Self::Incomplete { .. } => NativeFactStatus::Incomplete,
            Self::Unavailable => NativeFactStatus::Unavailable,
            Self::Unknown => NativeFactStatus::Unknown,
        }
    }

    pub fn facts(&self) -> Option<&T> {
        match self {
            Self::Complete(facts) | Self::Incomplete { facts, .. } => Some(facts),
            Self::Unavailable | Self::Unknown => None,
        }
    }

    pub fn gaps(&self) -> Option<&[ProjectionGap]> {
        match self {
            Self::Incomplete { gaps, .. } => Some(gaps),
            Self::Complete(_) | Self::Unavailable | Self::Unknown => None,
        }
    }
}

impl<T: fmt::Debug> fmt::Debug for NativeFactRead<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Complete(facts) => formatter
                .debug_struct("Complete")
                .field("facts", facts)
                .finish(),
            Self::Incomplete { facts, gaps } => formatter
                .debug_struct("Incomplete")
                .field("facts", facts)
                .field("gap_count", &gaps.len())
                .finish(),
            Self::Unavailable => formatter.write_str("Unavailable"),
            Self::Unknown => formatter.write_str("Unknown"),
        }
    }
}

/// A public Renderer field that is not yet producible from Matcha native facts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionField {
    Catalog,
    Identity,
    Items,
    AssistantTurns,
    Tools,
    Approvals,
    Usage,
    Artifacts,
    ContextTokens,
    TaskSnapshot,
    Runtime,
    Window,
    ReplayCompleteness,
}

/// The typed producer required for one missing Renderer field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionProducer {
    SessionCatalogFacts,
    RendererItemAssembler,
    ApprovalDetailsFacts,
    UsageEventHistoryFacts,
    ArtifactFacts,
    ContextTokenFacts,
    TaskSnapshotFacts,
    RuntimeStateFacts,
    RendererWindowAssembler,
    ReplayCompletenessFacts,
}

/// Why a source-backed native fact cannot satisfy a Renderer field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionGapReason {
    SourceUnavailable,
    SourceUnknown,
    Native,
    NotProduced,
}

/// An owner-local, field-level incompleteness reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProjectionGap {
    field: ProjectionField,
    producer: ProjectionProducer,
    reason: ProjectionGapReason,
}

impl ProjectionGap {
    const fn new(
        field: ProjectionField,
        producer: ProjectionProducer,
        reason: ProjectionGapReason,
    ) -> Self {
        Self {
            field,
            producer,
            reason,
        }
    }

    pub const fn field(self) -> ProjectionField {
        self.field
    }

    pub const fn producer(self) -> ProjectionProducer {
        self.producer
    }

    pub const fn reason(self) -> ProjectionGapReason {
        self.reason
    }
}

const PROJECTION_GAPS: &[ProjectionGap] = &[
    ProjectionGap::new(
        ProjectionField::Items,
        ProjectionProducer::RendererItemAssembler,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::AssistantTurns,
        ProjectionProducer::RendererItemAssembler,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::Tools,
        ProjectionProducer::RendererItemAssembler,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::Approvals,
        ProjectionProducer::ApprovalDetailsFacts,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::Usage,
        ProjectionProducer::UsageEventHistoryFacts,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::Artifacts,
        ProjectionProducer::ArtifactFacts,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::ContextTokens,
        ProjectionProducer::ContextTokenFacts,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::TaskSnapshot,
        ProjectionProducer::TaskSnapshotFacts,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::Runtime,
        ProjectionProducer::RuntimeStateFacts,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::Window,
        ProjectionProducer::RendererWindowAssembler,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        ProjectionField::ReplayCompleteness,
        ProjectionProducer::ReplayCompletenessFacts,
        ProjectionGapReason::NotProduced,
    ),
];

/// A read-only, reconstructable view over one `NativeSessionFacts` owner.
///
/// The projection owns no shadow state and retains no native event payload. It
/// only borrows already validated native facts; a new view can be reconstructed
/// from the same facts at any time.
#[derive(Clone, Copy)]
pub struct NativeSessionProjection<'facts> {
    facts: &'facts NativeSessionFacts,
}

impl<'facts> NativeSessionProjection<'facts> {
    /// Creates the native projection from the sole facts owner.
    pub fn from_facts(facts: &'facts NativeSessionFacts) -> Self {
        Self { facts }
    }

    /// The native catalog facts borrowed from the validated session record.
    pub fn catalog(&self) -> SessionCatalogFacts<'facts> {
        self.facts.catalog()
    }

    /// The native session identity.
    pub fn session_id(&self) -> &'facts SessionId {
        &self.facts.session().session_id
    }

    /// The validated native session record.
    pub fn session(&self) -> &'facts SessionRecord {
        self.facts.session()
    }

    pub fn snapshot_version(&self) -> u64 {
        self.facts.snapshot_version()
    }

    pub fn snapshot_updated_at(&self) -> &'facts str {
        self.facts.snapshot_updated_at()
    }

    /// The requested, bounded native transcript window.
    pub fn transcript(&self) -> &'facts HydrationSnapshot {
        self.facts.transcript()
    }

    pub fn transcript_messages(&self) -> &'facts [HydratedMessage] {
        self.transcript().messages()
    }

    pub fn transcript_window(&self) -> HydrationWindow {
        self.transcript().window()
    }

    /// Assembles the ordered native transcript, event, approval, and terminal
    /// facts without introducing a second owner or a Host sequence.
    pub fn ordered_facts(&self) -> NativeOrderedFacts<'facts> {
        NativeFactAssembler::assemble(self.facts)
    }

    pub fn runs(&self) -> &'facts [RunRecord] {
        self.facts.runs()
    }

    /// Opaque pending approval records; native prompt/tool/secret fields are
    /// intentionally not present in `ApprovalRecord`.
    pub fn pending_approvals(&self) -> &'facts [ApprovalRecord] {
        self.facts.pending_approvals()
    }

    pub fn usage(&self) -> Option<UsageSummary> {
        self.facts.usage()
    }

    pub fn native_worker_state(&self) -> &'facts WorkerRuntimeState {
        &self.session().worker_state
    }

    /// Returns only a run id explicitly present in native worker state.
    pub fn native_active_run_id(&self) -> Option<&'facts RunId> {
        match self.native_worker_state() {
            WorkerRuntimeState::Running { run_id, .. }
            | WorkerRuntimeState::WaitingForApproval { run_id, .. } => Some(run_id),
            WorkerRuntimeState::Unloaded { .. }
            | WorkerRuntimeState::Spawning { .. }
            | WorkerRuntimeState::Ready { .. }
            | WorkerRuntimeState::Stopping { .. }
            | WorkerRuntimeState::Crashed { .. } => None,
        }
    }

    /// Typed facts projected from events present in the native snapshot.
    pub fn snapshot_events(&self) -> &'facts [NativeEventFact] {
        self.facts.snapshot_events()
    }

    /// Typed facts projected from the native replay response.
    pub fn replay_events(&self) -> &'facts [NativeEventFact] {
        self.facts.replay_events()
    }

    /// Native replay event count reported by the peer, not a transcript count.
    pub fn replay_event_count(&self) -> usize {
        self.facts.replay_event_count()
    }

    pub fn replay_boundary(&self) -> crate::session::facts::NativeReplayBoundary {
        self.facts.replay_boundary()
    }

    pub fn has_complete_replay_boundary(&self) -> bool {
        self.facts.has_complete_replay_boundary()
    }

    /// The session-bound native event-recovery cursor.
    pub fn replay_cursor(&self) -> &'facts EventRecoveryCursor {
        self.facts.replay_cursor()
    }

    /// Whether the native cursor reached the native session `last_seq`.
    ///
    /// This is only native replay alignment. It must not be serialized as a
    /// completed Renderer snapshot because the transcript remains bounded and
    /// the full Renderer replay model is still a declared gap.
    pub fn native_replay_reached_snapshot(&self) -> bool {
        self.replay_cursor().sequence() == self.session().last_seq
    }

    /// Dependencies that remain before a full Renderer `SessionStateSnapshot`
    /// can be produced. No gap is filled with a default value here.
    pub const fn projection_gaps() -> &'static [ProjectionGap] {
        PROJECTION_GAPS
    }

    /// Native facts alone cannot produce the full Renderer snapshot.
    pub const fn can_build_renderer_snapshot() -> bool {
        false
    }
}

/// The typed native facts that are available for a snapshot attempt.
///
/// This is an integration-local projection, not the public Renderer DTO. Every
/// value is borrowed from `NativeSessionFacts`; no raw event envelope or native
/// payload is retained and no missing Renderer field is represented by a
/// fabricated empty/false/null value.
pub type NativeSnapshotAvailable<'facts> = NativeSessionProjection<'facts>;

/// The result of attempting to assemble a Renderer snapshot from native facts.
///
/// Matcha currently has no native producers for the missing Renderer fields, so
/// this result intentionally has no complete variant. Consumers must inspect
/// the typed native availability and the exact owner-local gaps.
pub enum SnapshotAssembly<'facts> {
    Incomplete {
        available: NativeSnapshotAvailable<'facts>,
        gaps: &'static [ProjectionGap],
    },
}

impl<'facts> SnapshotAssembly<'facts> {
    pub fn available(&self) -> &NativeSnapshotAvailable<'facts> {
        match self {
            Self::Incomplete { available, .. } => available,
        }
    }

    pub fn projection(&self) -> &NativeSnapshotAvailable<'facts> {
        self.available()
    }

    pub const fn gaps(&self) -> &'static [ProjectionGap] {
        match self {
            Self::Incomplete { gaps, .. } => gaps,
        }
    }

    pub const fn is_incomplete(&self) -> bool {
        true
    }
}

impl fmt::Debug for SnapshotAssembly<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SnapshotAssembly::Incomplete")
            .field("gap_count", &self.gaps().len())
            .field("available", self.available())
            .finish()
    }
}

/// Integration-owned assembler for the native snapshot projection seam.
#[derive(Clone, Copy, Debug, Default)]
pub struct SnapshotAssembler;

impl SnapshotAssembler {
    pub const fn new() -> Self {
        Self
    }

    pub const fn projection_gaps() -> &'static [ProjectionGap] {
        PROJECTION_GAPS
    }

    pub const fn can_build_renderer_snapshot() -> bool {
        false
    }

    pub fn assemble<'facts>(facts: &'facts NativeSessionFacts) -> SnapshotAssembly<'facts> {
        SnapshotAssembly::Incomplete {
            available: NativeSessionProjection::from_facts(facts),
            gaps: Self::projection_gaps(),
        }
    }
}

impl fmt::Debug for NativeSessionProjection<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeSessionProjection")
            .field("snapshot_version", &self.snapshot_version())
            .field("run_count", &self.runs().len())
            .field("pending_approval_count", &self.pending_approvals().len())
            .field(
                "transcript_message_count",
                &self.transcript().messages().len(),
            )
            .field("snapshot_event_count", &self.snapshot_events().len())
            .field("replay_event_count", &self.replay_event_count())
            .field("replay_cursor", &self.replay_cursor())
            .field(
                "native_replay_reached_snapshot",
                &self.native_replay_reached_snapshot(),
            )
            .field("projection_gap_count", &PROJECTION_GAPS.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::session::{
        client::{EventReplay, EventReplayPayload},
        hydration::{HydrationSnapshot, HydrationWindow},
        model::{
            EventId, RunId, RunStatus, RuntimeKind, Sequence, SessionSnapshot, StopReason,
            UnloadedReason, WorkerRuntimeState,
        },
        protocol_event::{Event, EventEnvelope},
    };

    fn id(value: &str) -> SessionId {
        SessionId::try_new(value).unwrap()
    }

    fn event_id(value: &str) -> EventId {
        EventId::try_new(value).unwrap()
    }

    fn run_id(value: &str) -> RunId {
        RunId::try_new(value).unwrap()
    }

    fn envelope(
        event_id_value: &str,
        session_id: &str,
        sequence: u64,
        event: serde_json::Value,
    ) -> EventEnvelope {
        EventEnvelope {
            event_id: event_id(event_id_value),
            session_id: id(session_id),
            seq: Sequence::try_new(sequence).unwrap(),
            run_id: Some(run_id("run-native")),
            worker_id: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            event: Event::try_new(event).unwrap(),
        }
    }

    fn complete_native_facts() -> NativeSessionFacts {
        let session_id = id("session-native");
        let session = SessionRecord {
            session_id: session_id.clone(),
            created_at: "created-at".into(),
            updated_at: "updated-at".into(),
            title: Some("title".into()),
            runtime: RuntimeKind::MatchaAgent,
            transcript_ref: None,
            has_conversation: Some(true),
            last_seq: Sequence::try_new(2).unwrap(),
            last_snapshot_version: 7,
            model: Some("model".into()),
            model_selection_id: Some("model-selection".into()),
            provider_fingerprint: Some("provider-fingerprint".into()),
            permission_mode: Some("default".into()),
            worker_state: WorkerRuntimeState::Unloaded {
                reason: UnloadedReason::NotStarted,
            },
        };
        let pending_approval: ApprovalRecord = serde_json::from_value(json!({
            "approvalId": "approval-native",
            "options": [{"optionId": "option-native", "kind": "allow_once"}],
            "status": {"type": "pending"}
        }))
        .unwrap();
        let snapshot_event = envelope(
            "snapshot-event",
            "session-native",
            1,
            json!({
                "type": "message.delta",
                "messageId": "message-snapshot",
                "delta": "snapshot payload must not enter projection debug"
            }),
        );
        let replay_event = envelope(
            "replay-event",
            "session-native",
            2,
            json!({
                "type": "message.delta",
                "messageId": "message-replay",
                "delta": "replay payload must not enter projection debug"
            }),
        );
        let snapshot = SessionSnapshot {
            session: session.clone(),
            version: 7,
            updated_at: "snapshot-updated".into(),
            runs: vec![RunRecord {
                run_id: run_id("run-native"),
                session_id: session_id.clone(),
                prompt_id: "prompt-native".into(),
                status: RunStatus::Completed {
                    completed_at: "completed-at".into(),
                    stop_reason: StopReason::EndTurn,
                },
            }],
            messages: vec![snapshot_event],
            pending_approvals: vec![pending_approval],
            usage: Some(UsageSummary {
                input_tokens: 11,
                output_tokens: 13,
                cached_read_tokens: 17,
                cached_write_tokens: 19,
                total_tokens: 60,
            }),
        };
        NativeSessionFacts::from_native(
            session,
            snapshot,
            HydrationSnapshot::new(Vec::new(), HydrationWindow::new(4, 2, 4)),
            EventReplayPayload::new(
                EventReplay::new(1, Sequence::try_new(2).unwrap()),
                vec![replay_event],
            ),
        )
        .unwrap()
    }

    #[test]
    fn reads_native_identity_cursor_usage_approval_and_event_facts() {
        let facts = complete_native_facts();
        let projection = NativeSessionProjection::from_facts(&facts);

        assert_eq!(projection.session_id().as_str(), "session-native");
        assert_eq!(projection.session().last_seq.get(), 2);
        assert_eq!(projection.snapshot_version(), 7);
        assert_eq!(projection.transcript().window().total_item_count(), 4);
        assert_eq!(projection.runs().len(), 1);
        assert_eq!(projection.pending_approvals().len(), 1);
        assert_eq!(
            projection.pending_approvals()[0].approval_id().as_str(),
            "approval-native"
        );
        assert_eq!(projection.usage().unwrap().total_tokens, 60);
        assert_eq!(projection.snapshot_events().len(), 1);
        assert_eq!(projection.replay_events().len(), 1);
        assert_eq!(projection.replay_event_count(), 1);
        assert_eq!(projection.replay_cursor().sequence().get(), 2);
        assert!(projection.native_replay_reached_snapshot());

        let debug = format!("{projection:?}");
        for secret in [
            "snapshot payload must not enter projection debug",
            "replay payload must not enter projection debug",
            "approval-native",
            "option-native",
            "session-native",
        ] {
            assert!(!debug.contains(secret), "projection debug leaked {secret}");
        }
    }

    #[test]
    fn declares_required_renderer_gaps_without_claiming_snapshot_completion() {
        let gaps = SnapshotAssembler::projection_gaps();
        assert!(!gaps.iter().any(|gap| {
            matches!(
                gap.field(),
                ProjectionField::Catalog | ProjectionField::Identity
            )
        }));
        for required in [
            ProjectionField::Items,
            ProjectionField::AssistantTurns,
            ProjectionField::Tools,
            ProjectionField::Approvals,
            ProjectionField::Usage,
            ProjectionField::Artifacts,
            ProjectionField::ContextTokens,
            ProjectionField::TaskSnapshot,
            ProjectionField::Runtime,
            ProjectionField::Window,
            ProjectionField::ReplayCompleteness,
        ] {
            assert!(
                gaps.iter().any(|gap| gap.field() == required),
                "missing gap: {required:?}"
            );
        }
        assert!(gaps.iter().any(|gap| {
            gap.field() == ProjectionField::Items
                && gap.producer() == ProjectionProducer::RendererItemAssembler
        }));
        assert!(!SnapshotAssembler::can_build_renderer_snapshot());
        assert!(!NativeSessionProjection::can_build_renderer_snapshot());
    }

    #[test]
    fn assembler_exposes_available_native_facts_and_keeps_renderer_snapshot_incomplete() {
        let facts = complete_native_facts();
        let assembly = SnapshotAssembler::assemble(&facts);
        assert!(assembly.is_incomplete());
        assert_eq!(assembly.available().session_id().as_str(), "session-native");
        assert_eq!(assembly.available().runs().len(), 1);
        assert_eq!(assembly.gaps(), SnapshotAssembler::projection_gaps());
        assert_eq!(assembly.projection().snapshot_version(), 7);
    }
}
