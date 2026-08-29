use crate::sessions::state::{
    ApprovalPhase, ApprovalView, ItemStatus, MissingFact, OmissionReason, RunPhase, RuntimeView,
    SessionCompleteness, SessionContent, SessionFact, SessionIdentity, SessionItem,
    SessionProvider, SessionView, SessionWindow, ToolPhase, ToolView,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SESSION_KEY_BYTES: usize = 4096;
const MAX_ID_BYTES: usize = 256;
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;
const MAX_WINDOW_LIMIT: usize = 200;
const DEFAULT_WINDOW_LIMIT: usize = 80;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Provider {
    OpenClaw,
    Matcha,
}

impl Provider {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
            Self::Matcha => "matcha-agent",
        }
    }

    pub(crate) const fn session_provider(self) -> SessionProvider {
        match self {
            Self::OpenClaw => SessionProvider::OpenClaw,
            Self::Matcha => SessionProvider::MatchaAgent,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Direction {
    Latest,
    Older,
    Newer,
}

impl Direction {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Latest => "latest",
            Self::Older => "older",
            Self::Newer => "newer",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WindowRequest {
    direction: Direction,
    limit: usize,
    offset: Option<usize>,
}

impl WindowRequest {
    pub(crate) const fn latest() -> Self {
        Self {
            direction: Direction::Latest,
            limit: DEFAULT_WINDOW_LIMIT,
            offset: None,
        }
    }

    pub(crate) const fn new(
        direction: Direction,
        limit: usize,
        offset: Option<usize>,
    ) -> Option<Self> {
        if limit > MAX_WINDOW_LIMIT || (matches!(direction, Direction::Latest) && offset.is_some())
        {
            return None;
        }
        if let Some(value) = offset {
            if value as u64 > MAX_SAFE_INTEGER {
                return None;
            }
        }
        Some(Self {
            direction,
            limit,
            offset,
        })
    }

    pub(crate) const fn direction(self) -> Direction {
        self.direction
    }

    pub(crate) const fn limit(self) -> usize {
        self.limit
    }

    pub(crate) const fn offset(self) -> Option<usize> {
        self.offset
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Command {
    provider: Provider,
    session_key: String,
    agent_id: Option<String>,
    window: WindowRequest,
    endpoint_session_id: Option<String>,
    include_canonical: bool,
}

impl Command {
    pub(crate) fn new(
        provider: Provider,
        session_key: String,
        agent_id: Option<String>,
        window: WindowRequest,
        endpoint_session_id: Option<String>,
        include_canonical: bool,
    ) -> Option<Self> {
        if !valid_bounded_text(&session_key, MAX_SESSION_KEY_BYTES)
            || !valid_optional_bounded_text(agent_id.as_deref(), MAX_ID_BYTES)
            || !valid_optional_bounded_text(
                endpoint_session_id.as_deref(),
                MAX_ENDPOINT_SESSION_ID_BYTES,
            )
        {
            return None;
        }
        Some(Self {
            provider,
            session_key,
            agent_id,
            window,
            endpoint_session_id,
            include_canonical,
        })
    }

    pub(crate) const fn provider(&self) -> Provider {
        self.provider
    }

    pub(crate) const fn session_provider(&self) -> SessionProvider {
        self.provider.session_provider()
    }

    pub(crate) fn session_key(&self) -> &str {
        &self.session_key
    }

    pub(crate) fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    pub(crate) fn endpoint_session_id(&self) -> Option<&str> {
        self.endpoint_session_id.as_deref()
    }

    pub(crate) const fn include_canonical(&self) -> bool {
        self.include_canonical
    }

    pub(crate) const fn direction(&self) -> Direction {
        self.window.direction()
    }

    pub(crate) const fn limit(&self) -> usize {
        self.window.limit()
    }

    pub(crate) const fn offset(&self) -> Option<usize> {
        self.window.offset()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UnavailableReason {
    RuntimeUnsupported,
    RuntimeUnavailable,
    RuntimeTargetRejected,
    RuntimeUnknown,
    SessionOpsUnavailable,
    MatchaMissingNativeSessionId,
    MatchaReadIncomplete,
    MatchaReadNotFound,
    MatchaReadUnavailable,
    MatchaReadUnknown,
    MatchaIdentityInvalid,
    MatchaProjectionInvalid,
    OpenClawBindingInvalid,
    OpenClawSessionKeyInvalid,
    OpenClawHistoryParamsInvalid,
    OpenClawWindowRequestInvalid,
    OpenClawReadSessionConnection,
    OpenClawReadRequestIdExhausted,
    OpenClawReadRequestDeadline,
    OpenClawReadConnectionClosed,
    OpenClawReadUnknownResponse,
    OpenClawReadTransport,
    OpenClawReadProtocol,
    OpenClawReadTargetRejected,
    OpenClawReadEventBackpressure,
    OpenClawIdentityMismatch,
    OpenClawIdentityInvalid,
    OpenClawProjectionInvalid,
}

impl UnavailableReason {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeUnsupported => "runtime.unsupported",
            Self::RuntimeUnavailable => "runtime.unavailable",
            Self::RuntimeTargetRejected => "runtime.target_rejected",
            Self::RuntimeUnknown => "runtime.unknown",
            Self::SessionOpsUnavailable => "runtime.session_ops_unavailable",
            Self::MatchaMissingNativeSessionId => "matcha.missing_native_session_id",
            Self::MatchaReadIncomplete => "matcha.read.incomplete",
            Self::MatchaReadNotFound => "matcha.read.not_found",
            Self::MatchaReadUnavailable => "matcha.read.unavailable",
            Self::MatchaReadUnknown => "matcha.read.unknown",
            Self::MatchaIdentityInvalid => "matcha.identity_invalid",
            Self::MatchaProjectionInvalid => "matcha.projection_invalid",
            Self::OpenClawBindingInvalid => "openclaw.binding_invalid",
            Self::OpenClawSessionKeyInvalid => "openclaw.session_key_invalid",
            Self::OpenClawHistoryParamsInvalid => "openclaw.history_params_invalid",
            Self::OpenClawWindowRequestInvalid => "openclaw.window_request_invalid",
            Self::OpenClawReadSessionConnection => "openclaw.read.session_connection",
            Self::OpenClawReadRequestIdExhausted => "openclaw.read.request_id_exhausted",
            Self::OpenClawReadRequestDeadline => "openclaw.read.request_deadline",
            Self::OpenClawReadConnectionClosed => "openclaw.read.connection_closed",
            Self::OpenClawReadUnknownResponse => "openclaw.read.unknown_response",
            Self::OpenClawReadTransport => "openclaw.read.transport",
            Self::OpenClawReadProtocol => "openclaw.read.protocol",
            Self::OpenClawReadTargetRejected => "openclaw.read.target_rejected",
            Self::OpenClawReadEventBackpressure => "openclaw.read.event_backpressure",
            Self::OpenClawIdentityMismatch => "openclaw.identity_mismatch",
            Self::OpenClawIdentityInvalid => "openclaw.identity_invalid",
            Self::OpenClawProjectionInvalid => "openclaw.projection_invalid",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct UnavailableDiagnostic {
    source: &'static str,
    message_index: Option<usize>,
    block_index: Option<usize>,
    field: &'static str,
    reason: &'static str,
    actual: &'static str,
}

impl UnavailableDiagnostic {
    fn openclaw_history(error: openclaw::session_window::HistoryError) -> Self {
        let diagnostic = error.diagnostic();
        Self {
            source: "openclaw.history",
            message_index: diagnostic.message_index(),
            block_index: diagnostic.block_index(),
            field: diagnostic.field(),
            reason: diagnostic.reason(),
            actual: diagnostic.actual(),
        }
    }

    pub(crate) const fn source(&self) -> &'static str {
        self.source
    }

    pub(crate) const fn message_index(&self) -> Option<usize> {
        self.message_index
    }

    pub(crate) const fn block_index(&self) -> Option<usize> {
        self.block_index
    }

    pub(crate) const fn field(&self) -> &'static str {
        self.field
    }

    pub(crate) const fn reason(&self) -> &'static str {
        self.reason
    }

    pub(crate) const fn actual(&self) -> &'static str {
        self.actual
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct UnavailableFailure {
    reason: UnavailableReason,
    diagnostic: Option<UnavailableDiagnostic>,
}

impl UnavailableFailure {
    const fn new(reason: UnavailableReason) -> Self {
        Self {
            reason,
            diagnostic: None,
        }
    }

    const fn with_diagnostic(reason: UnavailableReason, diagnostic: UnavailableDiagnostic) -> Self {
        Self {
            reason,
            diagnostic: Some(diagnostic),
        }
    }

    pub(crate) const fn reason(&self) -> UnavailableReason {
        self.reason
    }

    pub(crate) const fn diagnostic(&self) -> Option<UnavailableDiagnostic> {
        self.diagnostic
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Complete(SessionView),
    Incomplete(SessionView),
    Unavailable(UnavailableFailure),
}

impl Outcome {
    pub(crate) const fn unavailable(reason: UnavailableReason) -> Self {
        Self::Unavailable(UnavailableFailure::new(reason))
    }

    pub(crate) const fn unavailable_with_diagnostic(
        reason: UnavailableReason,
        diagnostic: UnavailableDiagnostic,
    ) -> Self {
        Self::Unavailable(UnavailableFailure::with_diagnostic(reason, diagnostic))
    }

    pub(crate) const fn unavailable_reason(&self) -> Option<UnavailableReason> {
        match self {
            Self::Unavailable(failure) => Some(failure.reason()),
            Self::Complete(_) | Self::Incomplete(_) => None,
        }
    }

    pub(crate) const fn unavailable_diagnostic(&self) -> Option<UnavailableDiagnostic> {
        match self {
            Self::Unavailable(failure) => failure.diagnostic(),
            Self::Complete(_) | Self::Incomplete(_) => None,
        }
    }
}

pub(crate) async fn load_matcha(
    session: &matcha_agent::peer::MatchaPeerSessionHandle,
    command: Command,
    epoch: u64,
) -> Outcome {
    let Some(session_id) = matcha_native_session_id(&command) else {
        return Outcome::unavailable(UnavailableReason::MatchaMissingNativeSessionId);
    };
    let mode = match command.window.direction() {
        Direction::Latest => matcha_agent::session::hydration::HydrationWindowMode::Latest,
        Direction::Older => matcha_agent::session::hydration::HydrationWindowMode::Older,
        Direction::Newer => matcha_agent::session::hydration::HydrationWindowMode::Newer,
    };
    let request = matcha_agent::session::hydration::HydrationWindowRequest::new(
        mode,
        command.window.limit(),
        command.offset(),
    );
    let facts = match session.read_canonical_session(session_id, request).await {
        matcha_agent::session::history::HistoryResult::Complete(facts) => facts,
        matcha_agent::session::history::HistoryResult::Incomplete(_) => {
            return Outcome::unavailable(UnavailableReason::MatchaReadIncomplete);
        }
        matcha_agent::session::history::HistoryResult::NotFound => {
            return Outcome::unavailable(UnavailableReason::MatchaReadNotFound);
        }
        matcha_agent::session::history::HistoryResult::Unavailable => {
            return Outcome::unavailable(UnavailableReason::MatchaReadUnavailable);
        }
        matcha_agent::session::history::HistoryResult::Unknown => {
            return Outcome::unavailable(UnavailableReason::MatchaReadUnknown);
        }
    };
    let Some(identity) = SessionIdentity::new(
        command.session_key,
        SessionProvider::MatchaAgent,
        command.agent_id,
    ) else {
        return Outcome::unavailable(UnavailableReason::MatchaIdentityInvalid);
    };
    project_matcha_view(&identity, command.endpoint_session_id, &facts, epoch)
        .map(Outcome::Incomplete)
        .unwrap_or_else(|| Outcome::unavailable(UnavailableReason::MatchaProjectionInvalid))
}

pub(crate) async fn load_openclaw(
    ops: &dyn crate::runtime_driver::SessionOps,
    command: Command,
    epoch: u64,
) -> Outcome {
    let Some(history_key) = openclaw_history_key(&command) else {
        return Outcome::unavailable(UnavailableReason::OpenClawBindingInvalid);
    };
    let key = match openclaw::session::protocol::SessionKey::try_new(history_key.clone()) {
        Ok(key) => key,
        Err(_) => return Outcome::unavailable(UnavailableReason::OpenClawSessionKeyInvalid),
    };
    let params = match openclaw::session::protocol::ChatHistoryParams::new(key)
        .try_with_limit(command.window.limit() as u64)
    {
        Ok(params) => params,
        Err(_) => return Outcome::unavailable(UnavailableReason::OpenClawHistoryParamsInvalid),
    };
    let request = match openclaw::session_window::PageRequest::new(
        match command.window.direction() {
            Direction::Latest => openclaw::session_window::Direction::Latest,
            Direction::Older => openclaw::session_window::Direction::Older,
            Direction::Newer => openclaw::session_window::Direction::Newer,
        },
        command.window.limit(),
        command.offset(),
    ) {
        Some(request) => request,
        None => return Outcome::unavailable(UnavailableReason::OpenClawWindowRequestInvalid),
    };
    let window = match ops.history_window(params, request).await {
        Ok(window)
            if openclaw_window_identity_matches(&window, &command.session_key, &history_key) =>
        {
            window
        }
        Ok(_) => return Outcome::unavailable(UnavailableReason::OpenClawIdentityMismatch),
        Err(error) => {
            let failure = openclaw_read_failure(error);
            return match failure.diagnostic {
                Some(diagnostic) => {
                    Outcome::unavailable_with_diagnostic(failure.reason, diagnostic)
                }
                None => Outcome::unavailable(failure.reason),
            };
        }
    };
    let agent_id = command
        .agent_id
        .or_else(|| command.session_key.split(':').nth(1).map(str::to_owned));
    let Some(identity) =
        SessionIdentity::new(command.session_key, SessionProvider::OpenClaw, agent_id)
    else {
        return Outcome::unavailable(UnavailableReason::OpenClawIdentityInvalid);
    };
    project_openclaw_view(&identity, &window, epoch)
        .map(Outcome::Incomplete)
        .unwrap_or_else(|| Outcome::unavailable(UnavailableReason::OpenClawProjectionInvalid))
}

struct OpenClawReadFailure {
    reason: UnavailableReason,
    diagnostic: Option<UnavailableDiagnostic>,
}

impl OpenClawReadFailure {
    const fn new(reason: UnavailableReason) -> Self {
        Self {
            reason,
            diagnostic: None,
        }
    }

    const fn with_diagnostic(reason: UnavailableReason, diagnostic: UnavailableDiagnostic) -> Self {
        Self {
            reason,
            diagnostic: Some(diagnostic),
        }
    }
}

fn openclaw_read_failure(
    error: crate::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
) -> OpenClawReadFailure {
    match error {
        crate::RuntimeSessionError::AdmissionClosed(_)
        | crate::RuntimeSessionError::RuntimeUnavailable => {
            OpenClawReadFailure::new(UnavailableReason::RuntimeUnavailable)
        }
        crate::RuntimeSessionError::Client(error) => match error {
            openclaw::port::OpenClawSessionError::SessionConnection => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadSessionConnection)
            }
            openclaw::port::OpenClawSessionError::RequestIdExhausted => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadRequestIdExhausted)
            }
            openclaw::port::OpenClawSessionError::RequestDeadline => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadRequestDeadline)
            }
            openclaw::port::OpenClawSessionError::ConnectionClosed => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadConnectionClosed)
            }
            openclaw::port::OpenClawSessionError::UnknownResponse => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadUnknownResponse)
            }
            openclaw::port::OpenClawSessionError::Transport => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadTransport)
            }
            openclaw::port::OpenClawSessionError::Protocol(error) => match error {
                Some(error) => OpenClawReadFailure::with_diagnostic(
                    UnavailableReason::OpenClawReadProtocol,
                    UnavailableDiagnostic::openclaw_history(error),
                ),
                None => OpenClawReadFailure::new(UnavailableReason::OpenClawReadProtocol),
            },
            openclaw::port::OpenClawSessionError::TargetRejected => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadTargetRejected)
            }
            openclaw::port::OpenClawSessionError::EventBackpressure => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadEventBackpressure)
            }
        },
    }
}

