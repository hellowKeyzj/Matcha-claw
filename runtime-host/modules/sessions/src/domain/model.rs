use std::{
    collections::{HashSet, VecDeque, hash_map::DefaultHasher},
    fmt,
    hash::{Hash, Hasher},
    mem,
};

use organization::{GraphRunId, RoleId, RoleSessionRef, TeamId};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::Value;

pub const MAX_SESSION_KEY_BYTES: usize = 4096;
pub const MAX_ID_BYTES: usize = 256;
pub const MAX_CONTENT_REF_BYTES: usize = 512;
pub const MAX_TEXT_BYTES: usize = 128 * 1024;
pub const MAX_ITEMS: usize = 200;
pub const MAX_TOOLS: usize = 128;
pub const MAX_SEGMENTS: usize = 64;
pub const MAX_APPROVALS: usize = 32;
pub const MAX_CHANGE_COUNT: usize = 16;
pub const MAX_MISSING_FACTS: usize = 16;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_RENDERER_ROUTE_KEY_BYTES: usize = 128;
const MAX_ACCEPTED_EVENT_IDENTITIES: usize = 1024;
const OUTGOING_MEDIA_PREFIX: &str = "/api/chat/media/outgoing/";
const OUTGOING_MEDIA_PREFIX_WITHOUT_SLASH: &str = "api/chat/media/outgoing/";
const UNKNOWN_TOOL_ANCHOR_NAME: &str = "tool";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionStateError {
    InvalidIdentity,
    InvalidEpoch,
    InvalidCursor,
    InvalidFacts,
}

impl fmt::Display for SessionStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentity => "invalid session identity",
            Self::InvalidEpoch => "session epoch must be a non-zero safe integer",
            Self::InvalidCursor => "session cursor must be a safe integer",
            Self::InvalidFacts => "invalid session facts",
        })
    }
}

impl std::error::Error for SessionStateError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SessionProvider {
    #[serde(rename = "openclaw")]
    OpenClaw,
    #[serde(rename = "matcha-agent")]
    MatchaAgent,
}

impl SessionProvider {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
            Self::MatchaAgent => "matcha-agent",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionModelOverrideSource {
    User,
    Auto,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionModelIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub model: String,
    #[serde(rename = "ref")]
    pub model_ref: String,
}

impl SessionModelIdentity {
    pub fn try_new(
        provider: Option<String>,
        model: impl Into<String>,
        model_ref: impl Into<String>,
    ) -> Result<Self, SessionStateError> {
        let identity = Self {
            provider,
            model: model.into(),
            model_ref: model_ref.into(),
        };
        valid_session_model_identity(&identity)
            .then_some(identity)
            .ok_or(SessionStateError::InvalidFacts)
    }

    pub fn from_ref(model_ref: impl Into<String>) -> Result<Self, SessionStateError> {
        let model_ref = model_ref.into();
        Self::try_new(None, model_ref.clone(), model_ref)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionModelState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<SessionModelIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<SessionModelIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_source: Option<SessionModelOverrideSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_id: Option<String>,
}

impl SessionModelState {
    pub fn selected_ref(&self) -> Option<&str> {
        self.selected.as_ref().map(|model| model.model_ref.as_str())
    }

