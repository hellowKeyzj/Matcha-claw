use std::collections::HashMap;

use crate::gateway::ingress::GatewayEpoch;

use super::{
    events::TerminalOutcome,
    projection::{
        AssistantTurnChunkKind, AssistantTurnSegment, AssistantTurnStatus, CanonicalIngressResult,
        CanonicalRecoveryReason, CanonicalRunProgress, CanonicalRuntimeActivity,
        CanonicalSessionChange, CanonicalSessionDeltaProducer,
    },
    protocol::{
        ChatState, MessageActivityLifecycle, MessageId, RunId, RuntimeActivityPhase,
        RuntimeFallbackDetail, RuntimeGuardianNotice, SessionActivityKind, SessionApprovalEvent,
        SessionApprovalLifecycle, SessionChangedPhase, SessionEventEnvelope, SessionEventKind,
        SessionKey, ToolActivityPhase, ToolId,
    },
};

fn trace_reducer_event(
    event: &SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,

) {
    if !super::trace::enabled() {
        return;
    }
    super::trace::log_unscoped("runtime.openclaw.reducer.input", serde_json::json!({
        "sessionHash": sessions_module::trace::fingerprint(event.session_key.as_str()),
        "runHash": event.run_id.as_ref().map(|id| sessions_module::trace::fingerprint(id.as_str())),
        "messageHash": event.message_id.as_ref().map(|id| sessions_module::trace::fingerprint(id.as_str())),
        "embeddedMessageHash": event.embedded_message_id.as_ref().map(|id| sessions_module::trace::fingerprint(id.as_str())),
        "sourceEpoch": source_epoch.map(GatewayEpoch::as_u64), "nativeCursor": event.gateway_sequence,
        "kind": format!("{:?}", event.kind),
        "deltaText": event.chat.as_ref().and_then(|chat| chat.delta_text.as_deref()).map(sessions_module::trace::text_shape),
        "messageText": event.chat.as_ref().and_then(|chat| chat.message_text.as_deref()).map(sessions_module::trace::text_shape),
        "messageThinking": event.chat.as_ref().and_then(|chat| chat.message_thinking.as_deref()).map(sessions_module::trace::text_shape),
    }));
    match event.kind {
        SessionEventKind::Chat => {
            let Some(chat) = event.chat.as_ref() else {
                return;
            };
            super::trace::log_unscoped(
                "runtime.openclaw.reducer.event",
                serde_json::json!({
                    "kind": "chat",
                    "state": format!("{:?}", chat.state),
                    "sourceEpoch": source_epoch.map(GatewayEpoch::as_u64),
                    "gatewaySequence": event.gateway_sequence,
                    "chatSequence": chat.sequence,

                    "hasRunId": event.run_id.is_some(),
                    "hasMessageId": event.message_id.is_some(),
                    "hasEmbeddedMessageId": event.embedded_message_id.is_some(),
                    "deltaTextLength": chat.delta_text.as_ref().map_or(0, String::len),
                    "replace": chat.replace,
                    "messageTextLength": chat.message_text.as_ref().map_or(0, String::len),
                    "messageThinkingLength": chat.message_thinking.as_ref().map_or(0, String::len),
                    "hasErrorKind": chat.error_kind.is_some(),
                    "hasErrorMessage": chat.error_message.is_some(),
                    "hasStopReason": chat.stop_reason.is_some(),
                    "statusPhase": chat.status_phase.map(|phase| format!("{:?}", phase)),
                    "hasErrorDetail": chat.error_detail.is_some(),
                }),
            );
        }
        SessionEventKind::Message | SessionEventKind::Tool | SessionEventKind::Agent => {
            let Some(activity) = event.activity.as_ref() else {
                super::trace::log_unscoped(
                    "runtime.openclaw.reducer.event",
                    serde_json::json!({
                        "kind": format!("{:?}", event.kind),
                        "sourceEpoch": source_epoch.map(GatewayEpoch::as_u64),
                        "gatewaySequence": event.gateway_sequence,

                        "hasRunId": event.run_id.is_some(),
                        "hasMessageId": event.message_id.is_some(),
                        "hasEmbeddedMessageId": event.embedded_message_id.is_some(),
                        "hasActivity": false,
                    }),
                );
                return;
            };
            let (message_lifecycle, tool_phase, text_length) = match activity.kind() {
                SessionActivityKind::Message {
                    lifecycle, text, ..
                } => (
                    Some(format!("{:?}", lifecycle)),
                    None,
                    text.as_ref().map_or(0, String::len),
                ),
                SessionActivityKind::Tool { phase, summary, .. } => (
                    None,
                    Some(format!("{:?}", phase)),
                    summary.as_ref().map_or(0, String::len),
                ),
                SessionActivityKind::Thinking { text } => (None, None, text.len()),
                SessionActivityKind::Compaction { phase } => {
                    (None, Some(format!("{:?}", phase)), 0)
                }
                SessionActivityKind::Fallback { detail } => (
                    None,
                    Some("Fallback".to_owned()),
                    runtime_fallback_detail_text_length(detail),
                ),
                SessionActivityKind::FallbackCleared => {
                    (None, Some("FallbackCleared".to_owned()), 0)
                }
                SessionActivityKind::Guardian { notice } => (
                    None,
                    Some(format!("{:?}", notice.phase)),
                    runtime_guardian_notice_text_length(notice),
                ),
            };
            super::trace::log_unscoped(
                "runtime.openclaw.reducer.event",
                serde_json::json!({
                    "kind": format!("{:?}", event.kind),
                    "sourceEpoch": source_epoch.map(GatewayEpoch::as_u64),
                    "gatewaySequence": event.gateway_sequence,

                    "hasRunId": event.run_id.is_some(),
                    "hasMessageId": event.message_id.is_some(),
                    "hasEmbeddedMessageId": event.embedded_message_id.is_some(),
                    "hasActivity": true,
                    "messageLifecycle": message_lifecycle,
                    "toolPhase": tool_phase,
                    "textLength": text_length,
                    "hasInput": activity.input().is_some(),
                    "inputTextLength": activity.input_text().map_or(0, str::len),
                    "hasOutput": activity.output().is_some(),
                    "isError": activity.is_error(),
                }),
            );
        }
        SessionEventKind::ApprovalRequested | SessionEventKind::ApprovalResolved => {
            let Some(approval) = event.approval.as_ref() else {
                return;
            };
            super::trace::log_unscoped(
                "runtime.openclaw.reducer.event",
                serde_json::json!({
                    "kind": format!("{:?}", event.kind),
                    "sourceEpoch": source_epoch.map(GatewayEpoch::as_u64),
                    "gatewaySequence": event.gateway_sequence,

                    "hasRunId": event.run_id.is_some(),
                    "hasMessageId": event.message_id.is_some(),
                    "hasEmbeddedMessageId": event.embedded_message_id.is_some(),
                    "approvalSource": format!("{:?}", approval.source),
                    "approvalLifecycle": format!("{:?}", approval.lifecycle),
                    "hasApprovalRunId": approval.run_id.is_some(),
                    "optionCount": approval.option_ids.len(),
                }),
            );
        }
        SessionEventKind::Changed => {
            super::trace::log_unscoped(
                "runtime.openclaw.reducer.event",
                serde_json::json!({
                    "kind": "changed",
                    "sourceEpoch": source_epoch.map(GatewayEpoch::as_u64),
                    "gatewaySequence": event.gateway_sequence,

                    "hasRunId": event.run_id.is_some(),
                    "hasMessageId": event.message_id.is_some(),
                    "hasEmbeddedMessageId": event.embedded_message_id.is_some(),
                }),
            );
        }
    }
}

#[derive(Default)]
struct CanonicalChangeDebugSummary {
    assistant_turn_snapshot_count: usize,
    assistant_turn_chunk_count: usize,
    tool_activity_count: usize,
    tool_started_count: usize,
    tool_updated_count: usize,
    tool_completed_count: usize,
    tool_failed_count: usize,
    terminal_count: usize,
    terminal_completed_count: usize,
    terminal_aborted_count: usize,
    terminal_error_count: usize,
    runtime_activity_count: usize,
    run_progress_count: usize,
    approval_requested_count: usize,
    approval_resolved_count: usize,
    recovery_required_count: usize,
    transcript_message_count: usize,
    assistant_text_bytes: usize,
    assistant_thinking_bytes: usize,
    assistant_segment_count: usize,
    assistant_text_segment_count: usize,
    assistant_text_segment_bytes: usize,
    assistant_thinking_segment_count: usize,
    assistant_tool_segment_count: usize,
    run_started_count: usize,
}

