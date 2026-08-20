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
    const fn new(start: usize, end: usize) -> Self {
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
            WindowRange::new(
                anchor.saturating_sub(request.limit),
                anchor.saturating_add(request.limit).min(total),
            )
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
pub enum MessageContent {
    Text {
        text: String,
    },
    ToolUse {
        name: String,
        tool_call_id: Option<String>,
    },
    ToolResult {
        tool_name: Option<String>,
        tool_call_id: Option<String>,
        summary: Option<String>,
        is_error: Option<bool>,
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
pub struct Message {
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
            run_id,
            sequence,
            created_at,
            updated_at,
        }
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionWindow {
    messages: Vec<Message>,
    range: WindowRange,
    total_item_count: usize,
}

impl SessionWindow {
    pub(crate) fn new(messages: Vec<Message>, range: WindowRange, total_item_count: usize) -> Self {
        Self {
            messages,
            range,
            total_item_count,
        }
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub const fn range(&self) -> WindowRange {
        self.range
    }

    pub const fn total_item_count(&self) -> usize {
        self.total_item_count
    }
}