    pub fn selected_from_ref(model_ref: impl Into<String>) -> Result<Self, SessionStateError> {
        Ok(Self {
            selected: Some(SessionModelIdentity::from_ref(model_ref)?),
            active: None,
            override_source: None,
            selection_id: None,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionEndpoint {
    pub kind: String,
    pub runtime_adapter_id: SessionProvider,
    pub runtime_instance_id: String,
}

impl SessionEndpoint {
    pub fn new(
        kind: impl Into<String>,
        runtime_adapter_id: SessionProvider,
        runtime_instance_id: impl Into<String>,
    ) -> Result<Self, SessionStateError> {
        let endpoint = Self {
            kind: kind.into(),
            runtime_adapter_id,
            runtime_instance_id: runtime_instance_id.into(),
        };
        valid_endpoint(&endpoint)
            .then_some(endpoint)
            .ok_or(SessionStateError::InvalidIdentity)
    }

    pub fn local(provider: SessionProvider) -> Self {
        Self {
            kind: "native-runtime".to_owned(),
            runtime_adapter_id: provider,
            runtime_instance_id: "local".to_owned(),
        }
    }

    pub const fn provider(&self) -> SessionProvider {
        self.runtime_adapter_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionIdentity {
    pub session_key: String,
    pub endpoint: SessionEndpoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

impl SessionIdentity {
    pub fn new(
        session_key: impl Into<String>,
        provider: SessionProvider,
        agent_id: Option<String>,
    ) -> Option<Self> {
        Self::with_endpoint(session_key, SessionEndpoint::local(provider), agent_id).ok()
    }

    pub fn try_new(
        session_key: impl Into<String>,
        provider: SessionProvider,
        agent_id: Option<String>,
    ) -> Result<Self, SessionStateError> {
        Self::with_endpoint(session_key, SessionEndpoint::local(provider), agent_id)
    }

    pub fn with_endpoint(
        session_key: impl Into<String>,
        endpoint: SessionEndpoint,
        agent_id: Option<String>,
    ) -> Result<Self, SessionStateError> {
        let identity = Self {
            session_key: session_key.into(),
            endpoint,
            agent_id,
        };
        valid_identity(&identity)
            .then_some(identity)
            .ok_or(SessionStateError::InvalidIdentity)
    }

    pub fn session_key(&self) -> &str {
        &self.session_key
    }

    pub fn provider(&self) -> SessionProvider {
        self.endpoint.provider()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunPhase {
    Queued,
    Started,
    WaitingForApproval,
    CancellationRequested,
    Cancelled,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Pending,
    Streaming,
    WaitingForTool,
    Final,
    Error,
    Aborted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPhase {
    Started,
    Updated,
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPhase {
    Requested,
    Resolved,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionContent {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    LargeText {
        text: String,
        content_ref: String,
        total_bytes: u64,
        loaded_bytes: u64,
    },
    ToolUse {
        name: String,
        tool_call_id: String,
    },
    ToolResult {
        tool_call_id: String,
        summary: Option<String>,
        is_error: bool,
    },
    Media {
        media_type: Option<String>,
        reference: String,
    },
    Omitted {
        reason: OmissionReason,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OmissionReason {
    Thinking,
    UnsafeMedia,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionItem {
    UserMessage {
        item_id: String,
        message_id: Option<String>,
        text: String,
        content: Vec<SessionContent>,
        status: ItemStatus,
    },
    AssistantTurn {
        item_id: String,
        run_id: Option<String>,
        message_id: Option<String>,
        status: ItemStatus,
        segments: Vec<SessionContent>,
        text: String,
    },
    System {
        item_id: String,
        text: String,
        status: ItemStatus,
    },
}

impl SessionItem {
    pub fn item_id(&self) -> &str {
        match self {
            Self::UserMessage { item_id, .. }
            | Self::AssistantTurn { item_id, .. }
            | Self::System { item_id, .. } => item_id,
        }
    }

    fn run_id(&self) -> Option<&str> {
        match self {
            Self::AssistantTurn { run_id, .. } => run_id.as_deref(),
            Self::UserMessage { .. } | Self::System { .. } => None,
        }
    }

    fn message_id(&self) -> Option<&str> {
        match self {
            Self::UserMessage { message_id, .. } | Self::AssistantTurn { message_id, .. } => {
                message_id.as_deref()
            }
            Self::System { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolView {
    pub tool_call_id: String,
    pub run_id: Option<String>,
    pub name: Option<String>,
    pub phase: ToolPhase,
    pub input: Option<Value>,
    pub input_text: Option<String>,
    pub summary: Option<String>,
    pub output: Option<Value>,
    pub details: Option<Value>,
    pub is_error: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalView {
    pub approval_id: String,
    pub run_id: Option<String>,
    pub phase: ApprovalPhase,
    pub option_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeView {
    pub phase: RunPhase,
    pub active_run_id: Option<String>,
    pub issue: Option<RuntimeIssue>,
    pub run_progress: Option<RunProgress>,
    pub runtime_activity: Option<RuntimeActivity>,
    pub error_detail: Option<RuntimeErrorDetail>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeIssue {
    Unknown,
    Unavailable,
    Timeout,
    Rejected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunProgress {
    Startup { phase: RunStartupPhase },
    Retrying { attempt: u8, max_attempts: u8 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStartupPhase {
    PreparingWorkspace,
    NamingWorktree,
    CreatingWorktree,
    RunningSetup,
    ProvisioningEnvironment,
    PreparingContext,
    StartingModel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeActivity {
    Compacting,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeErrorKind {
    Fallback,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeErrorDetail {
    pub kind: RuntimeErrorKind,
    pub failover_reason: Option<String>,
    pub provider_runtime_failure_kind: Option<String>,
    pub provider_error_type: Option<String>,
    pub provider_error_message_preview: Option<String>,
    pub http_status: Option<u16>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeNotice {
    pub run_id: String,
    pub kind: RuntimeNoticeKind,
    pub command: Option<String>,
    pub risk_level: Option<String>,
    pub rationale: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeNoticeKind {
    GuardianReviewing,
    GuardianApproved,
    GuardianDenied,
    GuardianWarning,
    GuardianStrictReviewRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionWindow {
    pub total_item_count: u64,
    pub window_start_offset: u64,
    pub window_end_offset: u64,
    pub has_more: bool,
    pub has_newer: bool,
    pub is_at_latest: bool,
}

impl SessionWindow {
    pub const fn latest(item_count: u64) -> Self {
        Self {
            total_item_count: item_count,
            window_start_offset: 0,
            window_end_offset: item_count,
            has_more: false,
            has_newer: false,
            is_at_latest: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissingFact {
    SessionIdentity,
    Catalog,
    Usage,
    Artifacts,
    ContextTokens,
    Tasks,
    ReplayCursor,
    BoundedHistory,
    PartialRuntime,
    EventOnly,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionCompleteness {
    Complete,
    Incomplete { missing: Vec<MissingFact> },
    Unavailable,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionFact<T> {
    Complete(T),
    Incomplete { facts: T, gaps: Vec<MissingFact> },
    Unavailable,
    Unknown,
}

impl<T> SessionFact<T> {
    pub const fn unknown() -> Self {
        Self::Unknown
    }

    pub const fn unavailable() -> Self {
        Self::Unavailable
    }

    pub const fn is_complete(&self) -> bool {
        matches!(self, Self::Complete(_))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFacts {
    pub items: SessionFact<Vec<SessionItem>>,
    pub tools: SessionFact<Vec<ToolView>>,
    pub approvals: SessionFact<Vec<ApprovalView>>,
    pub runtime: SessionFact<RuntimeView>,
    pub window: SessionFact<SessionWindow>,
    pub completeness: SessionCompleteness,
}

impl SessionFacts {
    pub fn unknown() -> Self {
        Self {
            items: SessionFact::Unknown,
            tools: SessionFact::Unknown,
            approvals: SessionFact::Unknown,
            runtime: SessionFact::Unknown,
            window: SessionFact::Unknown,
            completeness: incomplete_without_native_facts(),
        }
    }

    pub fn validate(&self) -> Result<(), SessionStateError> {
        valid_facts(self)
            .then_some(())
            .ok_or(SessionStateError::InvalidFacts)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionView {
    pub session_key: String,
    pub endpoint_session_id: Option<String>,
    pub model_state: Option<SessionModelState>,
    pub identity: SessionIdentity,
    pub epoch: u64,
    pub seq: u64,
    pub cursor: u64,
    pub items: SessionFact<Vec<SessionItem>>,
    pub tools: SessionFact<Vec<ToolView>>,
    pub approvals: SessionFact<Vec<ApprovalView>>,
    pub runtime: SessionFact<RuntimeView>,
    pub window: SessionFact<SessionWindow>,
    pub completeness: SessionCompleteness,
}

impl Serialize for SessionView {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            session_key: &'a str,
            endpoint_session_id: Option<&'a str>,
            model_state: Option<&'a SessionModelState>,
            identity: &'a SessionIdentity,
            epoch: u64,
            seq: u64,
            cursor: u64,
            items: SessionFact<Vec<SessionItem>>,
            tools: SessionFact<Vec<ToolView>>,
            approvals: &'a SessionFact<Vec<ApprovalView>>,
            runtime: SessionFact<RuntimeView>,
            window: &'a SessionFact<SessionWindow>,
            completeness: &'a SessionCompleteness,
        }

        Wire {
            session_key: &self.session_key,
            endpoint_session_id: self.endpoint_session_id.as_deref(),
            model_state: self.model_state.as_ref(),
            identity: &self.identity,
            epoch: self.epoch,
            seq: self.seq,
            cursor: self.cursor,
            items: public_items_fact(&self.items),
            tools: public_tools_fact(&self.tools),
            approvals: &self.approvals,
            runtime: public_runtime_fact(&self.runtime),
            window: &self.window,
            completeness: &self.completeness,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SessionView {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            session_key: String,
            endpoint_session_id: Option<String>,
            model_state: Option<SessionModelState>,
            identity: SessionIdentity,
            epoch: u64,
            seq: u64,
            cursor: u64,
            items: SessionFact<Vec<SessionItem>>,
            tools: SessionFact<Vec<ToolView>>,
            approvals: SessionFact<Vec<ApprovalView>>,
            runtime: SessionFact<RuntimeView>,
            window: SessionFact<SessionWindow>,
            completeness: SessionCompleteness,
        }

        let wire = Wire::deserialize(deserializer)?;
        let view = Self {
            session_key: wire.session_key,
            endpoint_session_id: wire.endpoint_session_id,
            model_state: wire.model_state,
            identity: wire.identity,
            epoch: wire.epoch,
            seq: wire.seq,
            cursor: wire.cursor,
            items: wire.items,
            tools: wire.tools,
            approvals: wire.approvals,
            runtime: wire.runtime,
            window: wire.window,
            completeness: wire.completeness,
        };
        view.validate().map_err(D::Error::custom)?;
        Ok(view)
    }
}

impl SessionView {
    pub fn session_key(&self) -> &str {
        &self.session_key
    }

    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    pub const fn seq(&self) -> u64 {
        self.seq
    }

    pub const fn cursor(&self) -> u64 {
        self.cursor
    }

    pub fn validate(&self) -> Result<(), SessionStateError> {
        if self.session_key != self.identity.session_key
            || self
                .endpoint_session_id
                .as_deref()
                .is_some_and(|value| !valid_id_with_limit(value, MAX_SESSION_KEY_BYTES))
            || self
                .model_state
                .as_ref()
                .is_some_and(|model_state| !valid_session_model_state(model_state))
            || !valid_identity(&self.identity)
            || !valid_epoch(self.epoch)
            || self.seq > MAX_SAFE_INTEGER
            || self.cursor > MAX_SAFE_INTEGER
            || !valid_facts(&SessionFacts {
                items: self.items.clone(),
                tools: self.tools.clone(),
                approvals: self.approvals.clone(),
                runtime: self.runtime.clone(),
                window: self.window.clone(),
                completeness: self.completeness.clone(),
            })
        {
            return Err(SessionStateError::InvalidFacts);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionChange {
    RunPhaseChanged {
        run_id: String,
        phase: RunPhase,
    },
    MessageDelta {
        item_id: String,
        run_id: Option<String>,
        message_id: Option<String>,
        text: String,
        replace: bool,
        status: ItemStatus,
    },
    MessageUpdated {
        item: SessionItem,
    },
    MessageReplaced {
        item: SessionItem,
    },
    ToolUpdated {
        tool: ToolView,
    },
    ApprovalUpdated {
        approval: ApprovalView,
    },
    RuntimeChanged {
        runtime: RuntimeView,
    },
    RuntimeNoticeUpdated {
        notice: RuntimeNotice,
    },
    WindowChanged {
        window: SessionWindow,
    },
    RecoveryRequired {
        reason: RecoveryReason,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryReason {
    CursorGap,
    CursorStale,
    EpochChanged,
    EventOverflow,
    NativeUnavailable,
    NativeUnknown,
    NativeCursorGap,
    NativeCursorStale,
    NativeEpochChanged,
    NativeEventOverflow,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionDelta {
    pub session_key: String,
    pub route_key: Option<String>,
    pub epoch: u64,
    pub seq: u64,
    pub cursor: u64,
    pub run_id: Option<String>,
    pub changes: Vec<SessionChange>,
}

impl Serialize for SessionDelta {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            session_key: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            route_key: Option<&'a str>,
            epoch: u64,
            seq: u64,
            cursor: u64,
            #[serde(skip_serializing_if = "Option::is_none")]
            run_id: Option<&'a str>,
            changes: Vec<SessionChange>,
        }

        Wire {
            session_key: &self.session_key,
            route_key: self.route_key.as_deref(),
            epoch: self.epoch,
            seq: self.seq,
            cursor: self.cursor,
            run_id: self.run_id.as_deref(),
            changes: self.changes.iter().map(public_delta_change).collect(),
        }
        .serialize(serializer)
    }
}

fn public_items_fact(items: &SessionFact<Vec<SessionItem>>) -> SessionFact<Vec<SessionItem>> {
    match items {
        SessionFact::Complete(items) => {
            SessionFact::Complete(items.iter().map(public_delta_item).collect())
        }
        SessionFact::Incomplete { facts, gaps } => SessionFact::Incomplete {
            facts: facts.iter().map(public_delta_item).collect(),
            gaps: gaps.clone(),
        },
        SessionFact::Unavailable => SessionFact::Unavailable,
        SessionFact::Unknown => SessionFact::Unknown,
    }
}

fn public_tools_fact(tools: &SessionFact<Vec<ToolView>>) -> SessionFact<Vec<ToolView>> {
    match tools {
        SessionFact::Complete(tools) => {
            SessionFact::Complete(tools.iter().map(public_delta_tool).collect())
        }
        SessionFact::Incomplete { facts, gaps } => SessionFact::Incomplete {
            facts: facts.iter().map(public_delta_tool).collect(),
            gaps: gaps.clone(),
        },
        SessionFact::Unavailable => SessionFact::Unavailable,
        SessionFact::Unknown => SessionFact::Unknown,
    }
}

fn public_runtime_fact(runtime: &SessionFact<RuntimeView>) -> SessionFact<RuntimeView> {
    match runtime {
        SessionFact::Complete(runtime) => SessionFact::Complete(public_delta_runtime(runtime)),
        SessionFact::Incomplete { facts, gaps } => SessionFact::Incomplete {
            facts: public_delta_runtime(facts),
            gaps: gaps.clone(),
        },
        SessionFact::Unavailable => SessionFact::Unavailable,
        SessionFact::Unknown => SessionFact::Unknown,
    }
}

impl<'de> Deserialize<'de> for SessionDelta {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            session_key: String,
            route_key: Option<String>,
            epoch: u64,
            seq: u64,
            cursor: u64,
            run_id: Option<String>,
            changes: Vec<SessionChange>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let delta = Self {
            session_key: wire.session_key,
            route_key: wire.route_key,
            epoch: wire.epoch,
            seq: wire.seq,
            cursor: wire.cursor,
            run_id: wire.run_id,
            changes: wire.changes,
        };
        delta.validate().map_err(D::Error::custom)?;
        Ok(delta)
    }
}

fn public_delta_change(change: &SessionChange) -> SessionChange {
    match change {
        SessionChange::MessageUpdated { item } => SessionChange::MessageUpdated {
            item: public_delta_item(item),
        },
        SessionChange::MessageReplaced { item } => SessionChange::MessageReplaced {
            item: public_delta_item(item),
        },
        SessionChange::ToolUpdated { tool } => SessionChange::ToolUpdated {
            tool: public_delta_tool(tool),
        },
        SessionChange::RuntimeChanged { runtime } => SessionChange::RuntimeChanged {
            runtime: public_delta_runtime(runtime),
        },
        SessionChange::RuntimeNoticeUpdated { notice } => SessionChange::RuntimeNoticeUpdated {
            notice: public_delta_runtime_notice(notice),
        },
        SessionChange::RunPhaseChanged { .. }
        | SessionChange::MessageDelta { .. }
        | SessionChange::ApprovalUpdated { .. }
        | SessionChange::WindowChanged { .. }
        | SessionChange::RecoveryRequired { .. } => change.clone(),
    }
}

fn public_delta_item(item: &SessionItem) -> SessionItem {
    match item {
        SessionItem::UserMessage {
            item_id,
            message_id,
            text,
            content,
            status,
        } => SessionItem::UserMessage {
            item_id: item_id.clone(),
            message_id: message_id.clone(),
            text: text.clone(),
            content: content.iter().map(public_delta_content).collect(),
            status: *status,
        },
        SessionItem::AssistantTurn {
            item_id,
            run_id,
            message_id,
            status,
            segments,
            text,
        } => SessionItem::AssistantTurn {
            item_id: item_id.clone(),
            run_id: run_id.clone(),
            message_id: message_id.clone(),
            status: *status,
            segments: segments.iter().map(public_delta_content).collect(),
            text: text.clone(),
        },
        SessionItem::System {
            item_id,
            text,
            status,
        } => SessionItem::System {
            item_id: item_id.clone(),
            text: text.clone(),
            status: *status,
        },
    }
}

fn public_delta_content(content: &SessionContent) -> SessionContent {
    match content {
        SessionContent::Media {
            media_type,
            reference,
        } => public_media_reference(reference).map_or(
            SessionContent::Omitted {
                reason: OmissionReason::UnsafeMedia,
            },
            |reference| SessionContent::Media {
                media_type: media_type.clone(),
                reference,
            },
        ),
        _ => content.clone(),
    }
}

fn public_delta_tool(tool: &ToolView) -> ToolView {
    tool.clone()
}

fn public_delta_runtime(runtime: &RuntimeView) -> RuntimeView {
    RuntimeView {
        phase: runtime.phase,
        active_run_id: runtime.active_run_id.clone(),
        issue: runtime.issue,
        run_progress: runtime.run_progress,
        runtime_activity: runtime.runtime_activity,
        error_detail: runtime.error_detail.clone(),
    }
}

fn public_delta_runtime_notice(notice: &RuntimeNotice) -> RuntimeNotice {
    RuntimeNotice {
        run_id: notice.run_id.clone(),
        kind: notice.kind,
        command: notice.command.clone(),
        risk_level: notice.risk_level.clone(),
        rationale: notice.rationale.clone(),
        message: notice.message.clone(),
    }
}

impl SessionDelta {
    pub fn session_key(&self) -> &str {
        &self.session_key
    }

    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    pub const fn seq(&self) -> u64 {
        self.seq
    }

    pub const fn cursor(&self) -> u64 {
        self.cursor
    }

    pub fn validate(&self) -> Result<(), SessionStateError> {
        if !valid_id_with_limit(&self.session_key, MAX_SESSION_KEY_BYTES)
            || !valid_epoch(self.epoch)
            || self.seq == 0
            || self.seq > MAX_SAFE_INTEGER
            || self.cursor == 0
            || self.cursor > MAX_SAFE_INTEGER
            || self
                .route_key
                .as_deref()
                .is_some_and(|value| !valid_route_key(value))
            || self.run_id.as_deref().is_some_and(|value| !valid_id(value))
            || self.changes.is_empty()
            || self.changes.len() > MAX_CHANGE_COUNT
            || !valid_changes(&self.changes, self.run_id.as_deref())
        {
            return Err(SessionStateError::InvalidFacts);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionApplyRejection {
    InvalidInput,
    InvalidChange,
    CursorConflict { cursor: u64 },
    SequenceExhausted,
    EventBackpressure,
    EventSinkUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionApplyResult {
    Applied(SessionDelta),
    Duplicate { cursor: u64 },
    Stale { cursor: u64, received: u64 },
    Gap { expected: u64, received: u64 },
    Rejected { reason: SessionApplyRejection },
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum AcceptedEventSource {
    Host,
    Native,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct AcceptedEventIdentity {
    source: AcceptedEventSource,
    source_epoch: Option<u64>,
    source_cursor: u64,
    change_fingerprint: u64,
}

fn canonical_change_fingerprint(changes: &[SessionChange]) -> u64 {
    let mut hasher = DefaultHasher::new();
    // SessionChange is the canonical internal identity when the wire DTO has no
    // eventId. Serialization is deterministic for this closed enum and avoids
    // manufacturing an event identifier for the public contract.
    if let Ok(encoded) = serde_json::to_vec(changes) {
        encoded.hash(&mut hasher);
    }
    hasher.finish()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionEventBinding {
    session_key: String,
    route_key: Option<String>,
    source_epoch: Option<u64>,
    source_cursor_contiguous: bool,
}

impl SessionEventBinding {
    pub fn new(
        session_key: impl Into<String>,
        route_key: Option<String>,
        source_epoch: Option<u64>,
    ) -> Option<Self> {
        Self::with_source_cursor_continuity(session_key, route_key, source_epoch, false)
    }

    /// Creates a binding only when the caller has a session-scoped contiguous
    /// source cursor. Gateway-wide cursors must use `new`, because their
    /// per-session values can legitimately jump over other sessions' frames.
    pub fn new_contiguous(
        session_key: impl Into<String>,
        route_key: Option<String>,
        source_epoch: Option<u64>,
    ) -> Option<Self> {
        Self::with_source_cursor_continuity(session_key, route_key, source_epoch, true)
    }

    fn with_source_cursor_continuity(
        session_key: impl Into<String>,
        route_key: Option<String>,
        source_epoch: Option<u64>,
        source_cursor_contiguous: bool,
    ) -> Option<Self> {
        let binding = Self {
            session_key: session_key.into(),
            route_key,
            source_epoch,
            source_cursor_contiguous,
        };
        (valid_id_with_limit(&binding.session_key, MAX_SESSION_KEY_BYTES)
            && binding.route_key.as_deref().is_none_or(valid_route_key)
            && binding.source_epoch.is_none_or(valid_epoch))
        .then_some(binding)
    }

    pub fn session_key(&self) -> &str {
        &self.session_key
    }

    pub fn route_key(&self) -> Option<&str> {
        self.route_key.as_deref()
    }

    pub const fn source_epoch(&self) -> Option<u64> {
        self.source_epoch
    }

    pub const fn source_cursor_contiguous(&self) -> bool {
        self.source_cursor_contiguous
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionSourceBinding {
    Ordinary,
    Team(SessionTeamSourceBinding),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionTeamSourceBinding {
    team_id: TeamId,
    team_run_id: GraphRunId,
    role_id: RoleId,
    session_ref: RoleSessionRef,
}

impl SessionSourceBinding {
    pub const fn ordinary() -> Self {
        Self::Ordinary
    }

    pub fn team_from_receipt(receipt: &organization::RoleSessionReceipt) -> Self {
        Self::Team(SessionTeamSourceBinding {
            team_id: receipt.team().clone(),
            team_run_id: receipt.team_run().clone(),
            role_id: receipt.role().clone(),
            session_ref: receipt.session_ref().clone(),
        })
    }

    pub const fn is_team(&self) -> bool {
        matches!(self, Self::Team(_))
    }
}

#[derive(Clone, Debug)]
pub struct SessionState {
    identity: SessionIdentity,
    source_binding: SessionSourceBinding,
    endpoint_session_id: Option<String>,
    epoch: u64,
    seq: u64,
    cursor: u64,
    items: SessionFact<Vec<SessionItem>>,
    tools: SessionFact<Vec<ToolView>>,
    approvals: SessionFact<Vec<ApprovalView>>,
    runtime: SessionFact<RuntimeView>,
    window: SessionFact<SessionWindow>,
    completeness: SessionCompleteness,
    terminal_run_ids: HashSet<String>,
    host_source_epoch: Option<u64>,
    native_source_epoch: Option<u64>,
    native_cursor: Option<u64>,
    native_recovery_cursor: Option<u64>,
    accepted_event_identities: HashSet<AcceptedEventIdentity>,
    accepted_event_identity_order: VecDeque<AcceptedEventIdentity>,
}

impl SessionState {
    pub fn new(identity: SessionIdentity, epoch: u64) -> Result<Self, SessionStateError> {
        let mut facts = SessionFacts::unknown();
        if identity.agent_id.is_none() {
            facts.completeness = add_missing(&facts.completeness, &[MissingFact::SessionIdentity]);
        }
        Self::from_facts(identity, epoch, 0, facts)
    }

    pub fn from_facts(
        identity: SessionIdentity,
        epoch: u64,
        cursor: u64,
        facts: SessionFacts,
    ) -> Result<Self, SessionStateError> {
        Self::from_view_parts(identity, epoch, 0, cursor, facts)
    }

    pub fn from_view_parts(
        identity: SessionIdentity,
        epoch: u64,
        seq: u64,
        cursor: u64,
        facts: SessionFacts,
    ) -> Result<Self, SessionStateError> {
        if !valid_identity(&identity) {
            return Err(SessionStateError::InvalidIdentity);
        }
        if !valid_epoch(epoch) {
            return Err(SessionStateError::InvalidEpoch);
        }
        if seq > MAX_SAFE_INTEGER || cursor > MAX_SAFE_INTEGER {
            return Err(SessionStateError::InvalidCursor);
        }
        facts.validate()?;
        let terminal_run_ids = terminal_run_ids_from_facts(&facts);
        Ok(Self {
            identity,
            source_binding: SessionSourceBinding::ordinary(),
            endpoint_session_id: None,
            epoch,
            seq,
            cursor,
            items: facts.items,
            tools: facts.tools,
            approvals: facts.approvals,
            runtime: facts.runtime,
            window: facts.window,
            completeness: facts.completeness,
            terminal_run_ids,
            host_source_epoch: None,
            native_source_epoch: None,
            native_cursor: None,
            native_recovery_cursor: None,
            accepted_event_identities: HashSet::new(),
            accepted_event_identity_order: VecDeque::new(),
        })
    }

    pub fn identity(&self) -> &SessionIdentity {
        &self.identity
    }

    pub fn source_binding(&self) -> &SessionSourceBinding {
        &self.source_binding
    }

    pub fn is_team_source(&self) -> bool {
        self.source_binding.is_team()
    }

    pub fn native_session_id(&self) -> Option<&str> {
        self.endpoint_session_id.as_deref()
    }

    pub fn assistant_text_for_run_id(&self, run_id: &str) -> Option<String> {
        match assistant_turn_for_run_id(&self.items, run_id)? {
            SessionItem::AssistantTurn {
                status: ItemStatus::Final,
                text,
                ..
            } => Some(text.clone()),
            _ => None,
        }
    }

    pub fn final_assistant_texts_by_run(&self) -> Vec<(String, String)> {
        items_fact_slice(&self.items)
            .into_iter()
            .flatten()
            .filter_map(|item| match item {
                SessionItem::AssistantTurn {
                    run_id: Some(run_id),
                    status: ItemStatus::Final,
                    text,
                    ..
                } => Some((run_id.clone(), text.clone())),
                _ => None,
            })
            .collect()
    }

    pub fn with_source_binding(mut self, binding: SessionSourceBinding) -> Self {
        self.source_binding = binding;
        self
    }

    pub fn bind_source(&mut self, binding: SessionSourceBinding) -> bool {
        if binding == SessionSourceBinding::Ordinary || self.source_binding == binding {
            return true;
        }
        if self.source_binding == SessionSourceBinding::Ordinary {
            self.source_binding = binding;
            return true;
        }
        false
    }

    pub fn with_endpoint_session_id(
        mut self,
        endpoint_session_id: Option<String>,
    ) -> Result<Self, SessionStateError> {
        if endpoint_session_id
            .as_deref()
            .is_some_and(|value| !valid_id_with_limit(value, MAX_SESSION_KEY_BYTES))
        {
            return Err(SessionStateError::InvalidIdentity);
        }
        self.endpoint_session_id = endpoint_session_id;
        Ok(self)
    }

    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    pub const fn seq(&self) -> u64 {
        self.seq
    }

    pub const fn cursor(&self) -> u64 {
        self.cursor
    }

    pub fn view(&self) -> SessionView {
        SessionView {
            session_key: self.identity.session_key.clone(),
            endpoint_session_id: self.endpoint_session_id.clone(),
            model_state: None,
            identity: self.identity.clone(),
            epoch: self.epoch,
            seq: self.seq,
            cursor: self.cursor,
            items: self.items.clone(),
            tools: self.tools.clone(),
            approvals: self.approvals.clone(),
            runtime: self.runtime.clone(),
            window: self.window.clone(),
            completeness: self.completeness.clone(),
        }
    }

    pub fn apply(
        &mut self,
        route_key: Option<String>,
        run_id: Option<String>,
        cursor: u64,
        changes: Vec<SessionChange>,
    ) -> SessionApplyResult {
        let Some(binding) =
            SessionEventBinding::new(self.identity.session_key.clone(), route_key, None)
        else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput,
            };
        };
        self.apply_bound(binding, run_id, cursor, changes)
    }

    pub fn apply_bound(
        &mut self,
        binding: SessionEventBinding,
        run_id: Option<String>,
        cursor: u64,
        changes: Vec<SessionChange>,
    ) -> SessionApplyResult {
        if binding.session_key() != self.identity.session_key
            || binding
                .source_epoch()
                .zip(self.host_source_epoch)
                .is_some_and(|(received, current)| received != current)
        {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput,
            };
        }
        if cursor == 0
            || cursor > MAX_SAFE_INTEGER
            || changes.is_empty()
            || changes.len() > MAX_CHANGE_COUNT
            || run_id.as_deref().is_some_and(|value| !valid_id(value))
            || !valid_changes(&changes, run_id.as_deref())
        {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput,
            };
        }
        let change_fingerprint = canonical_change_fingerprint(&changes);
        let event_identity = AcceptedEventIdentity {
            source: AcceptedEventSource::Host,
            source_epoch: binding.source_epoch(),
            source_cursor: cursor,
            change_fingerprint,
        };
        if self.accepted_event_identities.contains(&event_identity) {
            return SessionApplyResult::Duplicate { cursor };
        }
        if self.accepted_event_identities.iter().any(|accepted| {
            accepted.source == AcceptedEventSource::Host
                && accepted.source_epoch == binding.source_epoch()
                && accepted.source_cursor == cursor
        }) {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::CursorConflict { cursor },
            };
        }
        if cursor < self.cursor {
            return SessionApplyResult::Stale {
                cursor: self.cursor,
                received: cursor,
            };
        }
        if cursor == self.cursor {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::CursorConflict { cursor },
            };
        }
        let Some(expected) = self.cursor.checked_add(1) else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::SequenceExhausted,
            };
        };
        if cursor != expected {
            return SessionApplyResult::Gap {
                expected,
                received: cursor,
            };
        }
        let Some(next_seq) = self.seq.checked_add(1) else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::SequenceExhausted,
            };
        };
        if next_seq > MAX_SAFE_INTEGER {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::SequenceExhausted,
            };
        }

        let mut next = self.clone();
        if !changes.iter().all(|change| next.apply_change(change)) {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange,
            };
        }
        next.cursor = cursor;
        next.seq = next_seq;
        if next.host_source_epoch.is_none() {
            next.host_source_epoch = binding.source_epoch();
        }
        next.accepted_event_identities
            .insert(event_identity.clone());
        next.accepted_event_identity_order.push_back(event_identity);
        while next.accepted_event_identity_order.len() > MAX_ACCEPTED_EVENT_IDENTITIES {
            let Some(evicted) = next.accepted_event_identity_order.pop_front() else {
                break;
            };
            next.accepted_event_identities.remove(&evicted);
        }
        let Some(delta_changes) = project_delta_changes(&changes, &next, run_id.as_deref()) else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange,
            };
        };
        let delta = SessionDelta {
            session_key: next.identity.session_key.clone(),
            route_key: binding.route_key().map(str::to_owned),
            epoch: next.epoch,
            seq: next.seq,
            cursor,
            run_id,
            changes: delta_changes,
        };
        debug_assert!(delta.validate().is_ok());
        *self = next;
        SessionApplyResult::Applied(delta)
    }

    pub fn native_source_epoch_changed(&self, binding: &SessionEventBinding) -> bool {
        (self.native_cursor.is_some() || self.native_source_epoch.is_some())
            && binding.source_epoch() != self.native_source_epoch
    }

    pub fn apply_native_bound(
        &mut self,
        binding: SessionEventBinding,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        changes: Vec<SessionChange>,
    ) -> SessionApplyResult {
        let run_id = run_id.or_else(|| sole_change_run_id(&changes).map(str::to_owned));
        if binding.session_key() != self.identity.session_key
            || self.native_source_epoch_changed(&binding)
        {
            // A changed or newly discovered native epoch is a source boundary,
            // not a Host cursor gap. The caller must issue explicit
            // RecoveryRequired(EpochChanged) and rehydrate before accepting the
            // new stream; never turn an unknown epoch into zero.
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput,
            };
        }
        if native_cursor.is_some_and(|cursor| cursor == 0 || cursor > MAX_SAFE_INTEGER)
            || changes.is_empty()
            || changes.len() > MAX_CHANGE_COUNT
            || run_id.as_deref().is_some_and(|value| !valid_id(value))
            || !valid_changes(&changes, run_id.as_deref())
        {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput,
            };
        }

        if let Some(native_cursor) = native_cursor {
            let change_fingerprint = canonical_change_fingerprint(&changes);
            let event_identity = AcceptedEventIdentity {
                source: AcceptedEventSource::Native,
                source_epoch: binding.source_epoch(),
                source_cursor: native_cursor,
                change_fingerprint,
            };
            if self.accepted_event_identities.contains(&event_identity) {
                return SessionApplyResult::Duplicate {
                    cursor: native_cursor,
                };
            }
            if self.accepted_event_identities.iter().any(|accepted| {
                accepted.source == AcceptedEventSource::Native
                    && accepted.source_epoch == binding.source_epoch()
                    && accepted.source_cursor == native_cursor
            }) {
                return SessionApplyResult::Rejected {
                    reason: SessionApplyRejection::CursorConflict {
                        cursor: native_cursor,
                    },
                };
            }
            if let Some(previous) = self.native_cursor {
                if native_cursor < previous {
                    return SessionApplyResult::Stale {
                        cursor: previous,
                        received: native_cursor,
                    };
                }
                if native_cursor == previous {
                    return SessionApplyResult::Rejected {
                        reason: SessionApplyRejection::CursorConflict {
                            cursor: native_cursor,
                        },
                    };
                }
                if binding.source_cursor_contiguous() {
                    let Some(expected) = previous.checked_add(1) else {
                        return SessionApplyResult::Rejected {
                            reason: SessionApplyRejection::SequenceExhausted,
                        };
                    };
                    if native_cursor != expected {
                        return SessionApplyResult::Gap {
                            expected,
                            received: native_cursor,
                        };
                    }
                }
            }
        }

        let Some(next_seq) = self.seq.checked_add(1) else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::SequenceExhausted,
            };
        };
        let Some(next_cursor) = self.cursor.checked_add(1) else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::SequenceExhausted,
            };
        };
        if next_seq > MAX_SAFE_INTEGER || next_cursor > MAX_SAFE_INTEGER {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::SequenceExhausted,
            };
        }

        let mut next = self.clone();
        if !changes.iter().all(|change| next.apply_change(change)) {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange,
            };
        }
        next.cursor = next_cursor;
        next.seq = next_seq;
        if native_cursor.is_some() {
            next.native_cursor = native_cursor;
            next.native_source_epoch = binding.source_epoch();
            let event_identity = AcceptedEventIdentity {
                source: AcceptedEventSource::Native,
                source_epoch: binding.source_epoch(),
                source_cursor: native_cursor.expect("native cursor is present"),
                change_fingerprint: canonical_change_fingerprint(&changes),
            };
            next.accepted_event_identities
                .insert(event_identity.clone());
            next.accepted_event_identity_order.push_back(event_identity);
            while next.accepted_event_identity_order.len() > MAX_ACCEPTED_EVENT_IDENTITIES {
                let Some(evicted) = next.accepted_event_identity_order.pop_front() else {
                    break;
                };
                next.accepted_event_identities.remove(&evicted);
            }
        } else if binding.source_epoch().is_some() {
            next.native_source_epoch = binding.source_epoch();
        }
        let Some(delta_changes) = project_delta_changes(&changes, &next, run_id.as_deref()) else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange,
            };
        };
        let delta = SessionDelta {
            session_key: next.identity.session_key.clone(),
            route_key: binding.route_key().map(str::to_owned),
            epoch: next.epoch,
            seq: next.seq,
            cursor: next_cursor,
            run_id,
            changes: delta_changes,
        };
        debug_assert!(delta.validate().is_ok());
        *self = next;
        SessionApplyResult::Applied(delta)
    }

    pub fn apply_native_recovery_bound(
        &mut self,
        binding: SessionEventBinding,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        reason: RecoveryReason,
    ) -> SessionApplyResult {
        if binding.session_key() != self.identity.session_key
            || native_cursor.is_some_and(|cursor| cursor > MAX_SAFE_INTEGER)
            || run_id.as_deref().is_some_and(|value| !valid_id(value))
        {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput,
            };
        }

        let changes = vec![SessionChange::RecoveryRequired { reason }];
        if let Some(native_cursor) = native_cursor {
            if self.native_source_epoch == binding.source_epoch()
                && self.native_recovery_cursor == Some(native_cursor)
            {
                return SessionApplyResult::Duplicate {
                    cursor: native_cursor,
                };
            }
        }

        let Some(next_seq) = self.seq.checked_add(1) else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::SequenceExhausted,
            };
        };
        let Some(next_cursor) = self.cursor.checked_add(1) else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::SequenceExhausted,
            };
        };
        if next_seq > MAX_SAFE_INTEGER || next_cursor > MAX_SAFE_INTEGER {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::SequenceExhausted,
            };
        }

        let mut next = self.clone();
        if !next.apply_change(&changes[0]) {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange,
            };
        }
        next.cursor = next_cursor;
        next.seq = next_seq;
        next.native_recovery_cursor = native_cursor;
        next.native_cursor = None;
        next.native_source_epoch = binding.source_epoch();
        next.accepted_event_identities
            .retain(|identity| identity.source != AcceptedEventSource::Native);
        next.accepted_event_identity_order
            .retain(|identity| identity.source != AcceptedEventSource::Native);
        let delta = SessionDelta {
            session_key: next.identity.session_key.clone(),
            route_key: binding.route_key().map(str::to_owned),
            epoch: next.epoch,
            seq: next.seq,
            cursor: next_cursor,
            run_id,
            changes,
        };
        debug_assert!(delta.validate().is_ok());
        *self = next;
        SessionApplyResult::Applied(delta)
    }

    fn apply_change(&mut self, change: &SessionChange) -> bool {
        let applied = match change {
            SessionChange::RunPhaseChanged { run_id, phase } => {
                if self.terminal_run_ids.contains(run_id) {
                    return false;
                }
                update_runtime_phase(&mut self.runtime, run_id, *phase);
                if terminal_run_phase(*phase) {
                    if !update_assistant_turn_status_for_run(
                        &mut self.items,
                        run_id,
                        item_status_for_terminal_run_phase(*phase),
                    ) {
                        return false;
                    }
                    self.terminal_run_ids.insert(run_id.clone());
                }
                true
            }
            SessionChange::MessageDelta {
                item_id,
                run_id,
                message_id,
                text,
                replace,
                status,
            } => {
                if run_id
                    .as_deref()
                    .is_some_and(|run_id| self.terminal_run_ids.contains(run_id))
                {
                    return false;
                }
                let updated = update_message_delta(
                    &mut self.items,
                    item_id,
                    run_id.as_deref(),
                    message_id.as_deref(),
                    text,
                    *replace,
                    *status,
                );
                if updated {
                    clear_runtime_run_progress(&mut self.runtime, run_id.as_deref());
                }
                updated
            }
            SessionChange::MessageUpdated { item } => {
                if item
                    .run_id()
                    .is_some_and(|run_id| self.terminal_run_ids.contains(run_id))
                {
                    return false;
                }
                update_items(&mut self.items, item)
            }
            SessionChange::MessageReplaced { item } => {
                if item
                    .run_id()
                    .is_some_and(|run_id| self.terminal_run_ids.contains(run_id))
                {
                    return false;
                }
                replace_items(&mut self.items, item)
            }
            SessionChange::ToolUpdated { tool } => {
                let tool = tool_update_for_state(&self.tools, tool);
                if tool
                    .run_id
                    .as_deref()
                    .is_some_and(|run_id| self.terminal_run_ids.contains(run_id))
                {
                    return false;
                }
                update_tools(&mut self.tools, &tool) && update_tool_anchor(&mut self.items, &tool)
            }
            SessionChange::ApprovalUpdated { approval } => {
                if approval
                    .run_id
                    .as_deref()
                    .is_some_and(|run_id| self.terminal_run_ids.contains(run_id))
                {
                    return false;
                }
                update_approvals(&mut self.approvals, approval)
            }
            SessionChange::RuntimeChanged { runtime } => {
                if !valid_runtime(runtime) {
                    return false;
                }
                let mut runtime = runtime.clone();
                if let Some(run_id) = runtime.active_run_id.clone() {
                    if self.terminal_run_ids.contains(&run_id) {
                        return false;
                    }
                    if terminal_run_phase(runtime.phase) {
                        self.terminal_run_ids.insert(run_id);
                        runtime.active_run_id = None;
                    }
                } else if !terminal_run_phase(runtime.phase) {
                    return false;
                }
                self.runtime = event_runtime(runtime);
                true
            }
            SessionChange::RuntimeNoticeUpdated { notice } => {
                if self.terminal_run_ids.contains(&notice.run_id) {
                    return false;
                }
                valid_runtime_notice(notice)
            }
            SessionChange::WindowChanged { window } => {
                if !valid_window(window) {
                    return false;
                }
                self.window = SessionFact::Incomplete {
                    facts: *window,
                    gaps: vec![MissingFact::BoundedHistory],
                };
                true
            }
            SessionChange::RecoveryRequired { reason } => {
                self.apply_recovery(*reason);
                true
            }
        };
        if applied && !matches!(change, SessionChange::RecoveryRequired { .. }) {
            self.completeness = add_missing(&self.completeness, &[MissingFact::EventOnly]);
        }
        applied
    }

    fn apply_recovery(&mut self, reason: RecoveryReason) {
        self.completeness = match reason {
            RecoveryReason::NativeUnavailable => SessionCompleteness::Unavailable,
            RecoveryReason::NativeUnknown => SessionCompleteness::Unknown,
            RecoveryReason::CursorGap
            | RecoveryReason::CursorStale
            | RecoveryReason::EpochChanged
            | RecoveryReason::NativeCursorGap
            | RecoveryReason::NativeCursorStale
            | RecoveryReason::NativeEpochChanged => {
                add_missing(&self.completeness, &[MissingFact::ReplayCursor])
            }
            RecoveryReason::EventOverflow | RecoveryReason::NativeEventOverflow => {
                add_missing(&self.completeness, &[MissingFact::EventOnly])
            }
        };
    }
}

fn update_assistant_turn_status_for_run(
    fact: &mut SessionFact<Vec<SessionItem>>,
    run_id: &str,
    status: ItemStatus,
) -> bool {
    let current = mem::replace(fact, SessionFact::Unknown);
    let (mut items, gaps) = match current {
        SessionFact::Complete(items) => (items, Vec::new()),
        SessionFact::Incomplete { facts, gaps } => (facts, gaps),
        SessionFact::Unavailable | SessionFact::Unknown => {
            *fact = current;
            return true;
        }
    };
    for item in &mut items {
        if let SessionItem::AssistantTurn {
            run_id: Some(item_run_id),
            status: item_status,
            ..
        } = item
            && item_run_id == run_id
            && matches!(
                item_status,
                ItemStatus::Pending | ItemStatus::Streaming | ItemStatus::WaitingForTool
            )
        {
            *item_status = status;
        }
    }
    *fact = SessionFact::Incomplete {
        facts: items,
        gaps: with_gap(gaps, MissingFact::EventOnly),
    };
    true
}

fn item_status_for_terminal_run_phase(phase: RunPhase) -> ItemStatus {
    match phase {
        RunPhase::Cancelled | RunPhase::Interrupted => ItemStatus::Aborted,
        RunPhase::Completed => ItemStatus::Final,
        RunPhase::Failed => ItemStatus::Error,
        RunPhase::Queued
        | RunPhase::Started
        | RunPhase::WaitingForApproval
        | RunPhase::CancellationRequested => ItemStatus::Streaming,
    }
}

fn clear_runtime_run_progress(fact: &mut SessionFact<RuntimeView>, run_id: Option<&str>) {
    let runtime = match fact {
        SessionFact::Complete(runtime) | SessionFact::Incomplete { facts: runtime, .. } => runtime,
        SessionFact::Unavailable | SessionFact::Unknown => return,
    };
    if run_id.is_none_or(|run_id| runtime.active_run_id.as_deref() == Some(run_id)) {
        runtime.run_progress = None;
    }
}

fn update_runtime_phase(fact: &mut SessionFact<RuntimeView>, run_id: &str, phase: RunPhase) {
    let current = mem::replace(fact, SessionFact::Unknown);
    let (mut runtime, mut gaps) = match current {
        SessionFact::Complete(runtime) => (runtime, Vec::new()),
        SessionFact::Incomplete { facts, gaps } => (facts, gaps),
        SessionFact::Unavailable | SessionFact::Unknown => (
            RuntimeView {
                phase,
                active_run_id: None,
                issue: None,
                run_progress: None,
                runtime_activity: None,
                error_detail: None,
            },
            Vec::new(),
        ),
    };
    runtime.phase = phase;
    runtime.active_run_id = if terminal_run_phase(phase) {
        None
    } else {
        Some(run_id.to_owned())
    };
    runtime.run_progress = None;
    runtime.runtime_activity = None;
    runtime.error_detail = None;
    gaps = with_gap(gaps, MissingFact::EventOnly);
    gaps = with_gap(gaps, MissingFact::PartialRuntime);
    *fact = SessionFact::Incomplete {
        facts: runtime,
        gaps,
    };
}

fn event_runtime(runtime: RuntimeView) -> SessionFact<RuntimeView> {
    SessionFact::Incomplete {
        facts: runtime,
        gaps: vec![MissingFact::EventOnly, MissingFact::PartialRuntime],
    }
}

fn update_items(fact: &mut SessionFact<Vec<SessionItem>>, item: &SessionItem) -> bool {
    if !valid_item(item) {
        return false;
    }
    let current = mem::replace(fact, SessionFact::Unknown);
    let (mut items, gaps) = match current {
        SessionFact::Complete(items) => (items, Vec::new()),
        SessionFact::Incomplete { facts, gaps } => (facts, gaps),
        SessionFact::Unavailable | SessionFact::Unknown => (Vec::new(), Vec::new()),
    };
    if !replace_item(&mut items, item.clone()) {
        return false;
    }
    *fact = SessionFact::Incomplete {
        facts: items,
        gaps: with_gap(gaps, MissingFact::EventOnly),
    };
    true
}

fn update_message_delta(
    fact: &mut SessionFact<Vec<SessionItem>>,
    item_id: &str,
    run_id: Option<&str>,
    message_id: Option<&str>,
    text: &str,
    replace: bool,
    status: ItemStatus,
) -> bool {
    if !valid_id(item_id)
        || run_id.is_some_and(|value| !valid_id(value))
        || message_id.is_some_and(|value| !valid_id(value))
        || !valid_payload_text(text, MAX_TEXT_BYTES)
    {
        return false;
    }
    let current = mem::replace(fact, SessionFact::Unknown);
    let (mut items, gaps) = match current {
        SessionFact::Complete(items) => (items, Vec::new()),
        SessionFact::Incomplete { facts, gaps } => (facts, gaps),
        SessionFact::Unavailable | SessionFact::Unknown => (Vec::new(), Vec::new()),
    };
    let item_index = message_delta_target_index(&items, item_id, message_id, run_id);
    if let Some(item_index) = item_index {
        let existing = &mut items[item_index];
        let SessionItem::AssistantTurn {
            run_id: existing_run_id,
            message_id: existing_message_id,
            segments,
            text: current_text,
            status: current_status,
            ..
        } = existing
        else {
            return false;
        };
        if existing_run_id.as_deref() != run_id
            || !message_ids_can_merge(existing_message_id.as_deref(), message_id)
        {
            return false;
        }
        if existing_message_id.is_none() {
            *existing_message_id = message_id.map(str::to_owned);
        }
        if !sync_assistant_text_segment(segments, text, replace) {
            return false;
        }
        *current_text = assistant_text_cache(segments);
        *current_status = status;
    } else {
        if items.len() >= MAX_ITEMS {
            return false;
        }
        let mut segments = Vec::new();
        if !text.is_empty() {
            segments.push(SessionContent::Text {
                text: text.to_owned(),
            });
        }
        items.push(SessionItem::AssistantTurn {
            item_id: item_id.to_owned(),
            run_id: run_id.map(str::to_owned),
            message_id: message_id.map(str::to_owned),
            status,
            segments,
            text: text.to_owned(),
        });
    }
    *fact = SessionFact::Incomplete {
        facts: items,
        gaps: with_gap(gaps, MissingFact::EventOnly),
    };
    true
}

fn message_delta_target_index(
    items: &[SessionItem],
    item_id: &str,
    message_id: Option<&str>,
    run_id: Option<&str>,
) -> Option<usize> {
    items
        .iter()
        .position(|existing| existing.item_id() == item_id)
        .or_else(|| message_id.and_then(|id| assistant_turn_index_by_message_id(items, id)))
        .or_else(|| tool_anchor_only_message_delta_index(items, run_id))
}

fn assistant_turn_index_by_message_id(items: &[SessionItem], message_id: &str) -> Option<usize> {
    items.iter().position(|item| {
        matches!(item, SessionItem::AssistantTurn { message_id: Some(existing), .. } if existing == message_id)
    })
}

fn tool_anchor_only_message_delta_index(
    items: &[SessionItem],
    run_id: Option<&str>,
) -> Option<usize> {
    let run_id = run_id?;
    items.iter().position(|candidate| {
        matches!(
            candidate,
            SessionItem::AssistantTurn {
                run_id: Some(existing_run_id),
                message_id: None,
                text,
                segments,
                ..
            } if existing_run_id == run_id
                && text.is_empty()
                && !segments.is_empty()
                && segments.iter().all(|segment| tool_segment_call_id(segment).is_some())
        )
    })
}

fn assistant_turn_index_by_run_id(items: &[SessionItem], run_id: Option<&str>) -> Option<usize> {
    let run_id = run_id?;
    items.iter().position(|item| {
        matches!(item, SessionItem::AssistantTurn { run_id: Some(existing), .. } if existing == run_id)
    })
}

fn message_ids_can_merge(current: Option<&str>, incoming: Option<&str>) -> bool {
    match (current, incoming) {
        (Some(current), Some(incoming)) => current == incoming,
        _ => true,
    }
}

fn sync_assistant_text_segment(
    segments: &mut Vec<SessionContent>,
    text: &str,
    replace: bool,
) -> bool {
    if replace {
        segments.retain(|segment| !matches!(segment, SessionContent::Text { .. }));
    }
    if text.is_empty() {
        return true;
    }
    if !replace && let Some(SessionContent::Text { text: current }) = segments.last_mut() {
        current.push_str(text);
        return true;
    }
    if segments.len() >= MAX_SEGMENTS {
        return false;
    }
    segments.push(SessionContent::Text {
        text: text.to_owned(),
    });
    true
}

fn assistant_text_cache(segments: &[SessionContent]) -> String {
    let mut text = String::new();
    for segment in segments {
        match segment {
            SessionContent::Text { text: segment_text }
            | SessionContent::LargeText {
                text: segment_text, ..
            } => text.push_str(segment_text),
            SessionContent::Thinking { .. }
            | SessionContent::ToolUse { .. }
            | SessionContent::ToolResult { .. }
            | SessionContent::Media { .. }
            | SessionContent::Omitted { .. } => {}
        }
    }
    text
}

fn tool_update_for_state(fact: &SessionFact<Vec<ToolView>>, tool: &ToolView) -> ToolView {
    let Some(existing) = tools_fact_slice(fact).and_then(|tools| {
        tools
            .iter()
            .find(|existing| existing.tool_call_id == tool.tool_call_id)
    }) else {
        return tool.clone();
    };
    ToolView {
        tool_call_id: tool.tool_call_id.clone(),
        run_id: tool.run_id.clone().or_else(|| existing.run_id.clone()),
        name: tool.name.clone().or_else(|| existing.name.clone()),
        phase: tool.phase,
        input: tool.input.clone().or_else(|| existing.input.clone()),
        input_text: tool
            .input_text
            .clone()
            .or_else(|| existing.input_text.clone()),
        summary: tool.summary.clone().or_else(|| existing.summary.clone()),
        output: tool.output.clone().or_else(|| existing.output.clone()),
        details: tool.details.clone().or_else(|| existing.details.clone()),
        is_error: tool.is_error.or(existing.is_error),
    }
}

fn update_tool_anchor(fact: &mut SessionFact<Vec<SessionItem>>, tool: &ToolView) -> bool {
    if !valid_tool(tool) {
        return false;
    }
    let Some(run_id) = tool.run_id.as_deref() else {
        return true;
    };
    let current = mem::replace(fact, SessionFact::Unknown);
    let (mut items, gaps) = match current {
        SessionFact::Complete(items) => (items, Vec::new()),
        SessionFact::Incomplete { facts, gaps } => (facts, gaps),
        SessionFact::Unavailable | SessionFact::Unknown => (Vec::new(), Vec::new()),
    };
    if let Some(item_index) = assistant_turn_index_by_run_id(&items, Some(run_id)) {
        let SessionItem::AssistantTurn { segments, .. } = &mut items[item_index] else {
            return false;
        };
        if !upsert_tool_anchor_segment(segments, tool) {
            return false;
        }
    } else {
        if items.len() >= MAX_ITEMS {
            return false;
        }
        items.push(SessionItem::AssistantTurn {
            item_id: run_id.to_owned(),
            run_id: Some(run_id.to_owned()),
            message_id: None,
            status: ItemStatus::Streaming,
            segments: vec![tool_anchor_segment(tool)],
            text: String::new(),
        });
    }
    *fact = SessionFact::Incomplete {
        facts: items,
        gaps: with_gap(gaps, MissingFact::EventOnly),
    };
    true
}

fn upsert_tool_anchor_segment(segments: &mut Vec<SessionContent>, tool: &ToolView) -> bool {
    if let Some(existing) = segments
        .iter_mut()
        .find(|segment| tool_segment_call_id(segment) == Some(tool.tool_call_id.as_str()))
    {
        *existing = tool_anchor_segment(tool);
        return true;
    }
    if segments.len() >= MAX_SEGMENTS {
        return false;
    }
    segments.push(tool_anchor_segment(tool));
    true
}

fn tool_anchor_segment(tool: &ToolView) -> SessionContent {
    SessionContent::ToolUse {
        name: tool
            .name
            .clone()
            .unwrap_or_else(|| UNKNOWN_TOOL_ANCHOR_NAME.to_owned()),
        tool_call_id: tool.tool_call_id.clone(),
    }
}

fn tool_segment_call_id(segment: &SessionContent) -> Option<&str> {
    match segment {
        SessionContent::ToolUse { tool_call_id, .. }
        | SessionContent::ToolResult { tool_call_id, .. } => Some(tool_call_id),
        SessionContent::Text { .. }
        | SessionContent::Thinking { .. }
        | SessionContent::LargeText { .. }
        | SessionContent::Media { .. }
        | SessionContent::Omitted { .. } => None,
    }
}

fn update_tools(fact: &mut SessionFact<Vec<ToolView>>, tool: &ToolView) -> bool {
    if !valid_tool(tool) {
        return false;
    }
    let current = mem::replace(fact, SessionFact::Unknown);
    let (mut tools, gaps) = match current {
        SessionFact::Complete(tools) => (tools, Vec::new()),
        SessionFact::Incomplete { facts, gaps } => (facts, gaps),
        SessionFact::Unavailable | SessionFact::Unknown => (Vec::new(), Vec::new()),
    };
    if let Some(existing) = tools
        .iter_mut()
        .find(|existing| existing.tool_call_id == tool.tool_call_id)
    {
        *existing = tool.clone();
    } else {
        if tools.len() >= MAX_TOOLS {
            return false;
        }
        tools.push(tool.clone());
    }
    *fact = SessionFact::Incomplete {
        facts: tools,
        gaps: with_gap(gaps, MissingFact::EventOnly),
    };
    true
}

fn project_delta_changes(
    changes: &[SessionChange],
    state: &SessionState,
    outer_run_id: Option<&str>,
) -> Option<Vec<SessionChange>> {
    let mut projected = Vec::with_capacity(changes.len());
    for change in changes {
        match change {
            SessionChange::MessageDelta {
                item_id,
                run_id,
                message_id,
                ..
            } => {
                let Some(item) = state_item_for_message_delta(
                    &state.items,
                    item_id,
                    message_id.as_deref(),
                    run_id.as_deref(),
                ) else {
                    projected.push(change.clone());
                    continue;
                };
                if message_delta_needs_full_item(item, item_id, message_id.as_deref()) {
                    push_message_updated_change(&mut projected, item.clone());
                } else {
                    projected.push(change.clone());
                }
            }
            SessionChange::MessageUpdated { item } => {
                projected.push(SessionChange::MessageUpdated {
                    item: state_item_for_change_item(&state.items, item)
                        .unwrap_or(item)
                        .clone(),
                });
            }
            SessionChange::MessageReplaced { item } => {
                projected.push(SessionChange::MessageReplaced {
                    item: state_item_for_change_item(&state.items, item)
                        .unwrap_or(item)
                        .clone(),
                });
            }
            SessionChange::ToolUpdated { tool } => {
                let tool = state_tool_for_change(&state.tools, tool);
                projected.push(SessionChange::ToolUpdated { tool: tool.clone() });
                if let Some(run_id) = tool.run_id.as_deref()
                    && let Some(item) = assistant_turn_for_run_id(&state.items, run_id)
                {
                    push_message_updated_change(&mut projected, item.clone());
                }
            }
            SessionChange::RunPhaseChanged { run_id, phase } => {
                projected.push(change.clone());
                if terminal_run_phase(*phase)
                    && let Some(item) = assistant_turn_for_run_id(&state.items, run_id)
                {
                    push_message_updated_change(&mut projected, item.clone());
                }
            }
            SessionChange::ApprovalUpdated { .. }
            | SessionChange::RuntimeChanged { .. }
            | SessionChange::RuntimeNoticeUpdated { .. }
            | SessionChange::WindowChanged { .. }
            | SessionChange::RecoveryRequired { .. } => projected.push(change.clone()),
        }
    }
    (projected.len() <= MAX_CHANGE_COUNT && valid_changes(&projected, outer_run_id))
        .then_some(projected)
}

fn state_item_for_message_delta<'a>(
    fact: &'a SessionFact<Vec<SessionItem>>,
    item_id: &str,
    message_id: Option<&str>,
    run_id: Option<&str>,
) -> Option<&'a SessionItem> {
    let items = items_fact_slice(fact)?;
    message_delta_target_index(items, item_id, message_id, run_id).map(|index| &items[index])
}

fn state_tool_for_change(fact: &SessionFact<Vec<ToolView>>, tool: &ToolView) -> ToolView {
    tools_fact_slice(fact)
        .and_then(|tools| {
            tools
                .iter()
                .find(|existing| existing.tool_call_id == tool.tool_call_id)
        })
        .cloned()
        .unwrap_or_else(|| tool.clone())
}

fn state_item_for_change_item<'a>(
    fact: &'a SessionFact<Vec<SessionItem>>,
    item: &SessionItem,
) -> Option<&'a SessionItem> {
    let items = items_fact_slice(fact)?;
    if let Some(current) = items
        .iter()
        .find(|current| current.item_id() == item.item_id())
    {
        return Some(current);
    }
    let run_id = item.run_id()?;
    items.iter().find(|current| {
        matches!(current, SessionItem::AssistantTurn { run_id: Some(existing), .. } if existing == run_id)
    })
}

fn assistant_turn_for_run_id<'a>(
    fact: &'a SessionFact<Vec<SessionItem>>,
    run_id: &str,
) -> Option<&'a SessionItem> {
    items_fact_slice(fact)?.iter().find(|item| {
        matches!(item, SessionItem::AssistantTurn { run_id: Some(existing), .. } if existing == run_id)
    })
}

fn items_fact_slice(fact: &SessionFact<Vec<SessionItem>>) -> Option<&[SessionItem]> {
    match fact {
        SessionFact::Complete(items) | SessionFact::Incomplete { facts: items, .. } => Some(items),
        SessionFact::Unavailable | SessionFact::Unknown => None,
    }
}

fn tools_fact_slice(fact: &SessionFact<Vec<ToolView>>) -> Option<&[ToolView]> {
    match fact {
        SessionFact::Complete(tools) | SessionFact::Incomplete { facts: tools, .. } => Some(tools),
        SessionFact::Unavailable | SessionFact::Unknown => None,
    }
}

fn message_delta_needs_full_item(
    item: &SessionItem,
    item_id: &str,
    message_id: Option<&str>,
) -> bool {
    item.item_id() != item_id || item.message_id() != message_id || item_has_non_text_segment(item)
}

fn item_has_non_text_segment(item: &SessionItem) -> bool {
    matches!(
        item,
        SessionItem::AssistantTurn { segments, .. }
            if segments.iter().any(|segment| !matches!(segment, SessionContent::Text { .. } | SessionContent::LargeText { .. }))
    )
}

fn push_message_updated_change(changes: &mut Vec<SessionChange>, item: SessionItem) {
    if let Some(change) = changes.iter_mut().find(|change| {
        matches!(change, SessionChange::MessageUpdated { item: current } if current.item_id() == item.item_id())
    }) {
        *change = SessionChange::MessageUpdated { item };
        return;
    }
    changes.push(SessionChange::MessageUpdated { item });
}

fn update_approvals(fact: &mut SessionFact<Vec<ApprovalView>>, approval: &ApprovalView) -> bool {
    if !valid_approval(approval) {
        return false;
    }
    let current = mem::replace(fact, SessionFact::Unknown);
    let (mut approvals, gaps) = match current {
        SessionFact::Complete(approvals) => (approvals, Vec::new()),
        SessionFact::Incomplete { facts, gaps } => (facts, gaps),
        SessionFact::Unavailable | SessionFact::Unknown => (Vec::new(), Vec::new()),
    };
    if let Some(existing) = approvals
        .iter_mut()
        .find(|existing| existing.approval_id == approval.approval_id)
    {
        *existing = approval.clone();
    } else {
        if approvals.len() >= MAX_APPROVALS {
            return false;
        }
        approvals.push(approval.clone());
    }
    *fact = SessionFact::Incomplete {
        facts: approvals,
        gaps: with_gap(gaps, MissingFact::EventOnly),
    };
    true
}

fn replace_item(items: &mut Vec<SessionItem>, mut item: SessionItem) -> bool {
    if let Some(existing_index) = items
        .iter()
        .position(|existing| existing.item_id() == item.item_id())
    {
        if !carry_forward_assistant_segments(&mut item, &items[existing_index]) {
            return false;
        }
        items[existing_index] = item;
        return true;
    }
    if let Some(existing_index) = tool_anchor_only_turn_index(items, &item) {
        if !carry_forward_assistant_segments(&mut item, &items[existing_index]) {
            return false;
        }
        items[existing_index] = item;
        return true;
    }
    if items.len() >= MAX_ITEMS {
        return false;
    }
    items.push(item);
    true
}

fn carry_forward_assistant_segments(item: &mut SessionItem, existing: &SessionItem) -> bool {
    let SessionItem::AssistantTurn { segments, text, .. } = item else {
        return true;
    };
    let SessionItem::AssistantTurn {
        segments: existing_segments,
        text: existing_text,
        ..
    } = existing
    else {
        return true;
    };
    if merge_assistant_thinking_chunk(segments, text, existing_segments, existing_text) {
        return true;
    }
    merge_assistant_segments(segments, text, existing_segments, existing_text)
}

fn merge_assistant_thinking_chunk(
    segments: &mut Vec<SessionContent>,
    text: &mut String,
    existing_segments: &[SessionContent],
    existing_text: &str,
) -> bool {
    if !text.is_empty() {
        return false;
    }
    let [SessionContent::Thinking { text: incoming }] = segments.as_slice() else {
        return false;
    };
    let mut merged = existing_segments.to_vec();
    if let Some(SessionContent::Thinking { text }) = merged
        .iter_mut()
        .find(|segment| matches!(segment, SessionContent::Thinking { .. }))
    {
        text.push_str(incoming);
    } else {
        if merged.len() >= MAX_SEGMENTS {
            return false;
        }
        merged.insert(
            0,
            SessionContent::Thinking {
                text: incoming.clone(),
            },
        );
    }
    *segments = merged;
    text.push_str(existing_text);
    true
}

fn merge_assistant_segments(
    segments: &mut Vec<SessionContent>,
    text: &mut String,
    existing_segments: &[SessionContent],
    existing_text: &str,
) -> bool {
    if text.is_empty() && !existing_text.is_empty() {
        text.push_str(existing_text);
    }
    for segment in existing_segments {
        if should_carry_assistant_segment(segments, segment) {
            if segments.len() >= MAX_SEGMENTS {
                return false;
            }
            segments.push(segment.clone());
        }
    }
    true
}

fn should_carry_assistant_segment(segments: &[SessionContent], segment: &SessionContent) -> bool {
    match segment {
        SessionContent::Text { .. } | SessionContent::LargeText { .. } => false,
        SessionContent::Thinking { .. } => !segments
            .iter()
            .any(|candidate| matches!(candidate, SessionContent::Thinking { .. })),
        SessionContent::ToolUse { tool_call_id, .. }
        | SessionContent::ToolResult { tool_call_id, .. } => !segments
            .iter()
            .any(|candidate| tool_segment_call_id(candidate) == Some(tool_call_id.as_str())),
        SessionContent::Media { .. } | SessionContent::Omitted { .. } => false,
    }
}

fn tool_anchor_only_turn_index(items: &[SessionItem], item: &SessionItem) -> Option<usize> {
    let run_id = item.run_id()?;
    items.iter().position(|candidate| {
        matches!(
            candidate,
            SessionItem::AssistantTurn {
                run_id: Some(existing_run_id),
                message_id: None,
                text,
                segments,
                ..
            } if existing_run_id == run_id
                && text.is_empty()
                && !segments.is_empty()
                && segments.iter().all(|segment| tool_segment_call_id(segment).is_some())
        )
    })
}

fn replace_items(fact: &mut SessionFact<Vec<SessionItem>>, item: &SessionItem) -> bool {
    if !valid_item(item) {
        return false;
    }
    let current = mem::replace(fact, SessionFact::Unknown);
    let (mut items, gaps) = match current {
        SessionFact::Complete(items) => (items, Vec::new()),
        SessionFact::Incomplete { facts, gaps } => (facts, gaps),
        SessionFact::Unavailable | SessionFact::Unknown => (Vec::new(), Vec::new()),
    };
    if !replace_item(&mut items, item.clone()) {
        return false;
    }
    *fact = SessionFact::Incomplete { facts: items, gaps };
    true
}

fn terminal_run_ids_from_facts(facts: &SessionFacts) -> HashSet<String> {
    let mut terminal_run_ids = HashSet::new();
    if let SessionFact::Complete(items) | SessionFact::Incomplete { facts: items, .. } =
        &facts.items
    {
        for item in items {
            if let SessionItem::AssistantTurn {
                run_id: Some(run_id),
                status,
                ..
            } = item
                && matches!(
                    status,
                    ItemStatus::Final | ItemStatus::Error | ItemStatus::Aborted
                )
            {
                terminal_run_ids.insert(run_id.clone());
            }
        }
    }
    if let SessionFact::Complete(runtime) | SessionFact::Incomplete { facts: runtime, .. } =
        &facts.runtime
        && terminal_run_phase(runtime.phase)
        && let Some(run_id) = runtime.active_run_id.as_ref()
    {
        terminal_run_ids.insert(run_id.clone());
    }
    terminal_run_ids
}

fn valid_facts(facts: &SessionFacts) -> bool {
    valid_items_fact(&facts.items)
        && valid_tools_fact(&facts.tools)
        && valid_approvals_fact(&facts.approvals)
        && valid_runtime_fact(&facts.runtime)
        && valid_window_fact(&facts.window)
        && valid_completeness(&facts.completeness)
        && (!matches!(facts.completeness, SessionCompleteness::Complete)
            || (facts.items.is_complete()
                && facts.tools.is_complete()
                && facts.approvals.is_complete()
                && facts.runtime.is_complete()
                && facts.window.is_complete()))
}

fn valid_items_fact(fact: &SessionFact<Vec<SessionItem>>) -> bool {
    (match fact {
        SessionFact::Complete(items) | SessionFact::Incomplete { facts: items, .. } => {
            items.len() <= MAX_ITEMS && items.iter().all(valid_item)
        }
        SessionFact::Unavailable | SessionFact::Unknown => true,
    }) && valid_gaps(fact)
}

fn valid_tools_fact(fact: &SessionFact<Vec<ToolView>>) -> bool {
    (match fact {
        SessionFact::Complete(tools) | SessionFact::Incomplete { facts: tools, .. } => {
            tools.len() <= MAX_TOOLS && tools.iter().all(valid_tool)
        }
        SessionFact::Unavailable | SessionFact::Unknown => true,
    }) && valid_gaps(fact)
}

fn valid_approvals_fact(fact: &SessionFact<Vec<ApprovalView>>) -> bool {
    (match fact {
        SessionFact::Complete(approvals)
        | SessionFact::Incomplete {
            facts: approvals, ..
        } => approvals.len() <= MAX_APPROVALS && approvals.iter().all(valid_approval),
        SessionFact::Unavailable | SessionFact::Unknown => true,
    }) && valid_gaps(fact)
}

fn valid_runtime_fact(fact: &SessionFact<RuntimeView>) -> bool {
    (match fact {
        SessionFact::Complete(runtime) | SessionFact::Incomplete { facts: runtime, .. } => {
            valid_runtime(runtime)
        }
        SessionFact::Unavailable | SessionFact::Unknown => true,
    }) && valid_gaps(fact)
}

fn valid_window_fact(fact: &SessionFact<SessionWindow>) -> bool {
    (match fact {
        SessionFact::Complete(window) | SessionFact::Incomplete { facts: window, .. } => {
            valid_window(window)
        }
        SessionFact::Unavailable | SessionFact::Unknown => true,
    }) && valid_gaps(fact)
}

fn valid_gaps<T>(fact: &SessionFact<T>) -> bool {
    match fact {
        SessionFact::Incomplete { gaps, .. } => {
            !gaps.is_empty()
                && gaps.len() <= MAX_MISSING_FACTS
                && gaps
                    .iter()
                    .enumerate()
                    .all(|(index, gap)| !gaps[..index].contains(gap))
        }
        SessionFact::Complete(_) | SessionFact::Unavailable | SessionFact::Unknown => true,
    }
}

fn valid_completeness(completeness: &SessionCompleteness) -> bool {
    match completeness {
        SessionCompleteness::Incomplete { missing } => {
            !missing.is_empty()
                && missing.len() <= MAX_MISSING_FACTS
                && missing
                    .iter()
                    .enumerate()
                    .all(|(index, gap)| !missing[..index].contains(gap))
        }
        SessionCompleteness::Complete
        | SessionCompleteness::Unavailable
        | SessionCompleteness::Unknown => true,
    }
}

fn valid_identity(identity: &SessionIdentity) -> bool {
    valid_id_with_limit(&identity.session_key, MAX_SESSION_KEY_BYTES)
        && valid_endpoint(&identity.endpoint)
        && identity.agent_id.as_deref().is_none_or(valid_id)
}

fn valid_session_model_state(model_state: &SessionModelState) -> bool {
    model_state
        .selected
        .as_ref()
        .is_none_or(valid_session_model_identity)
        && model_state
            .active
            .as_ref()
            .is_none_or(valid_session_model_identity)
        && model_state
            .selection_id
            .as_deref()
            .is_none_or(|selection_id| valid_id_with_limit(selection_id, MAX_SESSION_KEY_BYTES))
}

fn valid_session_model_identity(identity: &SessionModelIdentity) -> bool {
    identity
        .provider
        .as_deref()
        .is_none_or(|provider| valid_id_with_limit(provider, MAX_SESSION_KEY_BYTES))
        && valid_id_with_limit(&identity.model, MAX_SESSION_KEY_BYTES)
        && valid_id_with_limit(&identity.model_ref, MAX_SESSION_KEY_BYTES)
}

fn valid_endpoint(endpoint: &SessionEndpoint) -> bool {
    valid_id(&endpoint.kind) && valid_id(&endpoint.runtime_instance_id)
}

fn valid_epoch(epoch: u64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&epoch)
}

fn valid_item(item: &SessionItem) -> bool {
    match item {
        SessionItem::UserMessage {
            item_id,
            message_id,
            text,
            content,
            ..
        } => {
            valid_id(item_id)
                && message_id.as_deref().is_none_or(valid_id)
                && valid_payload_text(text, MAX_TEXT_BYTES)
                && content.len() <= MAX_SEGMENTS
                && content.iter().all(valid_content)
        }
        SessionItem::AssistantTurn {
            item_id,
            run_id,
            message_id,
            text,
            segments,
            ..
        } => {
            valid_id(item_id)
                && run_id.as_deref().is_none_or(valid_id)
                && message_id.as_deref().is_none_or(valid_id)
                && valid_payload_text(text, MAX_TEXT_BYTES)
                && segments.len() <= MAX_SEGMENTS
                && segments.iter().all(valid_content)
        }
        SessionItem::System { item_id, text, .. } => {
            valid_id(item_id) && valid_payload_text(text, MAX_TEXT_BYTES)
        }
    }
}

fn valid_content(content: &SessionContent) -> bool {
    match content {
        SessionContent::Text { text } | SessionContent::Thinking { text } => {
            valid_payload_text(text, MAX_TEXT_BYTES)
        }
        SessionContent::LargeText {
            text,
            content_ref,
            total_bytes,
            loaded_bytes,
        } => {
            valid_payload_text(text, MAX_TEXT_BYTES)
                && valid_id_with_limit(content_ref, MAX_CONTENT_REF_BYTES)
                && *loaded_bytes <= *total_bytes
                && *total_bytes <= MAX_SAFE_INTEGER
                && text.len() as u64 == *loaded_bytes
        }
        SessionContent::ToolUse { name, tool_call_id } => valid_id(name) && valid_id(tool_call_id),
        SessionContent::ToolResult {
            tool_call_id,
            summary,
            ..
        } => {
            valid_id(tool_call_id)
                && summary
                    .as_deref()
                    .is_none_or(|value| valid_payload_text(value, MAX_TEXT_BYTES))
        }
        SessionContent::Media {
            media_type,
            reference,
        } => media_type.as_deref().is_none_or(valid_id) && valid_id(reference),
        SessionContent::Omitted { .. } => true,
    }
}

fn valid_tool(tool: &ToolView) -> bool {
    valid_id(&tool.tool_call_id)
        && tool.run_id.as_deref().is_none_or(valid_id)
        && tool.name.as_deref().is_none_or(valid_id)
        && tool
            .input
            .as_ref()
            .is_none_or(|value| valid_payload(value, MAX_TEXT_BYTES))
        && tool
            .input_text
            .as_deref()
            .is_none_or(|value| valid_payload_text(value, MAX_TEXT_BYTES))
        && tool
            .summary
            .as_deref()
            .is_none_or(|value| valid_payload_text(value, MAX_TEXT_BYTES))
        && tool
            .output
            .as_ref()
            .is_none_or(|value| valid_payload(value, MAX_TEXT_BYTES))
        && tool
            .details
            .as_ref()
            .is_none_or(|value| valid_payload(value, MAX_TEXT_BYTES))
}

fn valid_approval(approval: &ApprovalView) -> bool {
    valid_id(&approval.approval_id)
        && approval.run_id.as_deref().is_none_or(valid_id)
        && approval.option_ids.len() <= MAX_APPROVALS
        && approval.option_ids.iter().all(|value| valid_id(value))
}

fn valid_runtime(runtime: &RuntimeView) -> bool {
    runtime.active_run_id.as_deref().is_none_or(valid_id)
        && runtime.run_progress.is_none_or(valid_run_progress)
        && runtime
            .error_detail
            .as_ref()
            .is_none_or(valid_runtime_error_detail)
}

fn valid_run_progress(progress: RunProgress) -> bool {
    match progress {
        RunProgress::Startup { .. } => true,
        RunProgress::Retrying {
            attempt,
            max_attempts,
        } => (1..=10).contains(&attempt) && attempt <= max_attempts && max_attempts <= 10,
    }
}

fn valid_runtime_notice(notice: &RuntimeNotice) -> bool {
    valid_id(&notice.run_id)
        && [
            notice.command.as_deref(),
            notice.risk_level.as_deref(),
            notice.rationale.as_deref(),
            notice.message.as_deref(),
        ]
        .into_iter()
        .flatten()
        .all(|text| text.len() <= 300 && !text.contains('\0'))
}

fn valid_runtime_error_detail(detail: &RuntimeErrorDetail) -> bool {
    [
        detail.failover_reason.as_deref(),
        detail.provider_runtime_failure_kind.as_deref(),
        detail.provider_error_type.as_deref(),
        detail.provider_error_message_preview.as_deref(),
    ]
    .into_iter()
    .flatten()
    .all(|text| text.len() <= 300 && !text.contains('\0'))
        && detail
            .http_status
            .is_none_or(|status| (100..=599).contains(&status))
}

fn valid_window(window: &SessionWindow) -> bool {
    window.total_item_count <= MAX_SAFE_INTEGER
        && window.window_start_offset <= window.window_end_offset
        && window.window_end_offset <= window.total_item_count
        && window.window_end_offset - window.window_start_offset <= MAX_ITEMS as u64
}

fn valid_route_key(value: &str) -> bool {
    value.starts_with("renderer-route:")
        && value.len() <= MAX_RENDERER_ROUTE_KEY_BYTES
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b':' | b'-' | b'_'))
}

pub fn public_media_reference(reference: &str) -> Option<String> {
    let value = reference.trim();
    if !valid_id_with_limit(value, MAX_CONTENT_REF_BYTES) {
        return None;
    }
    if value.starts_with(OUTGOING_MEDIA_PREFIX) {
        return Some(value.to_owned());
    }
    if value.starts_with(OUTGOING_MEDIA_PREFIX_WITHOUT_SLASH) {
        return Some(format!("/{value}"));
    }
    if !value.contains(['?', '#'])
        && (value.starts_with("https://") || value.starts_with("http://"))
    {
        return Some(value.to_owned());
    }
    valid_opaque_media_reference(value).then(|| value.to_owned())
}

fn valid_opaque_media_reference(value: &str) -> bool {
    let bytes = value.as_bytes();
    if matches!(bytes, [drive, b':', ..] if drive.is_ascii_alphabetic()) {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b':' | b'.'))
}

fn valid_id(value: &str) -> bool {
    valid_id_with_limit(value, MAX_ID_BYTES)
}

fn valid_id_with_limit(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_payload_text(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes && !value.chars().any(|character| character == '\0')
}

fn valid_payload(value: &Value, max_bytes: usize) -> bool {
    serde_json::to_string(value).is_ok_and(|text| text.len() <= max_bytes)
        && !payload_contains_nul(value)
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

fn valid_changes(changes: &[SessionChange], outer_run_id: Option<&str>) -> bool {
    changes
        .iter()
        .all(|change| valid_change(change, outer_run_id))
}

fn sole_change_run_id(changes: &[SessionChange]) -> Option<&str> {
    let mut run_id = None;
    for change in changes {
        let Some(change_run_id) = change_run_id(change) else {
            continue;
        };
        match run_id {
            Some(current) if current != change_run_id => return None,
            Some(_) => {}
            None => run_id = Some(change_run_id),
        }
    }
    run_id
}

fn change_run_id(change: &SessionChange) -> Option<&str> {
    match change {
        SessionChange::RunPhaseChanged { run_id, .. } => Some(run_id.as_str()),
        SessionChange::MessageDelta { run_id, .. } => run_id.as_deref(),
        SessionChange::MessageUpdated { item } => item.run_id(),
        SessionChange::MessageReplaced { item } => item.run_id(),
        SessionChange::ToolUpdated { tool } => tool.run_id.as_deref(),
        SessionChange::ApprovalUpdated { approval } => approval.run_id.as_deref(),
        SessionChange::RuntimeChanged { runtime } => runtime.active_run_id.as_deref(),
        SessionChange::RuntimeNoticeUpdated { notice } => Some(notice.run_id.as_str()),
        SessionChange::WindowChanged { .. } | SessionChange::RecoveryRequired { .. } => None,
    }
}

fn valid_change(change: &SessionChange, outer_run_id: Option<&str>) -> bool {
    let change_run_id = change_run_id(change);
    if outer_run_id
        .zip(change_run_id)
        .is_some_and(|(outer, change)| outer != change)
    {
        return false;
    }
    match change {
        SessionChange::RunPhaseChanged { run_id, .. } => valid_id(run_id),
        SessionChange::MessageDelta {
            item_id,
            message_id,
            text,
            ..
        } => {
            valid_id(item_id)
                && message_id.as_deref().is_none_or(valid_id)
                && valid_payload_text(text, MAX_TEXT_BYTES)
        }
        SessionChange::MessageUpdated { item } => valid_item(item),
        SessionChange::MessageReplaced { item } => valid_item(item),
        SessionChange::ToolUpdated { tool } => valid_tool(tool),
        SessionChange::ApprovalUpdated { approval } => valid_approval(approval),
        SessionChange::RuntimeChanged { runtime } => {
            (runtime.active_run_id.is_some() || terminal_run_phase(runtime.phase))
                && valid_runtime(runtime)
        }
        SessionChange::RuntimeNoticeUpdated { notice } => valid_runtime_notice(notice),
        SessionChange::WindowChanged { window } => valid_window(window),
        SessionChange::RecoveryRequired { .. } => true,
    }
}

pub fn terminal_run_phase(phase: RunPhase) -> bool {
    matches!(
        phase,
        RunPhase::Cancelled | RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted
    )
}

fn with_gap(mut gaps: Vec<MissingFact>, gap: MissingFact) -> Vec<MissingFact> {
    if !gaps.contains(&gap) && gaps.len() < MAX_MISSING_FACTS {
        gaps.push(gap);
    }
    gaps
}

fn add_missing(completeness: &SessionCompleteness, missing: &[MissingFact]) -> SessionCompleteness {
    match completeness {
        SessionCompleteness::Complete => SessionCompleteness::Incomplete {
            missing: missing.to_vec(),
        },
        SessionCompleteness::Incomplete { missing: current } => {
            let mut merged = current.clone();
            for gap in missing {
                if !merged.contains(gap) && merged.len() < MAX_MISSING_FACTS {
                    merged.push(*gap);
                }
            }
            SessionCompleteness::Incomplete { missing: merged }
        }
        SessionCompleteness::Unavailable => SessionCompleteness::Unavailable,
        SessionCompleteness::Unknown => SessionCompleteness::Unknown,
    }
}

fn incomplete_without_native_facts() -> SessionCompleteness {
    SessionCompleteness::Incomplete {
        missing: vec![
            MissingFact::Catalog,
            MissingFact::Usage,
            MissingFact::Artifacts,
            MissingFact::ContextTokens,
            MissingFact::Tasks,
            MissingFact::ReplayCursor,
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> SessionIdentity {
        SessionIdentity::new("session-1", SessionProvider::MatchaAgent, None)
            .expect("test identity")
    }

    fn message() -> SessionItem {
        message_with_ids("item-1", "run-1", "message-1", "hello")
    }

    fn message_with_ids(item_id: &str, run_id: &str, message_id: &str, text: &str) -> SessionItem {
        SessionItem::AssistantTurn {
            item_id: item_id.to_owned(),
            run_id: Some(run_id.to_owned()),
            message_id: Some(message_id.to_owned()),
            status: ItemStatus::Streaming,
            segments: vec![SessionContent::Text {
                text: text.to_owned(),
            }],
            text: text.to_owned(),
        }
    }

    fn tool(tool_call_id: &str, run_id: &str, name: Option<&str>, phase: ToolPhase) -> ToolView {
        ToolView {
            tool_call_id: tool_call_id.to_owned(),
            run_id: Some(run_id.to_owned()),
            name: name.map(str::to_owned),
            phase,
            input: None,
            input_text: None,
            summary: None,
            output: None,
            details: None,
            is_error: None,
        }
    }

    #[test]
    fn applies_ordered_delta_and_projects_view() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let result = state.apply(
            Some("renderer-route:test".to_owned()),
            Some("run-1".to_owned()),
            1,
            vec![SessionChange::MessageUpdated { item: message() }],
        );
        let SessionApplyResult::Applied(delta) = result else {
            panic!("expected applied delta")
        };
        assert_eq!(delta.seq(), 1);
        assert_eq!(delta.cursor(), 1);
        let view = state.view();
        assert!(matches!(
            view.items,
            SessionFact::Incomplete { ref facts, .. } if facts.len() == 1
        ));
    }

    #[test]
    fn native_bound_derives_outer_run_id_from_single_run_changes() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let binding =
            SessionEventBinding::new("session-1", Some("renderer-route:test".to_owned()), Some(1))
                .expect("binding");
        let result = state.apply_native_bound(
            binding,
            None,
            Some(1),
            vec![SessionChange::MessageDelta {
                item_id: "message-1".to_owned(),
                run_id: Some("run-1".to_owned()),
                message_id: Some("message-1".to_owned()),
                text: "hello".to_owned(),
                replace: false,
                status: ItemStatus::Streaming,
            }],
        );

        assert!(matches!(
            result,
            SessionApplyResult::Applied(SessionDelta { run_id: Some(ref run_id), .. }) if run_id == "run-1"
        ));
    }

    #[test]
    fn terminal_run_phase_marks_existing_assistant_item_terminal() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageDelta {
                    item_id: "message-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    message_id: Some("message-1".to_owned()),
                    text: "partial".to_owned(),
                    replace: false,
                    status: ItemStatus::Streaming,
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        let result = state.apply(
            None,
            Some("run-1".to_owned()),
            2,
            vec![SessionChange::RunPhaseChanged {
                run_id: "run-1".to_owned(),
                phase: RunPhase::Cancelled,
            }],
        );

        assert!(matches!(
            result,
            SessionApplyResult::Applied(SessionDelta { changes, .. })
                if matches!(
                    changes.as_slice(),
                    [
                        SessionChange::RunPhaseChanged { .. },
                        SessionChange::MessageUpdated {
                            item: SessionItem::AssistantTurn {
                                status: ItemStatus::Aborted,
                                text,
                                ..
                            }
                        }
                    ] if text == "partial"
                )
        ));
        assert!(matches!(
            state.view().items,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(
                    facts.as_slice(),
                    [SessionItem::AssistantTurn { status: ItemStatus::Aborted, text, .. }] if text == "partial"
                )
        ));
    }

    #[test]
    fn session_view_and_delta_use_public_camel_case_fields() {
        let view = SessionView {
            session_key: "session-1".to_owned(),
            endpoint_session_id: Some("endpoint-session-1".to_owned()),
            model_state: None,
            identity: identity(),
            epoch: 1,
            seq: 1,
            cursor: 1,
            items: SessionFact::Complete(vec![SessionItem::UserMessage {
                item_id: "item-1".to_owned(),
                message_id: Some("message-1".to_owned()),
                text: "hello".to_owned(),
                content: vec![
                    SessionContent::ToolUse {
                        name: "tool".to_owned(),
                        tool_call_id: "tool-1".to_owned(),
                    },
                    SessionContent::ToolResult {
                        tool_call_id: "tool-1".to_owned(),
                        summary: Some("done".to_owned()),
                        is_error: false,
                    },
                    SessionContent::Thinking {
                        text: "private view thinking".to_owned(),
                    },
                    SessionContent::Media {
                        media_type: Some("image/png".to_owned()),
                        reference: "C:private.png".to_owned(),
                    },
                    SessionContent::Media {
                        media_type: Some("image".to_owned()),
                        reference: "media-1".to_owned(),
                    },
                ],
                status: ItemStatus::Final,
            }]),
            tools: SessionFact::Complete(vec![ToolView {
                tool_call_id: "tool-1".to_owned(),
                run_id: Some("run-1".to_owned()),
                name: Some("tool".to_owned()),
                phase: ToolPhase::Completed,
                input: Some(serde_json::json!({"path":"src/main.rs"})),
                input_text: Some("{\n  \"path\": \"src/main.rs\"\n}".to_owned()),
                summary: Some("done".to_owned()),
                output: Some(serde_json::json!({"ok":true})),
                details: Some(serde_json::json!({"rows":1})),
                is_error: Some(false),
            }]),
            approvals: SessionFact::Complete(Vec::new()),
            runtime: SessionFact::Complete(RuntimeView {
                phase: RunPhase::Completed,
                active_run_id: None,
                issue: None,
                run_progress: None,
                runtime_activity: None,
                error_detail: None,
            }),
            window: SessionFact::Complete(SessionWindow::latest(1)),
            completeness: SessionCompleteness::Complete,
        };
        let encoded = serde_json::to_value(&view).unwrap();
        let item = &encoded["items"]["complete"][0];
        assert_eq!(item["itemId"], "item-1");
        assert_eq!(item["messageId"], "message-1");
        assert_eq!(item["content"][0]["toolCallId"], "tool-1");
        assert_eq!(item["content"][1]["isError"], false);
        assert_eq!(item["content"][2]["kind"], "thinking");
        assert_eq!(item["content"][2]["text"], "private view thinking");
        assert_eq!(item["content"][3]["kind"], "omitted");
        assert_eq!(item["content"][3]["reason"], "unsafe_media");
        assert_eq!(item["content"][4]["mediaType"], "image");
        assert_eq!(
            encoded["tools"]["complete"][0]["input"]["path"],
            "src/main.rs"
        );
        assert_eq!(encoded["tools"]["complete"][0]["output"]["ok"], true);
        assert_eq!(encoded["tools"]["complete"][0]["details"]["rows"], 1);
        let rendered = encoded.to_string();
        assert!(rendered.contains("toolCallId"));
        assert!(!rendered.contains("tool_call_id"));
        assert!(!rendered.contains("item_id"));
        assert!(!rendered.contains("C:private.png"));

        let delta = SessionDelta {
            session_key: "session-1".to_owned(),
            route_key: None,
            epoch: 1,
            seq: 1,
            cursor: 1,
            run_id: Some("run-1".to_owned()),
            changes: vec![
                SessionChange::MessageDelta {
                    item_id: "item-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    message_id: Some("message-1".to_owned()),
                    text: "hello".to_owned(),
                    replace: false,
                    status: ItemStatus::Streaming,
                },
                SessionChange::MessageUpdated {
                    item: SessionItem::AssistantTurn {
                        item_id: "assistant-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        message_id: Some("message-2".to_owned()),
                        status: ItemStatus::Streaming,
                        segments: vec![SessionContent::Thinking {
                            text: "private thinking".to_owned(),
                        }],
                        text: String::new(),
                    },
                },
                SessionChange::ToolUpdated {
                    tool: ToolView {
                        tool_call_id: "tool-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        name: Some("Read".to_owned()),
                        phase: ToolPhase::Completed,
                        input: Some(serde_json::json!({ "path": "C:/private/file" })),
                        input_text: Some("private input".to_owned()),
                        summary: Some("read complete".to_owned()),
                        output: Some(serde_json::json!({ "secret": true })),
                        details: Some(serde_json::json!({ "raw": "native" })),
                        is_error: Some(false),
                    },
                },
                SessionChange::RuntimeChanged {
                    runtime: RuntimeView {
                        phase: RunPhase::Failed,
                        active_run_id: Some("run-1".to_owned()),
                        issue: None,
                        run_progress: None,
                        runtime_activity: None,
                        error_detail: Some(RuntimeErrorDetail {
                            kind: RuntimeErrorKind::Fallback,
                            failover_reason: Some("private failover".to_owned()),
                            provider_runtime_failure_kind: None,
                            provider_error_type: None,
                            provider_error_message_preview: Some(
                                "private provider error".to_owned(),
                            ),
                            http_status: Some(500),
                        }),
                    },
                },
                SessionChange::RuntimeNoticeUpdated {
                    notice: RuntimeNotice {
                        run_id: "run-1".to_owned(),
                        kind: RuntimeNoticeKind::GuardianWarning,
                        command: Some("private command".to_owned()),
                        risk_level: Some("high".to_owned()),
                        rationale: Some("private rationale".to_owned()),
                        message: Some("private notice".to_owned()),
                    },
                },
            ],
        };
        let encoded = serde_json::to_value(&delta).unwrap();
        let change = &encoded["changes"][0];
        assert_eq!(change["itemId"], "item-1");
        assert_eq!(change["runId"], "run-1");
        assert_eq!(change["messageId"], "message-1");
        assert_eq!(
            encoded["changes"][1]["item"]["segments"][0]["kind"],
            "thinking"
        );
        assert_eq!(
            encoded["changes"][1]["item"]["segments"][0]["text"],
            "private thinking"
        );
        assert_eq!(
            encoded["changes"][2]["tool"]["input"]["path"],
            "C:/private/file"
        );
        assert_eq!(encoded["changes"][2]["tool"]["inputText"], "private input");
        assert_eq!(encoded["changes"][2]["tool"]["summary"], "read complete");
        assert_eq!(encoded["changes"][2]["tool"]["output"]["secret"], true);
        assert_eq!(encoded["changes"][2]["tool"]["details"]["raw"], "native");
        assert_eq!(
            encoded["changes"][3]["runtime"]["errorDetail"]["kind"],
            "fallback"
        );
        assert_eq!(
            encoded["changes"][3]["runtime"]["errorDetail"]["failoverReason"],
            "private failover"
        );
        assert_eq!(
            encoded["changes"][3]["runtime"]["errorDetail"]["providerErrorMessagePreview"],
            "private provider error"
        );
        assert_eq!(
            encoded["changes"][3]["runtime"]["errorDetail"]["httpStatus"],
            500
        );
        assert_eq!(
            encoded["changes"][4]["notice"]["command"],
            "private command"
        );
        assert_eq!(encoded["changes"][4]["notice"]["message"], "private notice");
        let rendered = encoded.to_string();
        assert!(!rendered.contains("message_id"));
        assert!(rendered.contains("private rationale"));
    }

    #[test]
    fn delta_validates_run_phase_changed_with_outer_run_id() {
        let delta = SessionDelta {
            session_key: "session-1".to_owned(),
            route_key: Some("renderer-route:test".to_owned()),
            epoch: 1,
            seq: 1,
            cursor: 1,
            run_id: Some("ack-run-1".to_owned()),
            changes: vec![SessionChange::RunPhaseChanged {
                run_id: "ack-run-1".to_owned(),
                phase: RunPhase::Started,
            }],
        };

        assert_eq!(delta.validate(), Ok(()));
    }

    #[test]
    fn rejected_runtime_failure_can_project_failed_error_state() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let result = state.apply(
            None,
            Some("ack-run-1".to_owned()),
            1,
            vec![
                SessionChange::MessageDelta {
                    item_id: "item-1".to_owned(),
                    run_id: Some("ack-run-1".to_owned()),
                    message_id: Some("message-1".to_owned()),
                    text: "target rejected".to_owned(),
                    replace: true,
                    status: ItemStatus::Error,
                },
                SessionChange::RuntimeChanged {
                    runtime: RuntimeView {
                        phase: RunPhase::Failed,
                        active_run_id: Some("ack-run-1".to_owned()),
                        issue: Some(RuntimeIssue::Rejected),
                        run_progress: None,
                        runtime_activity: None,
                        error_detail: None,
                    },
                },
            ],
        );

        assert!(matches!(
            result,
            SessionApplyResult::Applied(ref delta) if delta.validate().is_ok()
        ));
        assert!(matches!(
            state.view().runtime,
            SessionFact::Incomplete {
                facts: RuntimeView {
                    phase: RunPhase::Failed,
                    active_run_id: None,
                    issue: Some(RuntimeIssue::Rejected),
                    ..
                },
                ..
            }
        ));
        assert!(matches!(
            state.view().items,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(
                    facts.as_slice(),
                    [SessionItem::AssistantTurn {
                        run_id: Some(run_id),
                        status: ItemStatus::Error,
                        ..
                    }] if run_id == "ack-run-1"
                )
        ));
    }

    #[test]
    fn terminal_runtime_change_clears_active_run_and_closes_run() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let result = state.apply(
            None,
            Some("run-1".to_owned()),
            1,
            vec![SessionChange::RuntimeChanged {
                runtime: RuntimeView {
                    phase: RunPhase::Failed,
                    active_run_id: Some("run-1".to_owned()),
                    issue: None,
                    run_progress: None,
                    runtime_activity: None,
                    error_detail: Some(RuntimeErrorDetail {
                        kind: RuntimeErrorKind::Error,
                        failover_reason: Some("auth_error".to_owned()),
                        provider_runtime_failure_kind: None,
                        provider_error_type: Some("authentication".to_owned()),
                        provider_error_message_preview: Some("invalid key".to_owned()),
                        http_status: Some(401),
                    }),
                },
            }],
        );

        assert!(matches!(result, SessionApplyResult::Applied(_)));
        assert!(matches!(
            state.view().runtime,
            SessionFact::Incomplete {
                facts: RuntimeView {
                    phase: RunPhase::Failed,
                    active_run_id: None,
                    error_detail: Some(_),
                    ..
                },
                ..
            }
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::MessageDelta {
                    item_id: "assistant-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    message_id: None,
                    text: "late".to_owned(),
                    replace: false,
                    status: ItemStatus::Streaming,
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange
            }
        ));
    }

    #[test]
    fn rejects_duplicate_gap_and_partial_batch_without_mutating_state() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let change = vec![SessionChange::MessageUpdated { item: message() }];
        assert!(matches!(
            state.apply(None, Some("run-1".to_owned()), 2, change.clone()),
            SessionApplyResult::Gap {
                expected: 1,
                received: 2
            }
        ));
        assert!(matches!(
            state.apply(None, Some("run-1".to_owned()), 1, change.clone()),
            SessionApplyResult::Applied(_)
        ));
        assert!(matches!(
            state.apply(None, Some("run-1".to_owned()), 1, change),
            SessionApplyResult::Duplicate { cursor: 1 }
        ));
        let invalid = SessionItem::System {
            item_id: "bad\nitem".to_owned(),
            text: "not applied".to_owned(),
            status: ItemStatus::Final,
        };
        assert!(matches!(
            state.apply(
                None,
                None,
                2,
                vec![
                    SessionChange::MessageUpdated { item: message() },
                    SessionChange::MessageUpdated { item: invalid },
                ],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput
            }
        ));
        assert_eq!(state.cursor(), 1);
    }

    #[test]
    fn conflicting_fingerprint_for_advanced_cursor_is_not_stale() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageUpdated { item: message() }],
            ),
            SessionApplyResult::Applied(_)
        ));
        assert!(matches!(
            state.apply(
                None,
                None,
                2,
                vec![SessionChange::WindowChanged {
                    window: SessionWindow::latest(1),
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageUpdated {
                    item: message_with_ids("item-1", "run-1", "message-1", "different"),
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::CursorConflict { cursor: 1 }
            }
        ));
        assert_eq!(state.cursor(), 2);
        assert_eq!(state.seq(), 2);
    }

    #[test]
    fn epoch_getter_is_read_only() {
        let state = SessionState::new(identity(), 7).expect("state");
        assert_eq!(state.epoch(), 7);
        assert_eq!(state.epoch(), 7);
        assert_eq!(state.cursor(), 0);
        assert_eq!(state.seq(), 0);
    }

    #[test]
    fn event_changes_degrade_global_completeness() {
        let facts = SessionFacts {
            items: SessionFact::Complete(Vec::new()),
            tools: SessionFact::Complete(Vec::new()),
            approvals: SessionFact::Complete(Vec::new()),
            runtime: SessionFact::Complete(RuntimeView {
                phase: RunPhase::Queued,
                active_run_id: None,
                issue: None,
                run_progress: None,
                runtime_activity: None,
                error_detail: None,
            }),
            window: SessionFact::Complete(SessionWindow::latest(0)),
            completeness: SessionCompleteness::Complete,
        };
        let mut state = SessionState::from_facts(identity(), 1, 0, facts).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageUpdated { item: message() }],
            ),
            SessionApplyResult::Applied(_)
        ));
        assert!(matches!(
            state.view().completeness,
            SessionCompleteness::Incomplete { ref missing }
                if missing.contains(&MissingFact::EventOnly)
        ));
    }

    #[test]
    fn seq_is_accepted_delta_count_independent_of_source_cursor() {
        let mut state =
            SessionState::from_facts(identity(), 1, 6, SessionFacts::unknown()).expect("state");
        assert_eq!(state.seq(), 0);
        assert_eq!(state.cursor(), 6);
        let first = state.apply(
            None,
            Some("run-1".to_owned()),
            7,
            vec![SessionChange::MessageUpdated { item: message() }],
        );
        assert!(
            matches!(first, SessionApplyResult::Applied(ref delta) if delta.seq() == 1 && delta.cursor() == 7)
        );
        let second = state.apply(
            None,
            Some("run-1".to_owned()),
            8,
            vec![SessionChange::WindowChanged {
                window: SessionWindow::latest(1),
            }],
        );
        assert!(
            matches!(second, SessionApplyResult::Applied(ref delta) if delta.seq() == 2 && delta.cursor() == 8)
        );
        assert_eq!(state.seq(), 2);
        assert_eq!(state.cursor(), 8);
    }

    #[test]
    fn replacement_uses_item_identity_not_run_identity() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageUpdated {
                    item: message_with_ids("item-1", "run-1", "message-1", "one"),
                }],
            ),
            SessionApplyResult::Applied(_)
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::MessageUpdated {
                    item: message_with_ids("item-2", "run-1", "message-2", "two"),
                }],
            ),
            SessionApplyResult::Applied(_)
        ));
        let SessionFact::Incomplete { facts, .. } = state.view().items else {
            panic!("expected incomplete item facts")
        };
        assert_eq!(facts.len(), 2);
    }

    #[test]
    fn terminal_run_fence_rejects_scoped_mutations() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::RunPhaseChanged {
                    run_id: "run-1".to_owned(),
                    phase: RunPhase::Completed,
                }],
            ),
            SessionApplyResult::Applied(_)
        ));
        let stale_item = message_with_ids("item-1", "run-1", "message-1", "late");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::MessageUpdated { item: stale_item }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange
            }
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::RunPhaseChanged {
                    run_id: "run-1".to_owned(),
                    phase: RunPhase::Started,
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange
            }
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::ToolUpdated {
                    tool: ToolView {
                        tool_call_id: "tool-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        name: Some("tool".to_owned()),
                        phase: ToolPhase::Started,
                        input: None,
                        input_text: None,
                        summary: None,
                        output: None,
                        details: None,
                        is_error: None,
                    },
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange
            }
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::ApprovalUpdated {
                    approval: ApprovalView {
                        approval_id: "approval-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        phase: ApprovalPhase::Requested,
                        option_ids: Vec::new(),
                    },
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange
            }
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::RuntimeChanged {
                    runtime: RuntimeView {
                        phase: RunPhase::Started,
                        active_run_id: Some("run-1".to_owned()),
                        issue: None,
                        run_progress: None,
                        runtime_activity: None,
                        error_detail: None,
                    },
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange
            }
        ));
        assert!(matches!(
            state.apply(
                None,
                None,
                2,
                vec![SessionChange::RuntimeChanged {
                    runtime: RuntimeView {
                        phase: RunPhase::Completed,
                        active_run_id: None,
                        issue: None,
                        run_progress: None,
                        runtime_activity: None,
                        error_detail: None,
                    },
                }],
            ),
            SessionApplyResult::Applied(_)
        ));
        assert_eq!(state.cursor(), 2);
    }

    #[test]
    fn outer_run_binding_must_match_when_change_binding_is_present() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageUpdated {
                    item: message_with_ids("item-1", "run-2", "message-1", "mismatch"),
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput
            }
        ));
    }

    #[test]
    fn tool_update_anchors_an_assistant_turn_for_live_projection() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let result = state.apply(
            None,
            Some("run-1".to_owned()),
            1,
            vec![SessionChange::ToolUpdated {
                tool: ToolView {
                    tool_call_id: "tool-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    name: Some("read".to_owned()),
                    phase: ToolPhase::Started,
                    input: None,
                    input_text: None,
                    summary: None,
                    output: None,
                    details: None,
                    is_error: None,
                },
            }],
        );
        let SessionApplyResult::Applied(delta) = result else {
            panic!("expected applied delta")
        };

        assert!(matches!(
            delta.changes.as_slice(),
            [
                SessionChange::ToolUpdated { tool },
                SessionChange::MessageUpdated {
                    item: SessionItem::AssistantTurn {
                        item_id,
                        run_id: Some(run_id),
                        segments,
                        ..
                    }
                }
            ] if tool.tool_call_id == "tool-1"
                && tool.name.as_deref() == Some("read")
                && item_id == "run-1"
                && run_id == "run-1"
                && matches!(
                    segments.as_slice(),
                    [SessionContent::ToolUse { name, tool_call_id }]
                        if name == "read" && tool_call_id == "tool-1"
                )
        ));
        assert!(matches!(
            state.view().tools,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(facts.as_slice(), [tool] if tool.tool_call_id == "tool-1")
        ));
        assert!(matches!(
            state.view().items,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(
                    facts.as_slice(),
                    [SessionItem::AssistantTurn { segments, .. }]
                        if matches!(
                            segments.as_slice(),
                            [SessionContent::ToolUse { name, tool_call_id }]
                                if name == "read" && tool_call_id == "tool-1"
                        )
                )
        ));
    }

    #[test]
    fn sparse_tool_update_keeps_existing_payload() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::ToolUpdated {
                    tool: ToolView {
                        tool_call_id: "tool-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        name: Some("read".to_owned()),
                        phase: ToolPhase::Started,
                        input: Some(serde_json::json!({"file_path":"src/main.rs"})),
                        input_text: Some("{\"file_path\":\"src/main.rs\"}".to_owned()),
                        summary: None,
                        output: None,
                        details: Some(serde_json::json!({"rows":1})),
                        is_error: None,
                    },
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        let result = state.apply(
            None,
            Some("run-1".to_owned()),
            2,
            vec![SessionChange::ToolUpdated {
                tool: ToolView {
                    tool_call_id: "tool-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    name: None,
                    phase: ToolPhase::Completed,
                    input: None,
                    input_text: None,
                    summary: Some("done".to_owned()),
                    output: Some(serde_json::json!({"ok":true})),
                    details: None,
                    is_error: Some(false),
                },
            }],
        );

        let SessionApplyResult::Applied(delta) = result else {
            panic!("expected applied delta")
        };
        assert!(matches!(
            delta.changes.as_slice(),
            [SessionChange::ToolUpdated { tool }, SessionChange::MessageUpdated { .. }]
                if tool.tool_call_id == "tool-1"
                    && tool.name.as_deref() == Some("read")
                    && tool.input == Some(serde_json::json!({"file_path":"src/main.rs"}))
                    && tool.input_text.as_deref() == Some("{\"file_path\":\"src/main.rs\"}")
                    && tool.summary.as_deref() == Some("done")
                    && tool.output == Some(serde_json::json!({"ok":true}))
                    && tool.details == Some(serde_json::json!({"rows":1}))
                    && tool.is_error == Some(false)
        ));
    }

    #[test]
    fn same_run_accepts_distinct_assistant_messages() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageDelta {
                    item_id: "message-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    message_id: Some("message-1".to_owned()),
                    text: "before tool".to_owned(),
                    replace: false,
                    status: ItemStatus::Final,
                }],
            ),
            SessionApplyResult::Applied(_)
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::ToolUpdated {
                    tool: ToolView {
                        tool_call_id: "tool-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        name: Some("read".to_owned()),
                        phase: ToolPhase::Completed,
                        input: None,
                        input_text: None,
                        summary: Some("done".to_owned()),
                        output: Some(serde_json::json!({"ok":true})),
                        details: None,
                        is_error: Some(false),
                    },
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        let result = state.apply(
            None,
            Some("run-1".to_owned()),
            3,
            vec![SessionChange::MessageDelta {
                item_id: "message-2".to_owned(),
                run_id: Some("run-1".to_owned()),
                message_id: Some("message-2".to_owned()),
                text: "after tool".to_owned(),
                replace: false,
                status: ItemStatus::Final,
            }],
        );

        assert!(matches!(result, SessionApplyResult::Applied(_)));
        assert!(matches!(
            state.view().items,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(
                    facts.as_slice(),
                    [
                        SessionItem::AssistantTurn { message_id: Some(first), text: first_text, .. },
                        SessionItem::AssistantTurn { message_id: Some(second), text: second_text, .. },
                    ] if first == "message-1"
                        && first_text == "before tool"
                        && second == "message-2"
                        && second_text == "after tool"
                )
        ));
    }

    #[test]
    fn message_delta_preserves_live_tool_anchor() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::ToolUpdated {
                    tool: ToolView {
                        tool_call_id: "tool-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        name: Some("read".to_owned()),
                        phase: ToolPhase::Started,
                        input: None,
                        input_text: None,
                        summary: None,
                        output: None,
                        details: None,
                        is_error: None,
                    },
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        let result = state.apply(
            None,
            Some("run-1".to_owned()),
            2,
            vec![SessionChange::MessageDelta {
                item_id: "message-1".to_owned(),
                run_id: Some("run-1".to_owned()),
                message_id: Some("message-1".to_owned()),
                text: "hello".to_owned(),
                replace: false,
                status: ItemStatus::Streaming,
            }],
        );
        let SessionApplyResult::Applied(delta) = result else {
            panic!("expected applied delta")
        };

        assert!(matches!(
            delta.changes.as_slice(),
            [SessionChange::MessageUpdated {
                item: SessionItem::AssistantTurn {
                    item_id,
                    run_id: Some(run_id),
                    message_id: Some(message_id),
                    text,
                    segments,
                    ..
                }
            }] if item_id == "run-1"
                && run_id == "run-1"
                && message_id == "message-1"
                && text == "hello"
                && matches!(
                    segments.as_slice(),
                    [
                        SessionContent::ToolUse { name, tool_call_id },
                        SessionContent::Text { text }
                    ] if text == "hello" && name == "read" && tool_call_id == "tool-1"
                )
        ));
    }

    #[test]
    fn message_delta_preserves_tool_anchor_position_between_text_segments() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageDelta {
                    item_id: "message-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    message_id: Some("message-1".to_owned()),
                    text: "A".to_owned(),
                    replace: false,
                    status: ItemStatus::Streaming,
                }],
            ),
            SessionApplyResult::Applied(_)
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::ToolUpdated {
                    tool: tool("tool-1", "run-1", Some("write"), ToolPhase::Started),
                }],
            ),
            SessionApplyResult::Applied(_)
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                3,
                vec![SessionChange::MessageDelta {
                    item_id: "message-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    message_id: Some("message-1".to_owned()),
                    text: "B".to_owned(),
                    replace: false,
                    status: ItemStatus::Streaming,
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        assert!(matches!(
            state.view().items,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(
                    facts.as_slice(),
                    [SessionItem::AssistantTurn { text, segments, .. }]
                        if text == "AB"
                            && matches!(
                                segments.as_slice(),
                                [
                                    SessionContent::Text { text: before },
                                    SessionContent::ToolUse { name, tool_call_id },
                                    SessionContent::Text { text: after },
                                ] if before == "A"
                                    && name == "write"
                                    && tool_call_id == "tool-1"
                                    && after == "B"
                            )
                )
        ));
    }

    #[test]
    fn completed_tool_update_does_not_move_anchor_after_later_text() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageUpdated {
                    item: SessionItem::AssistantTurn {
                        item_id: "message-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        message_id: Some("message-1".to_owned()),
                        status: ItemStatus::Streaming,
                        segments: vec![
                            SessionContent::Thinking {
                                text: "thinking".to_owned(),
                            },
                            SessionContent::Text {
                                text: "A".to_owned(),
                            },
                            SessionContent::ToolUse {
                                name: "write".to_owned(),
                                tool_call_id: "tool-1".to_owned(),
                            },
                            SessionContent::Text {
                                text: "B".to_owned(),
                            },
                        ],
                        text: "AB".to_owned(),
                    },
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::ToolUpdated {
                    tool: tool("tool-1", "run-1", Some("write"), ToolPhase::Started),
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        let result = state.apply(
            None,
            Some("run-1".to_owned()),
            3,
            vec![SessionChange::ToolUpdated {
                tool: ToolView {
                    summary: Some("done".to_owned()),
                    output: Some(serde_json::json!({"ok":true})),
                    details: None,
                    is_error: Some(false),
                    ..tool("tool-1", "run-1", None, ToolPhase::Completed)
                },
            }],
        );

        assert!(matches!(result, SessionApplyResult::Applied(_)));
        assert!(matches!(
            state.view().items,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(
                    facts.as_slice(),
                    [SessionItem::AssistantTurn { text, segments, .. }]
                        if text == "AB"
                            && matches!(
                                segments.as_slice(),
                                [
                                    SessionContent::Thinking { text: thinking },
                                    SessionContent::Text { text: before },
                                    SessionContent::ToolUse { name, tool_call_id },
                                    SessionContent::Text { text: after },
                                ] if thinking == "thinking"
                                    && before == "A"
                                    && name == "write"
                                    && tool_call_id == "tool-1"
                                    && after == "B"
                            )
                )
        ));
        assert!(matches!(
            state.view().tools,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(
                    facts.as_slice(),
                    [tool] if tool.tool_call_id == "tool-1"
                        && tool.name.as_deref() == Some("write")
                        && tool.phase == ToolPhase::Completed
                        && tool.summary.as_deref() == Some("done")
                        && tool.output == Some(serde_json::json!({"ok":true}))
                        && tool.is_error == Some(false)
                )
        ));
    }

    #[test]
    fn openclaw_tool_delta_result_terminal_projection_keeps_text_and_tool_segment() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::ToolUpdated {
                    tool: ToolView {
                        tool_call_id: "tool-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        name: Some("read".to_owned()),
                        phase: ToolPhase::Started,
                        input: None,
                        input_text: None,
                        summary: None,
                        output: None,
                        details: None,
                        is_error: None,
                    },
                }],
            ),
            SessionApplyResult::Applied(_)
        ));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                2,
                vec![SessionChange::MessageDelta {
                    item_id: "message-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    message_id: Some("message-1".to_owned()),
                    text: "hello".to_owned(),
                    replace: false,
                    status: ItemStatus::Streaming,
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        let tool_result = state.apply(
            None,
            Some("run-1".to_owned()),
            3,
            vec![SessionChange::ToolUpdated {
                tool: ToolView {
                    tool_call_id: "tool-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    name: None,
                    phase: ToolPhase::Completed,
                    input: None,
                    input_text: None,
                    summary: Some("done".to_owned()),
                    output: None,
                    details: None,
                    is_error: Some(false),
                },
            }],
        );
        assert!(matches!(
            tool_result,
            SessionApplyResult::Applied(SessionDelta { changes, .. })
                if matches!(
                    changes.as_slice(),
                    [
                        SessionChange::ToolUpdated { tool },
                        SessionChange::MessageUpdated {
                            item: SessionItem::AssistantTurn { text, segments, .. }
                        },
                    ] if tool.phase == ToolPhase::Completed
                        && tool.name.as_deref() == Some("read")
                        && tool.summary.as_deref() == Some("done")
                        && text == "hello"
                        && matches!(
                            segments.as_slice(),
                            [
                                SessionContent::ToolUse { name, tool_call_id },
                                SessionContent::Text { text },
                            ] if text == "hello" && name == "read" && tool_call_id == "tool-1"
                        )
                )
        ));

        let terminal = state.apply(
            None,
            Some("run-1".to_owned()),
            4,
            vec![SessionChange::RunPhaseChanged {
                run_id: "run-1".to_owned(),
                phase: RunPhase::Completed,
            }],
        );
        assert!(matches!(
            terminal,
            SessionApplyResult::Applied(SessionDelta { changes, .. })
                if matches!(
                    changes.as_slice(),
                    [
                        SessionChange::RunPhaseChanged { phase: RunPhase::Completed, .. },
                        SessionChange::MessageUpdated {
                            item: SessionItem::AssistantTurn {
                                status: ItemStatus::Final,
                                text,
                                segments,
                                ..
                            }
                        },
                    ] if text == "hello"
                        && matches!(
                            segments.as_slice(),
                            [
                                SessionContent::ToolUse { name, tool_call_id },
                                SessionContent::Text { text },
                            ] if text == "hello" && name == "read" && tool_call_id == "tool-1"
                        )
                )
        ));
        assert!(matches!(
            state.view().items,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(
                    facts.as_slice(),
                    [SessionItem::AssistantTurn {
                        status: ItemStatus::Final,
                        text,
                        segments,
                        ..
                    }] if text == "hello"
                        && matches!(
                            segments.as_slice(),
                            [
                                SessionContent::ToolUse { name, tool_call_id },
                                SessionContent::Text { text },
                            ] if text == "hello" && name == "read" && tool_call_id == "tool-1"
                        )
                )
        ));
    }

    #[test]
    fn message_updated_replaces_tool_anchor_without_reordering_segments() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::ToolUpdated {
                    tool: ToolView {
                        tool_call_id: "tool-1".to_owned(),
                        run_id: Some("run-1".to_owned()),
                        name: Some("read".to_owned()),
                        phase: ToolPhase::Started,
                        input: None,
                        input_text: None,
                        summary: None,
                        output: None,
                        details: None,
                        is_error: None,
                    },
                }],
            ),
            SessionApplyResult::Applied(_)
        ));

        let ordered = SessionItem::AssistantTurn {
            item_id: "message-1".to_owned(),
            run_id: Some("run-1".to_owned()),
            message_id: Some("message-1".to_owned()),
            status: ItemStatus::Streaming,
            segments: vec![
                SessionContent::Text {
                    text: "before tool".to_owned(),
                },
                SessionContent::ToolUse {
                    name: "read".to_owned(),
                    tool_call_id: "tool-1".to_owned(),
                },
                SessionContent::Text {
                    text: "after tool".to_owned(),
                },
            ],
            text: "before tool after tool".to_owned(),
        };
        let result = state.apply(
            None,
            Some("run-1".to_owned()),
            2,
            vec![SessionChange::MessageUpdated { item: ordered }],
        );
        let SessionApplyResult::Applied(delta) = result else {
            panic!("expected applied delta")
        };

        assert!(matches!(
            delta.changes.as_slice(),
            [SessionChange::MessageUpdated {
                item: SessionItem::AssistantTurn { item_id, segments, .. }
            }] if item_id == "message-1"
                && matches!(
                    segments.as_slice(),
                    [
                        SessionContent::Text { text: before },
                        SessionContent::ToolUse { name, tool_call_id },
                        SessionContent::Text { text: after },
                    ] if before == "before tool"
                        && name == "read"
                        && tool_call_id == "tool-1"
                        && after == "after tool"
                )
        ));
        assert!(matches!(
            state.view().items,
            SessionFact::Incomplete { ref facts, .. }
                if matches!(
                    facts.as_slice(),
                    [SessionItem::AssistantTurn { item_id, segments, .. }]
                        if item_id == "message-1"
                            && matches!(
                                segments.as_slice(),
                                [
                                    SessionContent::Text { text: before },
                                    SessionContent::ToolUse { name, tool_call_id },
                                    SessionContent::Text { text: after },
                                ] if before == "before tool"
                                    && name == "read"
                                    && tool_call_id == "tool-1"
                                    && after == "after tool"
                            )
                )
        ));
    }

    #[test]
    fn native_cursor_is_separate_from_host_cursor_and_seq() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let binding =
            SessionEventBinding::new("session-1", Some("renderer-route:test".to_owned()), Some(7))
                .expect("binding");
        let first = state.apply_native_bound(
            binding.clone(),
            Some("run-1".to_owned()),
            Some(41),
            vec![SessionChange::MessageUpdated { item: message() }],
        );
        assert!(matches!(
            first,
            SessionApplyResult::Applied(ref delta) if delta.seq() == 1 && delta.cursor() == 1
        ));
        assert_eq!(state.seq(), 1);
        assert_eq!(state.cursor(), 1);
        assert_eq!(state.native_cursor, Some(41));
        assert_eq!(state.native_source_epoch, Some(7));

        let second = state.apply_native_bound(
            binding,
            Some("run-1".to_owned()),
            Some(44),
            vec![SessionChange::WindowChanged {
                window: SessionWindow::latest(1),
            }],
        );
        assert!(matches!(
            second,
            SessionApplyResult::Applied(ref delta) if delta.seq() == 2 && delta.cursor() == 2
        ));
        assert_eq!(state.seq(), 2);
        assert_eq!(state.cursor(), 2);
        assert_eq!(state.native_cursor, Some(44));
    }

    #[test]
    fn native_gap_is_checked_only_for_explicitly_contiguous_binding() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let first_binding =
            SessionEventBinding::new_contiguous("session-1", None, Some(3)).expect("binding");
        assert!(matches!(
            state.apply_native_bound(
                first_binding,
                Some("run-1".to_owned()),
                Some(10),
                vec![SessionChange::MessageUpdated { item: message() }],
            ),
            SessionApplyResult::Applied(_)
        ));
        let gap_binding =
            SessionEventBinding::new_contiguous("session-1", None, Some(3)).expect("binding");
        assert!(matches!(
            state.apply_native_bound(
                gap_binding,
                Some("run-1".to_owned()),
                Some(12),
                vec![SessionChange::WindowChanged {
                    window: SessionWindow::latest(1),
                }],
            ),
            SessionApplyResult::Gap {
                expected: 11,
                received: 12,
            }
        ));
        assert_eq!(state.cursor(), 1);
        assert_eq!(state.seq(), 1);
    }

    #[test]
    fn native_epoch_change_is_rejected_without_fabricating_an_epoch() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let first_binding = SessionEventBinding::new("session-1", None, None).expect("binding");
        assert!(matches!(
            state.apply_native_bound(
                first_binding,
                Some("run-1".to_owned()),
                Some(4),
                vec![SessionChange::MessageUpdated { item: message() }],
            ),
            SessionApplyResult::Applied(_)
        ));
        assert_eq!(state.native_source_epoch, None);

        let changed_binding =
            SessionEventBinding::new("session-1", None, Some(9)).expect("binding");
        assert!(matches!(
            state.apply_native_bound(
                changed_binding,
                Some("run-1".to_owned()),
                Some(5),
                vec![SessionChange::WindowChanged {
                    window: SessionWindow::latest(1),
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput
            }
        ));
        assert_eq!(state.cursor(), 1);
        assert_eq!(state.seq(), 1);
        assert_eq!(state.native_cursor, Some(4));
        assert_eq!(state.native_source_epoch, None);
    }

    #[test]
    fn native_recovery_cursor_does_not_conflict_with_recovered_event() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let first_binding = SessionEventBinding::new("session-1", None, None).expect("binding");
        assert!(matches!(
            state.apply_native_bound(
                first_binding,
                Some("run-1".to_owned()),
                Some(4),
                vec![SessionChange::MessageUpdated { item: message() }],
            ),
            SessionApplyResult::Applied(_)
        ));

        let changed_binding =
            SessionEventBinding::new("session-1", None, Some(9)).expect("binding");
        assert!(matches!(
            state.apply_native_recovery_bound(
                changed_binding.clone(),
                None,
                Some(5),
                RecoveryReason::EpochChanged,
            ),
            SessionApplyResult::Applied(ref delta)
                if delta.cursor() == 2
                    && matches!(delta.changes.as_slice(), [SessionChange::RecoveryRequired { reason: RecoveryReason::EpochChanged }])
        ));
        assert_eq!(state.native_cursor, None);
        assert_eq!(state.native_source_epoch, Some(9));

        assert!(matches!(
            state.apply_native_bound(
                changed_binding,
                Some("run-1".to_owned()),
                Some(5),
                vec![SessionChange::WindowChanged {
                    window: SessionWindow::latest(1),
                }],
            ),
            SessionApplyResult::Applied(ref delta) if delta.cursor() == 3
        ));
        assert_eq!(state.native_cursor, Some(5));
    }

    #[test]
    fn from_view_parts_preserves_seq_and_cursor() {
        let state = SessionState::from_view_parts(identity(), 7, 9, 11, SessionFacts::unknown())
            .expect("state");
        assert_eq!(state.epoch(), 7);
        assert_eq!(state.seq(), 9);
        assert_eq!(state.cursor(), 11);
    }

    #[test]
    fn from_facts_rebuilds_terminal_run_fence_from_hydrated_items() {
        let facts = SessionFacts {
            items: SessionFact::Complete(vec![SessionItem::AssistantTurn {
                item_id: "item-1".to_owned(),
                run_id: Some("run-1".to_owned()),
                message_id: Some("message-1".to_owned()),
                status: ItemStatus::Final,
                segments: vec![SessionContent::Text {
                    text: "done".to_owned(),
                }],
                text: "done".to_owned(),
            }]),
            tools: SessionFact::Complete(Vec::new()),
            approvals: SessionFact::Complete(Vec::new()),
            runtime: SessionFact::Complete(RuntimeView {
                phase: RunPhase::Completed,
                active_run_id: None,
                issue: None,
                run_progress: None,
                runtime_activity: None,
                error_detail: None,
            }),
            window: SessionFact::Complete(SessionWindow::latest(1)),
            completeness: SessionCompleteness::Complete,
        };
        let mut state = SessionState::from_facts(identity(), 1, 0, facts).expect("state");
        assert!(state.terminal_run_ids.contains("run-1"));
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageUpdated {
                    item: message_with_ids("item-1", "run-1", "message-1", "late"),
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidChange
            }
        ));
        assert_eq!(state.cursor(), 0);
        assert_eq!(state.seq(), 0);
    }

    #[test]
    fn from_facts_keeps_terminal_run_unknown_when_facts_do_not_bind_a_run() {
        let mut state =
            SessionState::from_facts(identity(), 1, 0, SessionFacts::unknown()).expect("state");
        assert!(state.terminal_run_ids.is_empty());
        assert!(matches!(
            state.apply(
                None,
                Some("run-1".to_owned()),
                1,
                vec![SessionChange::MessageUpdated { item: message() }],
            ),
            SessionApplyResult::Applied(_)
        ));
    }

    #[test]
    fn view_wire_round_trips_and_rejects_unknown_fields() {
        let state = SessionState::new(identity(), 1).expect("state");
        let value = serde_json::to_value(state.view()).expect("encode view");
        let decoded: SessionView = serde_json::from_value(value).expect("decode view");
        assert_eq!(decoded.cursor(), 0);
        let invalid = serde_json::json!({
            "sessionKey": "session-1",
            "endpointSessionId": null,
            "identity": {
                "sessionKey": "session-1",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "matcha-agent",
                    "runtimeInstanceId": "local"
                }
            },
            "epoch": 1,
            "seq": 0,
            "cursor": 0,
            "items": "unknown",
            "tools": "unknown",
            "approvals": "unknown",
            "runtime": "unknown",
            "window": "unknown",
            "completeness": { "incomplete": { "missing": ["catalog"] } },
            "extra": true
        });
        assert!(serde_json::from_value::<SessionView>(invalid).is_err());
    }
}