fn project_matcha_view(
    identity: &SessionIdentity,
    endpoint_session_id: Option<String>,
    facts: &matcha_agent::session::facts::NativeSessionFacts,
    epoch: u64,
) -> Option<SessionView> {
    let projection = matcha_agent::session::canonical::CanonicalSessionAssembler::project(facts);
    let transcript = projection.transcript_window();
    let items = matcha_items(&projection);
    let tools = matcha_tools(&projection);
    let approvals = matcha_approvals(&projection);
    let active_run_id = projection
        .native_active_run_id()
        .map(|run_id| run_id.as_str().to_owned());
    let runtime = RuntimeView {
        phase: if projection.pending_approvals().is_empty() {
            if active_run_id.is_some() {
                RunPhase::Started
            } else {
                RunPhase::Queued
            }
        } else {
            RunPhase::WaitingForApproval
        },
        active_run_id,
        issue: None,
    };
    let mut missing = vec![
        MissingFact::Artifacts,
        MissingFact::ContextTokens,
        MissingFact::Tasks,
        MissingFact::PartialRuntime,
    ];
    if projection.usage().is_none() {
        missing.push(MissingFact::Usage);
    }
    let view = SessionView {
        session_key: identity.session_key.clone(),
        endpoint_session_id,
        identity: identity.clone(),
        epoch,
        seq: 0,
        cursor: 0,
        items: SessionFact::Complete(items),
        tools: SessionFact::Complete(tools),
        approvals: SessionFact::Complete(approvals),
        runtime: SessionFact::Incomplete {
            facts: runtime,
            gaps: vec![MissingFact::PartialRuntime],
        },
        window: SessionFact::Complete(SessionWindow {
            total_item_count: transcript.total_item_count() as u64,
            window_start_offset: transcript.window_start_offset() as u64,
            window_end_offset: transcript.window_end_offset() as u64,
            has_more: transcript.has_more(),
            has_newer: transcript.has_newer(),
            is_at_latest: transcript.is_at_latest(),
        }),
        completeness: SessionCompleteness::Incomplete { missing },
    };
    view.validate().ok().map(|_| view)
}

