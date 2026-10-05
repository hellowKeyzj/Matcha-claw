use crate::state::{MAX_CONTENT_REF_BYTES, SessionIdentity, SessionProvider, SessionView};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SESSION_KEY_BYTES: usize = 4096;
const MAX_ID_BYTES: usize = 256;
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;
const MAX_WINDOW_LIMIT: usize = 200;
const DEFAULT_WINDOW_LIMIT: usize = 80;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    OpenClaw,
    Matcha,
}

impl Provider {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
            Self::Matcha => "matcha-agent",
        }
    }

    pub const fn session_provider(self) -> SessionProvider {
        match self {
            Self::OpenClaw => SessionProvider::OpenClaw,
            Self::Matcha => SessionProvider::MatchaAgent,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Latest,
    Older,
    Newer,
}

impl Direction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Latest => "latest",
            Self::Older => "older",
            Self::Newer => "newer",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowRequest {
    direction: Direction,
    limit: usize,
    offset: Option<usize>,
}

impl WindowRequest {
    pub const fn latest() -> Self {
        Self {
            direction: Direction::Latest,
            limit: DEFAULT_WINDOW_LIMIT,
            offset: None,
        }
    }

    pub const fn new(direction: Direction, limit: usize, offset: Option<usize>) -> Option<Self> {
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContentCommand {
    identity: SessionIdentity,
    endpoint_session_id: Option<String>,
    content_ref: String,
    offset: u64,
    limit: usize,
}

impl ContentCommand {
    pub fn new(
        identity: SessionIdentity,
        endpoint_session_id: Option<String>,
        content_ref: String,
        offset: u64,
        limit: usize,
    ) -> Option<Self> {
        if SessionIdentity::with_endpoint(identity.session_key.clone(), identity.endpoint.clone(), identity.agent_id.clone()).is_err()
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
            identity,
            endpoint_session_id,
            content_ref,
            offset,
            limit,
        })
    }

    pub fn identity(&self) -> &SessionIdentity {
        &self.identity
    }

    pub fn provider(&self) -> Provider {
        match self.identity.provider() {
            SessionProvider::OpenClaw => Provider::OpenClaw,
            SessionProvider::MatchaAgent => Provider::Matcha,
        }
    }

    pub fn session_provider(&self) -> SessionProvider {
        self.identity.provider()
    }

    pub fn session_key(&self) -> &str {
        self.identity.session_key()
    }

    pub fn agent_id(&self) -> Option<&str> {
        Some(&self.identity.agent_id)
    }

    pub fn endpoint_session_id(&self) -> Option<&str> {
        self.endpoint_session_id.as_deref()
    }

    pub fn with_endpoint_session_id(mut self, endpoint_session_id: String) -> Option<Self> {
        if !valid_optional_bounded_text(Some(&endpoint_session_id), MAX_ENDPOINT_SESSION_ID_BYTES) {
            return None;
        }
        self.endpoint_session_id = Some(endpoint_session_id);
        Some(self)
    }

    pub fn content_ref(&self) -> &str {
        &self.content_ref
    }

    pub const fn offset(&self) -> u64 {
        self.offset
    }

    pub const fn limit(&self) -> usize {
        self.limit
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContentChunk {
    pub content_ref: String,
    pub offset: u64,
    pub text: String,
    pub next_offset: u64,
    pub total_bytes: u64,
    pub complete: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContentOutcome {
    Complete(ContentChunk),
    Unavailable(UnavailableReason),
}

impl ContentOutcome {
    pub const fn unavailable(reason: UnavailableReason) -> Self {
        Self::Unavailable(reason)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation {
    Load,
    Window,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Command {
    operation: Operation,
    identity: SessionIdentity,
    window: WindowRequest,
    endpoint_session_id: Option<String>,
    include_canonical: bool,
}

impl Command {
    pub fn new(
        operation: Operation,
        identity: SessionIdentity,
        window: WindowRequest,
        endpoint_session_id: Option<String>,
        include_canonical: bool,
    ) -> Option<Self> {
        if SessionIdentity::with_endpoint(identity.session_key.clone(), identity.endpoint.clone(), identity.agent_id.clone()).is_err()
            || !valid_optional_bounded_text(
                endpoint_session_id.as_deref(),
                MAX_ENDPOINT_SESSION_ID_BYTES,
            )
        {
            return None;
        }
        Some(Self {
            operation,
            identity,
            window,
            endpoint_session_id,
            include_canonical,
        })
    }

    pub const fn operation(&self) -> Operation {
        self.operation
    }

    pub fn identity(&self) -> &SessionIdentity {
        &self.identity
    }

    pub fn provider(&self) -> Provider {
        match self.identity.provider() {
            SessionProvider::OpenClaw => Provider::OpenClaw,
            SessionProvider::MatchaAgent => Provider::Matcha,
        }
    }

    pub fn session_provider(&self) -> SessionProvider {
        self.identity.provider()
    }

    pub fn session_key(&self) -> &str {
        self.identity.session_key()
    }

    pub fn agent_id(&self) -> Option<&str> {
        Some(&self.identity.agent_id)
    }

    pub fn endpoint_session_id(&self) -> Option<&str> {
        self.endpoint_session_id.as_deref()
    }

    pub fn with_endpoint_session_id(mut self, endpoint_session_id: String) -> Option<Self> {
        if !valid_optional_bounded_text(Some(&endpoint_session_id), MAX_ENDPOINT_SESSION_ID_BYTES) {
            return None;
        }
        self.endpoint_session_id = Some(endpoint_session_id);
        Some(self)
    }

    pub const fn include_canonical(&self) -> bool {
        self.include_canonical
    }

    pub const fn direction(&self) -> Direction {
        self.window.direction()
    }

    pub const fn limit(&self) -> usize {
        self.window.limit()
    }

    pub const fn offset(&self) -> Option<usize> {
        self.window.offset()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnavailableReason {
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
    pub const fn as_str(self) -> &'static str {
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
pub struct UnavailableDiagnostic {
    source: &'static str,
    message_index: Option<usize>,
    block_index: Option<usize>,
    block_type: Option<&'static str>,
    field: &'static str,
    reason: &'static str,
    actual: &'static str,
}

impl UnavailableDiagnostic {
    pub const fn new(
        source: &'static str,
        message_index: Option<usize>,
        block_index: Option<usize>,
        block_type: Option<&'static str>,
        field: &'static str,
        reason: &'static str,
        actual: &'static str,
    ) -> Self {
        Self {
            source,
            message_index,
            block_index,
            block_type,
            field,
            reason,
            actual,
        }
    }

    pub const fn source(&self) -> &'static str {
        self.source
    }

    pub const fn message_index(&self) -> Option<usize> {
        self.message_index
    }

    pub const fn block_index(&self) -> Option<usize> {
        self.block_index
    }

    pub const fn block_type(&self) -> Option<&'static str> {
        self.block_type
    }

    pub const fn field(&self) -> &'static str {
        self.field
    }

    pub const fn reason(&self) -> &'static str {
        self.reason
    }

    pub const fn actual(&self) -> &'static str {
        self.actual
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UnavailableFailure {
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

    pub const fn reason(&self) -> UnavailableReason {
        self.reason
    }

    pub const fn diagnostic(&self) -> Option<UnavailableDiagnostic> {
        self.diagnostic
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Outcome {
    Complete(SessionView),
    Incomplete(SessionView),
    Unavailable(UnavailableFailure),
}

impl Outcome {
    pub const fn unavailable(reason: UnavailableReason) -> Self {
        Self::Unavailable(UnavailableFailure::new(reason))
    }

    pub const fn unavailable_with_diagnostic(
        reason: UnavailableReason,
        diagnostic: UnavailableDiagnostic,
    ) -> Self {
        Self::Unavailable(UnavailableFailure::with_diagnostic(reason, diagnostic))
    }

    pub const fn unavailable_reason(&self) -> Option<UnavailableReason> {
        match self {
            Self::Unavailable(failure) => Some(failure.reason()),
            Self::Complete(_) | Self::Incomplete(_) => None,
        }
    }

    pub const fn unavailable_diagnostic(&self) -> Option<UnavailableDiagnostic> {
        match self {
            Self::Unavailable(failure) => failure.diagnostic(),
            Self::Complete(_) | Self::Incomplete(_) => None,
        }
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
    use super::*;

    #[test]
    fn rejects_endpoint_session_id_that_cannot_be_bound() {
        let command = Command::new(
            Operation::Load,
            Provider::OpenClaw,
            "session-1".to_owned(),
            None,
            WindowRequest::latest(),
            Some(
                "endpoint
 session"
                    .to_owned(),
            ),
            true,
        );
        assert!(command.is_none());
    }

    #[test]
    fn keeps_canonical_request_controls_on_the_command() {
        let command = Command::new(
            Operation::Load,
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
}
