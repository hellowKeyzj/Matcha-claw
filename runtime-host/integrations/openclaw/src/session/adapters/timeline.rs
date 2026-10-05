use std::collections::HashMap;

use crate::port::OpenClawSessionError;
use platform::state_dir::CanonicalStateDir;
use sessions_module::{
    RuntimeSessionError,
    state::{
        ApprovalPhase, ApprovalView, ItemStatus, MissingFact, OmissionReason, RunPhase,
        RunProgress, RunStartupPhase, RuntimeActivity, RuntimeErrorDetail, RuntimeErrorKind,
        RuntimeView, SessionCompleteness, SessionContent, SessionFact, SessionIdentity,
        SessionItem, SessionProvider, SessionView, SessionWindow, ToolPhase, ToolView,
        public_media_reference,
    },
    timeline::{self, Direction, Outcome, UnavailableDiagnostic, UnavailableReason},
};

use crate::driver::OpenClawDriver;

const MAX_OPENCLAW_WINDOW_LIMIT: u64 = crate::session::window::PageRequest::MAX_LIMIT as u64;

impl OpenClawDriver {
    pub(super) async fn load_openclaw_session_timeline(
        &self,
        command: timeline::Command,
        epoch: u64,
    ) -> timeline::Outcome {
        let page = match openclaw_page_request(&command) {
            Ok(page) => page, Err(_) => return Outcome::unavailable(UnavailableReason::OpenClawBindingInvalid),
        };
        let window = match self.session_gateway.history_for_identity(command.identity(), page, None).await {
            Ok(window) => window,
            Err(error) => {
                let failure = openclaw_read_failure(RuntimeSessionError::Client(error));
                return match failure.diagnostic {
                    Some(diagnostic) => Outcome::unavailable_with_diagnostic(failure.reason, diagnostic),
                    None => Outcome::unavailable(failure.reason),
                };
            }
        };
        let key = match crate::session::protocol::SessionKey::try_new(command.session_key().to_owned()) {
            Ok(key) => key, Err(_) => return Outcome::unavailable(UnavailableReason::OpenClawSessionKeyInvalid),
        };
        let mut actor = crate::session::reducer::SessionReducerActor::new(key);
        let source_epoch = match crate::gateway::ingress::GatewayEpoch::try_new(1) {
            Ok(epoch) => epoch, Err(_) => unreachable!(),
        };
        if actor.sync_history(&window, page, source_epoch).is_err() {
            return Outcome::unavailable(UnavailableReason::OpenClawProjectionInvalid);
        }
        match actor.snapshot(epoch) {
            Ok(mut view) => { view.identity = command.identity().clone(); Outcome::Incomplete(view) },
            Err(_) => Outcome::unavailable(UnavailableReason::OpenClawProjectionInvalid),
        }
    }
}