fn parse_openclaw_session_key(session_key: &str) -> Option<(&str, &str)> {
    let (agent_id, suffix) = session_key.strip_prefix("agent:")?.split_once(':')?;
    if agent_id.is_empty()
        || suffix.is_empty()
        || suffix.trim() != suffix
        || suffix.starts_with("agent:")
        || suffix.split(':').any(str::is_empty)
    {
        return None;
    }
    Some((agent_id, suffix))
}

fn openclaw_history_key(command: &Command) -> Option<String> {
    let (agent_id, endpoint_session_id) = parse_openclaw_session_key(&command.session_key)?;
    if command
        .agent_id
        .as_deref()
        .is_some_and(|expected| expected != agent_id)
    {
        return None;
    }
    if command
        .endpoint_session_id
        .as_deref()
        .is_some_and(|bound| bound != endpoint_session_id)
    {
        return None;
    }
    Some(command.session_key.clone())
}

fn matcha_native_session_id(command: &Command) -> Option<matcha_agent::session::model::SessionId> {
    let session_id = match command.endpoint_session_id.as_deref() {
        Some(session_id) => session_id,
        None if command.session_key.starts_with("matcha-agent:") => return None,
        None => command.session_key.as_str(),
    };
    matcha_agent::session::model::SessionId::try_new(session_id.to_owned()).ok()
}