impl CanonicalChangeDebugSummary {
    fn observe(&mut self, change: &CanonicalSessionChange) {
        match change {
            CanonicalSessionChange::RunStarted { .. } => {
                self.run_started_count += 1;
            }
            CanonicalSessionChange::AssistantTurnSnapshot { snapshot } => {
                self.assistant_turn_snapshot_count += 1;
                self.assistant_text_bytes += snapshot.text.len();
                self.assistant_thinking_bytes += snapshot.thinking.as_ref().map_or(0, String::len);
                self.assistant_segment_count += snapshot.segments.len();
                for segment in &snapshot.segments {
                    self.observe_segment(segment);
                }
            }
            CanonicalSessionChange::AssistantTurnChunk { kind, text, .. } => {
                self.assistant_turn_chunk_count += 1;
                match kind {
                    AssistantTurnChunkKind::Text => {
                        self.assistant_text_bytes += text.len();
                        self.assistant_text_segment_count += 1;
                        self.assistant_text_segment_bytes += text.len();
                    }
                    AssistantTurnChunkKind::Thinking => {
                        self.assistant_thinking_bytes += text.len();
                        self.assistant_thinking_segment_count += 1;
                    }
                }
            }
            CanonicalSessionChange::ToolActivity { phase, .. } => {
                self.tool_activity_count += 1;
                match *phase {
                    ToolActivityPhase::Started => self.tool_started_count += 1,
                    ToolActivityPhase::Updated => self.tool_updated_count += 1,
                    ToolActivityPhase::Completed => self.tool_completed_count += 1,
                    ToolActivityPhase::Failed => self.tool_failed_count += 1,
                }
            }
            CanonicalSessionChange::Terminal { outcome, .. } => {
                self.terminal_count += 1;
                match *outcome {
                    TerminalOutcome::Completed => self.terminal_completed_count += 1,
                    TerminalOutcome::Aborted => self.terminal_aborted_count += 1,
                    TerminalOutcome::Error => self.terminal_error_count += 1,
                }
            }
            CanonicalSessionChange::RuntimeActivity { .. }
            | CanonicalSessionChange::RuntimeActivityCleared { .. }
            | CanonicalSessionChange::RuntimeFallback { .. }
            | CanonicalSessionChange::RuntimeFallbackCleared { .. }
            | CanonicalSessionChange::GuardianNotice { .. } => {
                self.runtime_activity_count += 1;
            }
            CanonicalSessionChange::RunProgress { .. } => {
                self.run_progress_count += 1;
            }
            CanonicalSessionChange::ApprovalRequested { .. } => {
                self.approval_requested_count += 1;
            }
            CanonicalSessionChange::ApprovalResolved { .. } => {
                self.approval_resolved_count += 1;
            }
            CanonicalSessionChange::RecoveryRequired { .. } => {
                self.recovery_required_count += 1;
            }
            CanonicalSessionChange::ItemsReplaced { .. } => {},
            CanonicalSessionChange::TranscriptMessage { .. } => {
                self.transcript_message_count += 1;
            }
        }
    }

    fn observe_segment(&mut self, segment: &AssistantTurnSegment) {
        match segment {
            AssistantTurnSegment::Text { text } => {
                self.assistant_text_segment_count += 1;
                self.assistant_text_segment_bytes += text.len();
            }
            AssistantTurnSegment::Thinking { .. } => {
                self.assistant_thinking_segment_count += 1;
            }
            AssistantTurnSegment::ToolUse { .. } | AssistantTurnSegment::ToolResult { .. } => {
                self.assistant_tool_segment_count += 1;
            }
        }
    }
}

fn runtime_fallback_detail_text_length(detail: &RuntimeFallbackDetail) -> usize {
    detail.failover_reason.as_ref().map_or(0, String::len)
        + detail
            .provider_runtime_failure_kind
            .as_ref()
            .map_or(0, String::len)
        + detail.provider_error_type.as_ref().map_or(0, String::len)
        + detail
            .provider_error_message_preview
            .as_ref()
            .map_or(0, String::len)
}

fn runtime_guardian_notice_text_length(notice: &RuntimeGuardianNotice) -> usize {
    notice.command.as_ref().map_or(0, String::len)
        + notice.risk_level.as_ref().map_or(0, String::len)
        + notice.rationale.as_ref().map_or(0, String::len)
        + notice.message.as_ref().map_or(0, String::len)
}

fn trace_canonical_changes(stage: &'static str, changes: &[CanonicalSessionChange]) {
    if !super::trace::enabled() {
        return;
    }
    let mut summary = CanonicalChangeDebugSummary::default();
    for change in changes {
        summary.observe(change);
    }
    let projected = crate::driver::projection::openclaw_canonical_changes(changes);
    super::trace::log_unscoped(
        "runtime.openclaw.reducer.projected",
        serde_json::json!({
            "reducerStage": stage,
            "commitState": "candidate_only",
            "projectedChanges": sessions_module::trace::changes_shape(&projected),
            "changeCount": changes.len(),
            "runStartedCount": summary.run_started_count,
            "assistantTurnSnapshotCount": summary.assistant_turn_snapshot_count,
            "assistantTurnChunkCount": summary.assistant_turn_chunk_count,
            "toolActivityCount": summary.tool_activity_count,
            "toolStartedCount": summary.tool_started_count,
            "toolUpdatedCount": summary.tool_updated_count,
            "toolCompletedCount": summary.tool_completed_count,
            "toolFailedCount": summary.tool_failed_count,
            "terminalCount": summary.terminal_count,
            "terminalCompletedCount": summary.terminal_completed_count,
            "terminalAbortedCount": summary.terminal_aborted_count,
            "terminalErrorCount": summary.terminal_error_count,
            "runtimeActivityCount": summary.runtime_activity_count,
            "runProgressCount": summary.run_progress_count,
            "approvalRequestedCount": summary.approval_requested_count,
            "approvalResolvedCount": summary.approval_resolved_count,
            "recoveryRequiredCount": summary.recovery_required_count,
            "transcriptMessageCount": summary.transcript_message_count,
            "assistantTextLength": summary.assistant_text_bytes,
            "assistantThinkingLength": summary.assistant_thinking_bytes,
            "assistantSegmentCount": summary.assistant_segment_count,
            "assistantTextSegmentCount": summary.assistant_text_segment_count,
            "assistantTextSegmentLength": summary.assistant_text_segment_bytes,
            "assistantThinkingSegmentCount": summary.assistant_thinking_segment_count,
            "assistantToolSegmentCount": summary.assistant_tool_segment_count,
        }),
    );
}

pub(crate) struct SessionReducerActor {
    session_key: SessionKey,
    active_run: Option<ActiveRunState>,
    approvals: HashMap<String, ApprovalState>,
    body: super::body::Body,
    cache: super::adapters::timeline::OpenClawReplayProjection,
    window: Option<sessions_module::state::SessionWindow>,
    native_session_id: Option<String>,
    goal: sessions_module::goal::SessionGoalView,
    approvals_known: bool,
}

impl SessionReducerActor {
    pub(crate) fn new(session_key: SessionKey) -> Self {
        Self {
            session_key,
            active_run: None,
            approvals: HashMap::new(),
            body: super::body::Body::default(),
            cache: super::adapters::timeline::OpenClawReplayProjection::empty(),
            window: None,
            native_session_id: None,
            goal: sessions_module::goal::SessionGoalView::Unknown,
            approvals_known: false,
        }
    }

