use std::{
    collections::{HashSet, VecDeque, hash_map::DefaultHasher},
    fmt,
    hash::{Hash, Hasher},
    mem,
};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

pub const MAX_SESSION_KEY_BYTES: usize = 4096;
pub const MAX_ID_BYTES: usize = 256;
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
    fn item_id(&self) -> &str {
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
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolView {
    pub tool_call_id: String,
    pub run_id: Option<String>,
    pub name: Option<String>,
    pub phase: ToolPhase,
    pub summary: Option<String>,
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionView {
    pub session_key: String,
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

impl<'de> Deserialize<'de> for SessionView {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            session_key: String,
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
    ToolUpdated {
        tool: ToolView,
    },
    ApprovalUpdated {
        approval: ApprovalView,
    },
    RuntimeChanged {
        runtime: RuntimeView,
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
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDelta {
    pub session_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route_key: Option<String>,
    pub epoch: u64,
    pub seq: u64,
    pub cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub changes: Vec<SessionChange>,
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
pub(crate) struct SessionSourceBinding {
    session_key: String,
    route_key: Option<String>,
    source_epoch: Option<u64>,
    source_cursor_contiguous: bool,
}

impl SessionSourceBinding {
    pub(crate) fn new(
        session_key: impl Into<String>,
        route_key: Option<String>,
        source_epoch: Option<u64>,
    ) -> Option<Self> {
        Self::with_source_cursor_continuity(session_key, route_key, source_epoch, false)
    }

    /// Creates a binding only when the caller has a session-scoped contiguous
    /// source cursor. Gateway-wide cursors must use `new`, because their
    /// per-session values can legitimately jump over other sessions' frames.
    pub(crate) fn new_contiguous(
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

    pub(crate) fn session_key(&self) -> &str {
        &self.session_key
    }

    pub(crate) fn route_key(&self) -> Option<&str> {
        self.route_key.as_deref()
    }

    pub(crate) const fn source_epoch(&self) -> Option<u64> {
        self.source_epoch
    }

    pub(crate) const fn source_cursor_contiguous(&self) -> bool {
        self.source_cursor_contiguous
    }
}

#[derive(Clone, Debug)]
pub struct SessionState {
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
    terminal_run_ids: HashSet<String>,
    host_source_epoch: Option<u64>,
    native_source_epoch: Option<u64>,
    native_cursor: Option<u64>,
    native_recovery_cursor: Option<u64>,
    source_route_key: Option<String>,
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
        if !valid_identity(&identity) {
            return Err(SessionStateError::InvalidIdentity);
        }
        if !valid_epoch(epoch) {
            return Err(SessionStateError::InvalidEpoch);
        }
        if cursor > MAX_SAFE_INTEGER {
            return Err(SessionStateError::InvalidCursor);
        }
        facts.validate()?;
        let terminal_run_ids = terminal_run_ids_from_facts(&facts);
        Ok(Self {
            identity,
            epoch,
            seq: 0,
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
            source_route_key: None,
            accepted_event_identities: HashSet::new(),
            accepted_event_identity_order: VecDeque::new(),
        })
    }

    pub fn identity(&self) -> &SessionIdentity {
        &self.identity
    }

    pub(crate) fn source_route_key(&self) -> Option<&str> {
        self.source_route_key.as_deref()
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
            SessionSourceBinding::new(self.identity.session_key.clone(), route_key, None)
        else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput,
            };
        };
        self.apply_bound(binding, run_id, cursor, changes)
    }

    pub(crate) fn apply_bound(
        &mut self,
        binding: SessionSourceBinding,
        run_id: Option<String>,
        cursor: u64,
        changes: Vec<SessionChange>,
    ) -> SessionApplyResult {
        if binding.session_key() != self.identity.session_key
            || binding
                .source_epoch()
                .zip(self.host_source_epoch)
                .is_some_and(|(received, current)| received != current)
            || binding
                .route_key()
                .zip(self.source_route_key.as_deref())
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
        if next.source_route_key.is_none() {
            next.source_route_key = binding.route_key().map(str::to_owned);
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
        let delta = SessionDelta {
            session_key: next.identity.session_key.clone(),
            route_key: binding.route_key().map(str::to_owned),
            epoch: next.epoch,
            seq: next.seq,
            cursor,
            run_id,
            changes,
        };
        debug_assert!(delta.validate().is_ok());
        *self = next;
        SessionApplyResult::Applied(delta)
    }

    pub(crate) fn native_source_epoch_changed(&self, binding: &SessionSourceBinding) -> bool {
        (self.native_cursor.is_some() || self.native_source_epoch.is_some())
            && binding.source_epoch() != self.native_source_epoch
    }

    pub(crate) fn apply_native_bound(
        &mut self,
        binding: SessionSourceBinding,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        changes: Vec<SessionChange>,
    ) -> SessionApplyResult {
        if binding.session_key() != self.identity.session_key
            || binding
                .route_key()
                .zip(self.source_route_key.as_deref())
                .is_some_and(|(received, current)| received != current)
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
        if next.source_route_key.is_none() {
            next.source_route_key = binding.route_key().map(str::to_owned);
        }
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

    pub(crate) fn apply_native_recovery_bound(
        &mut self,
        binding: SessionSourceBinding,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        reason: RecoveryReason,
    ) -> SessionApplyResult {
        if binding.session_key() != self.identity.session_key
            || binding
                .route_key()
                .zip(self.source_route_key.as_deref())
                .is_some_and(|(received, current)| received != current)
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
        if next.source_route_key.is_none() {
            next.source_route_key = binding.route_key().map(str::to_owned);
        }
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
                update_message_delta(
                    &mut self.items,
                    item_id,
                    run_id.as_deref(),
                    message_id.as_deref(),
                    text,
                    *replace,
                    *status,
                )
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
            SessionChange::ToolUpdated { tool } => {
                if tool
                    .run_id
                    .as_deref()
                    .is_some_and(|run_id| self.terminal_run_ids.contains(run_id))
                {
                    return false;
                }
                update_tools(&mut self.tools, tool)
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
                let Some(run_id) = runtime.active_run_id.as_deref() else {
                    return false;
                };
                if !valid_runtime(runtime) || self.terminal_run_ids.contains(run_id) {
                    return false;
                }
                self.runtime = event_runtime(runtime.clone());
                if terminal_run_phase(runtime.phase) {
                    self.terminal_run_ids.insert(run_id.to_owned());
                }
                true
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
            | RecoveryReason::EpochChanged => {
                add_missing(&self.completeness, &[MissingFact::ReplayCursor])
            }
            RecoveryReason::EventOverflow => {
                add_missing(&self.completeness, &[MissingFact::EventOnly])
            }
        };
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
    let content_text = |text: &str| {
        vec![SessionContent::Text {
            text: text.to_owned(),
        }]
    };
    if let Some(existing) = items
        .iter_mut()
        .find(|existing| existing.item_id() == item_id)
    {
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
        if existing_run_id.as_deref() != run_id || existing_message_id.as_deref() != message_id {
            return false;
        }
        if replace {
            current_text.clear();
            current_text.push_str(text);
        } else {
            current_text.push_str(text);
        }
        *segments = content_text(current_text);
        *current_status = status;
    } else {
        if items.len() >= MAX_ITEMS {
            return false;
        }
        items.push(SessionItem::AssistantTurn {
            item_id: item_id.to_owned(),
            run_id: run_id.map(str::to_owned),
            message_id: message_id.map(str::to_owned),
            status,
            segments: content_text(text),
            text: text.to_owned(),
        });
    }
    *fact = SessionFact::Incomplete {
        facts: items,
        gaps: with_gap(gaps, MissingFact::EventOnly),
    };
    true
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

fn replace_item(items: &mut Vec<SessionItem>, item: SessionItem) -> bool {
    if let Some(existing) = items
        .iter_mut()
        .find(|existing| existing.item_id() == item.item_id())
    {
        *existing = item;
        return true;
    }
    if items.len() >= MAX_ITEMS {
        return false;
    }
    items.push(item);
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
            .summary
            .as_deref()
            .is_none_or(|value| valid_payload_text(value, MAX_TEXT_BYTES))
}

fn valid_approval(approval: &ApprovalView) -> bool {
    valid_id(&approval.approval_id)
        && approval.run_id.as_deref().is_none_or(valid_id)
        && approval.option_ids.len() <= MAX_APPROVALS
        && approval.option_ids.iter().all(|value| valid_id(value))
}

fn valid_runtime(runtime: &RuntimeView) -> bool {
    runtime.active_run_id.as_deref().is_none_or(valid_id)
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

fn valid_changes(changes: &[SessionChange], outer_run_id: Option<&str>) -> bool {
    changes
        .iter()
        .all(|change| valid_change(change, outer_run_id))
}

fn valid_change(change: &SessionChange, outer_run_id: Option<&str>) -> bool {
    let change_run_id = match change {
        SessionChange::RunPhaseChanged { run_id, .. } => Some(run_id.as_str()),
        SessionChange::MessageDelta { run_id, .. } => run_id.as_deref(),
        SessionChange::MessageUpdated { item } => item.run_id(),
        SessionChange::ToolUpdated { tool } => tool.run_id.as_deref(),
        SessionChange::ApprovalUpdated { approval } => approval.run_id.as_deref(),
        SessionChange::RuntimeChanged { runtime } => runtime.active_run_id.as_deref(),
        SessionChange::WindowChanged { .. } | SessionChange::RecoveryRequired { .. } => None,
    };
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
        SessionChange::ToolUpdated { tool } => valid_tool(tool),
        SessionChange::ApprovalUpdated { approval } => valid_approval(approval),
        SessionChange::RuntimeChanged { runtime } => {
            runtime.active_run_id.is_some() && valid_runtime(runtime)
        }
        SessionChange::WindowChanged { window } => valid_window(window),
        SessionChange::RecoveryRequired { .. } => true,
    }
}

fn terminal_run_phase(phase: RunPhase) -> bool {
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
    fn session_view_and_delta_use_public_camel_case_fields() {
        let view = SessionView {
            session_key: "session-1".to_owned(),
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
                summary: Some("done".to_owned()),
                is_error: Some(false),
            }]),
            approvals: SessionFact::Complete(Vec::new()),
            runtime: SessionFact::Complete(RuntimeView {
                phase: RunPhase::Completed,
                active_run_id: None,
                issue: None,
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
        assert_eq!(item["content"][2]["mediaType"], "image");
        assert!(encoded.to_string().contains("toolCallId"));
        assert!(!encoded.to_string().contains("tool_call_id"));
        assert!(!encoded.to_string().contains("item_id"));

        let delta = SessionDelta {
            session_key: "session-1".to_owned(),
            route_key: None,
            epoch: 1,
            seq: 1,
            cursor: 1,
            run_id: Some("run-1".to_owned()),
            changes: vec![SessionChange::MessageDelta {
                item_id: "item-1".to_owned(),
                run_id: Some("run-1".to_owned()),
                message_id: Some("message-1".to_owned()),
                text: "hello".to_owned(),
                replace: false,
                status: ItemStatus::Streaming,
            }],
        };
        let encoded = serde_json::to_value(&delta).unwrap();
        let change = &encoded["changes"][0];
        assert_eq!(change["itemId"], "item-1");
        assert_eq!(change["runId"], "run-1");
        assert_eq!(change["messageId"], "message-1");
        assert!(!encoded.to_string().contains("message_id"));
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
    fn terminal_run_fence_rejects_scoped_mutations_and_unknown_runtime_binding() {
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
                        summary: None,
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
                    },
                }],
            ),
            SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput
            }
        ));
        assert_eq!(state.cursor(), 1);
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
    fn native_cursor_is_separate_from_host_cursor_and_seq() {
        let mut state = SessionState::new(identity(), 1).expect("state");
        let binding =
            SessionSourceBinding::new("session-1", Some("renderer-route:test".to_owned()), Some(7))
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
            SessionSourceBinding::new_contiguous("session-1", None, Some(3)).expect("binding");
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
            SessionSourceBinding::new_contiguous("session-1", None, Some(3)).expect("binding");
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
        let first_binding = SessionSourceBinding::new("session-1", None, None).expect("binding");
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
            SessionSourceBinding::new("session-1", None, Some(9)).expect("binding");
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
        let first_binding = SessionSourceBinding::new("session-1", None, None).expect("binding");
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
            SessionSourceBinding::new("session-1", None, Some(9)).expect("binding");
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