fn openclaw_window_identity_matches(
    window: &openclaw::session_window::SessionWindow,
    session_key: &str,
    history_key: &str,
) -> bool {
    session_key == history_key
        && window
            .session_key()
            .is_none_or(|actual| actual == history_key)
}

fn project_openclaw_view(
    identity: &SessionIdentity,
    window: &openclaw::session_window::SessionWindow,
    epoch: u64,
) -> Option<SessionView> {
    let endpoint_session_id = parse_openclaw_session_key(&identity.session_key)
        .map(|(_, endpoint_session_id)| endpoint_session_id.to_owned())?;
    let range = window.range();
    let view = SessionView {
        session_key: identity.session_key.clone(),
        endpoint_session_id: Some(endpoint_session_id),
        identity: identity.clone(),
        epoch,
        seq: 0,
        cursor: 0,
        items: SessionFact::Complete(openclaw_items(window)),
        tools: SessionFact::Complete(openclaw_tools(window)),
        approvals: SessionFact::Incomplete {
            facts: Vec::new(),
            gaps: vec![MissingFact::EventOnly],
        },
        runtime: SessionFact::Incomplete {
            facts: RuntimeView {
                phase: RunPhase::Completed,
                active_run_id: None,
                issue: None,
            },
            gaps: vec![MissingFact::PartialRuntime],
        },
        window: SessionFact::Complete(SessionWindow {
            total_item_count: window.total_item_count() as u64,
            window_start_offset: range.start() as u64,
            window_end_offset: range.end() as u64,
            has_more: range.start() > 0,
            has_newer: range.end() < window.total_item_count(),
            is_at_latest: range.end() == window.total_item_count(),
        }),
        completeness: SessionCompleteness::Incomplete {
            missing: vec![
                MissingFact::Catalog,
                MissingFact::Usage,
                MissingFact::Artifacts,
                MissingFact::ContextTokens,
                MissingFact::Tasks,
                MissingFact::ReplayCursor,
                MissingFact::PartialRuntime,
                MissingFact::EventOnly,
            ],
        },
    };
    view.validate().ok().map(|_| view)
}

