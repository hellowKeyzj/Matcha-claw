use std::fmt;

const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 512;
const MAX_TIMESTAMP_BYTES: usize = 128;
const MAX_TOOL_NAME_BYTES: usize = 256;
const MAX_METADATA_KEYS: usize = 64;
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_MEDIA_REFERENCE_BYTES: usize = 2 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HydrationWindowMode {
    Latest,
    Older,
    Newer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HydrationWindowRequest {
    mode: HydrationWindowMode,
    limit: usize,
    offset: Option<usize>,
}

impl HydrationWindowRequest {
    pub const DEFAULT_LIMIT: usize = 80;
    pub const MAX_LIMIT: usize = 200;

    pub const fn latest() -> Self {
        Self {
            mode: HydrationWindowMode::Latest,
            limit: Self::DEFAULT_LIMIT,
            offset: None,
        }
    }

    pub fn new(mode: HydrationWindowMode, limit: usize, offset: Option<usize>) -> Self {
        Self {
            mode,
            limit: limit.min(Self::MAX_LIMIT),
            offset,
        }
    }

    pub const fn mode(self) -> HydrationWindowMode {
        self.mode
    }
    pub const fn limit(self) -> usize {
        self.limit
    }
    pub const fn offset(self) -> Option<usize> {
        self.offset
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HydrationWindow {
    total_item_count: usize,
    window_start_offset: usize,
    window_end_offset: usize,
    has_more: bool,
    has_newer: bool,
    is_at_latest: bool,
}

impl HydrationWindow {
    pub(crate) const fn new(
        total_item_count: usize,
        window_start_offset: usize,
        window_end_offset: usize,
    ) -> Self {
        Self {
            total_item_count,
            window_start_offset,
            window_end_offset,
            has_more: window_start_offset > 0,
            has_newer: window_end_offset < total_item_count,
            is_at_latest: window_end_offset == total_item_count,
        }
    }

    pub const fn total_item_count(self) -> usize {
        self.total_item_count
    }
    pub const fn window_start_offset(self) -> usize {
        self.window_start_offset
    }
    pub const fn window_end_offset(self) -> usize {
        self.window_end_offset
    }
    pub const fn has_more(self) -> bool {
        self.has_more
    }
    pub const fn has_newer(self) -> bool {
        self.has_newer
    }
    pub const fn is_at_latest(self) -> bool {
        self.is_at_latest
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HydratedMessageRole {
    User,
    Assistant,
    System,
}

#[derive(Clone, Eq, PartialEq)]
pub enum HydratedContentBlock {
    Text { text: String },
    Thinking { text: String },
    ToolUse(HydratedToolUse),
    ToolResult(HydratedToolResult),
    Image(HydratedImage),
}

#[derive(Clone, Eq, PartialEq)]
pub struct HydratedToolUse {
    tool_call_id: String,
    name: String,
    metadata: HydratedToolMetadata,
}

impl HydratedToolUse {
    pub(crate) fn new(tool_call_id: String, name: String, metadata: HydratedToolMetadata) -> Self {
        Self {
            tool_call_id,
            name,
            metadata,
        }
    }
    pub fn tool_call_id(&self) -> &str {
        &self.tool_call_id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn metadata(&self) -> &HydratedToolMetadata {
        &self.metadata
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct HydratedToolResult {
    tool_call_id: Option<String>,
    body: Option<String>,
    is_error: Option<bool>,
}

impl HydratedToolResult {
    pub(crate) fn new(
        tool_call_id: Option<String>,
        body: Option<String>,
        is_error: Option<bool>,
    ) -> Self {
        Self {
            tool_call_id,
            body,
            is_error,
        }
    }
    pub fn tool_call_id(&self) -> Option<&str> {
        self.tool_call_id.as_deref()
    }
    pub fn body(&self) -> Option<&str> {
        self.body.as_deref()
    }
    pub const fn is_error(&self) -> Option<bool> {
        self.is_error
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct HydratedImage {
    media_type: String,
    reference: String,
}

impl HydratedImage {
    pub(crate) fn new(media_type: String, reference: String) -> Self {
        Self {
            media_type,
            reference,
        }
    }
    pub fn media_type(&self) -> &str {
        &self.media_type
    }
    pub fn reference(&self) -> &str {
        &self.reference
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct HydratedToolMetadata {
    input_keys: Vec<String>,
}

impl HydratedToolMetadata {
    pub(crate) fn new(input_keys: Vec<String>) -> Self {
        Self { input_keys }
    }
    pub fn input_keys(&self) -> &[String] {
        &self.input_keys
    }
}

impl fmt::Debug for HydratedContentBlock {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("HydratedContentBlock");
        match self {
            Self::Text { text } => debug
                .field("kind", &"text")
                .field("text_bytes", &text.len()),
            Self::Thinking { text } => debug
                .field("kind", &"thinking")
                .field("text_bytes", &text.len()),
            Self::ToolUse(tool) => debug
                .field("kind", &"tool_use")
                .field("tool_call_id_bytes", &tool.tool_call_id.len())
                .field("name_bytes", &tool.name.len())
                .field("input_key_count", &tool.metadata.input_keys.len()),
            Self::ToolResult(result) => debug
                .field("kind", &"tool_result")
                .field("has_tool_call_id", &result.tool_call_id.is_some())
                .field("body_bytes", &result.body.as_ref().map_or(0, String::len))
                .field("is_error", &result.is_error),
            Self::Image(image) => debug
                .field("kind", &"image")
                .field("media_type", &image.media_type)
                .field("reference_bytes", &image.reference.len()),
        };
        debug.finish()
    }
}

impl fmt::Debug for HydratedToolUse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HydratedToolUse")
            .field("has_tool_call_id", &true)
            .field("name_bytes", &self.name.len())
            .field("input_key_count", &self.metadata.input_keys.len())
            .finish()
    }
}

impl fmt::Debug for HydratedToolResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HydratedToolResult")
            .field("has_tool_call_id", &self.tool_call_id.is_some())
            .field("body_bytes", &self.body.as_ref().map_or(0, String::len))
            .field("is_error", &self.is_error)
            .finish()
    }
}

impl fmt::Debug for HydratedImage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HydratedImage")
            .field("media_type", &self.media_type)
            .field("has_reference", &true)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct HydratedMessage {
    id: Option<String>,
    parent_id: Option<String>,
    timestamp: Option<String>,
    origin_message_id: Option<String>,
    /// The zero-based ordinal of this item in the peer transcript. It is set
    /// only when the transcript decoder observed the source order.
    source_index: Option<usize>,
    role: HydratedMessageRole,
    content: Vec<HydratedContentBlock>,
    tool_call_id: Option<String>,
}

impl HydratedMessage {
    pub(crate) fn with_source_index(mut self, source_index: usize) -> Self {
        self.source_index = Some(source_index);
        self
    }

    pub(crate) fn try_new(role: HydratedMessageRole, text: String) -> Result<Self, DecodeFailure> {
        let text = bounded_text(text).ok_or(DecodeFailure::TextTooLarge)?;
        Ok(Self {
            id: None,
            parent_id: None,
            timestamp: None,
            origin_message_id: None,
            source_index: None,
            role,
            content: vec![HydratedContentBlock::Text { text }],
            tool_call_id: None,
        })
    }

    pub(crate) fn try_from_parts(
        id: Option<String>,
        parent_id: Option<String>,
        timestamp: Option<String>,
        origin_message_id: Option<String>,
        role: HydratedMessageRole,
        content: Vec<HydratedContentBlock>,
        tool_call_id: Option<String>,
    ) -> Result<Self, DecodeFailure> {
        if content.is_empty() {
            return Err(DecodeFailure::EmptyContent);
        }
        Ok(Self {
            id,
            parent_id,
            timestamp,
            origin_message_id,
            source_index: None,
            role,
            content,
            tool_call_id,
        })
    }

    pub fn id(&self) -> Option<&str> {
        self.id.as_deref()
    }
    pub fn parent_id(&self) -> Option<&str> {
        self.parent_id.as_deref()
    }
    pub fn timestamp(&self) -> Option<&str> {
        self.timestamp.as_deref()
    }
    pub fn origin_message_id(&self) -> Option<&str> {
        self.origin_message_id.as_deref()
    }

    pub const fn source_index(&self) -> Option<usize> {
        self.source_index
    }

    pub const fn role(&self) -> HydratedMessageRole {
        self.role
    }
    pub fn content(&self) -> &[HydratedContentBlock] {
        &self.content
    }
    pub fn tool_call_id(&self) -> Option<&str> {
        self.tool_call_id.as_deref()
    }
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|block| match block {
                HydratedContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

impl fmt::Debug for HydratedMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HydratedMessage")
            .field("has_id", &self.id.is_some())
            .field("has_parent_id", &self.parent_id.is_some())
            .field("has_timestamp", &self.timestamp.is_some())
            .field("has_origin_message_id", &self.origin_message_id.is_some())
            .field("role", &self.role)
            .field("content_count", &self.content.len())
            .field("has_tool_call_id", &self.tool_call_id.is_some())
            .finish()
    }
}

pub(crate) fn bounded_identifier(value: &str) -> Option<String> {
    bounded_string(value, MAX_IDENTIFIER_BYTES)
}

pub(crate) fn bounded_timestamp(value: &str) -> Option<String> {
    bounded_string(value, MAX_TIMESTAMP_BYTES)
}

pub(crate) fn bounded_tool_name(value: &str) -> Option<String> {
    bounded_string(value, MAX_TOOL_NAME_BYTES)
}

pub(crate) fn bounded_text(value: String) -> Option<String> {
    bounded_string(&value, MAX_TEXT_BYTES).map(|_| value)
}

pub(crate) fn bounded_body(value: String) -> Option<String> {
    bounded_string(&value, MAX_BODY_BYTES).map(|_| value)
}

pub(crate) fn bounded_media_reference(value: &str) -> Option<String> {
    bounded_string(value, MAX_MEDIA_REFERENCE_BYTES)
}

pub(crate) const fn max_metadata_keys() -> usize {
    MAX_METADATA_KEYS
}

fn bounded_string(value: &str, max_bytes: usize) -> Option<String> {
    (!value.is_empty() && value.len() <= max_bytes && value.is_char_boundary(value.len()))
        .then(|| value.to_owned())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeFailure {
    InvalidJson,
    InvalidShape,
    UnsupportedRole,
    UnsafeContent,
    TextTooLarge,
    EmptyContent,
    TranscriptTooLarge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HydrationIncomplete {
    ReplayRecoveryRequired,
    ReplayIncomplete,
    TranscriptRejected,
    ConnectionInterrupted,
    SourceRejected,
    SourceUnavailable,
    ProtocolRejected,
    ConnectionCloseFailed,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HydrationResult {
    Complete(HydrationSnapshot),
    Incomplete(HydrationIncomplete),
}

#[derive(Clone, PartialEq)]
pub struct HydrationSnapshot {
    messages: Vec<HydratedMessage>,
    window: HydrationWindow,
}

impl HydrationSnapshot {
    pub(crate) fn new(messages: Vec<HydratedMessage>, window: HydrationWindow) -> Self {
        Self { messages, window }
    }

    pub fn messages(&self) -> &[HydratedMessage] {
        &self.messages
    }

    /// Messages are retained in the peer transcript order. Every decoded item
    /// has a source index; this accessor exposes the bounded ordered facts
    /// without creating a second transcript representation.
    pub fn ordered_messages(&self) -> &[HydratedMessage] {
        &self.messages
    }

    pub fn has_source_order(&self) -> bool {
        self.messages.iter().enumerate().all(|(index, message)| {
            message.source_index() == Some(self.window.window_start_offset() + index)
        })
    }

    pub const fn window(&self) -> HydrationWindow {
        self.window
    }
}

impl fmt::Debug for HydrationSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HydrationSnapshot")
            .field("message_count", &self.messages.len())
            .field("window", &self.window)
            .finish()
    }
}