    pub(crate) fn reduce(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        if event.session_key != self.session_key {
            if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.dropped", serde_json::json!({
                "reason": "session_key_mismatch", "sessionHash": sessions_module::trace::fingerprint(event.session_key.as_str()),
                "targetSessionHash": sessions_module::trace::fingerprint(self.session_key.as_str()) })); }
            return None;
        }
        trace_reducer_event(&event, source_epoch);

        if let Some(message) = event.transcript_message.as_ref() {
            let mut body = self.body.clone();
            let replacement = body.message(message).or_else(|| {
                if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.dropped", serde_json::json!({
                    "reason": "body_message_candidate", "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) })); }
                None
            })?;
            let mut changes = vec![CanonicalSessionChange::TranscriptMessage { message: message.clone() }];
            push_replacement(&mut changes, replacement);
            self.commit_body(body, &mut changes)?;
            return produce_changes_debugged("persisted_message", event, source_epoch, changes);
        }
        if let Some((id, text)) = event.commentary.as_ref() {
            let mut body = self.body.clone();
            let replacement = body.keyed(event.run_id.as_ref()?.as_str(), id, text)?;
            let mut changes = Vec::new();
            push_replacement(&mut changes, replacement);
            self.commit_body(body, &mut changes)?;
            if changes.is_empty() { return None; }
            return produce_changes_debugged("keyed_commentary", event, source_epoch, changes);
        }
        if event.run_id.as_ref().is_some_and(|run| self.body.terminal.iter().any(|(id, _)| id == run.as_str())) {
            if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.dropped", serde_json::json!({
                "reason": "terminal_fence", "runHash": event.run_id.as_ref().map(|run| sessions_module::trace::fingerprint(run.as_str())),
                "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) })); }
            return None;
        }
        let active_run = self.active_run.clone();
        let approvals = self.approvals.clone();
        let mut committed = false;
        let result = (|| {
            let mut result = match event.kind {
                SessionEventKind::Chat => self.reduce_chat(event, source_epoch),
                SessionEventKind::Message => {
                    self.reduce_message_activity(event, source_epoch)
                }
                SessionEventKind::Tool | SessionEventKind::Agent => {
                    self.reduce_tool_activity(event, source_epoch)
                }
                SessionEventKind::ApprovalRequested | SessionEventKind::ApprovalResolved => {
                    self.reduce_approval(event, source_epoch)
                }
                SessionEventKind::Changed => self.reduce_changed(event, source_epoch),
            }.or_else(|| {
                if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.dropped", serde_json::json!({
                    "reason": "no_native_change", "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) })); }
                None
            })?;
            if let CanonicalIngressResult::Produced(delta) = &mut result {
                let mut body = self.body.clone();
                let replacement = body.observe(delta.changes()).or_else(|| {
                    if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.dropped", serde_json::json!({
                        "reason": "body_observe_candidate", "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) })); }
                    None
                })?;
                let mut canonical = delta.changes().to_vec();
                self.commit_body(body, &mut canonical)?;
                committed = true;
                let mut changes = Vec::new();
                push_replacement(&mut changes, replacement);
                changes.extend(canonical.into_iter().filter(|change| !matches!(change,
                    CanonicalSessionChange::AssistantTurnChunk { .. }
                    | CanonicalSessionChange::AssistantTurnSnapshot { .. })));
                if changes.is_empty() {
                    if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.no_display_changes", serde_json::json!({
                        "reason": "committed_without_display_change", "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) })); }
                    return None;
                }
                delta.replace_changes(changes);
            }
            Some(result)
        })();
        if !committed {
            self.active_run = active_run;
            self.approvals = approvals;
        }
        result
    }

    pub(crate) fn reduce_transcript_message(&mut self, message: super::window::Message, source_epoch: Option<u64>) -> Option<CanonicalIngressResult> {
        let mut body = self.body.clone();
        let replacement = body.message(&message)?;
        let mut result = CanonicalIngressResult::from_transcript_message(self.session_key.clone(), source_epoch, message)?;
        if let CanonicalIngressResult::Produced(delta) = &mut result {
            let mut changes = delta.changes().to_vec();
            push_replacement(&mut changes, replacement);
            self.commit_body(body, &mut changes)?;
            delta.replace_changes(changes);
        }
        Some(result)
    }

    fn commit_body(&mut self, body: super::body::Body, changes: &mut Vec<CanonicalSessionChange>) -> Option<()> {
        let commit_started = super::trace::enabled().then(std::time::Instant::now);
        let mut cache = self.cache.clone();
        let display_changed = body.items != self.body.items;
        for change in changes.iter_mut() {
            if let CanonicalSessionChange::AssistantTurnChunk { run_id, message_id, status, .. } = change {
                if message_id.is_some() && display_changed
                    && matches!(status, AssistantTurnStatus::Streaming | AssistantTurnStatus::WaitingForTool)
                {
                    cache.runtime.phase = sessions_module::state::RunPhase::Started;
                    cache.runtime.active_run_id = Some(run_id.as_str().to_owned());
                    cache.runtime.run_progress = None;
                }
            } else if !matches!(change, CanonicalSessionChange::ToolActivity { .. }) {
                if cache.apply_change(change).is_none() {
                    if super::trace::enabled() {
                        super::trace::log_unscoped("runtime.openclaw.reducer.commit_rejected", serde_json::json!({
                            "reason": "cache_apply_change", "candidateItems": sessions_module::trace::items_shape(&body.items),
                            "actualFinalItems": sessions_module::trace::items_shape(&self.body.items),
                            "change": sessions_module::trace::changes_shape(&crate::driver::projection::openclaw_canonical_changes(std::slice::from_ref(change))) }));
                    }
                    return None;
                }
            }
            else {
                *change = cache.apply_tool_observation(change)?;
            }
        }
        let durable_tools = changes.iter().filter_map(|change| match change {
            CanonicalSessionChange::TranscriptMessage { message } => Some(message), _ => None,
        }).flat_map(|message| cache.transcript_tool_changes(message)).collect::<Vec<_>>();
        cache.tools.retain(|tool| body.items.iter().any(|item| matches!(item, sessions_module::state::SessionItem::AssistantTurn { segments, .. }
            if segments.iter().any(|segment| matches!(segment, sessions_module::state::SessionContent::ToolUse { tool_call_id, .. }
                | sessions_module::state::SessionContent::ToolResult { tool_call_id, .. } if tool_call_id == &tool.tool_call_id))))
            || !self.body.items.iter().any(|item| matches!(item, sessions_module::state::SessionItem::AssistantTurn { segments, .. }
                if segments.iter().any(|segment| matches!(segment, sessions_module::state::SessionContent::ToolUse { tool_call_id, .. }
                    | sessions_module::state::SessionContent::ToolResult { tool_call_id, .. } if tool_call_id == &tool.tool_call_id))))
            || !matches!(tool.phase, sessions_module::state::ToolPhase::Completed | sessions_module::state::ToolPhase::Failed));
        cache.retain_tool_provenance();
        // The atomic body projection already owns tool anchors; do not infer same-run items.
        cache.items = body.items.clone();
        let view = match self.view_parts(1, &body, &cache) {
            Ok(view) => view,
            Err(_) => {
                if super::trace::enabled() {
                    super::trace::log_unscoped("runtime.openclaw.reducer.commit_rejected", serde_json::json!({
                        "reason": "candidate_view", "candidateItems": sessions_module::trace::items_shape(&body.items),
                        "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) }));
                }
                return None;
            }
        };
        if view.validate().is_err() {
            if super::trace::enabled() {
                super::trace::log_unscoped("runtime.openclaw.reducer.commit_rejected", serde_json::json!({
                    "reason": "candidate_validation", "candidateItems": sessions_module::trace::items_shape(&body.items),
                    "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) }));
            }
            return None;
        }
        changes.extend(durable_tools.into_iter().filter(|change| match change {
            CanonicalSessionChange::ToolActivity { run_id, .. } => !body.terminal.iter().any(|(owner, _)| owner == run_id.as_str()),
            _ => false,
        }));
        self.body = body;
        self.cache = cache;
        if let Some(commit_started) = commit_started {
            let commit_elapsed_ms = commit_started.elapsed().as_secs_f64() * 1000.0;
            let trace_started = std::time::Instant::now();
            self.body.trace_committed("runtime.openclaw.reducer.body_committed");
            super::trace::log_unscoped("runtime.openclaw.reducer.commit_accepted", serde_json::json!({
                "displayChanged": display_changed, "actualFinalItems": sessions_module::trace::items_shape(&self.body.items),
                "retiredItemCount": self.body.retired.len(), "retiredItemsTruncated": self.body.retired.len() > 200,
                "retiredItemHashes": self.body.retired.iter().take(200).map(|id| sessions_module::trace::fingerprint(id)).collect::<Vec<_>>(),
                "runtimePhase": self.cache.runtime.phase,
                "activeRunHash": self.cache.runtime.active_run_id.as_deref().map(sessions_module::trace::fingerprint),
                "commitElapsedMs": commit_elapsed_ms, "timingScope": "cache_merge_validate_and_assign_excluding_commit_success_trace" }));
            let trace_elapsed_ms = trace_started.elapsed().as_secs_f64() * 1000.0;
            super::trace::log_unscoped("runtime.openclaw.reducer.commit_trace_timing", serde_json::json!({
                "commitTraceElapsedMs": trace_elapsed_ms, "itemCount": self.body.items.len(),
                "timingScope": "body_committed_and_commit_accepted_shape_hash_emit_excluding_this_log" }));
        }
        Some(())
    }

    pub(crate) fn sync_history(&mut self, window: &super::window::SessionWindow, page: super::window::PageRequest, epoch: GatewayEpoch)
        -> Result<Option<CanonicalIngressResult>, sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure as Failure;
        let history_started = super::trace::enabled().then(std::time::Instant::now);
        if super::trace::enabled() {
            super::trace::log_unscoped("runtime.openclaw.reducer.history_input", serde_json::json!({
                "sessionHash": sessions_module::trace::fingerprint(self.session_key.as_str()), "sourceEpoch": epoch.as_u64(),
                "historyKind": format!("{:?}", window.state().kind()), "direction": format!("{:?}", page.direction()),
                "limit": page.limit(), "offset": page.offset(), "rangeStart": window.range().start(), "rangeEnd": window.range().end(),
                "totalItemCount": window.total_item_count(), "messageCount": window.messages().len(),
                "summarizedMessageCount": window.messages().len().min(super::window::PageRequest::MAX_LIMIT),
                "messagesTruncated": window.messages().len() > super::window::PageRequest::MAX_LIMIT,
                "cursorPresent": window.state().delta_cursor().is_some(), "cursorHash": window.state().delta_cursor().map(sessions_module::trace::fingerprint),
                "completeSnapshot": window.state().complete_snapshot(),
                "messages": window.messages().iter().take(super::window::PageRequest::MAX_LIMIT).enumerate().map(|(index, message)| serde_json::json!({
                    "index": index, "role": format!("{:?}", message.role()), "sequence": message.sequence(),
                    "runHash": message.run_id().map(sessions_module::trace::fingerprint), "messageHash": message.message_id().map(sessions_module::trace::fingerprint),
                    "displayItemHash": message.display_item_id().map(sessions_module::trace::fingerprint), "text": sessions_module::trace::text_shape(message.text()),
                    "originPresent": message.origin().is_some(), "contentCount": message.content().len(),
                })).collect::<Vec<_>>(),
                "inFlightRun": window.state().in_flight_run().map(|run| serde_json::json!({ "runHash": sessions_module::trace::fingerprint(run.run_id()),
                    "state": format!("{:?}", run.state()), "text": sessions_module::trace::text_shape(run.text()) })) }));
        }
        let input_trace_elapsed_ms = history_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
        if window.state().kind() == super::window::HistoryKind::Reset {
            if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.history_reset", serde_json::json!({ "decision": "request_full_history", "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) })); }
            return Ok(None);
        }
        if window.session_key().is_some_and(|key| key != self.session_key.as_str()) {
            if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.history_rejected", serde_json::json!({ "reason": "session_key_mismatch" })); }
            return Err(Failure::TargetRejected);
        }
        if let (Some(current), Some(incoming)) = (self.native_session_id.as_deref(), window.native_session_id()) {
            if current != incoming { return Err(Failure::Unknown); }
        }
        let in_flight_run = window.state().in_flight_run().filter(|_| matches!(page.direction(), super::window::Direction::Latest));
        let in_flight = in_flight_run.filter(|run| !self.body.terminal.iter().any(|(id, _)| id == run.run_id()))
            .map(|run| RunId::try_new(run.run_id().to_owned()).map_err(|_| Failure::Unknown)).transpose()?;
        // Body's existing per-message/reconcile traces are inside this interval; it is not pure merge CPU.
        let body_started = super::trace::enabled().then(std::time::Instant::now);
        let mut body = self.body.clone();
        let mut changes = Vec::new();
        for message in window.messages() {
            body.apply_message(message).ok_or_else(|| {
                if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.history_rejected", serde_json::json!({
                    "reason": "body_message_candidate", "messageHash": message.message_id().map(sessions_module::trace::fingerprint),
                    "sequence": message.sequence(), "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) })); }
                Failure::Unknown
            })?;
            changes.push(CanonicalSessionChange::TranscriptMessage { message: message.clone() });
        }
        if let Some(run) = in_flight_run {
            if !body.terminal.iter().any(|(id, _)| id == run.run_id()) {
                body.apply_cumulative(run.run_id(), run.text()).ok_or_else(|| {
                    if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.reducer.history_rejected", serde_json::json!({
                        "reason": "body_cumulative_candidate", "runHash": sessions_module::trace::fingerprint(run.run_id()),
                        "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) })); }
                    Failure::Unknown
                })?;
            } else if super::trace::enabled() {
                super::trace::log_unscoped("runtime.openclaw.reducer.history_cumulative_ignored", serde_json::json!({
                    "reason": "terminal_fence", "runHash": sessions_module::trace::fingerprint(run.run_id()),
                    "text": sessions_module::trace::text_shape(run.text()) }));
            }
        }
        let body_with_trace_elapsed_ms = body_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
        let previous_window = self.window;
        if window.state().kind() == super::window::HistoryKind::Full {
            let range = window.range();
            let total = window.total_item_count();
            self.window = Some(sessions_module::state::SessionWindow {
                total_item_count: total as u64, window_start_offset: range.start() as u64, window_end_offset: range.end() as u64,
                has_more: range.start() > 0, has_newer: range.end() < total,
                is_at_latest: matches!(page.direction(), super::window::Direction::Latest) && range.end() == total,
            });
        }
        let commit_started = super::trace::enabled().then(std::time::Instant::now);
        if self.commit_body(body, &mut changes).is_none() { self.window = previous_window; return Err(Failure::Unknown); }
        let commit_with_trace_elapsed_ms = commit_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
        if let Some(session_id) = window.native_session_id() { self.native_session_id = Some(session_id.to_owned()); }
        if let Some(run_id) = in_flight {
            if self.active_run_for(run_id.clone()).is_some() {
                self.cache.runtime.phase = sessions_module::state::RunPhase::Started;
                self.cache.runtime.active_run_id = Some(run_id.as_str().to_owned());
            }
        }
        let result = CanonicalSessionDeltaProducer::recovery(self.session_key.clone(), Some(epoch), CanonicalRecoveryReason::NativeUnknown);
        let mut result = result;
        result.replace_changes(Vec::new());
        if let Some(history_started) = history_started {
            let history_elapsed_ms = history_started.elapsed().as_secs_f64() * 1000.0;
            let accepted_trace_started = std::time::Instant::now();
            super::trace::log_unscoped("runtime.openclaw.reducer.history_accepted", serde_json::json!({
                "sourceEpoch": epoch.as_u64(), "historyKind": format!("{:?}", window.state().kind()),
                "actualFinalItems": sessions_module::trace::items_shape(&self.body.items),
                "runtimePhase": self.cache.runtime.phase, "activeRunHash": self.cache.runtime.active_run_id.as_deref().map(sessions_module::trace::fingerprint),
                "inputTraceElapsedMs": input_trace_elapsed_ms, "bodyWithTraceElapsedMs": body_with_trace_elapsed_ms,
                "commitWithTraceElapsedMs": commit_with_trace_elapsed_ms, "historyWithTraceElapsedMs": history_elapsed_ms,
                "timingScope": "sync_history_before_history_accepted_including_body_internal_trace" }));
            let accepted_trace_elapsed_ms = accepted_trace_started.elapsed().as_secs_f64() * 1000.0;
            super::trace::log_unscoped("runtime.openclaw.reducer.history_trace_timing", serde_json::json!({
                "historyAcceptedTraceElapsedMs": accepted_trace_elapsed_ms, "messageCount": window.messages().len(),
                "itemCount": self.body.items.len(), "timingScope": "history_accepted_shape_hash_emit_excluding_this_log" }));
        }
        Ok(Some(CanonicalIngressResult::Produced(result)))
    }

    pub(crate) fn sync_approvals(&mut self, approvals: &[SessionApprovalEvent], _epoch: GatewayEpoch)
        -> Result<(), sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::{ports::RuntimeOperationFailure as Failure, state::{ApprovalPhase, ApprovalView}};
        if approvals.len() > 32 || approvals.iter().any(|approval| approval.session_key != self.session_key) { return Err(Failure::TargetRejected); }
        self.cache.approvals = approvals.iter().map(|approval| ApprovalView {
            approval_id: approval.approval_id.as_str().to_owned(), run_id: approval.run_id.as_ref().map(|id| id.as_str().to_owned()),
            phase: if approval.lifecycle == SessionApprovalLifecycle::Requested { ApprovalPhase::Requested } else { ApprovalPhase::Resolved },
            option_ids: approval.option_ids.iter().map(|id| id.as_str().to_owned()).collect(),
        }).collect();
        for approval in approvals { self.observe_approval(approval); }
        self.approvals_known = true;
        Ok(())
    }

    fn view_parts(&self, epoch: u64, body: &super::body::Body, cache: &super::adapters::timeline::OpenClawReplayProjection)
        -> Result<sessions_module::state::SessionView, sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::{ports::RuntimeOperationFailure as Failure, state::{MissingFact, SessionCompleteness, SessionFact, SessionIdentity, SessionProvider, SessionView}};
        let (agent, suffix) = self.session_key.as_str().strip_prefix("agent:").and_then(|key| key.split_once(':')).ok_or(Failure::TargetRejected)?;
        let key = super::protocol::AgentScopedSessionKey::try_new(super::protocol::AgentId::try_new(agent.to_owned()).map_err(|_| Failure::TargetRejected)?,
            super::protocol::EndpointSessionId::try_new(suffix.to_owned()).map_err(|_| Failure::TargetRejected)?).map_err(|_| Failure::TargetRejected)?;
        if key.as_str() != self.session_key.as_str() { return Err(Failure::TargetRejected); }
        let identity = SessionIdentity::new(key.as_str().to_owned(), SessionProvider::OpenClaw, agent.to_owned()).ok_or(Failure::TargetRejected)?;
        let view = SessionView {
            session_key: identity.session_key.clone(), endpoint_session_id: self.native_session_id.clone(), ownership: None, model_state: None, goal: self.goal.clone(), identity,
            epoch, seq: 0, cursor: 0,
            items: SessionFact::Incomplete { facts: body.items.clone(), gaps: vec![MissingFact::BoundedHistory] },
            tools: SessionFact::Incomplete { facts: cache.tools.clone(), gaps: vec![MissingFact::BoundedHistory] },
            approvals: if self.approvals_known { SessionFact::Complete(cache.approvals.clone()) }
                else { SessionFact::Incomplete { facts: cache.approvals.clone(), gaps: vec![MissingFact::EventOnly] } },
            runtime: SessionFact::Incomplete { facts: cache.runtime.clone(), gaps: vec![MissingFact::PartialRuntime] },
            window: self.window.map_or(SessionFact::Unknown, SessionFact::Complete),
            completeness: SessionCompleteness::Incomplete { missing: vec![MissingFact::BoundedHistory, MissingFact::PartialRuntime, MissingFact::Catalog, MissingFact::Usage] },
        };
        view.validate().map_err(|_| {
            if super::trace::enabled() {
                super::trace::log_unscoped("runtime.openclaw.reducer.view_rejected", serde_json::json!({
                    "reason": "view_validation", "candidateItems": sessions_module::trace::items_shape(&body.items),
                    "actualFinalItems": sessions_module::trace::items_shape(&self.body.items) }));
            }
            Failure::Unknown
        })?;
        Ok(view)
    }

    pub(crate) fn page_actor(&self) -> Self {
        let mut page = Self::new(self.session_key.clone());
        page.cache.approvals = self.cache.approvals.clone();
        page.cache.runtime = self.cache.runtime.clone();
        page.approvals_known = self.approvals_known;
        page.native_session_id = self.native_session_id.clone();
        page.goal = self.goal.clone();
        page.body.terminal = self.body.terminal.clone();
        page
    }

    pub(crate) fn sync_goal(&mut self, session_id: &str, goal: sessions_module::goal::SessionGoalView) -> Result<bool, sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::{goal::SessionGoalView, ports::RuntimeOperationFailure};
        if session_id.is_empty() || goal.validate().is_err() { return Err(RuntimeOperationFailure::Unknown); }
        if self.native_session_id.as_deref().is_some_and(|current| current != session_id) { return Err(RuntimeOperationFailure::Unknown); }
        self.native_session_id = Some(session_id.to_owned());
        if matches!(goal, SessionGoalView::Unknown) || self.goal == goal { return Ok(false); }
        self.goal = goal;
        Ok(true)
    }

    pub(crate) fn snapshot(&self, epoch: u64) -> Result<sessions_module::state::SessionView, sessions_module::ports::RuntimeOperationFailure> {
        self.view_parts(epoch, &self.body, &self.cache)
    }

    pub(crate) fn terminal_runs(&self) -> Vec<sessions_module::ports::SessionTerminalRun> {
        self.body.terminal.iter().map(|(run_id, phase)| sessions_module::ports::SessionTerminalRun { run_id: run_id.clone(), phase: *phase }).collect()
    }

    pub(crate) fn retired_item_ids(&self) -> Vec<String> { self.body.retired.clone() }

    pub(crate) fn recover(
        &mut self,
        source_epoch: Option<GatewayEpoch>,

        reason: CanonicalRecoveryReason,
    ) -> CanonicalIngressResult {
        if super::trace::enabled() {
            self.body.trace_committed("runtime.openclaw.reducer.recover_body_retained");
            super::trace::log_unscoped("runtime.openclaw.reducer.recover", serde_json::json!({
                "sessionHash": sessions_module::trace::fingerprint(self.session_key.as_str()),
                "sourceEpoch": source_epoch.map(GatewayEpoch::as_u64), "reason": format!("{:?}", reason),
                "activeRunHash": self.active_run.as_ref().map(|run| sessions_module::trace::fingerprint(run.run_id.as_str())),
                "bodyRetained": true, "actualFinalItems": sessions_module::trace::items_shape(&self.body.items),
                "retiredItemCount": self.body.retired.len() }));
        }
        self.active_run = None;
        CanonicalIngressResult::Produced(CanonicalSessionDeltaProducer::recovery(
            self.session_key.clone(),

            source_epoch,
            reason,
        ))
    }

    pub(crate) fn recover_replay(
        &mut self,
        source_epoch: Option<u64>,
        source_cursor: u64,

    ) -> CanonicalIngressResult {
        self.active_run = None;
        CanonicalIngressResult::from_replay_recovery(
            self.session_key.clone(),
            source_epoch,
            source_cursor,

        )
    }

    fn reduce_chat(
        &mut self,
        mut event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        let chat = event.chat.as_ref()?;
        if event.run_id.as_ref() != Some(&chat.run_id) || event.session_key != chat.session_key {
            return None;
        }

        match chat.state {
            ChatState::Status => self.reduce_chat_status(event, source_epoch),
            ChatState::Delta => self.reduce_chat_delta(event, source_epoch),
            state => {
                let run_id = chat.run_id.clone();
                let assistant_changes = self.assistant_snapshot_changes(
                    run_id.clone(), None, chat.delta_text.as_deref().filter(|_| chat.replace).or(chat.message_text.as_deref()), chat.message_thinking.as_deref(),
                );

                if let Some(chat) = event.chat.as_mut() {
                    chat.message_text = None;
                    chat.message_thinking = None;
                }

                let result = terminal_outcome(state).and_then(|_| {
                    let mut changes = Vec::with_capacity(assistant_changes.len() + 1);
                    changes.extend(assistant_changes);
                    changes.push(terminal_change(&event)?);
                    produce_changes_debugged(
                        "chat_terminal",
                        event,
                        source_epoch,

                        changes,
                    )
                });
                self.clear_active_run(&run_id);
                result
            }
        }
    }

    fn reduce_chat_status(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        let chat = event.chat.as_ref()?;
        let run_id = chat.run_id.clone();
        let progress = if let Some(retry) = chat.status_retry {
            CanonicalRunProgress::Retrying {
                attempt: retry.attempt,
                max_attempts: retry.max_attempts,
            }
        } else {
            CanonicalRunProgress::Startup {
                phase: chat.status_phase?,
            }
        };
        produce_changes_debugged(
            "chat_status",
            event,
            source_epoch,

            vec![CanonicalSessionChange::RunProgress { run_id, progress }],
        )
    }

    fn reduce_chat_delta(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        let chat = event.chat.as_ref()?;
        let run_id = chat.run_id.clone();
        if chat.message_text.is_some() || chat.message_thinking.is_some() {
            let changes = self.assistant_snapshot_changes(
                run_id.clone(), None, chat.delta_text.as_deref().filter(|_| chat.replace).or(chat.message_text.as_deref()), chat.message_thinking.as_deref(),
            );
            if changes.is_empty() {
                return None;
            }
            return produce_changes_debugged(
                "chat_snapshot",
                event,
                source_epoch,

                changes,
            );
        }

        if let Some(delta_text) = chat.delta_text.as_deref() {
            let change = CanonicalSessionChange::AssistantTurnChunk {
                run_id, message_id: None, kind: AssistantTurnChunkKind::Text,
                text: delta_text.to_owned(), replace: chat.replace, status: AssistantTurnStatus::Streaming,
            };
            return produce_changes_debugged(
                "chat_delta_text",
                event,
                source_epoch,

                vec![change],
            );
        }
        produce_debugged("chat_passthrough", event, source_epoch)
    }

    fn reduce_message_activity(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        let activity = event.activity.as_ref()?;
        if activity.session_key != self.session_key
            || event.run_id.as_ref() != Some(&activity.run_id)
        {
            return None;
        }

        let SessionActivityKind::Message {
            message_id,
            lifecycle,
            text,
        } = activity.kind()
        else {
            return None;
        };
        let run_id = activity.run_id.clone();
        let change = CanonicalSessionChange::AssistantTurnChunk {
            run_id, message_id: Some(message_id.clone()), kind: AssistantTurnChunkKind::Text,
            text: match lifecycle {
                MessageActivityLifecycle::Delta => text.clone()?,
                MessageActivityLifecycle::Started | MessageActivityLifecycle::Completed => String::new(),
            },
            replace: matches!(lifecycle, MessageActivityLifecycle::Delta),
            status: AssistantTurnStatus::from_message_lifecycle(*lifecycle),
        };
        produce_changes_debugged("message_activity", event, source_epoch, vec![change])
    }

    fn reduce_agent_activity(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        let activity = event.activity.as_ref()?;
        if activity.session_key != self.session_key
            || event.run_id.as_ref() != Some(&activity.run_id)
        {
            return None;
        }

        let SessionActivityKind::Thinking { text } = activity.kind() else {
            return None;
        };
        let run_id = activity.run_id.clone();
        let changes = self.assistant_snapshot_changes(run_id, native_message_id(&event), None, Some(text));
        if changes.is_empty() {
            return None;
        }
        produce_changes_debugged("agent_thinking", event, source_epoch, changes)
    }

    fn reduce_runtime_activity(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        let activity = event.activity.as_ref()?;
        if activity.session_key != self.session_key
            || event.run_id.as_ref() != Some(&activity.run_id)
        {
            return None;
        }
        match activity.kind() {
            SessionActivityKind::Thinking { .. } => {
                self.reduce_agent_activity(event, source_epoch)
            }
            SessionActivityKind::Compaction { phase } => {
                let change = match phase {
                    RuntimeActivityPhase::Started | RuntimeActivityPhase::Retrying => {
                        CanonicalSessionChange::RuntimeActivity {
                            run_id: activity.run_id.clone(),
                            activity: CanonicalRuntimeActivity::Compacting,
                        }
                    }
                    RuntimeActivityPhase::Completed | RuntimeActivityPhase::CompletedIfRetrying => {
                        CanonicalSessionChange::RuntimeActivityCleared {
                            run_id: activity.run_id.clone(),
                            activity: CanonicalRuntimeActivity::Compacting,
                            retrying_cleanup: matches!(
                                phase,
                                RuntimeActivityPhase::CompletedIfRetrying
                            ),
                        }
                    }
                };
                if matches!(phase, RuntimeActivityPhase::Retrying) {
                    return None;
                }
                if matches!(phase, RuntimeActivityPhase::CompletedIfRetrying)
                    && !matches!(self.active_run.as_ref(), Some(active) if active.run_id == activity.run_id && active.compacting)
                {
                    return None;
                }
                if matches!(
                    phase,
                    RuntimeActivityPhase::Started | RuntimeActivityPhase::Retrying
                ) {
                    if let Some(active) = self.active_run_for(activity.run_id.clone())
                        && matches!(phase, RuntimeActivityPhase::Started)
                    {
                        active.compacting = true;
                    }
                } else if let Some(active) = self.active_run.as_mut()
                    && active.run_id == activity.run_id
                {
                    active.compacting = false;
                }
                produce_changes_debugged(
                    "runtime_activity",
                    event,
                    source_epoch,

                    vec![change],
                )
            }
            SessionActivityKind::Fallback { detail } => {
                let run_id = activity.run_id.clone();
                let detail = detail.clone();
                produce_changes_debugged(
                    "runtime_fallback",
                    event,
                    source_epoch,

                    vec![CanonicalSessionChange::RuntimeFallback { run_id, detail }],
                )
            }
            SessionActivityKind::FallbackCleared => {
                let run_id = activity.run_id.clone();
                produce_changes_debugged(
                    "runtime_fallback_cleared",
                    event,
                    source_epoch,

                    vec![CanonicalSessionChange::RuntimeFallbackCleared { run_id }],
                )
            }
            SessionActivityKind::Guardian { notice } => {
                let run_id = activity.run_id.clone();
                let notice = notice.clone();
                produce_changes_debugged(
                    "guardian_notice",
                    event,
                    source_epoch,

                    vec![CanonicalSessionChange::GuardianNotice { run_id, notice }],
                )
            }
            SessionActivityKind::Message { .. } | SessionActivityKind::Tool { .. } => None,
        }
    }

    fn reduce_tool_activity(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        let activity = event.activity.as_ref()?;
        if activity.session_key != self.session_key
            || event.run_id.as_ref() != Some(&activity.run_id)
        {
            return None;
        }

        let SessionActivityKind::Tool {
            tool_id,
            tool_name,
            phase,
            summary,
        } = activity.kind()
        else {
            return self.reduce_runtime_activity(event, source_epoch);
        };
        let run_id = activity.run_id.clone();
        if let Some(active) = self.active_run_for(run_id.clone())
            && matches!(phase, ToolActivityPhase::Started)
        {
            if active.started_tools.contains(tool_id) { return None; }
            active.started_tools.push(tool_id.clone());
        }
        let change = CanonicalSessionChange::ToolActivity {
            run_id, tool_id: tool_id.clone(), tool_name: tool_name.clone(), phase: *phase,
            input: activity.input().cloned(), input_text: activity.input_text().map(str::to_owned),
            summary: summary.clone(), output: activity.output().cloned(),
            details: activity.details().cloned(), is_error: activity.is_error(),
        };
        produce_changes_debugged(
            "tool_activity",
            event,
            source_epoch,

            vec![change],
        )
    }

    fn reduce_approval(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        let approval = event.approval.as_ref()?;
        if approval.session_key != self.session_key {
            return None;
        }
        if matches!(approval.lifecycle, SessionApprovalLifecycle::Requested)
            && self.approval_state(approval) == Some(ApprovalState::Requested)
        {
            return None;
        }
        self.observe_approval(approval);
        produce_debugged("approval", event, source_epoch)
    }

    fn reduce_changed(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,

    ) -> Option<CanonicalIngressResult> {
        let changed = event.changed.as_ref()?;
        if changed.session_key != self.session_key
            || event.run_id.as_ref() != Some(&changed.run_id)
            || !matches!(changed.phase, SessionChangedPhase::Start)
        {
            return None;
        }
        let run_id = changed.run_id.clone();
        if let Some(active) = self.active_run_for(run_id.clone()) {
            if active.started { return None; }
            active.started = true;
        }
        produce_changes_debugged(
            "session_changed_start",
            event,
            source_epoch,

            vec![CanonicalSessionChange::RunStarted { run_id }],
        )
    }

    fn observe_approval(&mut self, approval: &SessionApprovalEvent) {
        let key = approval_key(approval);
        match approval.lifecycle {
            SessionApprovalLifecycle::Requested => {
                self.approvals.insert(key, ApprovalState::Requested);
            }
            SessionApprovalLifecycle::Resolved => {
                self.approvals.insert(key, ApprovalState::Resolved);
            }
        }
    }

    fn approval_state(&self, approval: &SessionApprovalEvent) -> Option<ApprovalState> {
        self.approvals.get(&approval_key(approval)).copied()
    }

    fn assistant_snapshot_changes(
        &self,
        run_id: RunId,
        message_id: Option<MessageId>,
        text: Option<&str>,
        thinking: Option<&str>,
    ) -> Vec<CanonicalSessionChange> {
        let mut changes = Vec::with_capacity(usize::from(text.is_some()) + usize::from(thinking.is_some()));
        for (kind, snapshot) in [(AssistantTurnChunkKind::Thinking, thinking), (AssistantTurnChunkKind::Text, text)] {
            if let Some(snapshot) = snapshot {
                changes.push(CanonicalSessionChange::AssistantTurnChunk {
                    run_id: run_id.clone(), message_id: message_id.clone(), kind,
                    text: snapshot.to_owned(), replace: true, status: AssistantTurnStatus::Streaming,
                });
            }
        }
        changes
    }

    fn active_run_for(&mut self, run_id: RunId) -> Option<&mut ActiveRunState> {
        if self.active_run.is_none() {
            self.active_run = Some(ActiveRunState::new(run_id.clone()));
        }
        self.active_run.as_mut().filter(|active| active.run_id == run_id)
    }

    fn clear_active_run(&mut self, run_id: &RunId) {
        if matches!(self.active_run.as_ref(), Some(active) if &active.run_id == run_id) {
            self.active_run = None;
        }
    }
}