fn matcha_items(
    view: &matcha_agent::session::canonical::CanonicalSessionView<'_>,
) -> Vec<SessionItem> {
    view.transcript_messages()
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let item_id = message
                .id()
                .or(message.origin_message_id())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("source:{index}"));
            let text = message.text();
            let content = matcha_content(message);
            match message.role() {
                matcha_agent::session::hydration::HydratedMessageRole::User => {
                    SessionItem::UserMessage {
                        item_id,
                        message_id: message.id().map(str::to_owned),
                        text,
                        content,
                        status: ItemStatus::Final,
                    }
                }
                matcha_agent::session::hydration::HydratedMessageRole::Assistant => {
                    SessionItem::AssistantTurn {
                        item_id,
                        run_id: None,
                        message_id: message.id().map(str::to_owned),
                        status: ItemStatus::Final,
                        segments: content,
                        text,
                    }
                }
                matcha_agent::session::hydration::HydratedMessageRole::System => {
                    SessionItem::System {
                        item_id,
                        text,
                        status: ItemStatus::Final,
                    }
                }
            }
        })
        .collect()
}

fn matcha_content(
    message: &matcha_agent::session::hydration::HydratedMessage,
) -> Vec<SessionContent> {
    message
        .content()
        .iter()
        .map(|block| match block {
            matcha_agent::session::hydration::HydratedContentBlock::Text { text } => {
                SessionContent::Text { text: text.clone() }
            }
            matcha_agent::session::hydration::HydratedContentBlock::Thinking { text } => {
                SessionContent::Thinking { text: text.clone() }
            }
            matcha_agent::session::hydration::HydratedContentBlock::ToolUse(tool) => {
                SessionContent::ToolUse {
                    name: tool.name().to_owned(),
                    tool_call_id: tool.tool_call_id().to_owned(),
                }
            }
            matcha_agent::session::hydration::HydratedContentBlock::ToolResult(result) => {
                match result.tool_call_id() {
                    Some(tool_call_id) => SessionContent::ToolResult {
                        tool_call_id: tool_call_id.to_owned(),
                        summary: result.body().map(str::to_owned),
                        is_error: result.is_error().unwrap_or(false),
                    },
                    None => SessionContent::Omitted {
                        reason: OmissionReason::Unknown,
                    },
                }
            }
            matcha_agent::session::hydration::HydratedContentBlock::Image(image) => {
                SessionContent::Media {
                    media_type: Some(image.media_type().to_owned()),
                    reference: image.reference().to_owned(),
                }
            }
        })
        .collect()
}

