use std::collections::BTreeMap;

pub use platform::endpoint::runtime_address::SessionIdentity as BoardIdentity;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type BoardParams = BTreeMap<String, Value>;

// Native optional fields may be absent, but explicit null is not their wire value.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardChatDock {
    Left,
    Right,
    Bottom,
    Hidden,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardSize {
    Sm,
    Md,
    Lg,
    Xl,
    Full,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BoardWidgetPresentation {
    Card,
    FullBleed,
    Frameless,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardWidgetHeightMode {
    Auto,
    Fixed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardTab {
    pub tab_id: String,
    pub title: String,
    pub position: u64,
    pub chat_dock: BoardChatDock,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardWidgetDeclared {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub net_origins: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub tools: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum BoardGeneratedSource {
    #[serde(rename = "show_widget")]
    ShowWidget,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardWidgetGeneratedIdentity {
    pub source: BoardGeneratedSource,
    pub key: String,
    pub fallback_name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardMcpAppDescriptor {
    pub server_name: String,
    pub tool_name: String,
    pub ui_resource_uri: String,
    pub tool_call_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BoardWidgetPutContent {
    Html {
        html: String,
    },
    McpApp {
        view_id: String,
    },
    Plugin {
        plugin_kind: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        props: Option<BoardParams>,
    },
    Registered {
        content_kind: String,
        source: String,
    },
    CanvasDoc {
        doc_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BoardWidgetContentKind {
    Html,
    McpApp,
    Plugin,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BoardWidgetContentOwner {
    Html,
    McpApp,
    Plugin,
    Registered,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardGrantState {
    None,
    Pending,
    Granted,
    Rejected,
}

/// Native view URLs, tickets and sandbox metadata live only for this view; never persist them.
#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardWidget {
    pub name: String,
    pub tab_id: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<String>,
    pub content_kind: BoardWidgetContentKind,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub content_owner: Option<BoardWidgetContentOwner>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub registered_content_kind: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub plugin_kind: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub props: Option<BoardParams>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub presentation: Option<BoardWidgetPresentation>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub height_mode: Option<BoardWidgetHeightMode>,
    pub size_w: u64,
    pub size_h: u64,
    pub position: u64,
    pub grant_state: BoardGrantState,
    pub revision: u64,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub instance_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub declared_summary: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub declared: Option<BoardWidgetDeclared>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub frame_url: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub view_ticket: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub view_ticket_ttl_ms: Option<u64>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub view_generation: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub sandbox_url: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub sandbox_port: Option<u16>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub sandbox_origin: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub kind_label: Option<String>,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardSnapshot {
    pub session_key: String,
    pub revision: u64,
    pub tabs: Vec<BoardTab>,
    pub widgets: Vec<BoardWidget>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BoardOp {
    TabCreate {
        tab_id: String,
        title: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        chat_dock: Option<BoardChatDock>,
    },
    TabUpdate {
        tab_id: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        title: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        chat_dock: Option<BoardChatDock>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        position: Option<u64>,
    },
    TabDelete {
        tab_id: String,
    },
    TabsReorder {
        tab_ids: Vec<String>,
    },
    WidgetMove {
        name: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        tab_id: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        position: Option<u64>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        after: Option<String>,
    },
    WidgetResize {
        name: String,
        size_w: i64,
        size_h: i64,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        height_mode: Option<BoardWidgetHeightMode>,
    },
    WidgetRemove {
        name: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardWidgetPlacement {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub tab_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub size: Option<BoardSize>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub after: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardGrantDecision {
    Granted,
    Rejected,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum BoardMethod {
    #[serde(rename = "board.get")]
    Get,
    #[serde(rename = "board.update")]
    Update,
    #[serde(rename = "board.widget.put")]
    WidgetPut,
    #[serde(rename = "board.widget.grant")]
    WidgetGrant,
    #[serde(rename = "board.widget.appView")]
    WidgetAppView,
    #[serde(rename = "board.event")]
    Event,
    #[serde(rename = "board.prompt.authorize")]
    PromptAuthorize,
    #[serde(rename = "board.data.read")]
    DataRead,
    #[serde(rename = "board.action")]
    Action,
}

impl BoardMethod {
    pub const ALL: [Self; 9] = [
        Self::Get,
        Self::Update,
        Self::WidgetPut,
        Self::WidgetGrant,
        Self::WidgetAppView,
        Self::Event,
        Self::PromptAuthorize,
        Self::DataRead,
        Self::Action,
    ];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "board.get",
            Self::Update => "board.update",
            Self::WidgetPut => "board.widget.put",
            Self::WidgetGrant => "board.widget.grant",
            Self::WidgetAppView => "board.widget.appView",
            Self::Event => "board.event",
            Self::PromptAuthorize => "board.prompt.authorize",
            Self::DataRead => "board.data.read",
            Self::Action => "board.action",
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(tag = "method", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum BoardOperation {
    #[serde(rename = "board.get")]
    Get {},
    #[serde(rename = "board.update")]
    Update { ops: Vec<BoardOp> },
    #[serde(rename = "board.widget.put")]
    WidgetPut {
        name: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        title: Option<String>,
        content: BoardWidgetPutContent,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        presentation: Option<BoardWidgetPresentation>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        height_mode: Option<BoardWidgetHeightMode>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        placement: Option<BoardWidgetPlacement>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        declared: Option<BoardWidgetDeclared>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        generated_identity: Option<BoardWidgetGeneratedIdentity>,
    },
    #[serde(rename = "board.widget.grant")]
    WidgetGrant {
        name: String,
        decision: BoardGrantDecision,
        revision: u64,
        instance_id: String,
    },
    #[serde(rename = "board.widget.appView")]
    WidgetAppView {
        name: String,
        revision: u64,
        instance_id: String,
    },
    #[serde(rename = "board.event")]
    Event {
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        widget: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        ticket: Option<String>,
        payload: Value,
    },
    #[serde(rename = "board.prompt.authorize")]
    PromptAuthorize { ticket: String },
    #[serde(rename = "board.data.read")]
    DataRead {
        ticket: String,
        binding_id: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        params: Option<BoardParams>,
    },
    #[serde(rename = "board.action")]
    Action {
        ticket: String,
        action: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        job_id: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        params: Option<BoardParams>,
    },
}

impl BoardOperation {
    pub const fn method(&self) -> BoardMethod {
        match self {
            Self::Get {} => BoardMethod::Get,
            Self::Update { .. } => BoardMethod::Update,
            Self::WidgetPut { .. } => BoardMethod::WidgetPut,
            Self::WidgetGrant { .. } => BoardMethod::WidgetGrant,
            Self::WidgetAppView { .. } => BoardMethod::WidgetAppView,
            Self::Event { .. } => BoardMethod::Event,
            Self::PromptAuthorize { .. } => BoardMethod::PromptAuthorize,
            Self::DataRead { .. } => BoardMethod::DataRead,
            Self::Action { .. } => BoardMethod::Action,
        }
    }

    pub fn validate(&self) -> Result<(), BoardFailure> {
        crate::validation::operation(self)
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardWidgetPutResult {
    pub session_key: String,
    pub revision: u64,
    pub tabs: Vec<BoardTab>,
    pub widgets: Vec<BoardWidget>,
    pub resolved_widget_name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardWidgetAppViewResult {
    pub view_id: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BoardEventResult {
    pub ok: bool,
    pub appended: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardPromptAuthorization {
    pub confirmation_required: bool,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum BoardResult {
    Snapshot(BoardSnapshot),
    WidgetPut(BoardWidgetPutResult),
    AppView(BoardWidgetAppViewResult),
    Event(BoardEventResult),
    PromptAuthorization(BoardPromptAuthorization),
    Data(Value),
    Action(Value),
}

impl BoardResult {
    pub fn decode(method: BoardMethod, value: Value) -> Result<Self, BoardFailure> {
        let result = match method {
            BoardMethod::Get | BoardMethod::Update | BoardMethod::WidgetGrant => {
                serde_json::from_value(value).map(Self::Snapshot)
            }
            BoardMethod::WidgetPut => serde_json::from_value(value).map(Self::WidgetPut),
            BoardMethod::WidgetAppView => serde_json::from_value(value).map(Self::AppView),
            BoardMethod::Event => serde_json::from_value(value).map(Self::Event),
            BoardMethod::PromptAuthorize => {
                serde_json::from_value(value).map(Self::PromptAuthorization)
            }
            BoardMethod::DataRead => Ok(Self::Data(value)),
            BoardMethod::Action => Ok(Self::Action(value)),
        }
        .map_err(|_| BoardFailure::Unknown)?;
        crate::validation::result(&result)?;
        Ok(result)
    }

    pub fn matches_method(&self, method: BoardMethod) -> bool {
        matches!(
            (self, method),
            (
                Self::Snapshot(_),
                BoardMethod::Get | BoardMethod::Update | BoardMethod::WidgetGrant
            ) | (Self::WidgetPut(_), BoardMethod::WidgetPut)
                | (Self::AppView(_), BoardMethod::WidgetAppView)
                | (Self::Event(_), BoardMethod::Event)
                | (Self::PromptAuthorization(_), BoardMethod::PromptAuthorize)
                | (Self::Data(_), BoardMethod::DataRead)
                | (Self::Action(_), BoardMethod::Action)
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BoardFailure {
    Unsupported,
    Invalid,
    Forbidden,
    Stale,
    Expired,
    MissingSource,
    Unavailable,
    Unknown,
}

impl BoardFailure {
    pub const fn message(self) -> &'static str {
        match self {
            Self::Unsupported => "Board is not supported by this runtime",
            Self::Invalid => "Board request is invalid",
            Self::Forbidden => "Board operation is not authorized",
            Self::Stale => "Board widget has changed; refresh and try again",
            Self::Expired => "Board view has expired; refresh the board",
            Self::MissingSource => "Board widget source is no longer available",
            Self::Unavailable => "Board runtime is unavailable",
            Self::Unknown => "Board operation outcome is unknown",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BoardCommand {
    FocusTab { tab_id: String },
    SetChatDock { dock: BoardChatDock },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardChangedEvent {
    pub identity: BoardIdentity,
    pub revision: u64,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub widget: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCommandEvent {
    pub identity: BoardIdentity,
    pub command: BoardCommand,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "event", rename_all = "lowercase")]
pub enum BoardEvent {
    Changed(BoardChangedEvent),
    Command(BoardCommandEvent),
}

impl BoardEvent {
    pub fn identity(&self) -> &BoardIdentity {
        match self {
            Self::Changed(event) => &event.identity,
            Self::Command(event) => &event.identity,
        }
    }
}