#[derive(Clone)]
struct ActiveRunState {
    run_id: RunId,
    started: bool,
    compacting: bool,
    started_tools: Vec<ToolId>,
}

impl ActiveRunState {
    fn new(run_id: RunId) -> Self {
        Self { run_id, started: false, compacting: false, started_tools: Vec::new() }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ApprovalState {
    Requested,
    Resolved,
}

fn push_replacement(changes: &mut Vec<CanonicalSessionChange>, replacement: CanonicalSessionChange) {
    if matches!(&replacement, CanonicalSessionChange::ItemsReplaced { old_item_ids, items, .. } if old_item_ids.is_empty() && items.is_empty()) {
        return;
    }
    changes.push(replacement);
}

fn produce(
    event: SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,

) -> Option<CanonicalIngressResult> {
    CanonicalSessionDeltaProducer::from_native_event(&event, source_epoch)
        .map(CanonicalIngressResult::Produced)
}

fn produce_debugged(
    stage: &'static str,
    event: SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,

) -> Option<CanonicalIngressResult> {
    let result = produce(event, source_epoch);
    if let Some(CanonicalIngressResult::Produced(delta)) = result.as_ref() {
        trace_canonical_changes(stage, delta.changes());
    }
    result
}

fn produce_changes(
    event: SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,

    changes: Vec<CanonicalSessionChange>,
) -> Option<CanonicalIngressResult> {
    CanonicalSessionDeltaProducer::from_native_changes(&event, source_epoch, changes)
        .map(CanonicalIngressResult::Produced)
}

fn produce_changes_debugged(
    stage: &'static str,
    event: SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,

    changes: Vec<CanonicalSessionChange>,
) -> Option<CanonicalIngressResult> {
    trace_canonical_changes(stage, &changes);
    produce_changes(event, source_epoch, changes)
}

fn terminal_change(event: &SessionEventEnvelope) -> Option<CanonicalSessionChange> {
    let chat = event.chat.as_ref()?;
    Some(CanonicalSessionChange::Terminal {
        run_id: chat.run_id.clone(),
        outcome: terminal_outcome(chat.state)?,
        message_id: native_message_id(event),
        error_kind: chat.error_kind,
        error_message: chat.error_message.clone(),
        stop_reason: chat.stop_reason.clone(),
        error_detail: chat.error_detail.clone(),
    })
}

fn native_message_id(event: &SessionEventEnvelope) -> Option<MessageId> {
    event
        .message_id
        .clone()
        .or_else(|| event.embedded_message_id.clone())
}

fn approval_key(approval: &SessionApprovalEvent) -> String {
    match approval.source {
        super::protocol::SessionApprovalSource::Exec => {
            format!("exec:{}", approval.approval_id.as_str())
        }
        super::protocol::SessionApprovalSource::Plugin => {
            format!("plugin:{}", approval.approval_id.as_str())
        }
        super::protocol::SessionApprovalSource::SystemAgent => {
            format!("system-agent:{}", approval.approval_id.as_str())
        }
    }
}

fn terminal_outcome(state: ChatState) -> Option<TerminalOutcome> {
    match state {
        ChatState::Final => Some(TerminalOutcome::Completed),
        ChatState::Aborted => Some(TerminalOutcome::Aborted),
        ChatState::Error => Some(TerminalOutcome::Error),
        ChatState::Status | ChatState::Delta => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        gateway::wire::GatewayEvent,
        session::{
            projection::CanonicalSessionChange,
            protocol::{RunId, decode_session_event},
        },
    };

    fn session_key() -> SessionKey {
        SessionKey::try_new("agent:main:session-1").unwrap()
    }

    fn run_id() -> RunId {
        RunId::try_new("run-1").unwrap()
    }

    fn epoch() -> GatewayEpoch {
        GatewayEpoch::try_new(7).unwrap()
    }

    fn decode(name: &str, payload: serde_json::Value, sequence: u64) -> SessionEventEnvelope {
        decode_session_event(GatewayEvent {
            name: name.to_owned(),
            payload: Some(payload),
            sequence: Some(sequence),
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    fn chat_snapshot(sequence: u64, content: &str) -> SessionEventEnvelope {
        chat_snapshot_with_delta(sequence, content, "ignored fallback delta")
    }

    fn chat_snapshot_with_delta(
        sequence: u64,
        content: &str,
        delta_text: &str,
    ) -> SessionEventEnvelope {
        decode(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": sequence,
                "state": "delta",
                "deltaText": delta_text,
                "message": {
                    "id": "message-1",
                    "role": "assistant",
                    "content": [{"type": "text", "text": content}]
                }
            }),
            sequence,
        )
    }

    fn chat_thinking_snapshot(
        sequence: u64,
        content: &str,
        thinking: &str,
    ) -> SessionEventEnvelope {
        decode(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": sequence,
                "state": "delta",
                "message": {
                    "id": "message-1",
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": thinking},
                        {"type": "text", "text": content}
                    ]
                }
            }),
            sequence,
        )
    }