fn matcha_tools(
    view: &matcha_agent::session::canonical::CanonicalSessionView<'_>,
) -> Vec<ToolView> {
    view.transcript_messages()
        .iter()
        .flat_map(|message| message.content().iter())
        .filter_map(|block| match block {
            matcha_agent::session::hydration::HydratedContentBlock::ToolUse(tool) => {
                Some(ToolView {
                    tool_call_id: tool.tool_call_id().to_owned(),
                    run_id: None,
                    name: Some(tool.name().to_owned()),
                    phase: ToolPhase::Started,
                    summary: None,
                    is_error: None,
                })
            }
            matcha_agent::session::hydration::HydratedContentBlock::ToolResult(result) => {
                result.tool_call_id().map(|tool_call_id| ToolView {
                    tool_call_id: tool_call_id.to_owned(),
                    run_id: None,
                    name: None,
                    phase: if result.is_error() == Some(true) {
                        ToolPhase::Failed
                    } else {
                        ToolPhase::Completed
                    },
                    summary: result.body().map(str::to_owned),
                    is_error: result.is_error(),
                })
            }
            _ => None,
        })
        .collect()
}

fn matcha_approvals(
    view: &matcha_agent::session::canonical::CanonicalSessionView<'_>,
) -> Vec<ApprovalView> {
    view.pending_approvals()
        .iter()
        .map(|approval| ApprovalView {
            approval_id: approval.approval_id().as_str().to_owned(),
            run_id: None,
            phase: ApprovalPhase::Requested,
            option_ids: approval
                .option_ids()
                .iter()
                .map(|option| option.as_str().to_owned())
                .collect(),
        })
        .collect()
}

fn openclaw_items(window: &openclaw::session_window::SessionWindow) -> Vec<SessionItem> {
    window
        .messages()
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let item_id = message
                .message_id()
                .or(message.origin())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("source:{index}"));
            let text = message.text().to_owned();
            let content = openclaw_content(message);
            if !has_openclaw_renderable_content(&text, &content) {
                return None;
            }
            match message.role() {
                openclaw::session_window::MessageRole::User => Some(SessionItem::UserMessage {
                    item_id,
                    message_id: message.message_id().map(str::to_owned),
                    text,
                    content,
                    status: ItemStatus::Final,
                }),
                openclaw::session_window::MessageRole::Assistant => {
                    Some(SessionItem::AssistantTurn {
                        item_id,
                        run_id: message.run_id().map(str::to_owned),
                        message_id: message.message_id().map(str::to_owned),
                        status: ItemStatus::Final,
                        segments: content,
                        text,
                    })
                }
                openclaw::session_window::MessageRole::System
                | openclaw::session_window::MessageRole::ToolResult => None,
            }
        })
        .collect()
}

fn has_openclaw_renderable_content(text: &str, content: &[SessionContent]) -> bool {
    !text.trim().is_empty()
        || content.iter().any(|content| match content {
            SessionContent::Text { text } | SessionContent::Thinking { text } => {
                !text.trim().is_empty()
            }
            SessionContent::ToolUse { .. }
            | SessionContent::ToolResult { .. }
            | SessionContent::Media { .. } => true,
            SessionContent::Omitted { .. } => false,
        })
}

