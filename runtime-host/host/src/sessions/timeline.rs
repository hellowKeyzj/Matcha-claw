use crate::sessions::state::{
    ApprovalPhase, ApprovalView, ItemStatus, MAX_CONTENT_REF_BYTES, MissingFact, OmissionReason,
    RunPhase, RuntimeActivity, RuntimeErrorDetail, RuntimeView, SessionCompleteness,
    SessionContent, SessionFact, SessionIdentity, SessionItem, SessionProvider, SessionView,
    SessionWindow, ToolPhase, ToolView,
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
pub(crate) struct ContentCommand {
    provider: Provider,
    session_key: String,
    agent_id: Option<String>,
    endpoint_session_id: Option<String>,
    content_ref: String,
    offset: u64,
    limit: usize,
}

impl ContentCommand {
    pub(crate) fn new(
        provider: Provider,
        session_key: String,
        agent_id: Option<String>,
        endpoint_session_id: Option<String>,
        content_ref: String,
        offset: u64,
        limit: usize,
    ) -> Option<Self> {
        if !valid_bounded_text(&session_key, MAX_SESSION_KEY_BYTES)
            || !valid_optional_bounded_text(agent_id.as_deref(), MAX_ID_BYTES)
            || !valid_optional_bounded_text(
                endpoint_session_id.as_deref(),
                MAX_ENDPOINT_SESSION_ID_BYTES,
            )
            || !valid_bounded_text(&content_ref, MAX_CONTENT_REF_BYTES)
            || offset > MAX_SAFE_INTEGER
            || limit == 0
            || limit > 64 * 1024
        {
            return None;
        }
        Some(Self {
            provider,
            session_key,
            agent_id,
            endpoint_session_id,
            content_ref,
            offset,
            limit,
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

    pub(crate) fn with_endpoint_session_id(mut self, endpoint_session_id: String) -> Option<Self> {
        if !valid_optional_bounded_text(Some(&endpoint_session_id), MAX_ENDPOINT_SESSION_ID_BYTES) {
            return None;
        }
        self.endpoint_session_id = Some(endpoint_session_id);
        Some(self)
    }

    pub(crate) fn content_ref(&self) -> &str {
        &self.content_ref
    }

    pub(crate) const fn offset(&self) -> u64 {
        self.offset
    }

    pub(crate) const fn limit(&self) -> usize {
        self.limit
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ContentChunk {
    pub(crate) content_ref: String,
    pub(crate) offset: u64,
    pub(crate) text: String,
    pub(crate) next_offset: u64,
    pub(crate) total_bytes: u64,
    pub(crate) complete: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ContentOutcome {
    Complete(ContentChunk),
    Unavailable(UnavailableReason),
}

impl ContentOutcome {
    pub(crate) const fn unavailable(reason: UnavailableReason) -> Self {
        Self::Unavailable(reason)
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

    pub(crate) fn with_endpoint_session_id(mut self, endpoint_session_id: String) -> Option<Self> {
        if !valid_optional_bounded_text(Some(&endpoint_session_id), MAX_ENDPOINT_SESSION_ID_BYTES) {
            return None;
        }
        self.endpoint_session_id = Some(endpoint_session_id);
        Some(self)
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
    block_type: Option<&'static str>,
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
            block_type: None,
            field: diagnostic.field(),
            reason: diagnostic.reason(),
            actual: diagnostic.actual(),
        }
    }

    const fn matcha_hydration(
        source: &'static str,
        reason: matcha_agent::session::hydration::HydrationIncomplete,
    ) -> Self {
        let rejection = reason.transcript_rejection();
        Self {
            source,
            message_index: match rejection {
                Some(rejection) => rejection.message_index(),
                None => None,
            },
            block_index: match rejection {
                Some(rejection) => rejection.block_index(),
                None => None,
            },
            block_type: match rejection {
                Some(rejection) => rejection.block_type(),
                None => None,
            },
            field: match rejection {
                Some(rejection) => rejection.field(),
                None => "hydration",
            },
            reason: match rejection {
                Some(rejection) => rejection.reason(),
                None => matcha_hydration_reason(reason),
            },
            actual: match rejection {
                Some(rejection) => rejection.actual(),
                None => "hydration_incomplete",
            },
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

    pub(crate) const fn block_type(&self) -> Option<&'static str> {
        self.block_type
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
    let local_history = session
        .load_local_history(session_id.clone(), request)
        .await;
    match local_history {
        matcha_agent::session::history::HistoryResult::Complete(snapshot) => {
            let Some(identity) = SessionIdentity::new(
                command.session_key,
                SessionProvider::MatchaAgent,
                command.agent_id,
            ) else {
                return Outcome::unavailable(UnavailableReason::MatchaIdentityInvalid);
            };
            return project_matcha_hydration_view(
                &identity,
                command.endpoint_session_id,
                &snapshot,
                epoch,
            )
            .map(Outcome::Incomplete)
            .unwrap_or_else(|| Outcome::unavailable(UnavailableReason::MatchaProjectionInvalid));
        }
        matcha_agent::session::history::HistoryResult::Incomplete(reason) => {
            return Outcome::unavailable_with_diagnostic(
                UnavailableReason::MatchaReadIncomplete,
                UnavailableDiagnostic::matcha_hydration("matcha.local-history", reason),
            );
        }
        matcha_agent::session::history::HistoryResult::Unknown => {
            return Outcome::unavailable(UnavailableReason::MatchaReadUnknown);
        }
        matcha_agent::session::history::HistoryResult::NotFound
        | matcha_agent::session::history::HistoryResult::Unavailable => {}
    }
    let facts = match session.read_canonical_session(session_id, request).await {
        matcha_agent::session::history::HistoryResult::Complete(facts) => facts,
        matcha_agent::session::history::HistoryResult::Incomplete(reason) => {
            return Outcome::unavailable_with_diagnostic(
                UnavailableReason::MatchaReadIncomplete,
                UnavailableDiagnostic::matcha_hydration("matcha.canonical", reason),
            );
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

pub(crate) async fn load_matcha_content(
    session: &matcha_agent::peer::MatchaPeerSessionHandle,
    command: ContentCommand,
) -> ContentOutcome {
    let Some(session_id) = matcha_native_session_id_for_binding(command.endpoint_session_id())
    else {
        return ContentOutcome::unavailable(UnavailableReason::MatchaMissingNativeSessionId);
    };
    match session
        .load_local_history_content(
            session_id,
            command.content_ref().to_owned(),
            command.offset(),
            command.limit(),
        )
        .await
    {
        matcha_agent::session::history::HistoryResult::Complete(chunk) => {
            ContentOutcome::Complete(ContentChunk {
                content_ref: chunk.content_ref().to_owned(),
                offset: chunk.offset(),
                text: chunk.text().to_owned(),
                next_offset: chunk.next_offset(),
                total_bytes: chunk.total_bytes(),
                complete: chunk.complete(),
            })
        }
        matcha_agent::session::history::HistoryResult::NotFound => {
            ContentOutcome::unavailable(UnavailableReason::MatchaReadNotFound)
        }
        matcha_agent::session::history::HistoryResult::Unavailable => {
            ContentOutcome::unavailable(UnavailableReason::MatchaReadUnavailable)
        }
        matcha_agent::session::history::HistoryResult::Unknown
        | matcha_agent::session::history::HistoryResult::Incomplete(_) => {
            ContentOutcome::unavailable(UnavailableReason::MatchaReadUnknown)
        }
    }
}

pub(crate) fn load_openclaw_content(_command: ContentCommand) -> ContentOutcome {
    ContentOutcome::unavailable(UnavailableReason::RuntimeUnsupported)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OpenClawReplayRequest {
    session_key: openclaw::session::protocol::SessionKey,
    window: WindowRequest,
}

impl OpenClawReplayRequest {
    pub(crate) fn new(
        session_key: openclaw::session::protocol::SessionKey,
        window: WindowRequest,
    ) -> Self {
        Self {
            session_key,
            window,
        }
    }

    pub(crate) fn session_key(&self) -> &openclaw::session::protocol::SessionKey {
        &self.session_key
    }

    pub(crate) const fn window(&self) -> WindowRequest {
        self.window
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OpenClawReplayWindow {
    replay: openclaw::port::CanonicalSessionReplay,
    window: SessionWindow,
}

impl OpenClawReplayWindow {
    pub(crate) fn new(
        replay: openclaw::port::CanonicalSessionReplay,
        window: SessionWindow,
    ) -> Option<Self> {
        (window.window_start_offset <= window.window_end_offset
            && window.window_end_offset <= window.total_item_count
            && window.window_end_offset - window.window_start_offset <= MAX_WINDOW_LIMIT as u64)
            .then_some(Self { replay, window })
    }

    pub(crate) const fn replay(&self) -> &openclaw::port::CanonicalSessionReplay {
        &self.replay
    }

    pub(crate) const fn window(&self) -> SessionWindow {
        self.window
    }
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
    let request = OpenClawReplayRequest::new(key, command.window);
    let window = match ops.load_openclaw_session_replay(request).await {
        Ok(window)
            if openclaw_replay_identity_matches(&window, &command.session_key, &history_key) =>
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
    project_openclaw_replay_view(&identity, &window, epoch)
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

const fn matcha_hydration_reason(
    reason: matcha_agent::session::hydration::HydrationIncomplete,
) -> &'static str {
    match reason {
        matcha_agent::session::hydration::HydrationIncomplete::ReplayRecoveryRequired => {
            "replay_recovery_required"
        }
        matcha_agent::session::hydration::HydrationIncomplete::ReplayIncomplete => {
            "replay_incomplete"
        }
        matcha_agent::session::hydration::HydrationIncomplete::TranscriptRejected(_) => {
            "transcript_rejected"
        }
        matcha_agent::session::hydration::HydrationIncomplete::ConnectionInterrupted => {
            "connection_interrupted"
        }
        matcha_agent::session::hydration::HydrationIncomplete::SourceRejected => "source_rejected",
        matcha_agent::session::hydration::HydrationIncomplete::SourceUnavailable => {
            "source_unavailable"
        }
        matcha_agent::session::hydration::HydrationIncomplete::ProtocolRejected => {
            "protocol_rejected"
        }
        matcha_agent::session::hydration::HydrationIncomplete::ConnectionCloseFailed => {
            "connection_close_failed"
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
    let messages = projection.transcript_messages();
    let items = matcha_items(messages);
    let tools = matcha_tools(messages);
    let approvals = matcha_approvals(&projection);
    let (phase, active_run_id) = match projection.native_worker_state() {
        matcha_agent::session::model::WorkerRuntimeState::Running { run_id, .. } => {
            (RunPhase::Started, Some(run_id.as_str().to_owned()))
        }
        matcha_agent::session::model::WorkerRuntimeState::WaitingForApproval { run_id, .. } => (
            RunPhase::WaitingForApproval,
            Some(run_id.as_str().to_owned()),
        ),
        _ if !projection.pending_approvals().is_empty() => (
            RunPhase::WaitingForApproval,
            projection
                .runs()
                .iter()
                .rev()
                .find(|run| {
                    matches!(
                        &run.status,
                        matcha_agent::session::model::RunStatus::WaitingForApproval { .. }
                    )
                })
                .map(|run| run.run_id.as_str().to_owned()),
        ),
        _ => {
            let queued_run_id = projection
                .runs()
                .iter()
                .rev()
                .find(|run| {
                    matches!(
                        &run.status,
                        matcha_agent::session::model::RunStatus::Queued { .. }
                    )
                })
                .map(|run| run.run_id.as_str().to_owned());

            match queued_run_id {
                Some(run_id) => (RunPhase::Queued, Some(run_id)),
                None => (RunPhase::Completed, None),
            }
        }
    };
    let runtime = RuntimeView {
        phase,
        active_run_id,
        issue: None,
        runtime_activity: None,
        error_detail: None,
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
    matcha_native_session_id_for_binding(command.endpoint_session_id())
}

fn matcha_native_session_id_for_binding(
    endpoint_session_id: Option<&str>,
) -> Option<matcha_agent::session::model::SessionId> {
    matcha_agent::session::model::SessionId::try_new(endpoint_session_id?.to_owned()).ok()
}

fn openclaw_replay_identity_matches(
    window: &OpenClawReplayWindow,
    session_key: &str,
    history_key: &str,
) -> bool {
    session_key == history_key && window.replay().session_key().as_str() == history_key
}

fn project_openclaw_replay_view(
    identity: &SessionIdentity,
    window: &OpenClawReplayWindow,
    epoch: u64,
) -> Option<SessionView> {
    let endpoint_session_id = parse_openclaw_session_key(&identity.session_key)
        .map(|(_, endpoint_session_id)| endpoint_session_id.to_owned())?;
    let projection = OpenClawReplayProjection::from_replay(window.replay())?;
    let partial = projection.partial;
    let gaps = vec![MissingFact::BoundedHistory];
    let items = if partial {
        SessionFact::Incomplete {
            facts: projection.items,
            gaps: gaps.clone(),
        }
    } else {
        SessionFact::Complete(projection.items)
    };
    let tools = if partial {
        SessionFact::Incomplete {
            facts: projection.tools,
            gaps: gaps.clone(),
        }
    } else {
        SessionFact::Complete(projection.tools)
    };
    let approvals = if partial {
        SessionFact::Incomplete {
            facts: projection.approvals,
            gaps,
        }
    } else {
        SessionFact::Complete(projection.approvals)
    };
    let mut missing = vec![
        MissingFact::Catalog,
        MissingFact::Usage,
        MissingFact::Artifacts,
        MissingFact::ContextTokens,
        MissingFact::Tasks,
        MissingFact::ReplayCursor,
        MissingFact::PartialRuntime,
    ];
    if partial {
        missing.push(MissingFact::BoundedHistory);
    }
    let view = SessionView {
        session_key: identity.session_key.clone(),
        endpoint_session_id: Some(endpoint_session_id),
        identity: identity.clone(),
        epoch,
        seq: 0,
        cursor: 0,
        items,
        tools,
        approvals,
        runtime: SessionFact::Incomplete {
            facts: projection.runtime,
            gaps: vec![MissingFact::PartialRuntime],
        },
        window: SessionFact::Complete(window.window()),
        completeness: SessionCompleteness::Incomplete { missing },
    };
    view.validate().ok().map(|_| view)
}

const OPENCLAW_REPLAY_RECOVERY_ITEM_ID: &str = "openclaw:replay-recovery";
const OPENCLAW_REPLAY_RECOVERY_TEXT: &str = "部分历史内容无法加载，已省略。";

struct OpenClawReplayProjection {
    items: Vec<SessionItem>,
    tools: Vec<ToolView>,
    approvals: Vec<ApprovalView>,
    runtime: RuntimeView,
    partial: bool,
}

impl OpenClawReplayProjection {
    fn from_replay(replay: &openclaw::port::CanonicalSessionReplay) -> Option<Self> {
        let mut projection = Self {
            items: Vec::new(),
            tools: Vec::new(),
            approvals: Vec::new(),
            runtime: RuntimeView {
                phase: RunPhase::Completed,
                active_run_id: None,
                issue: None,
                runtime_activity: None,
                error_detail: None,
            },
            partial: false,
        };
        for result in replay.ingress_results() {
            let openclaw::port::CanonicalIngressResult::Produced(delta) = result else {
                continue;
            };
            for change in delta.changes() {
                projection.apply_change(change)?;
            }
        }
        Some(projection)
    }

    fn apply_change(
        &mut self,
        change: &openclaw::session::projection::CanonicalSessionChange,
    ) -> Option<()> {
        match change {
            openclaw::session::projection::CanonicalSessionChange::AssistantTurnChunk {
                run_id,
                message_id,
                kind,
                text,
                replace,
                status,
            } => self.apply_assistant_turn_chunk(
                run_id.as_str(),
                message_id.as_ref().map(|id| id.as_str()),
                *kind,
                text,
                *replace,
                *status,
            ),
            openclaw::session::projection::CanonicalSessionChange::AssistantTurnSnapshot {
                snapshot,
            } => self.apply_assistant_turn_snapshot(snapshot),
            openclaw::session::projection::CanonicalSessionChange::ToolActivity {
                run_id,
                tool_id,
                tool_name,
                phase,
                input,
                input_text,
                summary,
                output,
                details,
                is_error,
            } => self.apply_tool_activity(OpenClawReplayToolActivity {
                run_id: run_id.as_str(),
                tool_id: tool_id.as_str(),
                tool_name: tool_name.as_deref(),
                phase: *phase,
                input,
                input_text: input_text.as_deref(),
                summary: summary.as_deref(),
                output,
                details,
                is_error: *is_error,
            }),
            openclaw::session::projection::CanonicalSessionChange::RuntimeActivity {
                run_id,
                activity,
            } => self.apply_runtime_activity(run_id.as_str(), Some(*activity)),
            openclaw::session::projection::CanonicalSessionChange::RuntimeActivityCleared {
                run_id,
                retrying_cleanup,
                ..
            } => {
                if *retrying_cleanup {
                    Some(())
                } else {
                    self.apply_runtime_activity(run_id.as_str(), None)
                }
            }
            openclaw::session::projection::CanonicalSessionChange::RuntimeFallback {
                detail,
                ..
            } => self.apply_runtime_fallback(detail),
            openclaw::session::projection::CanonicalSessionChange::RuntimeFallbackCleared {
                ..
            } => self.apply_runtime_fallback_cleared(),
            openclaw::session::projection::CanonicalSessionChange::GuardianNotice { .. } => {
                Some(())
            }
            openclaw::session::projection::CanonicalSessionChange::ApprovalRequested {
                run_id,
                approval_id,
                option_ids,
            } => self.upsert_approval(
                approval_id.as_str(),
                Some(run_id.as_str()),
                ApprovalPhase::Requested,
                option_ids.iter().map(|id| id.as_str()).collect(),
            ),
            openclaw::session::projection::CanonicalSessionChange::ApprovalResolved {
                run_id,
                approval_id,
                option_ids,
            } => self.upsert_approval(
                approval_id.as_str(),
                Some(run_id.as_str()),
                ApprovalPhase::Resolved,
                option_ids.iter().map(|id| id.as_str()).collect(),
            ),
            openclaw::session::projection::CanonicalSessionChange::Terminal {
                run_id,
                outcome,
                error_kind,
                error_message,
                stop_reason,
                error_detail,
                ..
            } => self.apply_terminal(
                run_id.as_str(),
                *outcome,
                error_detail,
                error_message,
                error_kind,
                stop_reason,
            ),
            openclaw::session::projection::CanonicalSessionChange::RecoveryRequired { .. } => {
                self.apply_recovery()
            }
            openclaw::session::projection::CanonicalSessionChange::TranscriptMessage {
                message,
            } => self.apply_transcript_message(message),
        }
    }

    fn apply_recovery(&mut self) -> Option<()> {
        self.partial = true;
        if self
            .items
            .iter()
            .any(|item| item.item_id() == OPENCLAW_REPLAY_RECOVERY_ITEM_ID)
        {
            return Some(());
        }
        if self.items.len() >= MAX_WINDOW_LIMIT {
            return Some(());
        }
        self.items.push(SessionItem::System {
            item_id: OPENCLAW_REPLAY_RECOVERY_ITEM_ID.to_owned(),
            text: OPENCLAW_REPLAY_RECOVERY_TEXT.to_owned(),
            status: ItemStatus::Final,
        });
        Some(())
    }

    fn apply_transcript_message(
        &mut self,
        message: &openclaw::session_window::Message,
    ) -> Option<()> {
        for content in message.content() {
            self.apply_transcript_tool_content(message, content)?;
        }
        if let Some(item) = transcript_session_item(message, self.items.len()) {
            upsert_replay_item(&mut self.items, item)?;
        }
        Some(())
    }

    fn apply_transcript_tool_content(
        &mut self,
        message: &openclaw::session_window::Message,
        content: &openclaw::session_window::MessageContent,
    ) -> Option<()> {
        match content {
            openclaw::session_window::MessageContent::ToolUse {
                name,
                tool_call_id: Some(tool_call_id),
                input,
                input_text,
            } => upsert_replay_tool(
                &mut self.tools,
                transcript_tool_view(
                    tool_call_id,
                    message.run_id(),
                    Some(name.as_str()),
                    ToolPhase::Started,
                    input.as_ref(),
                    input_text.as_deref(),
                    None,
                    None,
                    None,
                    None,
                )?,
            ),
            openclaw::session_window::MessageContent::ToolResult {
                tool_name,
                tool_call_id: Some(tool_call_id),
                summary,
                output,
                details,
                is_error,
            } => upsert_replay_tool(
                &mut self.tools,
                transcript_tool_view(
                    tool_call_id,
                    message.run_id(),
                    tool_name.as_deref(),
                    match is_error {
                        Some(true) => ToolPhase::Failed,
                        _ => ToolPhase::Completed,
                    },
                    None,
                    None,
                    summary.as_deref(),
                    output.as_ref(),
                    details.as_ref(),
                    *is_error,
                )?,
            ),
            openclaw::session_window::MessageContent::MessageToolDelivery { text, media } => {
                if let Some(tool_call_id) = transcript_message_tool_call_id(message) {
                    upsert_replay_tool(
                        &mut self.tools,
                        transcript_tool_view(
                            tool_call_id,
                            message.run_id(),
                            None,
                            ToolPhase::Completed,
                            None,
                            None,
                            text.as_deref(),
                            transcript_delivery_output(text.as_deref(), media).as_ref(),
                            None,
                            None,
                        )?,
                    );
                }
            }
            _ => {}
        }
        Some(())
    }

    fn apply_assistant_turn_chunk(
        &mut self,
        run_id: &str,
        message_id: Option<&str>,
        kind: openclaw::session::projection::AssistantTurnChunkKind,
        text: &str,
        replace: bool,
        status: openclaw::session::projection::AssistantTurnStatus,
    ) -> Option<()> {
        let mut item = self.assistant_turn_mut(run_id, message_id)?;
        item.push_chunk(kind, text, replace)?;
        *item.status = openclaw_assistant_turn_item_status(status);
        self.observe_assistant_turn_status(run_id, status);
        Some(())
    }

    fn apply_assistant_turn_snapshot(
        &mut self,
        snapshot: &openclaw::session::projection::AssistantTurnSnapshot,
    ) -> Option<()> {
        let mut item = self.assistant_turn_mut(
            snapshot.run_id.as_str(),
            snapshot.message_id.as_ref().map(|id| id.as_str()),
        )?;
        item.set_ordered_snapshot(&snapshot.segments, &snapshot.text)?;
        *item.status = openclaw_assistant_turn_item_status(snapshot.status);
        self.observe_assistant_turn_status(snapshot.run_id.as_str(), snapshot.status);
        Some(())
    }

    fn observe_assistant_turn_status(
        &mut self,
        run_id: &str,
        status: openclaw::session::projection::AssistantTurnStatus,
    ) {
        self.runtime.phase = openclaw_assistant_turn_run_phase(status);
        self.runtime.active_run_id = match status {
            openclaw::session::projection::AssistantTurnStatus::Final
            | openclaw::session::projection::AssistantTurnStatus::Aborted
            | openclaw::session::projection::AssistantTurnStatus::Error => None,
            openclaw::session::projection::AssistantTurnStatus::Streaming
            | openclaw::session::projection::AssistantTurnStatus::WaitingForTool => {
                Some(run_id.to_owned())
            }
        };
    }

    fn apply_tool_activity(&mut self, activity: OpenClawReplayToolActivity<'_>) -> Option<()> {
        let phase = openclaw_replay_tool_phase(activity.phase);
        let tool = ToolView {
            tool_call_id: activity.tool_id.to_owned(),
            run_id: Some(activity.run_id.to_owned()),
            name: activity.tool_name.map(str::to_owned),
            phase,
            input: activity.input.clone(),
            input_text: activity.input_text.map(str::to_owned),
            summary: activity.summary.map(str::to_owned),
            output: activity.output.clone(),
            details: activity.details.clone(),
            is_error: activity.is_error,
        };
        upsert_replay_tool(&mut self.tools, tool);
        let mut item = self.assistant_turn_mut(activity.run_id, None)?;
        item.upsert_tool(activity.tool_id, activity.tool_name)?;
        *item.status = match phase {
            ToolPhase::Completed | ToolPhase::Failed => ItemStatus::Streaming,
            ToolPhase::Started | ToolPhase::Updated => ItemStatus::WaitingForTool,
        };
        self.runtime.phase = RunPhase::Started;
        self.runtime.active_run_id = Some(activity.run_id.to_owned());
        Some(())
    }

    fn upsert_approval(
        &mut self,
        approval_id: &str,
        run_id: Option<&str>,
        phase: ApprovalPhase,
        option_ids: Vec<&str>,
    ) -> Option<()> {
        if let Some(approval) = self
            .approvals
            .iter_mut()
            .find(|approval| approval.approval_id == approval_id)
        {
            approval.run_id = run_id.map(str::to_owned);
            approval.phase = phase;
            approval.option_ids = option_ids.into_iter().map(str::to_owned).collect();
        } else {
            self.approvals.push(ApprovalView {
                approval_id: approval_id.to_owned(),
                run_id: run_id.map(str::to_owned),
                phase,
                option_ids: option_ids.into_iter().map(str::to_owned).collect(),
            });
        }
        if phase == ApprovalPhase::Requested {
            self.runtime.phase = RunPhase::WaitingForApproval;
            self.runtime.active_run_id = run_id.map(str::to_owned);
        }
        Some(())
    }

    fn apply_runtime_activity(
        &mut self,
        run_id: &str,
        activity: Option<openclaw::session::projection::CanonicalRuntimeActivity>,
    ) -> Option<()> {
        self.runtime.phase = RunPhase::Started;
        self.runtime.active_run_id = Some(run_id.to_owned());
        self.runtime.runtime_activity = activity.map(|activity| match activity {
            openclaw::session::projection::CanonicalRuntimeActivity::Compacting => {
                RuntimeActivity::Compacting
            }
        });
        self.runtime.error_detail = None;
        Some(())
    }

    fn apply_runtime_fallback(
        &mut self,
        detail: &openclaw::session::protocol::RuntimeFallbackDetail,
    ) -> Option<()> {
        self.runtime.error_detail = Some(RuntimeErrorDetail {
            failover_reason: detail.failover_reason.clone(),
            provider_runtime_failure_kind: detail.provider_runtime_failure_kind.clone(),
            provider_error_type: detail.provider_error_type.clone(),
            provider_error_message_preview: detail.provider_error_message_preview.clone(),
            http_status: detail.http_status,
        });
        Some(())
    }

    fn apply_runtime_fallback_cleared(&mut self) -> Option<()> {
        self.runtime.error_detail = None;
        Some(())
    }

    fn apply_terminal(
        &mut self,
        run_id: &str,
        outcome: openclaw::port::TerminalOutcome,
        error_detail: &Option<serde_json::Value>,
        error_message: &Option<String>,
        error_kind: &Option<openclaw::session::protocol::SessionErrorKind>,
        stop_reason: &Option<String>,
    ) -> Option<()> {
        let status = openclaw_terminal_item_status(outcome);
        if let Some(item) = self.assistant_turn_by_run_mut(run_id) {
            *item.status = status;
        }
        let phase = openclaw_terminal_run_phase(outcome);
        self.runtime.phase = phase;
        self.runtime.active_run_id = None;
        self.runtime.runtime_activity = None;
        self.runtime.error_detail = matches!(outcome, openclaw::port::TerminalOutcome::Error)
            .then(|| {
                super::openclaw::terminal_runtime_error_detail(
                    error_detail,
                    error_message,
                    error_kind,
                    stop_reason,
                )
            })
            .flatten();
        Some(())
    }

    fn assistant_turn_mut(
        &mut self,
        run_id: &str,
        message_id: Option<&str>,
    ) -> Option<OpenClawReplayAssistantTurn<'_>> {
        if let Some(index) = self.assistant_turn_index(run_id, message_id) {
            let item = &mut self.items[index];
            let SessionItem::AssistantTurn {
                status,
                segments,
                text,
                message_id: existing_message_id,
                ..
            } = item
            else {
                return None;
            };
            if existing_message_id.is_none() {
                *existing_message_id = message_id.map(str::to_owned);
            }
            return Some(OpenClawReplayAssistantTurn {
                status,
                segments,
                text,
            });
        }
        if self.items.len() >= MAX_WINDOW_LIMIT {
            return None;
        }
        self.items.push(SessionItem::AssistantTurn {
            item_id: message_id.unwrap_or(run_id).to_owned(),
            run_id: Some(run_id.to_owned()),
            message_id: message_id.map(str::to_owned),
            status: ItemStatus::Streaming,
            segments: Vec::new(),
            text: String::new(),
        });
        self.assistant_turn_mut(run_id, message_id)
    }

    fn assistant_turn_by_run_mut(
        &mut self,
        run_id: &str,
    ) -> Option<OpenClawReplayAssistantTurn<'_>> {
        let index = self.items.iter().position(|item| {
            matches!(item, SessionItem::AssistantTurn { run_id: Some(existing), .. } if existing == run_id)
        })?;
        let item = &mut self.items[index];
        let SessionItem::AssistantTurn {
            status,
            segments,
            text,
            ..
        } = item
        else {
            return None;
        };
        Some(OpenClawReplayAssistantTurn {
            status,
            segments,
            text,
        })
    }

    fn assistant_turn_index(&self, run_id: &str, message_id: Option<&str>) -> Option<usize> {
        message_id
            .and_then(|message_id| {
                self.items.iter().position(|item| {
                    matches!(item, SessionItem::AssistantTurn { message_id: Some(existing), .. } if existing == message_id)
                })
            })
            .or_else(|| {
                self.items.iter().position(|item| {
                    matches!(item, SessionItem::AssistantTurn { run_id: Some(existing), .. } if existing == run_id)
                })
            })
    }
}

struct OpenClawReplayToolActivity<'a> {
    run_id: &'a str,
    tool_id: &'a str,
    tool_name: Option<&'a str>,
    phase: openclaw::session::protocol::ToolActivityPhase,
    input: &'a Option<serde_json::Value>,
    input_text: Option<&'a str>,
    summary: Option<&'a str>,
    output: &'a Option<serde_json::Value>,
    details: &'a Option<serde_json::Value>,
    is_error: Option<bool>,
}

struct OpenClawReplayAssistantTurn<'a> {
    status: &'a mut ItemStatus,
    segments: &'a mut Vec<SessionContent>,
    text: &'a mut String,
}

impl OpenClawReplayAssistantTurn<'_> {
    fn push_chunk(
        &mut self,
        kind: openclaw::session::projection::AssistantTurnChunkKind,
        text: &str,
        replace: bool,
    ) -> Option<()> {
        match kind {
            openclaw::session::projection::AssistantTurnChunkKind::Text => {
                if replace {
                    self.text.clear();
                    remove_replay_text_segments(self.segments);
                }
                self.text.push_str(text);
                push_or_append_replay_segment(
                    self.segments,
                    SessionContent::Text {
                        text: text.to_owned(),
                    },
                )
            }
            openclaw::session::projection::AssistantTurnChunkKind::Thinking => {
                if replace {
                    remove_replay_thinking_segments(self.segments);
                }
                push_or_append_replay_segment(
                    self.segments,
                    SessionContent::Thinking {
                        text: text.to_owned(),
                    },
                )
            }
        }
    }

    fn set_ordered_snapshot(
        &mut self,
        segments: &[openclaw::session::projection::AssistantTurnSegment],
        text: &str,
    ) -> Option<()> {
        self.segments.clear();
        for segment in segments {
            if let Some(segment) = openclaw_assistant_turn_segment(segment) {
                push_transcript_segment(self.segments, segment)?;
            }
        }
        *self.text = text.to_owned();
        Some(())
    }

    fn upsert_tool(&mut self, tool_id: &str, tool_name: Option<&str>) -> Option<()> {
        let name = tool_name.unwrap_or("unknown").to_owned();
        if let Some(segment) = self.segments.iter_mut().find(|segment| {
            matches!(segment, SessionContent::ToolUse { tool_call_id, .. } if tool_call_id == tool_id)
        }) {
            *segment = SessionContent::ToolUse {
                name,
                tool_call_id: tool_id.to_owned(),
            };
            return Some(());
        }
        if self.segments.len() >= 64 {
            return None;
        }
        self.segments.push(SessionContent::ToolUse {
            name,
            tool_call_id: tool_id.to_owned(),
        });
        Some(())
    }
}

fn transcript_session_item(
    message: &openclaw::session_window::Message,
    fallback_index: usize,
) -> Option<SessionItem> {
    let item_id = transcript_item_id(message, fallback_index);
    let message_id = message.message_id().map(str::to_owned);
    let text = message.text().to_owned();
    match message.role() {
        openclaw::session_window::MessageRole::User => Some(SessionItem::UserMessage {
            item_id,
            message_id,
            text,
            content: transcript_content(message, TranscriptContentMode::User)?,
            status: ItemStatus::Final,
        }),
        openclaw::session_window::MessageRole::Assistant => Some(SessionItem::AssistantTurn {
            item_id,
            run_id: message.run_id().map(str::to_owned),
            message_id,
            status: ItemStatus::Final,
            segments: transcript_content(message, TranscriptContentMode::Assistant)?,
            text,
        }),
        openclaw::session_window::MessageRole::System => Some(SessionItem::System {
            item_id,
            text,
            status: ItemStatus::Final,
        }),
        openclaw::session_window::MessageRole::ToolResult => None,
    }
}

fn transcript_item_id(
    message: &openclaw::session_window::Message,
    fallback_index: usize,
) -> String {
    message
        .message_id()
        .or_else(|| message.origin())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("source:{fallback_index}"))
}

#[derive(Clone, Copy)]
enum TranscriptContentMode {
    User,
    Assistant,
}

fn transcript_content(
    message: &openclaw::session_window::Message,
    mode: TranscriptContentMode,
) -> Option<Vec<SessionContent>> {
    let mut segments = Vec::new();
    for block in message.content() {
        let segment = match block {
            openclaw::session_window::MessageContent::Text { text } => {
                Some(SessionContent::Text { text: text.clone() })
            }
            openclaw::session_window::MessageContent::Thinking { text } => {
                Some(SessionContent::Thinking { text: text.clone() })
            }
            openclaw::session_window::MessageContent::ToolUse {
                name,
                tool_call_id: Some(tool_call_id),
                ..
            } => Some(SessionContent::ToolUse {
                name: name.clone(),
                tool_call_id: tool_call_id.clone(),
            }),
            openclaw::session_window::MessageContent::ToolUse { .. } => {
                Some(SessionContent::Omitted {
                    reason: OmissionReason::Unknown,
                })
            }
            openclaw::session_window::MessageContent::ToolResult {
                tool_call_id: Some(tool_call_id),
                summary,
                is_error,
                ..
            } => transcript_tool_result_segment(mode, tool_call_id, summary.as_deref(), *is_error),
            openclaw::session_window::MessageContent::ToolResult { .. } => {
                Some(SessionContent::Omitted {
                    reason: OmissionReason::Unknown,
                })
            }
            openclaw::session_window::MessageContent::MessageToolDelivery { text, media } => {
                append_transcript_delivery(message, mode, text.as_deref(), media, &mut segments)?;
                None
            }
            openclaw::session_window::MessageContent::Media {
                media_type,
                reference: Some(reference),
                bytes: None,
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
                    reason: transcript_omission_reason(*kind),
                })
            }
        };
        if let Some(segment) = segment {
            push_transcript_segment(&mut segments, segment)?;
        }
    }
    Some(segments)
}

fn transcript_tool_result_segment(
    mode: TranscriptContentMode,
    tool_call_id: &str,
    summary: Option<&str>,
    is_error: Option<bool>,
) -> Option<SessionContent> {
    match mode {
        TranscriptContentMode::Assistant => None,
        TranscriptContentMode::User => Some(SessionContent::ToolResult {
            tool_call_id: tool_call_id.to_owned(),
            summary: summary.map(str::to_owned),
            is_error: is_error.unwrap_or(false),
        }),
    }
}

fn append_transcript_delivery(
    message: &openclaw::session_window::Message,
    mode: TranscriptContentMode,
    text: Option<&str>,
    media: &[openclaw::session_window::MessageToolDeliveryMedia],
    segments: &mut Vec<SessionContent>,
) -> Option<()> {
    let is_tool_delivery = transcript_message_tool_call_id(message).is_some();
    if let Some(text) = text
        && (matches!(mode, TranscriptContentMode::User) || !is_tool_delivery)
    {
        push_transcript_segment(
            segments,
            SessionContent::Text {
                text: text.to_owned(),
            },
        )?;
    }
    if matches!(mode, TranscriptContentMode::Assistant) && is_tool_delivery {
        return Some(());
    }
    for media in media {
        push_transcript_segment(
            segments,
            SessionContent::Media {
                media_type: media.media_type().map(str::to_owned),
                reference: media.reference().to_owned(),
            },
        )?;
    }
    Some(())
}

fn push_transcript_segment(
    segments: &mut Vec<SessionContent>,
    segment: SessionContent,
) -> Option<()> {
    if segments.len() >= 64 {
        return None;
    }
    segments.push(segment);
    Some(())
}

fn push_or_append_replay_segment(
    segments: &mut Vec<SessionContent>,
    segment: SessionContent,
) -> Option<()> {
    match (segments.last_mut(), segment) {
        (Some(SessionContent::Text { text: current }), SessionContent::Text { text }) => {
            current.push_str(&text);
            Some(())
        }
        (Some(SessionContent::Thinking { text: current }), SessionContent::Thinking { text }) => {
            current.push_str(&text);
            Some(())
        }
        (_, segment) => push_transcript_segment(segments, segment),
    }
}

fn remove_replay_text_segments(segments: &mut Vec<SessionContent>) {
    segments.retain(|segment| !matches!(segment, SessionContent::Text { .. }));
}

fn remove_replay_thinking_segments(segments: &mut Vec<SessionContent>) {
    segments.retain(|segment| !matches!(segment, SessionContent::Thinking { .. }));
}

fn transcript_message_tool_call_id(message: &openclaw::session_window::Message) -> Option<&str> {
    message.tool_call_id().or_else(|| {
        message.content().iter().find_map(|content| match content {
            openclaw::session_window::MessageContent::ToolResult {
                tool_call_id: Some(tool_call_id),
                ..
            } => Some(tool_call_id.as_str()),
            _ => None,
        })
    })
}

fn transcript_delivery_output(
    text: Option<&str>,
    media: &[openclaw::session_window::MessageToolDeliveryMedia],
) -> Option<serde_json::Value> {
    if media.is_empty() {
        return text.map(|text| serde_json::Value::String(text.to_owned()));
    }
    let media = media
        .iter()
        .map(|media| {
            let mut item = serde_json::Map::new();
            if let Some(media_type) = media.media_type() {
                item.insert(
                    "mediaType".to_owned(),
                    serde_json::Value::String(media_type.to_owned()),
                );
            }
            item.insert(
                "reference".to_owned(),
                serde_json::Value::String(media.reference().to_owned()),
            );
            serde_json::Value::Object(item)
        })
        .collect::<Vec<_>>();
    let mut output = serde_json::Map::new();
    if let Some(text) = text {
        output.insert(
            "text".to_owned(),
            serde_json::Value::String(text.to_owned()),
        );
    }
    output.insert("media".to_owned(), serde_json::Value::Array(media));
    Some(serde_json::Value::Object(output))
}

fn transcript_omission_reason(
    kind: openclaw::session_window::OmittedContentKind,
) -> OmissionReason {
    match kind {
        openclaw::session_window::OmittedContentKind::Thinking => OmissionReason::Thinking,
        openclaw::session_window::OmittedContentKind::Unknown => OmissionReason::Unknown,
        openclaw::session_window::OmittedContentKind::UnsafeMedia => OmissionReason::UnsafeMedia,
    }
}

fn transcript_tool_view(
    tool_call_id: &str,
    run_id: Option<&str>,
    name: Option<&str>,
    phase: ToolPhase,
    input: Option<&serde_json::Value>,
    input_text: Option<&str>,
    summary: Option<&str>,
    output: Option<&serde_json::Value>,
    details: Option<&serde_json::Value>,
    is_error: Option<bool>,
) -> Option<ToolView> {
    Some(ToolView {
        tool_call_id: tool_call_id.to_owned(),
        run_id: run_id.map(str::to_owned),
        name: name.map(str::to_owned),
        phase,
        input: input.cloned(),
        input_text: input_text.map(str::to_owned),
        summary: summary.map(str::to_owned),
        output: output.cloned(),
        details: details.cloned(),
        is_error,
    })
}

fn upsert_replay_item(items: &mut Vec<SessionItem>, item: SessionItem) -> Option<()> {
    if let Some(index) = items
        .iter()
        .position(|existing| existing.item_id() == item.item_id())
    {
        items[index] = item;
        return Some(());
    }
    if let Some(index) = transcript_assistant_turn_index(items, &item) {
        if matches!(
            items[index],
            SessionItem::AssistantTurn {
                message_id: None,
                ..
            }
        ) {
            items.remove(index);
            items.push(item);
        } else {
            items[index] = item;
        }
        return Some(());
    }
    if items.len() >= MAX_WINDOW_LIMIT {
        return None;
    }
    items.push(item);
    Some(())
}

fn transcript_assistant_turn_index(items: &[SessionItem], item: &SessionItem) -> Option<usize> {
    let SessionItem::AssistantTurn {
        run_id: Some(run_id),
        ..
    } = item
    else {
        return None;
    };
    items.iter().position(|existing| {
        matches!(existing, SessionItem::AssistantTurn { run_id: Some(existing), .. } if existing == run_id)
    })
}

fn openclaw_assistant_turn_segment(
    segment: &openclaw::session::projection::AssistantTurnSegment,
) -> Option<SessionContent> {
    match segment {
        openclaw::session::projection::AssistantTurnSegment::Text { text } => {
            Some(SessionContent::Text { text: text.clone() })
        }
        openclaw::session::projection::AssistantTurnSegment::Thinking { text } => {
            Some(SessionContent::Thinking { text: text.clone() })
        }
        openclaw::session::projection::AssistantTurnSegment::ToolUse { tool_id, tool_name } => {
            Some(SessionContent::ToolUse {
                name: tool_name.as_deref().unwrap_or("unknown").to_owned(),
                tool_call_id: tool_id.as_str().to_owned(),
            })
        }
        openclaw::session::projection::AssistantTurnSegment::ToolResult { .. } => None,
    }
}

fn upsert_replay_tool(tools: &mut Vec<ToolView>, tool: ToolView) {
    if let Some(existing) = tools
        .iter_mut()
        .find(|existing| existing.tool_call_id == tool.tool_call_id)
    {
        if tool.name.is_some() {
            existing.name = tool.name.clone();
        }
        existing.phase = tool.phase;
        if tool.input.is_some() {
            existing.input = tool.input;
        }
        if tool.input_text.is_some() {
            existing.input_text = tool.input_text;
        }
        if tool.summary.is_some() {
            existing.summary = tool.summary;
        }
        if tool.output.is_some() {
            existing.output = tool.output;
        }
        if tool.details.is_some() {
            existing.details = tool.details;
        }
        if tool.is_error.is_some() {
            existing.is_error = tool.is_error;
        }
        if existing.run_id.is_none() {
            existing.run_id = tool.run_id;
        }
        return;
    }
    tools.push(tool);
}

const fn openclaw_assistant_turn_run_phase(
    status: openclaw::session::projection::AssistantTurnStatus,
) -> RunPhase {
    match status {
        openclaw::session::projection::AssistantTurnStatus::Streaming => RunPhase::Started,
        openclaw::session::projection::AssistantTurnStatus::WaitingForTool => RunPhase::Started,
        openclaw::session::projection::AssistantTurnStatus::Final => RunPhase::Completed,
        openclaw::session::projection::AssistantTurnStatus::Aborted => RunPhase::Interrupted,
        openclaw::session::projection::AssistantTurnStatus::Error => RunPhase::Failed,
    }
}

const fn openclaw_assistant_turn_item_status(
    status: openclaw::session::projection::AssistantTurnStatus,
) -> ItemStatus {
    match status {
        openclaw::session::projection::AssistantTurnStatus::Streaming => ItemStatus::Streaming,
        openclaw::session::projection::AssistantTurnStatus::WaitingForTool => {
            ItemStatus::WaitingForTool
        }
        openclaw::session::projection::AssistantTurnStatus::Final => ItemStatus::Final,
        openclaw::session::projection::AssistantTurnStatus::Aborted => ItemStatus::Aborted,
        openclaw::session::projection::AssistantTurnStatus::Error => ItemStatus::Error,
    }
}

const fn openclaw_replay_tool_phase(
    phase: openclaw::session::protocol::ToolActivityPhase,
) -> ToolPhase {
    match phase {
        openclaw::session::protocol::ToolActivityPhase::Started => ToolPhase::Started,
        openclaw::session::protocol::ToolActivityPhase::Updated => ToolPhase::Updated,
        openclaw::session::protocol::ToolActivityPhase::Completed => ToolPhase::Completed,
        openclaw::session::protocol::ToolActivityPhase::Failed => ToolPhase::Failed,
    }
}

const fn openclaw_terminal_run_phase(outcome: openclaw::port::TerminalOutcome) -> RunPhase {
    match outcome {
        openclaw::port::TerminalOutcome::Completed => RunPhase::Completed,
        openclaw::port::TerminalOutcome::Aborted => RunPhase::Interrupted,
        openclaw::port::TerminalOutcome::Error => RunPhase::Failed,
    }
}

const fn openclaw_terminal_item_status(outcome: openclaw::port::TerminalOutcome) -> ItemStatus {
    match outcome {
        openclaw::port::TerminalOutcome::Completed => ItemStatus::Final,
        openclaw::port::TerminalOutcome::Aborted => ItemStatus::Aborted,
        openclaw::port::TerminalOutcome::Error => ItemStatus::Error,
    }
}

fn project_matcha_hydration_view(
    identity: &SessionIdentity,
    endpoint_session_id: Option<String>,
    snapshot: &matcha_agent::session::hydration::HydrationSnapshot,
    epoch: u64,
) -> Option<SessionView> {
    let transcript = snapshot.window();
    let view = SessionView {
        session_key: identity.session_key.clone(),
        endpoint_session_id,
        identity: identity.clone(),
        epoch,
        seq: 0,
        cursor: 0,
        items: SessionFact::Complete(matcha_items(snapshot.messages())),
        tools: SessionFact::Complete(matcha_tools(snapshot.messages())),
        approvals: SessionFact::Incomplete {
            facts: Vec::new(),
            gaps: vec![MissingFact::EventOnly],
        },
        runtime: SessionFact::Incomplete {
            facts: RuntimeView {
                phase: RunPhase::Completed,
                active_run_id: None,
                issue: None,
                runtime_activity: None,
                error_detail: None,
            },
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
    messages: &[matcha_agent::session::hydration::HydratedMessage],
) -> Vec<SessionItem> {
    messages
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
            matcha_agent::session::hydration::HydratedContentBlock::LargeText(text) => {
                SessionContent::LargeText {
                    text: text.text().to_owned(),
                    content_ref: text.content_ref().to_owned(),
                    total_bytes: text.total_bytes(),
                    loaded_bytes: text.loaded_bytes(),
                }
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

fn matcha_tools(messages: &[matcha_agent::session::hydration::HydratedMessage]) -> Vec<ToolView> {
    let mut tools = Vec::new();
    for message in messages {
        for block in message.content() {
            match block {
                matcha_agent::session::hydration::HydratedContentBlock::ToolUse(tool) => {
                    upsert_matcha_tool_use(&mut tools, tool);
                }
                matcha_agent::session::hydration::HydratedContentBlock::ToolResult(result) => {
                    if let Some(tool_call_id) = result.tool_call_id() {
                        upsert_matcha_tool_result(&mut tools, tool_call_id, result);
                    }
                }
                _ => {}
            }
        }
    }
    tools
}

fn upsert_matcha_tool_use(
    tools: &mut Vec<ToolView>,
    tool: &matcha_agent::session::hydration::HydratedToolUse,
) {
    if let Some(existing) = tools
        .iter_mut()
        .find(|existing| existing.tool_call_id == tool.tool_call_id())
    {
        if existing.name.is_none() {
            existing.name = Some(tool.name().to_owned());
        }
        if tool.input().is_some() {
            existing.input = tool.input().cloned();
        }
        if tool.input_text().is_some() {
            existing.input_text = tool.input_text().map(str::to_owned);
        }
        return;
    }

    tools.push(ToolView {
        tool_call_id: tool.tool_call_id().to_owned(),
        run_id: None,
        name: Some(tool.name().to_owned()),
        phase: ToolPhase::Started,
        input: tool.input().cloned(),
        input_text: tool.input_text().map(str::to_owned),
        summary: None,
        output: None,
        details: None,
        is_error: None,
    });
}

fn upsert_matcha_tool_result(
    tools: &mut Vec<ToolView>,
    tool_call_id: &str,
    result: &matcha_agent::session::hydration::HydratedToolResult,
) {
    let phase = matcha_tool_result_phase(result.is_error());
    if let Some(existing) = tools
        .iter_mut()
        .find(|existing| existing.tool_call_id == tool_call_id)
    {
        existing.phase = phase;
        if result.body().is_some() {
            existing.summary = result.body().map(str::to_owned);
        }
        if result.is_error().is_some() {
            existing.is_error = result.is_error();
        }
        return;
    }

    tools.push(ToolView {
        tool_call_id: tool_call_id.to_owned(),
        run_id: None,
        name: None,
        phase,
        input: None,
        input_text: None,
        summary: result.body().map(str::to_owned),
        output: None,
        details: None,
        is_error: result.is_error(),
    });
}

const fn matcha_tool_result_phase(is_error: Option<bool>) -> ToolPhase {
    if matches!(is_error, Some(true)) {
        ToolPhase::Failed
    } else {
        ToolPhase::Completed
    }
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
    use std::sync::Mutex;

    use super::*;
    use crate::{
        RuntimeSessionError,
        runtime_driver::{RuntimeDriverIdentity, SessionFuture, SessionOps},
        sessions::{
            abort::{SessionAbortCommand, SessionAbortOutcome},
            create::{SessionAdmission, SessionCreateCommand, SessionCreateOutcome},
            model_selection::{ResolvedSessionModelSelection, SessionModelSelectionOutcome},
            send::{SessionSendCommand, SessionSendOutcome},
        },
    };

    #[derive(Default)]
    struct CapturingSessionOps {
        captured: Mutex<Option<serde_json::Value>>,
    }

    impl SessionOps for CapturingSessionOps {
        fn admission(&self) -> SessionAdmission {
            SessionAdmission::agent_scoped(
                RuntimeDriverIdentity::open_claw().endpoint(),
                SessionProvider::OpenClaw,
                "agent",
            )
        }

        fn abort_session<'a>(
            &'a self,
            _command: SessionAbortCommand,
        ) -> SessionFuture<'a, SessionAbortOutcome> {
            Box::pin(async { SessionAbortOutcome::Unavailable })
        }

        fn create_session<'a>(
            &'a self,
            _command: SessionCreateCommand,
            _epoch: u64,
        ) -> SessionFuture<'a, SessionCreateOutcome> {
            Box::pin(async { SessionCreateOutcome::Unavailable })
        }

        fn load_openclaw_session_replay<'a>(
            &'a self,
            request: OpenClawReplayRequest,
        ) -> SessionFuture<
            'a,
            Result<OpenClawReplayWindow, RuntimeSessionError<openclaw::port::OpenClawSessionError>>,
        > {
            let captured = serde_json::json!({
                "sessionKey": request.session_key().as_str(),
                "direction": request.window().direction().as_str(),
                "limit": request.window().limit(),
                "offset": request.window().offset(),
            });
            *self.captured.lock().expect("captured lock") = Some(captured);
            Box::pin(async {
                OpenClawReplayWindow::new(
                    replay_from_events([terminal_snapshot(1)]),
                    SessionWindow {
                        total_item_count: 12,
                        window_start_offset: 3,
                        window_end_offset: 5,
                        has_more: true,
                        has_newer: true,
                        is_at_latest: false,
                    },
                )
                .ok_or(RuntimeSessionError::Client(
                    openclaw::port::OpenClawSessionError::Protocol(None),
                ))
            })
        }

        fn send_session<'a>(
            &'a self,
            _command: SessionSendCommand,
        ) -> SessionFuture<'a, SessionSendOutcome> {
            Box::pin(async { SessionSendOutcome::Unavailable })
        }

        fn select_session_model<'a>(
            &'a self,
            _command: ResolvedSessionModelSelection,
        ) -> SessionFuture<'a, SessionModelSelectionOutcome> {
            Box::pin(async { SessionModelSelectionOutcome::Unavailable })
        }
    }

    fn session_key() -> openclaw::session::protocol::SessionKey {
        openclaw::session::protocol::SessionKey::try_new("agent:main:session-1").unwrap()
    }

    fn decode_event(
        name: &str,
        payload: serde_json::Value,
        sequence: u64,
    ) -> openclaw::session::protocol::SessionEventEnvelope {
        openclaw::session::protocol::decode_session_event(openclaw::gateway::wire::GatewayEvent {
            name: name.to_owned(),
            payload: Some(payload),
            sequence: Some(sequence),
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    fn terminal_snapshot(sequence: u64) -> openclaw::session::protocol::SessionEventEnvelope {
        decode_event(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": sequence,
                "state": "final",
                "message": {
                    "id": "message-1",
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "plan"},
                        {"type": "text", "text": "answer"}
                    ]
                }
            }),
            sequence,
        )
    }

    fn tool_event(sequence: u64, phase: &str) -> openclaw::session::protocol::SessionEventEnvelope {
        tool_event_with_id(sequence, phase, "tool-1")
    }

    fn tool_event_with_id(
        sequence: u64,
        phase: &str,
        tool_call_id: &str,
    ) -> openclaw::session::protocol::SessionEventEnvelope {
        decode_event(
            "session.tool",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "phase": phase,
                "toolCallId": tool_call_id,
                "toolName": "read",
                "args": {"path": "Cargo.toml"},
                "summary": "file list",
                "result": {"files": ["Cargo.toml"]},
                "isError": false
            }),
            sequence,
        )
    }

    fn approval_event(
        sequence: u64,
        name: &str,
    ) -> openclaw::session::protocol::SessionEventEnvelope {
        decode_event(
            name,
            json!({
                "id": "approval-1",
                "request": {
                    "sessionKey": "agent:main:session-1",
                    "runId": "run-1",
                    "allowedDecisions": ["allow-once", "deny"]
                }
            }),
            sequence,
        )
    }

    fn replay_from_events(
        events: impl IntoIterator<Item = openclaw::session::protocol::SessionEventEnvelope>,
    ) -> openclaw::port::CanonicalSessionReplay {
        openclaw::session::materialize_session_replay(session_key(), events, Some(1), None).unwrap()
    }

    fn partial_replay() -> openclaw::port::CanonicalSessionReplay {
        openclaw::session::materialize_session_replay_rows(
            session_key(),
            [openclaw::session::SessionReplaySourceRow::Recovery { source_sequence: 2 }],
            Some(1),
            None,
        )
        .unwrap()
    }

    fn transcript_message(
        role: openclaw::session_window::MessageRole,
        _text: &str,
        content: Vec<openclaw::session_window::MessageContent>,
    ) -> openclaw::session_window::Message {
        let window = openclaw::session_window::decode_window(
            json!({
                "messages": [{
                    "role": transcript_role(role),
                    "id": "message-1",
                    "runId": "run-1",
                    "seq": 1,
                    "content": content.into_iter().map(transcript_content_value).collect::<Vec<_>>()
                }]
            }),
            openclaw::session_window::PageRequest::latest(),
        )
        .unwrap();
        window.messages()[0].clone()
    }

    fn transcript_role(role: openclaw::session_window::MessageRole) -> &'static str {
        match role {
            openclaw::session_window::MessageRole::User => "user",
            openclaw::session_window::MessageRole::Assistant => "assistant",
            openclaw::session_window::MessageRole::System => "system",
            openclaw::session_window::MessageRole::ToolResult => "toolResult",
        }
    }

    fn transcript_content_value(
        content: openclaw::session_window::MessageContent,
    ) -> serde_json::Value {
        match content {
            openclaw::session_window::MessageContent::Text { text } => {
                json!({"type": "text", "text": text})
            }
            openclaw::session_window::MessageContent::Thinking { text } => {
                json!({"type": "thinking", "thinking": text})
            }
            openclaw::session_window::MessageContent::ToolUse {
                name,
                tool_call_id,
                input,
                input_text,
            } => json!({
                "type": "tool_use",
                "name": name,
                "tool_call_id": tool_call_id,
                "input": input,
                "input_text": input_text,
            }),
            openclaw::session_window::MessageContent::ToolResult {
                tool_name,
                tool_call_id,
                summary,
                output,
                details,
                is_error,
            } => json!({
                "type": "tool_result",
                "toolName": tool_name,
                "tool_call_id": tool_call_id,
                "summary": summary,
                "output": output,
                "details": details,
                "is_error": is_error,
            }),
            openclaw::session_window::MessageContent::Media {
                media_type,
                reference,
                bytes: None,
            } => json!({"type": "media", "mediaType": media_type, "reference": reference}),
            _ => json!({"type": "unknown"}),
        }
    }

    fn transcript_replay(
        rows: impl IntoIterator<Item = openclaw::session::SessionReplaySourceRow>,
    ) -> openclaw::port::CanonicalSessionReplay {
        openclaw::session::materialize_session_replay_rows(session_key(), rows, Some(1), None)
            .unwrap()
    }

    fn default_window(replay: openclaw::port::CanonicalSessionReplay) -> OpenClawReplayWindow {
        OpenClawReplayWindow::new(
            replay,
            SessionWindow {
                total_item_count: 1,
                window_start_offset: 0,
                window_end_offset: 1,
                has_more: false,
                has_newer: false,
                is_at_latest: true,
            },
        )
        .unwrap()
    }

    fn openclaw_identity() -> SessionIdentity {
        SessionIdentity::new(
            "agent:main:session-1".to_owned(),
            SessionProvider::OpenClaw,
            Some("main".to_owned()),
        )
        .unwrap()
    }

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
    fn matcha_native_session_id_uses_endpoint_binding() {
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
    fn matcha_native_session_id_rejects_missing_endpoint_binding() {
        for session_key in ["session-1", "matcha-agent:matcha:session-1"] {
            let command = Command::new(
                Provider::Matcha,
                session_key.to_owned(),
                Some("matcha".to_owned()),
                WindowRequest::latest(),
                None,
                true,
            )
            .unwrap();

            assert!(matcha_native_session_id(&command).is_none());
        }
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
    fn openclaw_replay_projection_uses_window_metadata() {
        let identity = SessionIdentity::new(
            "agent:main:session-1".to_owned(),
            SessionProvider::OpenClaw,
            Some("main".to_owned()),
        )
        .unwrap();
        let window = OpenClawReplayWindow::new(
            replay_from_events([terminal_snapshot(1)]),
            SessionWindow {
                total_item_count: 240,
                window_start_offset: 80,
                window_end_offset: 160,
                has_more: true,
                has_newer: true,
                is_at_latest: false,
            },
        )
        .unwrap();

        let view = project_openclaw_replay_view(&identity, &window, 1).unwrap();
        let SessionFact::Complete(projected) = view.window else {
            panic!("window projected");
        };
        assert_eq!(view.seq, 0);
        assert_eq!(view.cursor, 0);
        assert_eq!(projected.total_item_count, 240);
        assert_eq!(projected.window_start_offset, 80);
        assert_eq!(projected.window_end_offset, 160);
        assert!(projected.has_more);
        assert!(projected.has_newer);
        assert!(!projected.is_at_latest);
    }

    #[tokio::test]
    async fn openclaw_older_window_passes_request_to_replay_loader_and_keeps_window_metadata() {
        let ops = CapturingSessionOps::default();
        let command = Command::new(
            Provider::OpenClaw,
            "agent:main:session-1".to_owned(),
            Some("main".to_owned()),
            WindowRequest::new(Direction::Older, 2, Some(3)).unwrap(),
            Some("session-1".to_owned()),
            true,
        )
        .unwrap();

        let outcome = load_openclaw(&ops, command, 1).await;
        let captured = ops
            .captured
            .lock()
            .expect("captured lock")
            .clone()
            .expect("replay request captured");
        assert_eq!(captured["sessionKey"], "agent:main:session-1");
        assert_eq!(captured["direction"], "older");
        assert_eq!(captured["limit"], 2);
        assert_eq!(captured["offset"], 3);
        assert!(matches!(
            outcome,
            Outcome::Incomplete(SessionView {
                window: SessionFact::Complete(SessionWindow {
                    total_item_count: 12,
                    window_start_offset: 3,
                    window_end_offset: 5,
                    has_more: true,
                    has_newer: true,
                    is_at_latest: false,
                }),
                ..
            })
        ));
    }

    #[test]
    fn openclaw_replay_projection_marks_partial_rows_without_failing_view() {
        let identity = SessionIdentity::new(
            "agent:main:session-1".to_owned(),
            SessionProvider::OpenClaw,
            Some("main".to_owned()),
        )
        .unwrap();
        let window = OpenClawReplayWindow::new(
            partial_replay(),
            SessionWindow {
                total_item_count: 3,
                window_start_offset: 0,
                window_end_offset: 3,
                has_more: false,
                has_newer: false,
                is_at_latest: true,
            },
        )
        .unwrap();

        let view = project_openclaw_replay_view(&identity, &window, 7).unwrap();
        assert!(matches!(
            view.items,
            SessionFact::Incomplete { facts, gaps }
                if gaps == vec![MissingFact::BoundedHistory]
                    && matches!(
                        facts.as_slice(),
                        [SessionItem::System { text, status: ItemStatus::Final, .. }]
                            if text == OPENCLAW_REPLAY_RECOVERY_TEXT
                    )
        ));
        assert!(matches!(
            view.completeness,
            SessionCompleteness::Incomplete { missing }
                if missing.contains(&MissingFact::BoundedHistory)
        ));
    }

    #[test]
    fn openclaw_replay_projection_keeps_text_tool_text_order() {
        let identity = SessionIdentity::new(
            "agent:main:session-1".to_owned(),
            SessionProvider::OpenClaw,
            Some("main".to_owned()),
        )
        .unwrap();
        let window = OpenClawReplayWindow::new(
            replay_from_events([
                decode_event(
                    "chat",
                    json!({
                        "sessionKey": "agent:main:session-1",
                        "runId": "run-1",
                        "seq": 1,
                        "state": "delta",
                        "message": {
                            "id": "message-1",
                            "role": "assistant",
                            "content": [{"type": "text", "text": "before"}]
                        }
                    }),
                    1,
                ),
                tool_event_with_id(2, "start", "tool-1"),
                decode_event(
                    "chat",
                    json!({
                        "sessionKey": "agent:main:session-1",
                        "runId": "run-1",
                        "seq": 3,
                        "state": "delta",
                        "message": {
                            "id": "message-1",
                            "role": "assistant",
                            "content": [{"type": "text", "text": "before after"}]
                        }
                    }),
                    3,
                ),
            ]),
            SessionWindow {
                total_item_count: 3,
                window_start_offset: 0,
                window_end_offset: 3,
                has_more: false,
                has_newer: false,
                is_at_latest: true,
            },
        )
        .unwrap();

        let view = project_openclaw_replay_view(&identity, &window, 7).unwrap();
        let SessionFact::Complete(items) = view.items else {
            panic!("items projected");
        };
        assert!(matches!(
            items.as_slice(),
            [SessionItem::AssistantTurn { text, segments, .. }]
                if text == "before after"
                    && matches!(
                        segments.as_slice(),
                        [
                            SessionContent::Text { text: before },
                            SessionContent::ToolUse { tool_call_id, .. },
                            SessionContent::Text { text: after },
                        ] if before == "before" && tool_call_id == "tool-1" && after == " after"
                    )
        ));
    }

    #[test]
    fn openclaw_replay_projection_merges_native_and_transcript_tool() {
        let window = default_window(transcript_replay([
            openclaw::session::SessionReplaySourceRow::Event(tool_event(1, "start")),
            openclaw::session::SessionReplaySourceRow::TranscriptMessage(transcript_message(
                openclaw::session_window::MessageRole::Assistant,
                "before after",
                vec![
                    openclaw::session_window::MessageContent::Text {
                        text: "before ".to_owned(),
                    },
                    openclaw::session_window::MessageContent::ToolUse {
                        name: "read".to_owned(),
                        tool_call_id: Some("tool-1".to_owned()),
                        input: Some(json!({"path": "Cargo.toml"})),
                        input_text: Some("Cargo.toml".to_owned()),
                    },
                    openclaw::session_window::MessageContent::Text {
                        text: " after".to_owned(),
                    },
                ],
            )),
        ]));

        let view = project_openclaw_replay_view(&openclaw_identity(), &window, 7).unwrap();
        let SessionFact::Complete(items) = view.items else {
            panic!("items projected");
        };
        let SessionFact::Complete(tools) = view.tools else {
            panic!("tools projected");
        };
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].tool_call_id, "tool-1");
        assert_eq!(tools[0].run_id.as_deref(), Some("run-1"));
        assert_eq!(tools[0].name.as_deref(), Some("read"));
        assert_eq!(tools[0].input, Some(json!({"path": "Cargo.toml"})));
        assert_eq!(tools[0].input_text.as_deref(), Some("Cargo.toml"));
        assert!(items.iter().any(|item| matches!(
            item,
            SessionItem::AssistantTurn { segments, text, .. }
                if text == "before \n after"
                    && matches!(
                        segments.as_slice(),
                        [
                            SessionContent::Text { text: before },
                            SessionContent::ToolUse { tool_call_id, .. },
                            SessionContent::Text { text: after },
                        ] if before == "before " && tool_call_id == "tool-1" && after == " after"
                    )
        )));
    }

    #[test]
    fn openclaw_replay_tool_activity_projects_details() {
        let input = None;
        let output = None;
        let details = Some(json!({"lineCount":1}));
        let mut projection = OpenClawReplayProjection {
            items: Vec::new(),
            tools: Vec::new(),
            approvals: Vec::new(),
            runtime: RuntimeView {
                phase: RunPhase::Completed,
                active_run_id: None,
                issue: None,
                runtime_activity: None,
                error_detail: None,
            },
            partial: false,
        };

        projection
            .apply_tool_activity(OpenClawReplayToolActivity {
                run_id: "run-1",
                tool_id: "tool-1",
                tool_name: Some("read"),
                phase: openclaw::session::protocol::ToolActivityPhase::Completed,
                input: &input,
                input_text: None,
                summary: Some("done"),
                output: &output,
                details: &details,
                is_error: Some(false),
            })
            .unwrap();

        assert_eq!(projection.tools.len(), 1);
        assert_eq!(projection.tools[0].details, details);
    }

    #[test]
    fn openclaw_replay_tool_merge_keeps_existing_details_when_sparse_update_has_none() {
        let mut tools = vec![ToolView {
            tool_call_id: "tool-1".to_owned(),
            run_id: Some("run-1".to_owned()),
            name: Some("read".to_owned()),
            phase: ToolPhase::Updated,
            input: None,
            input_text: None,
            summary: None,
            output: None,
            details: Some(json!({"rows":1})),
            is_error: None,
        }];

        upsert_replay_tool(
            &mut tools,
            ToolView {
                tool_call_id: "tool-1".to_owned(),
                run_id: Some("run-1".to_owned()),
                name: None,
                phase: ToolPhase::Completed,
                input: None,
                input_text: None,
                summary: Some("done".to_owned()),
                output: Some(json!({"ok": true})),
                details: None,
                is_error: Some(false),
            },
        );

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].phase, ToolPhase::Completed);
        assert_eq!(tools[0].details, Some(json!({"rows":1})));
        assert_eq!(tools[0].summary.as_deref(), Some("done"));

        upsert_replay_tool(
            &mut tools,
            ToolView {
                tool_call_id: "tool-1".to_owned(),
                run_id: Some("run-1".to_owned()),
                name: None,
                phase: ToolPhase::Completed,
                input: None,
                input_text: None,
                summary: None,
                output: None,
                details: Some(json!({"rows":2})),
                is_error: None,
            },
        );

        assert_eq!(tools[0].details, Some(json!({"rows":2})));
    }

    #[test]
    fn openclaw_replay_projection_keeps_tool_result_out_of_assistant_text() {
        let window = default_window(transcript_replay([
            openclaw::session::SessionReplaySourceRow::TranscriptMessage(transcript_message(
                openclaw::session_window::MessageRole::Assistant,
                "answer",
                vec![
                    openclaw::session_window::MessageContent::Text {
                        text: "answer".to_owned(),
                    },
                    openclaw::session_window::MessageContent::ToolResult {
                        tool_name: Some("read".to_owned()),
                        tool_call_id: Some("tool-1".to_owned()),
                        summary: Some("file list".to_owned()),
                        output: Some(json!({"files": ["Cargo.toml"]})),
                        details: None,
                        is_error: Some(false),
                    },
                ],
            )),
        ]));

        let view = project_openclaw_replay_view(&openclaw_identity(), &window, 7).unwrap();
        let SessionFact::Complete(items) = view.items else {
            panic!("items projected");
        };
        let SessionFact::Complete(tools) = view.tools else {
            panic!("tools projected");
        };
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].tool_call_id, "tool-1");
        assert_eq!(tools[0].name.as_deref(), Some("read"));
        assert_eq!(tools[0].phase, ToolPhase::Completed);
        assert_eq!(tools[0].summary.as_deref(), Some("file list"));
        assert_eq!(tools[0].output, Some(json!({"files": ["Cargo.toml"]})));
        assert!(matches!(
            items.as_slice(),
            [SessionItem::AssistantTurn { segments, text, .. }]
                if text == "answer"
                    && matches!(segments.as_slice(), [SessionContent::Text { text }] if text == "answer")
        ));
    }

    #[test]
    fn openclaw_replay_projection_binds_tool_result_message_to_tool_card() {
        let window = default_window(transcript_replay([
            openclaw::session::SessionReplaySourceRow::TranscriptMessage(transcript_message(
                openclaw::session_window::MessageRole::Assistant,
                "answer",
                vec![
                    openclaw::session_window::MessageContent::Text {
                        text: "answer".to_owned(),
                    },
                    openclaw::session_window::MessageContent::ToolUse {
                        name: "message".to_owned(),
                        tool_call_id: Some("tool-1".to_owned()),
                        input: Some(json!({"text": "hi"})),
                        input_text: Some("hi".to_owned()),
                    },
                ],
            )),
            openclaw::session::SessionReplaySourceRow::TranscriptMessage(transcript_message(
                openclaw::session_window::MessageRole::ToolResult,
                "delivered text",
                vec![openclaw::session_window::MessageContent::ToolResult {
                    tool_name: Some("message".to_owned()),
                    tool_call_id: Some("tool-1".to_owned()),
                    summary: Some("sent".to_owned()),
                    output: Some(json!({"ok": true})),
                    details: Some(json!({"changed": true})),
                    is_error: Some(false),
                }],
            )),
        ]));

        let view = project_openclaw_replay_view(&openclaw_identity(), &window, 7).unwrap();
        let SessionFact::Complete(items) = view.items else {
            panic!("items projected");
        };
        let SessionFact::Complete(tools) = view.tools else {
            panic!("tools projected");
        };
        assert_eq!(items.len(), 1);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].tool_call_id, "tool-1");
        assert_eq!(tools[0].name.as_deref(), Some("message"));
        assert_eq!(tools[0].input, Some(json!({"text": "hi"})));
        assert_eq!(tools[0].input_text.as_deref(), Some("hi"));
        assert_eq!(tools[0].summary.as_deref(), Some("sent"));
        assert_eq!(tools[0].output, Some(json!({"ok": true})));
        assert!(matches!(
            items.as_slice(),
            [SessionItem::AssistantTurn { segments, text, .. }]
                if text == "answer"
                    && matches!(segments.as_slice(), [SessionContent::Text { .. }, SessionContent::ToolUse { tool_call_id, .. }] if tool_call_id == "tool-1")
        ));
    }

    #[test]
    fn openclaw_replay_projection_materializes_text_thinking_tool_approval_and_final() {
        let identity = SessionIdentity::new(
            "agent:main:session-1".to_owned(),
            SessionProvider::OpenClaw,
            Some("main".to_owned()),
        )
        .unwrap();
        let window = OpenClawReplayWindow::new(
            replay_from_events([
                tool_event(1, "start"),
                tool_event(2, "result"),
                approval_event(3, "exec.approval.requested"),
                approval_event(4, "exec.approval.resolved"),
                terminal_snapshot(5),
            ]),
            SessionWindow {
                total_item_count: 5,
                window_start_offset: 0,
                window_end_offset: 5,
                has_more: false,
                has_newer: false,
                is_at_latest: true,
            },
        )
        .unwrap();

        let view = project_openclaw_replay_view(&identity, &window, 7).unwrap();
        let SessionFact::Complete(items) = view.items else {
            panic!("items projected");
        };
        assert_eq!(view.seq, 0);
        assert_eq!(view.cursor, 0);
        assert!(matches!(
            items.as_slice(),
            [SessionItem::AssistantTurn {
                status: ItemStatus::Final,
                run_id: Some(run_id),
                message_id: Some(message_id),
                text,
                segments,
                ..
            }] if run_id == "run-1"
                && message_id == "message-1"
                && text == "answer"
                && segments.iter().any(|segment| matches!(segment, SessionContent::Text { text } if text == "answer"))
                && segments.iter().any(|segment| matches!(segment, SessionContent::Thinking { text } if text == "plan"))
                && segments.iter().any(|segment| matches!(segment, SessionContent::ToolUse { name, tool_call_id } if name == "read" && tool_call_id == "tool-1"))
        ));
        let SessionFact::Complete(tools) = view.tools else {
            panic!("tools projected");
        };
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].tool_call_id, "tool-1");
        assert_eq!(tools[0].run_id.as_deref(), Some("run-1"));
        assert_eq!(tools[0].name.as_deref(), Some("read"));
        assert_eq!(tools[0].phase, ToolPhase::Completed);
        assert_eq!(tools[0].input, Some(json!({"path": "Cargo.toml"})));
        assert_eq!(
            tools[0].input_text.as_deref(),
            Some("{\n  \"path\": \"Cargo.toml\"\n}")
        );
        assert_eq!(tools[0].summary.as_deref(), Some("file list"));
        assert_eq!(tools[0].output, Some(json!({"files": ["Cargo.toml"]})));
        assert_eq!(tools[0].is_error, Some(false));
        let SessionFact::Complete(approvals) = view.approvals else {
            panic!("approvals projected");
        };
        assert!(matches!(
            approvals.as_slice(),
            [ApprovalView {
                approval_id,
                run_id: Some(run_id),
                phase: ApprovalPhase::Resolved,
                option_ids,
            }] if approval_id == "approval-1"
                && run_id == "run-1"
                && option_ids == &vec!["allow-once".to_owned(), "deny".to_owned()]
        ));
        assert!(matches!(
            view.runtime,
            SessionFact::Incomplete {
                facts: RuntimeView {
                    phase: RunPhase::Completed,
                    active_run_id: None,
                    ..
                },
                ..
            }
        ));
    }
}