#[cfg(test)]
async fn load_openclaw_session_timeline_from_state(
    state_dir: &CanonicalStateDir,
    command: timeline::Command,
    epoch: u64,
) -> timeline::Outcome {
    let Some(history_key) = openclaw_history_key(&command) else {
        return Outcome::unavailable(UnavailableReason::OpenClawBindingInvalid);
    };
    let key = match crate::session::protocol::SessionKey::try_new(history_key.clone()) {
        Ok(key) => key,
        Err(_) => return Outcome::unavailable(UnavailableReason::OpenClawSessionKeyInvalid),
    };
    let window = match load_openclaw_replay_window(state_dir, key, &command) {
        Ok(window)
            if openclaw_replay_identity_matches(&window, command.session_key(), &history_key) =>
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
        .agent_id()
        .map(str::to_owned)
        .or_else(|| command.session_key().split(':').nth(1).map(str::to_owned));
    let Some(identity) = SessionIdentity::new(
        command.session_key().to_owned(),
        SessionProvider::OpenClaw,
        agent_id.unwrap_or_default(),
    ) else {
        return Outcome::unavailable(UnavailableReason::OpenClawIdentityInvalid);
    };
    project_openclaw_replay_view(&identity, &window, epoch)
        .map(Outcome::Incomplete)
        .unwrap_or_else(|| Outcome::unavailable(UnavailableReason::OpenClawProjectionInvalid))
}

#[cfg(test)]
fn load_openclaw_replay_window(
    state_dir: &CanonicalStateDir,
    session_key: crate::session::protocol::SessionKey,
    command: &timeline::Command,
) -> Result<OpenClawTimelineWindow, RuntimeSessionError<OpenClawSessionError>> {
    let page_request = openclaw_page_request(command)?;
    let source = crate::session::load_session_replay_source(state_dir, session_key, page_request)
        .map_err(openclaw_replay_source_error)?;
    let range = source.source_range();
    let total_item_count = source.total_source_events() as u64;
    let window = SessionWindow {
        total_item_count,
        window_start_offset: range.start() as u64,
        window_end_offset: range.end() as u64,
        has_more: range.start() > 0,
        has_newer: range.end() < source.total_source_events(),
        is_at_latest: range.end() >= source.total_source_events(),
    };
    let replay = crate::session::materialize_session_replay_rows(
        source.session_key().clone(),
        source.into_rows(),
        None,
    )
    .map_err(|_| RuntimeSessionError::Client(OpenClawSessionError::Protocol(None)))?;
    OpenClawTimelineWindow::new(replay, window).ok_or(RuntimeSessionError::Client(
        OpenClawSessionError::Protocol(None),
    ))
}

pub(crate) fn openclaw_page_request(
    command: &timeline::Command,
) -> Result<crate::session::window::PageRequest, RuntimeSessionError<OpenClawSessionError>> {
    let direction = match command.direction() {
        Direction::Latest => crate::session::window::Direction::Latest,
        Direction::Older => crate::session::window::Direction::Older,
        Direction::Newer => crate::session::window::Direction::Newer,
    };
    crate::session::window::PageRequest::new(direction, command.limit(), command.offset()).ok_or(
        RuntimeSessionError::Client(OpenClawSessionError::TargetRejected),
    )
}

fn openclaw_replay_source_error(
    error: crate::session::SessionReplaySourceError,
) -> RuntimeSessionError<OpenClawSessionError> {
    RuntimeSessionError::Client(match error {
        crate::session::SessionReplaySourceError::MissingStateDir => {
            OpenClawSessionError::SessionConnection
        }
        crate::session::SessionReplaySourceError::UnsupportedSessionKey => {
            OpenClawSessionError::TargetRejected
        }
        crate::session::SessionReplaySourceError::AgentStoreUnavailable
        | crate::session::SessionReplaySourceError::StoreReadFailed => {
            OpenClawSessionError::Transport
        }
        crate::session::SessionReplaySourceError::SessionUnavailable => {
            OpenClawSessionError::UnknownResponse
        }
        crate::session::SessionReplaySourceError::SourceMalformed
        | crate::session::SessionReplaySourceError::SourceUndecodable { .. } => {
            OpenClawSessionError::Protocol(None)
        }
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OpenClawTimelineWindow {
    replay: crate::port::CanonicalSessionReplay,
    window: SessionWindow,
}

impl OpenClawTimelineWindow {
    fn new(replay: crate::port::CanonicalSessionReplay, window: SessionWindow) -> Option<Self> {
        (window.window_start_offset <= window.window_end_offset
            && window.window_end_offset <= window.total_item_count
            && window.window_end_offset - window.window_start_offset <= MAX_OPENCLAW_WINDOW_LIMIT)
            .then_some(Self { replay, window })
    }

    const fn replay(&self) -> &crate::port::CanonicalSessionReplay {
        &self.replay
    }

    const fn window(&self) -> SessionWindow {
        self.window
    }
}

fn openclaw_history_diagnostic(
    error: crate::session::window::HistoryError,
) -> UnavailableDiagnostic {
    let diagnostic = error.diagnostic();
    UnavailableDiagnostic::new(
        "openclaw.history",
        diagnostic.message_index(),
        diagnostic.block_index(),
        None,
        diagnostic.field(),
        diagnostic.reason(),
        diagnostic.actual(),
    )
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

fn openclaw_read_failure(error: RuntimeSessionError<OpenClawSessionError>) -> OpenClawReadFailure {
    match error {
        RuntimeSessionError::AdmissionClosed(_) | RuntimeSessionError::RuntimeUnavailable => {
            OpenClawReadFailure::new(UnavailableReason::RuntimeUnavailable)
        }
        RuntimeSessionError::Client(error) => match error {
            OpenClawSessionError::SessionConnection => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadSessionConnection)
            }
            OpenClawSessionError::RequestIdExhausted => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadRequestIdExhausted)
            }
            OpenClawSessionError::RequestDeadline => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadRequestDeadline)
            }
            OpenClawSessionError::ConnectionClosed => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadConnectionClosed)
            }
            OpenClawSessionError::UnknownResponse => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadUnknownResponse)
            }
            OpenClawSessionError::Transport => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadTransport)
            }
            OpenClawSessionError::Protocol(error) => match error {
                Some(error) => OpenClawReadFailure::with_diagnostic(
                    UnavailableReason::OpenClawReadProtocol,
                    openclaw_history_diagnostic(error),
                ),
                None => OpenClawReadFailure::new(UnavailableReason::OpenClawReadProtocol),
            },
            OpenClawSessionError::TargetRejected => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadTargetRejected)
            }
            OpenClawSessionError::EventBackpressure => {
                OpenClawReadFailure::new(UnavailableReason::OpenClawReadEventBackpressure)
            }
        },
    }
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

fn openclaw_history_key(command: &timeline::Command) -> Option<String> {
    let session_key = command.session_key();
    let (agent_id, endpoint_session_id) = parse_openclaw_session_key(session_key)?;
    if command
        .agent_id()
        .is_some_and(|expected| expected != agent_id)
    {
        return None;
    }
    if command
        .endpoint_session_id()
        .is_some_and(|bound| bound != endpoint_session_id)
    {
        return None;
    }
    Some(session_key.to_owned())
}

fn openclaw_replay_identity_matches(
    window: &OpenClawTimelineWindow,
    session_key: &str,
    history_key: &str,
) -> bool {
    session_key == history_key && window.replay().session_key().as_str() == history_key
}