fn openclaw_content(message: &openclaw::session_window::Message) -> Vec<SessionContent> {
    message
        .content()
        .iter()
        .filter_map(|block| match block {
            openclaw::session_window::MessageContent::Text { text } => {
                Some(SessionContent::Text { text: text.clone() })
            }
            openclaw::session_window::MessageContent::ToolUse {
                name,
                tool_call_id: Some(tool_call_id),
            } => Some(SessionContent::ToolUse {
                name: name.clone(),
                tool_call_id: tool_call_id.clone(),
            }),
            openclaw::session_window::MessageContent::ToolUse {
                tool_call_id: None, ..
            } => Some(SessionContent::Omitted {
                reason: OmissionReason::Unknown,
            }),
            openclaw::session_window::MessageContent::ToolResult {
                tool_call_id: Some(tool_call_id),
                summary,
                is_error,
                ..
            } => Some(SessionContent::ToolResult {
                tool_call_id: tool_call_id.clone(),
                summary: summary.clone(),
                is_error: is_error.unwrap_or(false),
            }),
            openclaw::session_window::MessageContent::ToolResult {
                tool_call_id: None, ..
            } => Some(SessionContent::Omitted {
                reason: OmissionReason::Unknown,
            }),
            openclaw::session_window::MessageContent::Media {
                media_type,
                reference: Some(reference),
                ..
            } => Some(SessionContent::Media {
                media_type: media_type.clone(),
                reference: reference.clone(),
            }),
            openclaw::session_window::MessageContent::Media { .. } => {
                Some(SessionContent::Omitted {
                    reason: OmissionReason::UnsafeMedia,
                })
            }
            openclaw::session_window::MessageContent::Omitted { kind } => {
                Some(SessionContent::Omitted {
                    reason: match kind {
                        openclaw::session_window::OmittedContentKind::Thinking => {
                            OmissionReason::Thinking
                        }
                        openclaw::session_window::OmittedContentKind::UnsafeMedia => {
                            OmissionReason::UnsafeMedia
                        }
                        openclaw::session_window::OmittedContentKind::Unknown => {
                            OmissionReason::Unknown
                        }
                    },
                })
            }
        })
        .collect()
}

fn openclaw_tools(window: &openclaw::session_window::SessionWindow) -> Vec<ToolView> {
    let mut tools = Vec::new();
    for message in window.messages() {
        for block in message.content() {
            match block {
                openclaw::session_window::MessageContent::ToolUse {
                    name,
                    tool_call_id: Some(tool_call_id),
                } => upsert_openclaw_tool_use(&mut tools, tool_call_id, name),
                openclaw::session_window::MessageContent::ToolResult {
                    tool_name,
                    tool_call_id: Some(tool_call_id),
                    summary,
                    is_error,
                } => upsert_openclaw_tool_result(
                    &mut tools,
                    tool_call_id,
                    tool_name.as_deref(),
                    summary.clone(),
                    *is_error,
                ),
                _ => {}
            }
        }
    }
    tools
}

fn upsert_openclaw_tool_use(tools: &mut Vec<ToolView>, tool_call_id: &str, name: &str) {
    if let Some(tool) = tools
        .iter_mut()
        .find(|tool| tool.tool_call_id == tool_call_id)
    {
        if tool.name.is_none() {
            tool.name = Some(name.to_owned());
        }
        return;
    }

    tools.push(ToolView {
        tool_call_id: tool_call_id.to_owned(),
        run_id: None,
        name: Some(name.to_owned()),
        phase: ToolPhase::Started,
        summary: None,
        is_error: None,
    });
}

fn upsert_openclaw_tool_result(
    tools: &mut Vec<ToolView>,
    tool_call_id: &str,
    name: Option<&str>,
    summary: Option<String>,
    is_error: Option<bool>,
) {
    let phase = openclaw_tool_result_phase(is_error);
    if let Some(tool) = tools
        .iter_mut()
        .find(|tool| tool.tool_call_id == tool_call_id)
    {
        if tool.name.is_none() {
            tool.name = name.map(str::to_owned);
        }
        tool.phase = phase;
        tool.summary = summary;
        tool.is_error = is_error;
        return;
    }

    tools.push(ToolView {
        tool_call_id: tool_call_id.to_owned(),
        run_id: None,
        name: name.map(str::to_owned),
        phase,
        summary,
        is_error,
    });
}

const fn openclaw_tool_result_phase(is_error: Option<bool>) -> ToolPhase {
    if matches!(is_error, Some(true)) {
        ToolPhase::Failed
    } else {
        ToolPhase::Completed
    }
}

