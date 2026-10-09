use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Latest,
    Older,
    Newer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageRequest {
    direction: Direction,
    limit: usize,
    offset: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageMetadata {
    offset: usize,
    total_messages: usize,
    next_offset: Option<usize>,
    has_more: Option<bool>,
}

impl PageMetadata {
    pub const fn new(
        offset: usize,
        total_messages: usize,
        next_offset: Option<usize>,
        has_more: Option<bool>,
    ) -> Self {
        Self {
            offset,
            total_messages,
            next_offset,
            has_more,
        }
    }

    pub const fn offset(self) -> usize {
        self.offset
    }

    pub const fn total_messages(self) -> usize {
        self.total_messages
    }

    pub const fn next_offset(self) -> Option<usize> {
        self.next_offset
    }

    pub const fn has_more(self) -> Option<bool> {
        self.has_more
    }
}

impl PageRequest {
    pub const DEFAULT_LIMIT: usize = 80;
    pub const MAX_LIMIT: usize = 200;

    pub const fn new(direction: Direction, limit: usize, offset: Option<usize>) -> Option<Self> {
        if limit > Self::MAX_LIMIT {
            return None;
        }
        if matches!(direction, Direction::Latest) && offset.is_some() {
            return None;
        }
        Some(Self {
            direction,
            limit,
            offset,
        })
    }

    pub const fn latest() -> Self {
        Self {
            direction: Direction::Latest,
            limit: Self::DEFAULT_LIMIT,
            offset: None,
        }
    }

    pub const fn direction(self) -> Direction {
        self.direction
    }

    pub const fn limit(self) -> usize {
        self.limit
    }

    pub const fn offset(self) -> Option<usize> {
        self.offset
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowRange {
    start: usize,
    end: usize,
}

impl WindowRange {
    pub(crate) const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    pub const fn start(self) -> usize {
        self.start
    }

    pub const fn end(self) -> usize {
        self.end
    }
}

pub fn window_range(total: usize, request: PageRequest) -> WindowRange {
    if request.limit == 0 {
        let point = match request.direction {
            Direction::Latest => total,
            Direction::Older | Direction::Newer => request.offset.unwrap_or(total).min(total),
        };
        return WindowRange::new(point, point);
    }

    match request.direction {
        Direction::Latest => WindowRange::new(total.saturating_sub(request.limit), total),
        Direction::Older => {
            let anchor = request.offset.unwrap_or(total).min(total);
            WindowRange::new(anchor.saturating_sub(request.limit), anchor)
        }
        Direction::Newer => {
            let start = request.offset.unwrap_or(total).min(total);
            WindowRange::new(start, start.saturating_add(request.limit).min(total))
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
    ToolResult,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OmittedContentKind {
    Thinking,
    Unknown,
    UnsafeMedia,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageToolDeliveryMedia {
    media_type: Option<String>,
    reference: String,
}

impl MessageToolDeliveryMedia {
    pub(crate) fn new(media_type: Option<String>, reference: String) -> Self {
        Self {
            media_type,
            reference,
        }
    }

    pub fn media_type(&self) -> Option<&str> {
        self.media_type.as_deref()
    }

    pub fn reference(&self) -> &str {
        &self.reference
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MessageContent {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolUse {
        name: String,
        tool_call_id: Option<String>,
        input: Option<serde_json::Value>,
        input_text: Option<String>,
    },
    ToolResult {
        tool_name: Option<String>,
        tool_call_id: Option<String>,
        summary: Option<String>,
        output: Option<serde_json::Value>,
        details: Option<serde_json::Value>,
        is_error: Option<bool>,
    },
    MessageToolDelivery {
        text: Option<String>,
        media: Vec<MessageToolDeliveryMedia>,
    },
    Media {
        media_type: Option<String>,
        reference: Option<String>,
        bytes: Option<usize>,
    },
    Omitted {
        kind: OmittedContentKind,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisplayPosition {
    pub source: String,
    pub raw_seq: u64,
    pub activity: Option<ActivityPosition>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityPosition {
    pub after_raw_seq: Option<u64>,
    pub scope_id: String,
    pub start_order: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StreamFallbackSource {
    Segment,
    Current,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamFallback {
    pub source: StreamFallbackSource,
    pub replacement_text: String,
    pub item_id: Option<String>,
    pub run_id: Option<String>,
    pub after_boundary_run_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LargeTextFacts {
    pub text: String,
    pub content_ref: String,
    pub total_bytes: u64,
    pub loaded_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Message {
    role: MessageRole,
    text: String,
    content: Vec<MessageContent>,
    message_id: Option<String>,
    parent_id: Option<String>,
    origin: Option<String>,
    tool_call_id: Option<String>,
    run_id: Option<String>,
    identity_run_id: Option<String>,
    identity_message_id: Option<String>,
    identity_sequence: Option<u64>,
    steer_target_run_id: Option<String>,
    after_sequence: Option<Option<u64>>,
    sequence: Option<u64>,
    created_at: Option<u64>,
    updated_at: Option<u64>,
    display_position: Option<DisplayPosition>,
    stream_fallback: Option<StreamFallback>,
    has_active_run: Option<bool>,
    event_run_id: Option<String>,
    event_client_run_id: Option<String>,
    has_send_identity: bool,
    import_sequence_proven: bool,
    terminal_reply_signature: Option<String>,
    mirror_origin: Option<String>,
    run_terminal: bool,
    is_imported: bool,
    hidden_control_reply: bool,
    truncated: bool,
    large_text: Option<LargeTextFacts>,
}

impl Message {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        role: MessageRole,
        text: String,
        content: Vec<MessageContent>,
        message_id: Option<String>,
        parent_id: Option<String>,
        origin: Option<String>,
        tool_call_id: Option<String>,
        run_id: Option<String>,
        sequence: Option<u64>,
        created_at: Option<u64>,
        updated_at: Option<u64>,
    ) -> Self {
        Self {
            role,
            text,
            content,
            message_id,
            parent_id,
            origin,
            tool_call_id,
            identity_run_id: None,
            identity_message_id: None,
            identity_sequence: None,
            steer_target_run_id: None,
            after_sequence: None,
            run_id,
            sequence,
            created_at,
            updated_at,
            display_position: None,
            stream_fallback: None,
            has_active_run: None,
            event_run_id: None,
            event_client_run_id: None,
            has_send_identity: false,
            import_sequence_proven: false,
            terminal_reply_signature: None,
            mirror_origin: None,
            run_terminal: false,
            is_imported: false,
            hidden_control_reply: false,
            truncated: false,
            large_text: None,
        }
    }

    pub(crate) fn with_identity(
        mut self,
        message_id: Option<String>,
        run_id: Option<String>,
        sequence: Option<u64>,
        after_sequence: Option<Option<u64>>,
    ) -> Self {
        self.identity_message_id = message_id;
        self.identity_run_id = run_id;
        self.identity_sequence = sequence;
        self.after_sequence = after_sequence;
        self
    }

    pub(crate) fn with_terminal_text(mut self, text: String, after_sequence: Option<u64>) -> Self {
        self.text = text;
        let mut replaced = false;
        self.content.retain_mut(|block| {
            if let MessageContent::Text { text } = block {
                if replaced { return false; }
                *text = self.text.clone();
                replaced = true;
            }
            true
        });
        self.after_sequence = Some(after_sequence);
        self
    }

    pub(crate) fn identity_message_id(&self) -> Option<&str> { self.identity_message_id.as_deref() }
    pub(crate) fn identity_run_id(&self) -> Option<&str> { self.identity_run_id.as_deref() }
    pub(crate) const fn identity_sequence(&self) -> Option<u64> { self.identity_sequence }
    pub(crate) const fn after_sequence(&self) -> Option<Option<u64>> { self.after_sequence }

    pub(crate) fn with_event_facts(mut self, event_run_id: Option<String>, event_client_run_id: Option<String>, has_send_identity: bool, import_sequence_proven: bool, terminal_reply_signature: Option<String>) -> Self {
        self.event_run_id = event_run_id;
        self.event_client_run_id = event_client_run_id;
        self.has_send_identity = has_send_identity;
        self.import_sequence_proven = import_sequence_proven;
        self.terminal_reply_signature = terminal_reply_signature;
        self
    }

    pub(crate) fn event_run_id(&self) -> Option<&str> { self.event_run_id.as_deref() }
    pub(crate) fn event_client_run_id(&self) -> Option<&str> { self.event_client_run_id.as_deref() }
    pub(crate) const fn has_send_identity(&self) -> bool { self.has_send_identity }
    pub(crate) const fn import_sequence_proven(&self) -> bool { self.import_sequence_proven }
    pub(crate) fn terminal_reply_signature(&self) -> Option<&str> { self.terminal_reply_signature.as_deref() }

    pub(crate) fn steer_target_run_id(&self) -> Option<&str> { self.steer_target_run_id.as_deref() }

    pub(crate) fn with_steer_target_run_id(mut self, run_id: Option<String>) -> Self {
        self.steer_target_run_id = run_id;
        self
    }

    pub(crate) fn with_projection_state(
        mut self,
        has_active_run: Option<bool>,
        mirror_origin: Option<String>,
        run_terminal: bool,
    ) -> Self {
        self.has_active_run = has_active_run;
        self.mirror_origin = mirror_origin;
        self.run_terminal = run_terminal;
        self
    }

    pub const fn has_active_run(&self) -> Option<bool> {
        self.has_active_run
    }

    pub fn mirror_origin(&self) -> Option<&str> {
        self.mirror_origin.as_deref()
    }

    pub const fn run_terminal(&self) -> bool {
        self.run_terminal
    }

    pub(crate) fn with_imported(mut self, is_imported: bool) -> Self {
        self.is_imported = is_imported;
        self
    }

    pub const fn is_imported(&self) -> bool { self.is_imported }

    pub(crate) fn with_hidden_control_reply(mut self, hidden: bool) -> Self {
        self.hidden_control_reply = hidden;
        self
    }

    pub const fn hidden_control_reply(&self) -> bool { self.hidden_control_reply }

    pub(crate) fn with_truncated(mut self, truncated: bool) -> Self {
        self.truncated = truncated;
        self
    }

    pub const fn truncated(&self) -> bool { self.truncated }

    pub fn large_text(&self) -> Option<&LargeTextFacts> { self.large_text.as_ref() }

    pub(crate) fn with_large_text(mut self, facts: LargeTextFacts) -> Self {
        self.text = facts.text.clone();
        let mut inserted = false;
        self.content.retain_mut(|block| {
            if let MessageContent::Text { text } = block {
                if inserted { return false; }
                *text = facts.text.clone();
                inserted = true;
            }
            true
        });
        self.large_text = Some(facts);
        self
    }

    pub(crate) fn with_display(
        mut self,
        position: Option<DisplayPosition>,
        fallback: Option<StreamFallback>,
    ) -> Self {
        self.display_position = position;
        self.stream_fallback = fallback;
        self
    }

    pub fn display_position(&self) -> Option<&DisplayPosition> {
        self.display_position.as_ref()
    }

    pub fn stream_fallback(&self) -> Option<&StreamFallback> {
        self.stream_fallback.as_ref()
    }

    pub fn display_item_id(&self) -> Option<&str> {
        (self.role == MessageRole::Assistant).then(|| self.stream_fallback.as_ref().and_then(|fallback| fallback.item_id.as_deref())).flatten()
    }

    pub const fn role(&self) -> MessageRole {
        self.role
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn content(&self) -> &[MessageContent] {
        &self.content
    }

    pub fn message_id(&self) -> Option<&str> {
        self.message_id.as_deref()
    }

    pub fn parent_id(&self) -> Option<&str> {
        self.parent_id.as_deref()
    }

    pub fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }

    pub fn tool_call_id(&self) -> Option<&str> {
        self.tool_call_id.as_deref()
    }

    pub fn run_id(&self) -> Option<&str> {
        self.run_id.as_deref()
    }

    pub const fn sequence(&self) -> Option<u64> {
        self.sequence
    }

    pub const fn created_at(&self) -> Option<u64> {
        self.created_at
    }

    pub const fn updated_at(&self) -> Option<u64> {
        self.updated_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunState {
    Queued,
    Started,
    WaitingForApproval,
    CancellationRequested,
    Cancelled,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InFlightRun {
    run_id: String,
    state: RunState,
    text: String,
}

impl InFlightRun {
    pub(crate) fn new(run_id: String, state: RunState) -> Self {
        Self { run_id, state, text: String::new() }
    }

    pub(crate) fn with_text(mut self, text: String) -> Self {
        self.text = text;
        self
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn state(&self) -> RunState {
        self.state
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PendingInputState {
    Queued,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingInput {
    input_id: Option<String>,
    run_id: Option<String>,
    state: PendingInputState,
}

impl PendingInput {
    pub(crate) fn new(
        input_id: Option<String>,
        run_id: Option<String>,
        state: PendingInputState,
    ) -> Self {
        Self {
            input_id,
            run_id,
            state,
        }
    }

    pub fn input_id(&self) -> Option<&str> {
        self.input_id.as_deref()
    }

    pub fn run_id(&self) -> Option<&str> {
        self.run_id.as_deref()
    }

    pub const fn state(&self) -> PendingInputState {
        self.state
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InputReceipt {
    input_id: Option<String>,
    run_id: Option<String>,
    consumed: bool,
}

impl InputReceipt {
    pub(crate) fn new(input_id: Option<String>, run_id: Option<String>, consumed: bool) -> Self {
        Self {
            input_id,
            run_id,
            consumed,
        }
    }

    pub fn input_id(&self) -> Option<&str> {
        self.input_id.as_deref()
    }

    pub fn run_id(&self) -> Option<&str> {
        self.run_id.as_deref()
    }

    pub const fn consumed(&self) -> bool {
        self.consumed
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionState {
    pending_inputs: Vec<PendingInput>,
    input_receipts: Vec<InputReceipt>,
    in_flight_run: Option<InFlightRun>,
    delta_cursor: Option<String>,
    complete_snapshot: Option<bool>,
    kind: HistoryKind,
    active_leaf_entry_id: Option<Option<String>>,
    status: Option<String>,
    has_active_run: Option<bool>,
    active_run_ids: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryKind {
    Full,
    Delta,
    Reset,
}

impl SessionState {
    pub(crate) fn new(
        pending_inputs: Vec<PendingInput>,
        input_receipts: Vec<InputReceipt>,
        in_flight_run: Option<InFlightRun>,
        delta_cursor: Option<String>,
        complete_snapshot: Option<bool>,
    ) -> Self {
        Self {
            pending_inputs,
            input_receipts,
            in_flight_run,
            delta_cursor,
            complete_snapshot,
            kind: HistoryKind::Full,
            active_leaf_entry_id: None,
            status: None,
            has_active_run: None,
            active_run_ids: None,
        }
    }

    pub(crate) fn with_history(mut self, kind: HistoryKind, active_leaf_entry_id: Option<Option<String>>) -> Self {
        self.kind = kind;
        self.active_leaf_entry_id = active_leaf_entry_id;
        self
    }

    pub(crate) fn with_activity(
        mut self,
        status: Option<String>,
        has_active_run: Option<bool>,
        active_run_ids: Option<Vec<String>>,
    ) -> Self {
        self.status = status;
        self.has_active_run = has_active_run;
        self.active_run_ids = active_run_ids;
        self
    }

    pub const fn has_active_run(&self) -> Option<bool> { self.has_active_run }

    pub fn active_run_ids(&self) -> Option<&[String]> { self.active_run_ids.as_deref() }

    pub fn is_active(&self) -> bool {
        if self.status.as_deref().is_some_and(|status| !status.is_empty() && status != "queued" && status != "running") {
            return false;
        }
        self.has_active_run.unwrap_or(matches!(self.status.as_deref(), Some("queued" | "running")))
    }

    pub const fn kind(&self) -> HistoryKind { self.kind }

    pub fn active_leaf_entry_id(&self) -> Option<&str> { self.active_leaf_scope().flatten() }

    pub(crate) fn active_leaf_scope(&self) -> Option<Option<&str>> {
        self.active_leaf_entry_id.as_ref().map(|leaf| leaf.as_deref())
    }

    pub fn pending_inputs(&self) -> &[PendingInput] {
        &self.pending_inputs
    }

    pub fn input_receipts(&self) -> &[InputReceipt] {
        &self.input_receipts
    }

    pub fn in_flight_run(&self) -> Option<&InFlightRun> {
        self.in_flight_run.as_ref()
    }

    pub fn delta_cursor(&self) -> Option<&str> {
        self.delta_cursor.as_deref()
    }

    pub const fn complete_snapshot(&self) -> Option<bool> {
        self.complete_snapshot
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionWindow {
    messages: Vec<Message>,
    range: WindowRange,
    total_item_count: usize,
    pagination: Option<PageMetadata>,
    session_key: Option<String>,
    native_session_id: Option<String>,
    state: SessionState,
}

impl SessionWindow {
    pub(crate) fn new(
        messages: Vec<Message>,
        range: WindowRange,
        total_item_count: usize,
        pagination: Option<PageMetadata>,
        session_key: Option<String>,
        native_session_id: Option<String>,
        state: SessionState,
    ) -> Self {
        Self {
            messages,
            range,
            total_item_count,
            pagination,
            session_key,
            native_session_id,
            state,
        }
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub(crate) fn messages_mut(&mut self) -> &mut [Message] { &mut self.messages }

    pub const fn range(&self) -> WindowRange {
        self.range
    }

    pub const fn total_item_count(&self) -> usize {
        self.total_item_count
    }

    pub const fn pagination(&self) -> Option<PageMetadata> {
        self.pagination
    }

    pub fn session_key(&self) -> Option<&str> {
        self.session_key.as_deref()
    }

    pub fn native_session_id(&self) -> Option<&str> {
        self.native_session_id.as_deref()
    }

    pub const fn state(&self) -> &SessionState {
        &self.state
    }
}

impl fmt::Debug for SessionWindow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionWindow")
            .field("message_count", &self.messages.len())
            .field("range", &self.range)
            .field("total_item_count", &self.total_item_count)
            .field("pagination", &self.pagination)
            .field("has_session_key", &self.session_key.is_some())
            .field("has_native_session_id", &self.native_session_id.is_some())
            .field("pending_input_count", &self.state.pending_inputs.len())
            .field("input_receipt_count", &self.state.input_receipts.len())
            .field("has_in_flight_run", &self.state.in_flight_run.is_some())
            .field("has_delta_cursor", &self.state.delta_cursor.is_some())
            .field("complete_snapshot", &self.state.complete_snapshot)
            .finish()
    }
}
