use crate::{
    Host,
    session_state::{
        ApprovalPhase, ApprovalView, ItemStatus, MissingFact, OmissionReason, RunPhase,
        RuntimeView, SessionCompleteness, SessionContent, SessionFact, SessionIdentity,
        SessionItem, SessionProvider, SessionView, SessionWindow, ToolPhase, ToolView,
    },
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Direction {
    Latest,
    Older,
    Newer,
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

    pub(crate) fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    pub(crate) fn endpoint_session_id(&self) -> Option<&str> {
        self.endpoint_session_id.as_deref()
    }

    pub(crate) const fn include_canonical(&self) -> bool {
        self.include_canonical
    }

    pub(crate) const fn offset(&self) -> Option<usize> {
        self.window.offset()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Complete(SessionView),
    Incomplete(SessionView),
    Unavailable,
}

impl Host {
    pub(crate) async fn load_session_timeline(&mut self, command: Command) -> Outcome {
        if self.admission.admit_request().is_err() {
            return Outcome::Unavailable;
        }
        match command.provider {
            Provider::Matcha => self.load_matcha_timeline(command).await,
            Provider::OpenClaw => self.load_openclaw_timeline(command).await,
        }
    }

    async fn load_matcha_timeline(&self, command: Command) -> Outcome {
        let Some(session_id) =
            matcha_agent::session::model::SessionId::try_new(command.session_key.clone()).ok()
        else {
            return Outcome::Unavailable;
        };
        if self.matcha().snapshot().phase()
            != foundation::process::supervision::SupervisorPhase::Running
        {
            return Outcome::Unavailable;
        }
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
        let facts = match self
            .matcha()
            .read_canonical_session(session_id, request)
            .await
        {
            matcha_agent::session::history::HistoryResult::Complete(facts) => facts,
            matcha_agent::session::history::HistoryResult::Incomplete(_)
            | matcha_agent::session::history::HistoryResult::NotFound
            | matcha_agent::session::history::HistoryResult::Unavailable
            | matcha_agent::session::history::HistoryResult::Unknown => {
                return Outcome::Unavailable;
            }
        };
        let Some(identity) = SessionIdentity::new(
            command.session_key,
            SessionProvider::MatchaAgent,
            command.agent_id,
        ) else {
            return Outcome::Unavailable;
        };
        project_matcha_view(&identity, &facts, self.session_epoch())
            .map(Outcome::Incomplete)
            .unwrap_or(Outcome::Unavailable)
    }

    async fn load_openclaw_timeline(&mut self, command: Command) -> Outcome {
        let history_key = openclaw_history_key(&command);
        let key = match openclaw::session::protocol::SessionKey::try_new(history_key) {
            Ok(key) => key,
            Err(_) => return Outcome::Unavailable,
        };
        let params = match openclaw::session::protocol::ChatHistoryParams::new(key)
            .try_with_limit(command.window.limit() as u64)
        {
            Ok(params) => params,
            Err(_) => return Outcome::Unavailable,
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
            None => return Outcome::Unavailable,
        };
        let window = match self.open_claw_history_window(params, request).await {
            Ok(window) => window,
            Err(_) => return Outcome::Unavailable,
        };
        let agent_id = command
            .agent_id
            .or_else(|| command.session_key.split(':').nth(1).map(str::to_owned));
        let Some(identity) =
            SessionIdentity::new(command.session_key, SessionProvider::OpenClaw, agent_id)
        else {
            return Outcome::Unavailable;
        };
        project_openclaw_view(&identity, &window, self.session_epoch())
            .map(Outcome::Incomplete)
            .unwrap_or(Outcome::Unavailable)
    }
}

fn project_matcha_view(
    identity: &SessionIdentity,
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

fn openclaw_history_key(command: &Command) -> String {
    command
        .endpoint_session_id
        .clone()
        .unwrap_or_else(|| command.session_key.clone())
}

fn project_openclaw_view(
    identity: &SessionIdentity,
    window: &openclaw::session_window::SessionWindow,
    epoch: u64,
) -> Option<SessionView> {
    let range = window.range();
    let view = SessionView {
        session_key: identity.session_key.clone(),
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
    window
        .messages()
        .iter()
        .flat_map(|message| message.content().iter())
        .filter_map(|block| match block {
            openclaw::session_window::MessageContent::ToolUse {
                name,
                tool_call_id: Some(tool_call_id),
            } => Some(ToolView {
                tool_call_id: tool_call_id.clone(),
                run_id: None,
                name: Some(name.clone()),
                phase: ToolPhase::Started,
                summary: None,
                is_error: None,
            }),
            openclaw::session_window::MessageContent::ToolResult {
                tool_call_id: Some(tool_call_id),
                summary,
                is_error,
                ..
            } => Some(ToolView {
                tool_call_id: tool_call_id.clone(),
                run_id: None,
                name: None,
                phase: if is_error == &Some(true) {
                    ToolPhase::Failed
                } else {
                    ToolPhase::Completed
                },
                summary: summary.clone(),
                is_error: *is_error,
            }),
            _ => None,
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
    fn openclaw_history_key_uses_endpoint_session_id_as_native_key() {
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
            openclaw_history_key(&command),
            "team-endpoint-session-a8b648cce33bcc074ffa958a5436e843"
        );
    }

    #[test]
    fn openclaw_history_key_keeps_prefixed_endpoint_session_id() {
        let command = Command::new(
            Provider::OpenClaw,
            "agent:main:main".to_owned(),
            Some("main".to_owned()),
            WindowRequest::latest(),
            Some("agent:main:main".to_owned()),
            true,
        )
        .unwrap();

        assert_eq!(openclaw_history_key(&command), "agent:main:main");
    }
}