fn valid_bounded_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_optional_bounded_text(value: Option<&str>, max_bytes: usize) -> bool {
    value.is_none_or(|value| valid_bounded_text(value, max_bytes))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn rejects_endpoint_session_id_that_cannot_be_bound() {
        let command = Command::new(
            Provider::OpenClaw,
            "session-1".to_owned(),
            None,
            WindowRequest::latest(),
            Some("endpoint\n session".to_owned()),
            true,
        );
        assert!(command.is_none());
    }

    #[test]
    fn keeps_canonical_request_controls_on_the_command() {
        let command = Command::new(
            Provider::Matcha,
            "session-1".to_owned(),
            Some("agent-1".to_owned()),
            WindowRequest::new(Direction::Older, 20, Some(3)).unwrap(),
            Some("endpoint-session-1".to_owned()),
            false,
        )
        .unwrap();
        assert_eq!(
            command.endpoint_session_id.as_deref(),
            Some("endpoint-session-1")
        );
        assert!(!command.include_canonical);
        assert_eq!(command.window.direction(), Direction::Older);
        assert_eq!(command.window.limit(), 20);
        assert_eq!(command.window.offset(), Some(3));
    }

    #[test]
    fn matcha_native_session_id_prefers_endpoint_binding() {
        let command = Command::new(
            Provider::Matcha,
            "matcha-agent:matcha:native-session-1".to_owned(),
            Some("matcha".to_owned()),
            WindowRequest::latest(),
            Some("native-session-1".to_owned()),
            true,
        )
        .unwrap();

        assert_eq!(
            matcha_native_session_id(&command).unwrap().as_str(),
            "native-session-1"
        );
    }

    #[test]
    fn matcha_native_session_id_rejects_projected_key_without_endpoint_binding() {
        let command = Command::new(
            Provider::Matcha,
            "matcha-agent:matcha:session-1".to_owned(),
            Some("matcha".to_owned()),
            WindowRequest::latest(),
            None,
            true,
        )
        .unwrap();

        assert!(matcha_native_session_id(&command).is_none());
    }

    #[test]
    fn openclaw_history_key_uses_canonical_session_key_with_endpoint_binding() {
        let command = Command::new(
            Provider::OpenClaw,
            "agent:agentic-identity-trust-architect:team-endpoint-session-a8b648cce33bcc074ffa958a5436e843".to_owned(),
            Some("agentic-identity-trust-architect".to_owned()),
            WindowRequest::latest(),
            Some("team-endpoint-session-a8b648cce33bcc074ffa958a5436e843".to_owned()),
            true,
        )
        .unwrap();

        assert_eq!(
            openclaw_history_key(&command).as_deref(),
            Some(
                "agent:agentic-identity-trust-architect:team-endpoint-session-a8b648cce33bcc074ffa958a5436e843"
            )
        );
    }

    #[test]
    fn openclaw_history_key_keeps_agent_scoped_session_key() {
        let command = Command::new(
            Provider::OpenClaw,
            "agent:main:direct-session".to_owned(),
            None,
            WindowRequest::latest(),
            None,
            true,
        )
        .unwrap();

        assert_eq!(
            openclaw_history_key(&command).as_deref(),
            Some("agent:main:direct-session")
        );
    }

    #[test]
    fn openclaw_history_key_rejects_malformed_agent_scoped_session_key() {
        let command = Command::new(
            Provider::OpenClaw,
            "agent:main:".to_owned(),
            Some("main".to_owned()),
            WindowRequest::latest(),
            None,
            true,
        )
        .unwrap();

        assert!(openclaw_history_key(&command).is_none());
    }

    #[test]
    fn openclaw_history_key_rejects_nested_agent_scoped_session_key() {
        let command = Command::new(
            Provider::OpenClaw,
            "agent:main:agent:main:main".to_owned(),
            Some("main".to_owned()),
            WindowRequest::latest(),
            None,
            true,
        )
        .unwrap();

        assert!(openclaw_history_key(&command).is_none());
    }

    #[test]
    fn openclaw_projection_links_role_level_tool_results_to_assistant_turns() {
        let window = openclaw::session_window::decode_window(
            json!({
                "messages": [
                    {
                        "role": "assistant",
                        "id": "assistant-1",
                        "content": [{ "type": "toolUse", "name": "read", "toolUseId": "call-1" }]
                    },
                    {
                        "role": "toolResult",
                        "toolCallId": "call-1",
                        "toolName": "read",
                        "content": "file list",
                        "isError": true
                    }
                ],
                "sessionKey": "agent:main:main"
            }),
            openclaw::session_window::PageRequest::latest(),
        )
        .unwrap();

        let items = openclaw_items(&window);
        assert_eq!(items.len(), 1);
        assert!(matches!(
            &items[0],
            SessionItem::AssistantTurn { segments, .. }
                if segments.iter().any(|segment| matches!(
                    segment,
                    SessionContent::ToolUse { name, tool_call_id }
                        if name == "read" && tool_call_id == "call-1"
                ))
        ));

        let tools = openclaw_tools(&window);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].tool_call_id, "call-1");
        assert_eq!(tools[0].name.as_deref(), Some("read"));
        assert_eq!(tools[0].phase, ToolPhase::Failed);
        assert_eq!(tools[0].summary.as_deref(), Some("file list"));
        assert_eq!(tools[0].is_error, Some(true));
    }
}