fn project_openclaw_replay_view(
    identity: &SessionIdentity,
    window: &OpenClawTimelineWindow,
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
        ownership: None,
        model_state: None,
        goal: sessions_module::goal::SessionGoalView::Unknown,
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

#[derive(Clone)]
pub(crate) struct OpenClawReplayProjection {
    pub(crate) items: Vec<SessionItem>,
    pub(crate) tools: Vec<ToolView>,
    tool_sources: HashMap<String, ToolSources>,
    pub(crate) approvals: Vec<ApprovalView>,
    pub(crate) runtime: RuntimeView,
    pub(crate) partial: bool,
}

#[derive(Clone, Copy, Default)]
struct ToolSources {
    call_rank: u8,
    result_rank: u8,
}

impl OpenClawReplayProjection {
    pub(crate) fn empty() -> Self {
        Self { items: Vec::new(), tools: Vec::new(), tool_sources: HashMap::new(), approvals: Vec::new(),
            runtime: RuntimeView { phase: RunPhase::Completed, active_run_id: None, issue: None,
                run_progress: None, runtime_activity: None, error_detail: None }, partial: false }
    }

    fn from_replay(replay: &crate::port::CanonicalSessionReplay) -> Option<Self> {
        let mut projection = Self::empty();
        for result in replay.ingress_results() {
            let crate::port::CanonicalIngressResult::Produced(delta) = result else {
                continue;
            };
            for change in delta.changes() {
                projection.apply_change(change)?;
            }
        }
        Some(projection)
    }

    pub(crate) fn apply_change(
        &mut self,
        change: &crate::session::projection::CanonicalSessionChange,
    ) -> Option<()> {
        match change {
            crate::session::projection::CanonicalSessionChange::RunStarted { run_id } => {
                self.apply_run_started(run_id.as_str())
            }
            crate::session::projection::CanonicalSessionChange::AssistantTurnChunk {
                run_id, status, ..
            } => {
                self.observe_assistant_turn_status(run_id.as_str(), *status);
                Some(())
            }
            crate::session::projection::CanonicalSessionChange::AssistantTurnSnapshot { snapshot } => {
                self.observe_assistant_turn_status(snapshot.run_id.as_str(), snapshot.status);
                Some(())
            }
            crate::session::projection::CanonicalSessionChange::ToolActivity { .. } => {
                self.apply_tool_observation(change).map(|_| ())
            }
            crate::session::projection::CanonicalSessionChange::RuntimeActivity {
                run_id,
                activity,
            } => self.apply_runtime_activity(run_id.as_str(), Some(*activity)),
            crate::session::projection::CanonicalSessionChange::RuntimeActivityCleared {
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
            crate::session::projection::CanonicalSessionChange::RunProgress {
                run_id,
                progress,
            } => self.apply_run_progress(run_id.as_str(), Some(*progress)),
            crate::session::projection::CanonicalSessionChange::RuntimeFallback {
                detail, ..
            } => self.apply_runtime_fallback(detail),
            crate::session::projection::CanonicalSessionChange::RuntimeFallbackCleared {
                ..
            } => self.apply_runtime_fallback_cleared(),
            crate::session::projection::CanonicalSessionChange::GuardianNotice { .. } => Some(()),
            crate::session::projection::CanonicalSessionChange::ApprovalRequested {
                run_id,
                approval_id,
                option_ids,
            } => self.upsert_approval(
                approval_id.as_str(),
                Some(run_id.as_str()),
                ApprovalPhase::Requested,
                option_ids.iter().map(|id| id.as_str()).collect(),
            ),
            crate::session::projection::CanonicalSessionChange::ApprovalResolved {
                run_id,
                approval_id,
                option_ids,
            } => self.upsert_approval(
                approval_id.as_str(),
                Some(run_id.as_str()),
                ApprovalPhase::Resolved,
                option_ids.iter().map(|id| id.as_str()).collect(),
            ),
            crate::session::projection::CanonicalSessionChange::Terminal {
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
            crate::session::projection::CanonicalSessionChange::RecoveryRequired { .. } => {
                self.apply_recovery()
            }
            crate::session::projection::CanonicalSessionChange::ItemsReplaced { old_item_ids, anchor, items } => {
                self.items.retain(|item| !old_item_ids.iter().any(|id| id == item.item_id()) && !items.iter().any(|incoming| incoming.item_id() == item.item_id()));
                let index = match anchor {
                    sessions_module::state::ItemAnchor::Start => 0,
                    sessions_module::state::ItemAnchor::After { item_id } => self.items.iter().position(|item| item.item_id() == item_id)?.checked_add(1)?,
                };
                if self.items.len() + items.len() > 200 { return None; }
                self.items.splice(index..index, items.iter().cloned());
                Some(())
            }
            crate::session::projection::CanonicalSessionChange::TranscriptMessage { message } => {
                for content in message.content() { self.apply_transcript_tool_content(message, content)?; }
                Some(())
            }
        }
    }

    pub(crate) fn apply_tool_observation(
        &mut self,
        change: &crate::session::projection::CanonicalSessionChange,
    ) -> Option<crate::session::projection::CanonicalSessionChange> {
        use crate::session::{projection::CanonicalSessionChange, protocol::ToolActivityPhase};
        let CanonicalSessionChange::ToolActivity {
            run_id, tool_id, tool_name, phase, input, input_text, summary, output, details, is_error,
        } = change else { return None; };
        let result_rank = match phase {
            ToolActivityPhase::Started => 0,
            ToolActivityPhase::Updated => 1,
            ToolActivityPhase::Completed | ToolActivityPhase::Failed => 2,
        };
        let tool = self.merge_tool(ToolView {
            tool_call_id: tool_id.as_str().to_owned(), run_id: Some(run_id.as_str().to_owned()),
            name: tool_name.clone(), phase: openclaw_replay_tool_phase(*phase),
            input: input.clone(), input_text: input_text.clone(), summary: summary.clone(),
            output: output.clone(), details: details.clone(), is_error: *is_error,
        }, 1, result_rank)?;
        let merged = canonical_tool_change(tool)?;
        self.apply_run_started(run_id.as_str())?;
        Some(merged)
    }

    pub(crate) fn transcript_tool_changes(
        &self,
        message: &crate::session::window::Message,
    ) -> Vec<crate::session::projection::CanonicalSessionChange> {
        let mut ids = Vec::new();
        for content in message.content() {
            let id = match content {
                crate::session::window::MessageContent::ToolUse { tool_call_id, .. }
                | crate::session::window::MessageContent::ToolResult { tool_call_id, .. } => tool_call_id.as_deref(),
                crate::session::window::MessageContent::MessageToolDelivery { .. } => transcript_message_tool_call_id(message),
                _ => None,
            };
            if let Some(id) = id && !ids.contains(&id) { ids.push(id); }
        }
        ids.into_iter().filter_map(|id| self.tools.iter().find(|tool| tool.tool_call_id == id))
            .filter_map(canonical_tool_change).collect()
    }

    pub(crate) fn retain_tool_provenance(&mut self) {
        self.tool_sources.retain(|id, _| self.tools.iter().any(|tool| &tool.tool_call_id == id));
    }

    fn merge_tool(&mut self, tool: ToolView, call_rank: u8, result_rank: u8) -> Option<&ToolView> {
        let index = self.tools.iter().position(|existing| existing.tool_call_id == tool.tool_call_id);
        if index.is_some_and(|index| matches!((&self.tools[index].run_id, &tool.run_id),
            (Some(owner), Some(incoming)) if owner != incoming))
        {
            return None;
        }
        let sources = self.tool_sources.entry(tool.tool_call_id.clone()).or_default();
        let Some(index) = index else {
            *sources = ToolSources { call_rank, result_rank };
            self.tools.push(tool);
            return self.tools.last();
        };
        let existing = &mut self.tools[index];
        let prefer_call = call_rank >= sources.call_rank;
        let prefer_result = result_rank >= sources.result_rank;
        merge_tool_field(&mut existing.name, tool.name, prefer_call);
        merge_tool_field(&mut existing.input, tool.input, prefer_call);
        merge_tool_field(&mut existing.input_text, tool.input_text, prefer_call);
        merge_tool_field(&mut existing.summary, tool.summary, prefer_result);
        merge_tool_field(&mut existing.output, tool.output, prefer_result);
        merge_tool_details(&mut existing.details, tool.details, prefer_result);
        merge_tool_field(&mut existing.is_error, tool.is_error, prefer_result);
        merge_tool_field(&mut existing.run_id, tool.run_id, false);
        if prefer_result && (!matches!(existing.phase, ToolPhase::Completed | ToolPhase::Failed)
            || matches!(tool.phase, ToolPhase::Completed | ToolPhase::Failed))
        {
            existing.phase = tool.phase;
        }
        sources.call_rank = sources.call_rank.max(call_rank);
        sources.result_rank = sources.result_rank.max(result_rank);
        Some(existing)
    }

    fn apply_run_started(&mut self, run_id: &str) -> Option<()> {
        self.runtime.phase = RunPhase::Started;
        self.runtime.active_run_id = Some(run_id.to_owned());
        self.runtime.run_progress = None;
        self.runtime.runtime_activity = None;
        self.runtime.error_detail = None;
        Some(())
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
        if self.items.len() >= crate::session::window::PageRequest::MAX_LIMIT {
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
        message: &crate::session::window::Message,
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
        message: &crate::session::window::Message,
        content: &crate::session::window::MessageContent,
    ) -> Option<()> {
        match content {
            crate::session::window::MessageContent::ToolUse {
                name,
                tool_call_id: Some(tool_call_id),
                input,
                input_text,
            } => {
                self.merge_tool(transcript_tool_view(
                    tool_call_id, message.run_id(), Some(name.as_str()), ToolPhase::Started,
                    input.as_ref(), input_text.as_deref(), None, None, None, None,
                )?, 2, 0)?;
            }
            crate::session::window::MessageContent::ToolResult {
                tool_name,
                tool_call_id: Some(tool_call_id),
                summary,
                output,
                details,
                is_error,
            } => {
                self.merge_tool(transcript_tool_view(
                    tool_call_id, message.run_id(), tool_name.as_deref(),
                    match is_error { Some(true) => ToolPhase::Failed, _ => ToolPhase::Completed },
                    None, None, summary.as_deref(), output.as_ref(), details.as_ref(), *is_error,
                )?, 0, 3)?;
            }
            crate::session::window::MessageContent::MessageToolDelivery { text, media } => {
                if let Some(tool_call_id) = transcript_message_tool_call_id(message) {
                    self.merge_tool(transcript_tool_view(
                        tool_call_id, message.run_id(), None, ToolPhase::Completed, None, None,
                        text.as_deref(), transcript_delivery_output(text.as_deref(), media).as_ref(),
                        None, None,
                    )?, 0, 3)?;
                }
            }
            _ => {}
        }
        Some(())
    }

    fn observe_assistant_turn_status(
        &mut self,
        run_id: &str,
        status: crate::session::projection::AssistantTurnStatus,
    ) {
        if matches!(status, crate::session::projection::AssistantTurnStatus::Streaming
            | crate::session::projection::AssistantTurnStatus::WaitingForTool)
        {
            self.runtime.phase = RunPhase::Started;
            self.runtime.active_run_id = Some(run_id.to_owned());
            self.runtime.run_progress = None;
        }
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
            self.runtime.run_progress = None;
        }
        Some(())
    }

    fn apply_runtime_activity(
        &mut self,
        run_id: &str,
        activity: Option<crate::session::projection::CanonicalRuntimeActivity>,
    ) -> Option<()> {
        self.runtime.phase = RunPhase::Started;
        self.runtime.active_run_id = Some(run_id.to_owned());
        self.runtime.run_progress = None;
        self.runtime.runtime_activity = activity.map(|activity| match activity {
            crate::session::projection::CanonicalRuntimeActivity::Compacting => {
                RuntimeActivity::Compacting
            }
        });
        self.runtime.error_detail = None;
        Some(())
    }

    fn apply_run_progress(
        &mut self,
        run_id: &str,
        progress: Option<crate::session::projection::CanonicalRunProgress>,
    ) -> Option<()> {
        self.runtime.phase = RunPhase::Started;
        self.runtime.active_run_id = Some(run_id.to_owned());
        self.runtime.run_progress = progress.map(openclaw_run_progress);
        self.runtime.runtime_activity = None;
        self.runtime.error_detail = None;
        Some(())
    }

    fn apply_runtime_fallback(
        &mut self,
        detail: &crate::session::protocol::RuntimeFallbackDetail,
    ) -> Option<()> {
        self.runtime.run_progress = None;
        self.runtime.error_detail = Some(RuntimeErrorDetail {
            kind: RuntimeErrorKind::Fallback,
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
        _run_id: &str,
        outcome: crate::port::TerminalOutcome,
        error_detail: &Option<serde_json::Value>,
        error_message: &Option<String>,
        error_kind: &Option<crate::session::protocol::SessionErrorKind>,
        stop_reason: &Option<String>,
    ) -> Option<()> {
        let phase = openclaw_terminal_run_phase(outcome);
        self.runtime.phase = phase;
        self.runtime.active_run_id = None;
        self.runtime.run_progress = None;
        self.runtime.runtime_activity = None;
        self.runtime.error_detail = matches!(outcome, crate::port::TerminalOutcome::Error)
            .then(|| {
                crate::driver::projection::terminal_runtime_error_detail(
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
        if self.items.len() >= crate::session::window::PageRequest::MAX_LIMIT {
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

struct OpenClawReplayAssistantTurn<'a> {
    status: &'a mut ItemStatus,
    segments: &'a mut Vec<SessionContent>,
    text: &'a mut String,
}

impl OpenClawReplayAssistantTurn<'_> {
    fn push_chunk(
        &mut self,
        kind: crate::session::projection::AssistantTurnChunkKind,
        text: &str,
        replace: bool,
    ) -> Option<()> {
        match kind {
            crate::session::projection::AssistantTurnChunkKind::Text => {
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
            crate::session::projection::AssistantTurnChunkKind::Thinking => {
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
        segments: &[crate::session::projection::AssistantTurnSegment],
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

pub(crate) fn transcript_session_item(
    message: &crate::session::window::Message,
    fallback_index: usize,
) -> Option<SessionItem> {
    let item_id = transcript_item_id(message, fallback_index);
    let message_id = message.message_id().map(str::to_owned);
    let text = message.text().to_owned();
    match message.role() {
        crate::session::window::MessageRole::User => Some(SessionItem::UserMessage {
            item_id,
            message_id,
            text,
            content: transcript_content(message, TranscriptContentMode::User)?,
            status: ItemStatus::Final,
        }),
        crate::session::window::MessageRole::Assistant => Some(SessionItem::AssistantTurn {
            item_id,
            run_id: message.run_id().map(str::to_owned),
            message_id,
            status: ItemStatus::Final,
            segments: transcript_content(message, TranscriptContentMode::Assistant)?,
            text,
        }),
        crate::session::window::MessageRole::System => Some(SessionItem::System {
            item_id,
            text,
            status: ItemStatus::Final,
        }),
        crate::session::window::MessageRole::ToolResult => None,
    }
}

fn transcript_item_id(message: &crate::session::window::Message, fallback_index: usize) -> String {
    message
        .display_item_id()
        .or_else(|| message.message_id())
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
    message: &crate::session::window::Message,
    mode: TranscriptContentMode,
) -> Option<Vec<SessionContent>> {
    let mut segments = Vec::new();
    for block in message.content() {
        let segment = match block {
            crate::session::window::MessageContent::Text { text } => {
                Some(SessionContent::Text { text: text.clone() })
            }
            crate::session::window::MessageContent::Thinking { text } => {
                Some(SessionContent::Thinking { text: text.clone() })
            }
            crate::session::window::MessageContent::ToolUse {
                name,
                tool_call_id: Some(tool_call_id),
                ..
            } => Some(SessionContent::ToolUse {
                name: name.clone(),
                tool_call_id: tool_call_id.clone(),
            }),
            crate::session::window::MessageContent::ToolUse { .. } => {
                Some(SessionContent::Omitted {
                    reason: OmissionReason::Unknown,
                })
            }
            crate::session::window::MessageContent::ToolResult {
                tool_call_id: Some(tool_call_id),
                summary,
                is_error,
                ..
            } => transcript_tool_result_segment(mode, tool_call_id, summary.as_deref(), *is_error),
            crate::session::window::MessageContent::ToolResult { .. } => {
                Some(SessionContent::Omitted {
                    reason: OmissionReason::Unknown,
                })
            }
            crate::session::window::MessageContent::MessageToolDelivery { text, media } => {
                append_transcript_delivery(message, mode, text.as_deref(), media, &mut segments)?;
                None
            }
            crate::session::window::MessageContent::Media {
                media_type,
                reference: Some(reference),
                bytes: None,
            } => public_media_reference(reference).map_or(
                Some(SessionContent::Omitted {
                    reason: OmissionReason::UnsafeMedia,
                }),
                |reference| {
                    Some(SessionContent::Media {
                        media_type: media_type.clone(),
                        reference,
                    })
                },
            ),
            crate::session::window::MessageContent::Media { .. } => Some(SessionContent::Omitted {
                reason: OmissionReason::UnsafeMedia,
            }),
            crate::session::window::MessageContent::Omitted { kind } => {
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
    message: &crate::session::window::Message,
    mode: TranscriptContentMode,
    text: Option<&str>,
    media: &[crate::session::window::MessageToolDeliveryMedia],
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

fn transcript_message_tool_call_id(message: &crate::session::window::Message) -> Option<&str> {
    message.tool_call_id().or_else(|| {
        message.content().iter().find_map(|content| match content {
            crate::session::window::MessageContent::ToolResult {
                tool_call_id: Some(tool_call_id),
                ..
            } => Some(tool_call_id.as_str()),
            _ => None,
        })
    })
}

fn transcript_delivery_output(
    text: Option<&str>,
    media: &[crate::session::window::MessageToolDeliveryMedia],
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

fn transcript_omission_reason(kind: crate::session::window::OmittedContentKind) -> OmissionReason {
    match kind {
        crate::session::window::OmittedContentKind::Thinking => OmissionReason::Thinking,
        crate::session::window::OmittedContentKind::Unknown => OmissionReason::Unknown,
        crate::session::window::OmittedContentKind::UnsafeMedia => OmissionReason::UnsafeMedia,
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
    if items.len() >= crate::session::window::PageRequest::MAX_LIMIT {
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
    segment: &crate::session::projection::AssistantTurnSegment,
) -> Option<SessionContent> {
    match segment {
        crate::session::projection::AssistantTurnSegment::Text { text } => {
            Some(SessionContent::Text { text: text.clone() })
        }
        crate::session::projection::AssistantTurnSegment::Thinking { text } => {
            Some(SessionContent::Thinking { text: text.clone() })
        }
        crate::session::projection::AssistantTurnSegment::ToolUse { tool_id, tool_name } => {
            Some(SessionContent::ToolUse {
                name: tool_name.as_deref().unwrap_or("unknown").to_owned(),
                tool_call_id: tool_id.as_str().to_owned(),
            })
        }
        crate::session::projection::AssistantTurnSegment::ToolResult { .. } => None,
    }
}

fn canonical_tool_change(tool: &ToolView) -> Option<crate::session::projection::CanonicalSessionChange> {
    use crate::session::{projection::CanonicalSessionChange, protocol::{RunId, ToolActivityPhase, ToolId}};
    Some(CanonicalSessionChange::ToolActivity {
        run_id: RunId::try_new(tool.run_id.clone()?).ok()?,
        tool_id: ToolId::try_new(tool.tool_call_id.clone()).ok()?, tool_name: tool.name.clone(),
        phase: match tool.phase {
            ToolPhase::Started => ToolActivityPhase::Started,
            ToolPhase::Updated => ToolActivityPhase::Updated,
            ToolPhase::Completed => ToolActivityPhase::Completed,
            ToolPhase::Failed => ToolActivityPhase::Failed,
        },
        input: tool.input.clone(), input_text: tool.input_text.clone(), summary: tool.summary.clone(),
        output: tool.output.clone(), details: tool.details.clone(), is_error: tool.is_error,
    })
}

fn merge_tool_field<T>(existing: &mut Option<T>, incoming: Option<T>, preferred: bool) {
    if incoming.is_some() && (preferred || existing.is_none()) {
        *existing = incoming;
    }
}

fn merge_tool_details(
    existing: &mut Option<serde_json::Value>,
    incoming: Option<serde_json::Value>,
    preferred: bool,
) {
    if let (Some(serde_json::Value::Object(current)), Some(serde_json::Value::Object(next)))
        = (existing.as_mut(), incoming.as_ref())
    {
        for (key, value) in next {
            if preferred || !current.contains_key(key) {
                current.insert(key.clone(), value.clone());
            }
        }
    } else {
        merge_tool_field(existing, incoming, preferred);
    }
}

pub(in crate::session) fn upsert_replay_tool(tools: &mut Vec<ToolView>, tool: ToolView) {
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
    status: crate::session::projection::AssistantTurnStatus,
) -> RunPhase {
    match status {
        crate::session::projection::AssistantTurnStatus::Streaming => RunPhase::Started,
        crate::session::projection::AssistantTurnStatus::WaitingForTool => RunPhase::Started,
        crate::session::projection::AssistantTurnStatus::Final => RunPhase::Completed,
        crate::session::projection::AssistantTurnStatus::Aborted => RunPhase::Interrupted,
        crate::session::projection::AssistantTurnStatus::Error => RunPhase::Failed,
    }
}

const fn openclaw_assistant_turn_item_status(
    status: crate::session::projection::AssistantTurnStatus,
) -> ItemStatus {
    match status {
        crate::session::projection::AssistantTurnStatus::Streaming => ItemStatus::Streaming,
        crate::session::projection::AssistantTurnStatus::WaitingForTool => {
            ItemStatus::WaitingForTool
        }
        crate::session::projection::AssistantTurnStatus::Final => ItemStatus::Final,
        crate::session::projection::AssistantTurnStatus::Aborted => ItemStatus::Aborted,
        crate::session::projection::AssistantTurnStatus::Error => ItemStatus::Error,
    }
}

const fn openclaw_replay_tool_phase(
    phase: crate::session::protocol::ToolActivityPhase,
) -> ToolPhase {
    match phase {
        crate::session::protocol::ToolActivityPhase::Started => ToolPhase::Started,
        crate::session::protocol::ToolActivityPhase::Updated => ToolPhase::Updated,
        crate::session::protocol::ToolActivityPhase::Completed => ToolPhase::Completed,
        crate::session::protocol::ToolActivityPhase::Failed => ToolPhase::Failed,
    }
}

const fn openclaw_run_progress(
    progress: crate::session::projection::CanonicalRunProgress,
) -> RunProgress {
    match progress {
        crate::session::projection::CanonicalRunProgress::Startup { phase } => {
            RunProgress::Startup {
                phase: openclaw_run_startup_phase(phase),
            }
        }
        crate::session::projection::CanonicalRunProgress::Retrying {
            attempt,
            max_attempts,
        } => RunProgress::Retrying {
            attempt,
            max_attempts,
        },
    }
}

const fn openclaw_run_startup_phase(
    phase: crate::session::protocol::ChatStatusPhase,
) -> RunStartupPhase {
    match phase {
        crate::session::protocol::ChatStatusPhase::PreparingWorkspace => {
            RunStartupPhase::PreparingWorkspace
        }
        crate::session::protocol::ChatStatusPhase::NamingWorktree => {
            RunStartupPhase::NamingWorktree
        }
        crate::session::protocol::ChatStatusPhase::CreatingWorktree => {
            RunStartupPhase::CreatingWorktree
        }
        crate::session::protocol::ChatStatusPhase::RunningSetup => RunStartupPhase::RunningSetup,
        crate::session::protocol::ChatStatusPhase::ProvisioningEnvironment => {
            RunStartupPhase::ProvisioningEnvironment
        }
        crate::session::protocol::ChatStatusPhase::PreparingContext => {
            RunStartupPhase::PreparingContext
        }
        crate::session::protocol::ChatStatusPhase::StartingModel => RunStartupPhase::StartingModel,
    }
}

const fn openclaw_terminal_run_phase(outcome: crate::port::TerminalOutcome) -> RunPhase {
    match outcome {
        crate::port::TerminalOutcome::Completed => RunPhase::Completed,
        crate::port::TerminalOutcome::Aborted => RunPhase::Interrupted,
        crate::port::TerminalOutcome::Error => RunPhase::Failed,
    }
}

const fn openclaw_terminal_item_status(outcome: crate::port::TerminalOutcome) -> ItemStatus {
    match outcome {
        crate::port::TerminalOutcome::Completed => ItemStatus::Final,
        crate::port::TerminalOutcome::Aborted => ItemStatus::Aborted,
        crate::port::TerminalOutcome::Error => ItemStatus::Error,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use sessions_module::timeline::{Command, Direction, Operation, Provider, WindowRequest};

    fn session_key() -> crate::session::protocol::SessionKey {
        crate::session::protocol::SessionKey::try_new("agent:main:session-1").unwrap()
    }

    fn decode_event(
        name: &str,
        payload: serde_json::Value,
        sequence: u64,
    ) -> crate::session::protocol::SessionEventEnvelope {
        crate::session::protocol::decode_session_event(crate::gateway::wire::GatewayEvent {
            name: name.to_owned(),
            payload: Some(payload),
            sequence: Some(sequence),
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    fn terminal_snapshot(sequence: u64) -> crate::session::protocol::SessionEventEnvelope {
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

    fn tool_event(sequence: u64, phase: &str) -> crate::session::protocol::SessionEventEnvelope {
        tool_event_with_id(sequence, phase, "tool-1")
    }

    fn tool_event_with_id(
        sequence: u64,
        phase: &str,
        tool_call_id: &str,
    ) -> crate::session::protocol::SessionEventEnvelope {
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

    fn approval_event(sequence: u64, name: &str) -> crate::session::protocol::SessionEventEnvelope {
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
        events: impl IntoIterator<Item = crate::session::protocol::SessionEventEnvelope>,
    ) -> crate::port::CanonicalSessionReplay {
        crate::session::materialize_session_replay(session_key(), events, Some(1), None).unwrap()
    }

    fn partial_replay() -> crate::port::CanonicalSessionReplay {
        crate::session::materialize_session_replay_rows(
            session_key(),
            [crate::session::SessionReplaySourceRow::Recovery { source_sequence: 2 }],
            Some(1),
            None,
        )
        .unwrap()
    }

    fn transcript_message(
        role: crate::session::window::MessageRole,
        _text: &str,
        content: Vec<crate::session::window::MessageContent>,
    ) -> crate::session::window::Message {
        let window = crate::session::window::decode_window(
            json!({
                "messages": [{
                    "role": transcript_role(role),
                    "id": "message-1",
                    "runId": "run-1",
                    "seq": 1,
                    "content": content.into_iter().map(transcript_content_value).collect::<Vec<_>>()
                }]
            }),
            crate::session::window::PageRequest::latest(),
        )
        .unwrap();
        window.messages()[0].clone()
    }

    fn transcript_role(role: crate::session::window::MessageRole) -> &'static str {
        match role {
            crate::session::window::MessageRole::User => "user",
            crate::session::window::MessageRole::Assistant => "assistant",
            crate::session::window::MessageRole::System => "system",
            crate::session::window::MessageRole::ToolResult => "toolResult",
        }
    }

    fn transcript_content_value(
        content: crate::session::window::MessageContent,
    ) -> serde_json::Value {
        match content {
            crate::session::window::MessageContent::Text { text } => {
                json!({"type": "text", "text": text})
            }
            crate::session::window::MessageContent::Thinking { text } => {
                json!({"type": "thinking", "thinking": text})
            }
            crate::session::window::MessageContent::ToolUse {
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
            crate::session::window::MessageContent::ToolResult {
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
            crate::session::window::MessageContent::Media {
                media_type,
                reference,
                bytes: None,
            } => json!({"type": "media", "mediaType": media_type, "reference": reference}),
            _ => json!({"type": "unknown"}),
        }
    }

    fn transcript_replay(
        rows: impl IntoIterator<Item = crate::session::SessionReplaySourceRow>,
    ) -> crate::port::CanonicalSessionReplay {
        crate::session::materialize_session_replay_rows(session_key(), rows, Some(1), None).unwrap()
    }

    fn default_window(replay: crate::port::CanonicalSessionReplay) -> OpenClawTimelineWindow {
        OpenClawTimelineWindow::new(
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
    fn openclaw_history_key_uses_canonical_session_key_with_endpoint_binding() {
        let command = Command::new(
            Operation::Load,
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
            Operation::Load,
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
            Operation::Load,
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
            Operation::Load,
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
        let window = OpenClawTimelineWindow::new(
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

    #[test]
    fn openclaw_replay_projection_marks_partial_rows_without_failing_view() {
        let identity = SessionIdentity::new(
            "agent:main:session-1".to_owned(),
            SessionProvider::OpenClaw,
            Some("main".to_owned()),
        )
        .unwrap();
        let window = OpenClawTimelineWindow::new(
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
        let window = OpenClawTimelineWindow::new(
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
            crate::session::SessionReplaySourceRow::Event(tool_event(1, "start")),
            crate::session::SessionReplaySourceRow::TranscriptMessage(transcript_message(
                crate::session::window::MessageRole::Assistant,
                "before after",
                vec![
                    crate::session::window::MessageContent::Text {
                        text: "before ".to_owned(),
                    },
                    crate::session::window::MessageContent::ToolUse {
                        name: "read".to_owned(),
                        tool_call_id: Some("tool-1".to_owned()),
                        input: Some(json!({"path": "Cargo.toml"})),
                        input_text: Some("Cargo.toml".to_owned()),
                    },
                    crate::session::window::MessageContent::Text {
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
                run_progress: None,
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
                phase: crate::session::protocol::ToolActivityPhase::Completed,
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
            crate::session::SessionReplaySourceRow::TranscriptMessage(transcript_message(
                crate::session::window::MessageRole::Assistant,
                "answer",
                vec![
                    crate::session::window::MessageContent::Text {
                        text: "answer".to_owned(),
                    },
                    crate::session::window::MessageContent::ToolResult {
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
            crate::session::SessionReplaySourceRow::TranscriptMessage(transcript_message(
                crate::session::window::MessageRole::Assistant,
                "answer",
                vec![
                    crate::session::window::MessageContent::Text {
                        text: "answer".to_owned(),
                    },
                    crate::session::window::MessageContent::ToolUse {
                        name: "message".to_owned(),
                        tool_call_id: Some("tool-1".to_owned()),
                        input: Some(json!({"text": "hi"})),
                        input_text: Some("hi".to_owned()),
                    },
                ],
            )),
            crate::session::SessionReplaySourceRow::TranscriptMessage(transcript_message(
                crate::session::window::MessageRole::ToolResult,
                "delivered text",
                vec![crate::session::window::MessageContent::ToolResult {
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
        let window = OpenClawTimelineWindow::new(
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

    #[test]
    fn openclaw_older_window_builds_native_page_request() {
        let command = Command::new(
            Operation::Load,
            Provider::OpenClaw,
            "agent:main:session-1".to_owned(),
            Some("main".to_owned()),
            WindowRequest::new(Direction::Older, 2, Some(3)).unwrap(),
            Some("session-1".to_owned()),
            true,
        )
        .unwrap();

        let request = openclaw_page_request(&command).unwrap();
        assert_eq!(
            request.direction(),
            crate::session::window::Direction::Older
        );
        assert_eq!(request.limit(), 2);
        assert_eq!(request.offset(), Some(3));
    }

    #[tokio::test]
    async fn openclaw_missing_agent_store_maps_to_read_transport() {
        let root = tempfile::tempdir().unwrap();
        let state_dir =
            platform::state_dir::CanonicalStateDir::provision(root.path().join("state")).unwrap();
        let command = Command::new(
            Operation::Load,
            Provider::OpenClaw,
            "agent:main:session-1".to_owned(),
            Some("main".to_owned()),
            WindowRequest::latest(),
            Some("session-1".to_owned()),
            true,
        )
        .unwrap();

        let outcome = load_openclaw_session_timeline_from_state(&state_dir, command, 1).await;
        assert_eq!(
            outcome.unavailable_reason(),
            Some(UnavailableReason::OpenClawReadTransport)
        );
    }

    #[test]
    fn openclaw_read_errors_keep_unavailable_reason_mapping() {
        let cases = [
            (
                RuntimeSessionError::RuntimeUnavailable,
                UnavailableReason::RuntimeUnavailable,
            ),
            (
                RuntimeSessionError::AdmissionClosed(sessions_module::RequestAdmissionClosed),
                UnavailableReason::RuntimeUnavailable,
            ),
            (
                RuntimeSessionError::Client(OpenClawSessionError::SessionConnection),
                UnavailableReason::OpenClawReadSessionConnection,
            ),
            (
                RuntimeSessionError::Client(OpenClawSessionError::RequestIdExhausted),
                UnavailableReason::OpenClawReadRequestIdExhausted,
            ),
            (
                RuntimeSessionError::Client(OpenClawSessionError::RequestDeadline),
                UnavailableReason::OpenClawReadRequestDeadline,
            ),
            (
                RuntimeSessionError::Client(OpenClawSessionError::ConnectionClosed),
                UnavailableReason::OpenClawReadConnectionClosed,
            ),
            (
                RuntimeSessionError::Client(OpenClawSessionError::UnknownResponse),
                UnavailableReason::OpenClawReadUnknownResponse,
            ),
            (
                RuntimeSessionError::Client(OpenClawSessionError::Transport),
                UnavailableReason::OpenClawReadTransport,
            ),
            (
                RuntimeSessionError::Client(OpenClawSessionError::Protocol(None)),
                UnavailableReason::OpenClawReadProtocol,
            ),
            (
                RuntimeSessionError::Client(OpenClawSessionError::TargetRejected),
                UnavailableReason::OpenClawReadTargetRejected,
            ),
            (
                RuntimeSessionError::Client(OpenClawSessionError::EventBackpressure),
                UnavailableReason::OpenClawReadEventBackpressure,
            ),
        ];

        for (error, reason) in cases {
            assert_eq!(openclaw_read_failure(error).reason, reason);
        }
    }
}