    fn chat_delta_text(sequence: u64, content: &str) -> SessionEventEnvelope {
        decode(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": sequence,
                "state": "delta",
                "deltaText": content
            }),
            sequence,
        )
    }

    fn terminal_chat(sequence: u64) -> SessionEventEnvelope {
        decode(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": sequence,
                "state": "final"
            }),
            sequence,
        )
    }

    fn terminal_error_chat(sequence: u64) -> SessionEventEnvelope {
        decode(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": sequence,
                "state": "error",
                "errorMessage": "provider overloaded",
                "errorKind": "rate_limit",
                "stopReason": "gateway_error"
            }),
            sequence,
        )
    }

    fn final_chat_snapshot(sequence: u64, content: &str) -> SessionEventEnvelope {
        decode(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": sequence,
                "state": "final",
                "message": {
                    "id": "message-1",
                    "role": "assistant",
                    "content": [{"type": "text", "text": content}]
                }
            }),
            sequence,
        )
    }

    fn tool_event(sequence: u64, phase: &str) -> SessionEventEnvelope {
        decode(
            "session.tool",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "phase": phase,
                "toolCallId": "tool-1",
                "toolName": "read",
                "summary": "tool summary",
                "output": {"ok": true},
                "isError": false
            }),
            sequence,
        )
    }

    fn tool_event_with_details(
        sequence: u64,
        phase: &str,
        details: serde_json::Value,
    ) -> SessionEventEnvelope {
        decode(
            "session.tool",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "phase": phase,
                "toolCallId": "tool-1",
                "toolName": "read",
                "summary": "tool summary",
                "details": details,
                "isError": false
            }),
            sequence,
        )
    }

    fn approval_event(sequence: u64) -> SessionEventEnvelope {
        decode(
            "agent",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "stream": "approval",
                "data": {
                    "phase": "requested",
                    "kind": "exec",
                    "status": "pending",
                    "approvalId": "approval-1",
                    "allowedDecisions": ["allow-once", "deny"]
                }
            }),
            sequence,
        )
    }

    fn agent_stream_event(
        sequence: u64,
        stream: &str,
        data: serde_json::Value,
    ) -> SessionEventEnvelope {
        decode(
            "agent",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "stream": stream,
                "data": data
            }),
            sequence,
        )
    }

    fn changed_event(sequence: u64, phase: &str) -> SessionEventEnvelope {
        decode(
            "sessions.changed",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "phase": phase
            }),
            sequence,
        )
    }

    fn produced_change(result: Option<CanonicalIngressResult>) -> CanonicalSessionChange {
        let Some(CanonicalIngressResult::Produced(delta)) = result else {
            panic!("expected produced canonical delta");
        };
        assert_eq!(delta.session_key(), &session_key());
        assert_eq!(delta.source_epoch(), Some(epoch().as_u64()));
        assert_eq!(delta.route_key(), Some("route-1"));
        assert_eq!(delta.changes().len(), 1);
        delta.changes()[0].clone()
    }

    #[test]
    fn changed_start_projects_run_started_once() {
        let mut reducer = SessionReducerActor::new(session_key());

        let started = produced_change(reducer.reduce(
            changed_event(1, "start"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            started,
            CanonicalSessionChange::RunStarted { run_id } if run_id.as_str() == "run-1"
        ));
        assert!(matches!(
            reducer.active_run.as_ref().map(|run| run.started),
            Some(true)
        ));
        assert!(
            reducer
                .reduce(
                    changed_event(2, "start"),
                    Some(epoch()),
                    Some("route-1".to_owned())
                )
                .is_none()
        );
        assert!(
            reducer
                .reduce(
                    changed_event(3, "end"),
                    Some(epoch()),
                    Some("route-1".to_owned())
                )
                .is_none()
        );
    }

    #[test]
    fn text_full_snapshot_projects_tail_delta_only_on_growth() {
        let mut reducer = SessionReducerActor::new(session_key());

        let first = produced_change(reducer.reduce(
            chat_snapshot_with_delta(1, "hello", "not used"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            first,
            CanonicalSessionChange::AssistantTurnChunk { text, replace, .. }
                if text == "hello" && !replace
        ));

        let second = produced_change(reducer.reduce(
            chat_snapshot_with_delta(2, "hello world", "not used"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            second,
            CanonicalSessionChange::AssistantTurnChunk { text, replace, .. }
                if text == " world" && !replace
        ));

        assert!(
            reducer
                .reduce(
                    chat_snapshot(3, "hello world"),
                    Some(epoch()),
                    Some("route-1".to_owned())
                )
                .is_none()
        );
        assert!(
            reducer
                .reduce(
                    chat_snapshot(4, "reset"),
                    Some(epoch()),
                    Some("route-1".to_owned())
                )
                .is_none()
        );
    }

    #[test]
    fn delta_text_projects_text_delta_without_snapshot() {
        let mut reducer = SessionReducerActor::new(session_key());

        let change = produced_change(reducer.reduce(
            chat_delta_text(1, "hello"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));

        assert!(matches!(
            change,
            CanonicalSessionChange::AssistantTurnChunk { text, replace, .. }
                if text == "hello" && !replace
        ));
    }

    #[test]
    fn thinking_snapshot_projects_tail_chunk_after_text_tail_delta() {
        let mut reducer = SessionReducerActor::new(session_key());

        let Some(CanonicalIngressResult::Produced(delta)) = reducer.reduce(
            chat_thinking_snapshot(1, "hello", "thinking"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ) else {
            panic!("expected text and thinking chunks");
        };

        assert!(matches!(
            delta.changes(),
            [
                CanonicalSessionChange::AssistantTurnChunk {
                    kind: AssistantTurnChunkKind::Thinking,
                    text: thinking,
                    ..
                },
                CanonicalSessionChange::AssistantTurnChunk {
                    kind: AssistantTurnChunkKind::Text,
                    text,
                    ..
                }
            ] if text == "hello" && thinking == "thinking"
        ));
    }

    #[test]
    fn thinking_snapshot_diff_is_tracked() {
        let mut run = ActiveRunState::new(run_id());
        let first = run.record_assistant_snapshot(None, None, Some("thinking"));
        assert_eq!(
            first.thinking,
            Some(TextSnapshotDelta {
                text: "thinking".to_owned(),
                replace: false,
                previous_snapshot_was_empty: true,
            })
        );

        let second = run.record_assistant_snapshot(None, None, Some("thinking more"));
        assert_eq!(
            second.thinking,
            Some(TextSnapshotDelta {
                text: " more".to_owned(),
                replace: false,
                previous_snapshot_was_empty: false,
            })
        );

        assert_eq!(
            run.record_assistant_snapshot(None, None, Some("thinking more"))
                .thinking,
            None
        );
    }

    #[test]
    fn ordered_assistant_turn_delta_tool_snapshot_final_keeps_projection_order() {
        let mut reducer = SessionReducerActor::new(session_key());

        let first = produced_change(reducer.reduce(
            chat_snapshot(1, "before tool"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            first,
            CanonicalSessionChange::AssistantTurnChunk { text, .. } if text == "before tool"
        ));

        let start = produced_change(reducer.reduce(
            tool_event(2, "start"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            start,
            CanonicalSessionChange::ToolActivity {
                phase: ToolActivityPhase::Started,
                tool_name: Some(tool_name),
                summary: Some(summary),
                output,
                ..
            } if tool_name == "read"
                && summary == "tool summary"
                && output.is_none()
        ));

        let update = produced_change(reducer.reduce(
            tool_event(3, "update"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            update,
            CanonicalSessionChange::ToolActivity {
                phase: ToolActivityPhase::Updated,
                ..
            }
        ));
        assert!(matches!(
            reducer
                .active_run
                .as_ref()
                .map(|run| run.sent_text.as_str()),
            Some("before tool")
        ));

        let result = produced_change(reducer.reduce(
            tool_event(4, "result"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            result,
            CanonicalSessionChange::ToolActivity {
                phase: ToolActivityPhase::Completed,
                ..
            }
        ));
        assert!(matches!(
            reducer
                .active_run
                .as_ref()
                .map(|run| run.sent_text.as_str()),
            Some("before tool")
        ));

        let second = produced_change(reducer.reduce(
            chat_snapshot(5, "before tool after tool"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            second,
            CanonicalSessionChange::AssistantTurnChunk { text, .. } if text == " after tool"
        ));
        assert!(matches!(
            reducer.active_run.as_ref().map(|run| run.turn_segments.as_slice()),
            Some(
                [
                    OrderedAssistantTurnSegment::Text { text: before },
                    OrderedAssistantTurnSegment::Tool { tool_id },
                    OrderedAssistantTurnSegment::Text { text: after },
                ]
            ) if before == "before tool"
                && tool_id.as_str() == "tool-1"
                && after == " after tool"
        ));

        let Some(CanonicalIngressResult::Produced(final_delta)) = reducer.reduce(
            final_chat_snapshot(6, "before tool after tool."),
            Some(epoch()),
            Some("route-1".to_owned()),
        ) else {
            panic!("expected final delta and terminal delta");
        };
        assert!(matches!(
            final_delta.changes(),
            [
                CanonicalSessionChange::AssistantTurnChunk { text, .. },
                CanonicalSessionChange::Terminal {
                    outcome: TerminalOutcome::Completed,
                    ..
                }
            ] if text == "."
        ));
        assert!(reducer.active_run.is_none());
    }

    #[test]
    fn tool_start_duplicate_is_suppressed_and_result_patches_state() {
        let mut reducer = SessionReducerActor::new(session_key());

        let start = produced_change(reducer.reduce(
            tool_event(1, "start"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            start,
            CanonicalSessionChange::ToolActivity {
                phase: ToolActivityPhase::Started,
                ..
            }
        ));

        assert!(
            reducer
                .reduce(
                    tool_event(2, "start"),
                    Some(epoch()),
                    Some("route-1".to_owned())
                )
                .is_none()
        );

        let result = produced_change(reducer.reduce(
            tool_event(3, "result"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            result,
            CanonicalSessionChange::ToolActivity {
                phase: ToolActivityPhase::Completed,
                ..
            }
        ));
        assert_eq!(
            reducer
                .active_run
                .as_ref()
                .and_then(|run| run.tools.get(&ToolId::try_new("tool-1").unwrap()))
                .map(|tool| tool.phase),
            Some(ToolActivityPhase::Completed)
        );
        assert!(matches!(
            reducer.active_run.as_ref().map(|run| run.turn_segments.as_slice()),
            Some([OrderedAssistantTurnSegment::Tool { tool_id }]) if tool_id.as_str() == "tool-1"
        ));
        assert!(
            reducer
                .reduce(
                    tool_event(4, "start"),
                    Some(epoch()),
                    Some("route-1".to_owned())
                )
                .is_none()
        );
    }

    #[test]
    fn tool_details_merge_and_empty_output_result_still_emits() {
        let mut reducer = SessionReducerActor::new(session_key());

        let first = produced_change(reducer.reduce(
            tool_event_with_details(
                1,
                "result",
                json!({
                    "browserTab":{"title":"safe"},
                    "privatePayload":{"secret":true}
                }),
            ),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            first,
            CanonicalSessionChange::ToolActivity {
                phase: ToolActivityPhase::Completed,
                output,
                details: Some(details),
                ..
            } if output.is_none() && details == json!({"browserTab":{"title":"safe"}})
        ));

        let second = produced_change(reducer.reduce(
            tool_event(2, "update"),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            second,
            CanonicalSessionChange::ToolActivity {
                phase: ToolActivityPhase::Updated,
                details: Some(details),
                ..
            } if details == json!({"browserTab":{"title":"safe"}})
        ));
    }

    #[test]
    fn approval_request_deduplicates_by_approval_id() {
        let mut reducer = SessionReducerActor::new(session_key());

        let requested = produced_change(reducer.reduce(
            approval_event(1),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            requested,
            CanonicalSessionChange::ApprovalRequested { approval_id, option_ids, .. }
                if approval_id.as_str() == "approval-1" && option_ids.len() == 2
        ));
        assert!(
            reducer
                .reduce(approval_event(2), Some(epoch()), Some("route-1".to_owned()))
                .is_none()
        );
    }

    #[test]
    fn runtime_streams_project_status_without_chat_status_compaction() {
        let mut reducer = SessionReducerActor::new(session_key());

        let compacting = produced_change(reducer.reduce(
            agent_stream_event(1, "compaction", json!({ "phase": "start" })),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            compacting,
            CanonicalSessionChange::RuntimeActivity {
                activity: CanonicalRuntimeActivity::Compacting,
                ..
            }
        ));

        let cleanup = produced_change(reducer.reduce(
            agent_stream_event(
                2,
                "compaction",
                json!({ "phase": "end", "completed": true }),
            ),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            cleanup,
            CanonicalSessionChange::RuntimeActivityCleared {
                retrying_cleanup: false,
                ..
            }
        ));

        let fallback = produced_change(reducer.reduce(
            agent_stream_event(3, "lifecycle", json!({ "phase": "fallback", "reasonSummary": "rate limit", "providerErrorType": "overloaded", "httpStatus": 429 })),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            fallback,
            CanonicalSessionChange::RuntimeFallback { detail, .. }
                if detail.failover_reason.as_deref() == Some("rate limit")
                    && detail.provider_error_type.as_deref() == Some("overloaded")
                    && detail.http_status == Some(429)
        ));

        let fallback_cleared = produced_change(reducer.reduce(
            agent_stream_event(4, "lifecycle", json!({ "phase": "fallback_cleared" })),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            fallback_cleared,
            CanonicalSessionChange::RuntimeFallbackCleared { .. }
        ));

        let guardian = produced_change(reducer.reduce(
            agent_stream_event(
                5,
                "codex_app_server.guardian",
                json!({ "phase": "warning", "riskLevel": "medium" }),
            ),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            guardian,
            CanonicalSessionChange::GuardianNotice { notice, .. }
                if notice.phase == crate::session::protocol::RuntimeGuardianPhase::Warning
                    && notice.risk_level.as_deref() == Some("medium")
        ));
    }

    #[test]
    fn lifecycle_end_only_clears_active_compaction_retry_cleanup() {
        let mut reducer = SessionReducerActor::new(session_key());

        assert!(
            reducer
                .reduce(
                    agent_stream_event(1, "lifecycle", json!({ "phase": "end" })),
                    Some(epoch()),
                    Some("route-1".to_owned())
                )
                .is_none()
        );

        let compacting = produced_change(reducer.reduce(
            agent_stream_event(2, "compaction", json!({ "phase": "start" })),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            compacting,
            CanonicalSessionChange::RuntimeActivity { .. }
        ));

        let cleanup = produced_change(reducer.reduce(
            agent_stream_event(3, "lifecycle", json!({ "phase": "end" })),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            cleanup,
            CanonicalSessionChange::RuntimeActivityCleared {
                retrying_cleanup: true,
                ..
            }
        ));
    }

    #[test]
    fn terminal_closes_active_run() {
        let mut reducer = SessionReducerActor::new(session_key());
        assert!(
            reducer
                .reduce(
                    chat_snapshot(1, "hello"),
                    Some(epoch()),
                    Some("route-1".to_owned())
                )
                .is_some()
        );
        assert!(reducer.active_run.is_some());

        let terminal = produced_change(reducer.reduce(
            terminal_chat(2),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));
        assert!(matches!(
            terminal,
            CanonicalSessionChange::Terminal {
                outcome: TerminalOutcome::Completed,
                ..
            }
        ));
        assert!(reducer.active_run.is_none());
    }

    #[test]
    fn terminal_error_preserves_native_error_summary() {
        let mut reducer = SessionReducerActor::new(session_key());
        let terminal = produced_change(reducer.reduce(
            terminal_error_chat(1),
            Some(epoch()),
            Some("route-1".to_owned()),
        ));

        assert!(matches!(
            terminal,
            CanonicalSessionChange::Terminal {
                outcome: TerminalOutcome::Error,
                error_kind: Some(crate::session::protocol::SessionErrorKind::RateLimit),
                error_message: Some(error_message),
                stop_reason: Some(stop_reason),
                error_detail: None,
                ..
            } if error_message == "provider overloaded" && stop_reason == "gateway_error"
        ));
        assert!(reducer.active_run.is_none());
    }
}
