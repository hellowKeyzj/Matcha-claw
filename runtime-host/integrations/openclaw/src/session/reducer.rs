use std::{collections::HashMap, collections::hash_map::Entry};

use serde_json::Value;

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
        SessionApprovalLifecycle, SessionEventEnvelope, SessionEventKind, SessionKey,
        ToolActivityPhase, ToolId,
    },
};

fn trace_reducer_event(
    event: &SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,
    route_key: Option<&str>,
) {
    if !super::trace::enabled() {
        return;
    }
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
                    "hasRouteKey": route_key.is_some(),
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
                        "hasRouteKey": route_key.is_some(),
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
                    "hasRouteKey": route_key.is_some(),
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
                    "hasRouteKey": route_key.is_some(),
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
                    "hasRouteKey": route_key.is_some(),
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
}

impl CanonicalChangeDebugSummary {
    fn observe(&mut self, change: &CanonicalSessionChange) {
        match change {
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
    super::trace::log_unscoped(
        "runtime.openclaw.reducer.projected",
        serde_json::json!({
            "reducerStage": stage,
            "changeCount": changes.len(),
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
}

impl SessionReducerActor {
    pub(crate) fn new(session_key: SessionKey) -> Self {
        Self {
            session_key,
            active_run: None,
            approvals: HashMap::new(),
        }
    }

    pub(crate) fn reduce(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
    ) -> Option<CanonicalIngressResult> {
        if event.session_key != self.session_key {
            return None;
        }
        trace_reducer_event(&event, source_epoch, route_key.as_deref());

        match event.kind {
            SessionEventKind::Chat => self.reduce_chat(event, source_epoch, route_key),
            SessionEventKind::Message => {
                self.reduce_message_activity(event, source_epoch, route_key)
            }
            SessionEventKind::Tool | SessionEventKind::Agent => {
                self.reduce_tool_activity(event, source_epoch, route_key)
            }
            SessionEventKind::ApprovalRequested | SessionEventKind::ApprovalResolved => {
                self.reduce_approval(event, source_epoch, route_key)
            }
            SessionEventKind::Changed => None,
        }
    }

    pub(crate) fn recover(
        &mut self,
        source_epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
        reason: CanonicalRecoveryReason,
    ) -> CanonicalIngressResult {
        self.active_run = None;
        CanonicalIngressResult::Produced(CanonicalSessionDeltaProducer::recovery(
            self.session_key.clone(),
            route_key,
            source_epoch,
            reason,
        ))
    }

    pub(crate) fn recover_replay(
        &mut self,
        source_epoch: Option<u64>,
        source_cursor: u64,
        route_key: Option<String>,
    ) -> CanonicalIngressResult {
        self.active_run = None;
        CanonicalIngressResult::from_replay_recovery(
            self.session_key.clone(),
            source_epoch,
            source_cursor,
            route_key,
        )
    }

    fn reduce_chat(
        &mut self,
        mut event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
    ) -> Option<CanonicalIngressResult> {
        let chat = event.chat.as_ref()?;
        if event.run_id.as_ref() != Some(&chat.run_id) || event.session_key != chat.session_key {
            return None;
        }

        match chat.state {
            ChatState::Status => self.reduce_chat_status(event, source_epoch, route_key),
            ChatState::Delta => self.reduce_chat_delta(event, source_epoch, route_key),
            state => {
                let run_id = chat.run_id.clone();
                let message_id = native_message_id(&event);
                let terminal_snapshot = chat.message_text.clone();
                let terminal_thinking = chat.message_thinking.clone();
                let snapshot = if terminal_snapshot.is_some() || terminal_thinking.is_some() {
                    Some(
                        self.active_run_for(run_id.clone())
                            .record_assistant_snapshot(
                                message_id.clone(),
                                terminal_snapshot.as_deref(),
                                terminal_thinking.as_deref(),
                            ),
                    )
                } else {
                    None
                };
                let assistant_changes = snapshot
                    .map(|snapshot| {
                        self.assistant_snapshot_changes(
                            run_id.clone(),
                            message_id.clone(),
                            snapshot,
                        )
                    })
                    .unwrap_or_default();

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
                        route_key,
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
        route_key: Option<String>,
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
            route_key,
            vec![CanonicalSessionChange::RunProgress { run_id, progress }],
        )
    }

    fn reduce_chat_delta(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
    ) -> Option<CanonicalIngressResult> {
        let chat = event.chat.as_ref()?;
        let run_id = chat.run_id.clone();
        let message_id = native_message_id(&event);

        if chat.message_text.is_some() || chat.message_thinking.is_some() {
            let snapshot = self
                .active_run_for(run_id.clone())
                .record_assistant_snapshot(
                    message_id.clone(),
                    chat.message_text.as_deref(),
                    chat.message_thinking.as_deref(),
                );
            let changes = self.assistant_snapshot_changes(run_id.clone(), message_id, snapshot);
            if changes.is_empty() {
                return None;
            }
            return produce_changes_debugged(
                "chat_snapshot",
                event,
                source_epoch,
                route_key,
                changes,
            );
        }

        if let Some(delta_text) = chat.delta_text.as_deref() {
            let delta = self.active_run_for(run_id.clone()).record_streamed_text(
                message_id.clone(),
                delta_text,
                chat.replace,
            );
            let change = self.assistant_text_delta_change(run_id.clone(), message_id, delta)?;
            return produce_changes_debugged(
                "chat_delta_text",
                event,
                source_epoch,
                route_key,
                vec![change],
            );
        }
        produce_debugged("chat_passthrough", event, source_epoch, route_key)
    }

    fn reduce_message_activity(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
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
        let message_id = message_id.clone();
        let lifecycle = *lifecycle;
        let snapshot_text = text.clone();

        match lifecycle {
            MessageActivityLifecycle::Started => {
                self.active_run_for(run_id)
                    .observe_assistant_message(Some(message_id));
            }
            MessageActivityLifecycle::Delta => {
                let snapshot_text = snapshot_text?;
                let snapshot = self
                    .active_run_for(run_id.clone())
                    .record_assistant_snapshot(
                        Some(message_id.clone()),
                        Some(&snapshot_text),
                        None,
                    );
                let changes = self.assistant_snapshot_changes(run_id, Some(message_id), snapshot);
                if changes.is_empty() {
                    return None;
                }
                return produce_changes_debugged(
                    "message_delta",
                    event,
                    source_epoch,
                    route_key,
                    changes,
                );
            }
            MessageActivityLifecycle::Completed => {}
        }

        produce_debugged(
            "message_activity_passthrough",
            event,
            source_epoch,
            route_key,
        )
    }

    fn reduce_agent_activity(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
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
        let snapshot = self
            .active_run_for(run_id.clone())
            .record_assistant_snapshot(None, None, Some(text));
        let changes = self.assistant_snapshot_changes(run_id, native_message_id(&event), snapshot);
        if changes.is_empty() {
            return None;
        }
        produce_changes_debugged("agent_thinking", event, source_epoch, route_key, changes)
    }

    fn reduce_runtime_activity(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
    ) -> Option<CanonicalIngressResult> {
        let activity = event.activity.as_ref()?;
        if activity.session_key != self.session_key
            || event.run_id.as_ref() != Some(&activity.run_id)
        {
            return None;
        }
        match activity.kind() {
            SessionActivityKind::Thinking { .. } => {
                self.reduce_agent_activity(event, source_epoch, route_key)
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
                    let active = self.active_run_for(activity.run_id.clone());
                    if matches!(phase, RuntimeActivityPhase::Started) {
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
                    route_key,
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
                    route_key,
                    vec![CanonicalSessionChange::RuntimeFallback { run_id, detail }],
                )
            }
            SessionActivityKind::FallbackCleared => {
                let run_id = activity.run_id.clone();
                produce_changes_debugged(
                    "runtime_fallback_cleared",
                    event,
                    source_epoch,
                    route_key,
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
                    route_key,
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
        route_key: Option<String>,
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
            return self.reduce_runtime_activity(event, source_epoch, route_key);
        };
        let observation = ToolActivityObservation {
            tool_id: tool_id.clone(),
            tool_name: tool_name.clone(),
            phase: *phase,
            input: activity.input().cloned(),
            input_text: activity.input_text().map(str::to_owned),
            summary: summary.clone(),
            output: activity.output().cloned(),
            details: activity.details().cloned(),
            is_error: activity.is_error(),
        };
        let run_id = activity.run_id.clone();
        let projected_tool = self
            .active_run_for(run_id.clone())
            .observe_tool_activity(observation)?;
        let change = projected_tool.as_change(run_id, tool_id.clone());
        produce_changes_debugged(
            "tool_activity",
            event,
            source_epoch,
            route_key,
            vec![change],
        )
    }

    fn reduce_approval(
        &mut self,
        event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
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
        produce_debugged("approval", event, source_epoch, route_key)
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
        snapshot: AssistantSnapshotDelta,
    ) -> Vec<CanonicalSessionChange> {
        let mut changes = Vec::with_capacity(
            usize::from(snapshot.text.is_some()) + usize::from(snapshot.thinking.is_some()),
        );
        if let Some(thinking) = snapshot.thinking {
            if let Some(change) = self.assistant_thinking_delta_change(
                run_id.clone(),
                message_id.clone(),
                thinking,
                AssistantTurnStatus::Streaming,
            ) {
                changes.push(change);
            }
        }
        if let Some(text) = snapshot.text {
            if let Some(change) = self.assistant_text_delta_change(run_id, message_id, text) {
                changes.push(change);
            }
        }
        changes
    }

    fn assistant_text_delta_change(
        &self,
        run_id: RunId,
        message_id: Option<MessageId>,
        delta: TextSnapshotDelta,
    ) -> Option<CanonicalSessionChange> {
        let active = self.active_run.as_ref()?;
        let message_id = message_id.or_else(|| active.assistant_message_id.clone());
        Some(CanonicalSessionChange::AssistantTurnChunk {
            run_id,
            message_id,
            kind: AssistantTurnChunkKind::Text,
            text: delta.text,
            replace: delta.replace,
            status: AssistantTurnStatus::Streaming,
        })
    }

    fn assistant_thinking_delta_change(
        &self,
        run_id: RunId,
        message_id: Option<MessageId>,
        delta: TextSnapshotDelta,
        status: AssistantTurnStatus,
    ) -> Option<CanonicalSessionChange> {
        let active = self.active_run.as_ref()?;
        let message_id = message_id.or_else(|| active.assistant_message_id.clone());
        Some(CanonicalSessionChange::AssistantTurnChunk {
            run_id,
            message_id,
            kind: AssistantTurnChunkKind::Thinking,
            text: delta.text,
            replace: delta.replace,
            status,
        })
    }

    fn active_run_for(&mut self, run_id: RunId) -> &mut ActiveRunState {
        if !matches!(self.active_run.as_ref(), Some(active) if active.run_id == run_id) {
            self.active_run = Some(ActiveRunState::new(run_id));
        }
        self.active_run.as_mut().expect("active run was just set")
    }

    fn clear_active_run(&mut self, run_id: &RunId) {
        if matches!(self.active_run.as_ref(), Some(active) if &active.run_id == run_id) {
            self.active_run = None;
        }
    }
}

struct ActiveRunState {
    run_id: RunId,
    assistant_message_id: Option<MessageId>,
    sent_text: String,
    sent_thought: String,
    compacting: bool,
    turn_segments: Vec<OrderedAssistantTurnSegment>,
    tools: HashMap<ToolId, ToolState>,
}

impl ActiveRunState {
    fn new(run_id: RunId) -> Self {
        Self {
            run_id,
            assistant_message_id: None,
            sent_text: String::new(),
            sent_thought: String::new(),
            compacting: false,
            turn_segments: Vec::new(),
            tools: HashMap::new(),
        }
    }

    fn observe_assistant_message(&mut self, message_id: Option<MessageId>) {
        let Some(message_id) = message_id else {
            return;
        };
        if self.assistant_message_id.as_ref() == Some(&message_id) {
            return;
        }
        if self.assistant_message_id.is_some() {
            self.sent_text.clear();
            self.sent_thought.clear();
            self.compacting = false;
            self.turn_segments.clear();
        }
        self.assistant_message_id = Some(message_id);
    }

    fn record_assistant_snapshot(
        &mut self,
        message_id: Option<MessageId>,
        text_snapshot: Option<&str>,
        thinking_snapshot: Option<&str>,
    ) -> AssistantSnapshotDelta {
        self.observe_assistant_message(message_id);
        let thinking = thinking_snapshot
            .and_then(|snapshot| diff_full_snapshot(&mut self.sent_thought, snapshot));
        if let Some(delta) = thinking.as_ref() {
            self.push_thinking_segment(delta.text.as_str());
        }
        let text =
            text_snapshot.and_then(|snapshot| diff_full_snapshot(&mut self.sent_text, snapshot));
        if let Some(delta) = text.as_ref() {
            self.push_text_segment(delta.text.as_str());
        }
        AssistantSnapshotDelta { text, thinking }
    }

    fn record_streamed_text(
        &mut self,
        message_id: Option<MessageId>,
        delta_text: &str,
        replace: bool,
    ) -> TextSnapshotDelta {
        self.observe_assistant_message(message_id);
        if replace {
            self.sent_text.clear();
            self.turn_segments.clear();
        }
        let previous_snapshot_was_empty = self.sent_text.is_empty();
        self.sent_text.push_str(delta_text);
        self.push_text_segment(delta_text);
        TextSnapshotDelta {
            text: delta_text.to_owned(),
            replace,
            previous_snapshot_was_empty,
        }
    }

    fn observe_tool_activity(&mut self, observation: ToolActivityObservation) -> Option<ToolState> {
        match observation.phase {
            ToolActivityPhase::Started => {
                if self.has_tool_anchor(&observation.tool_id) {
                    return None;
                }
                self.turn_segments.push(OrderedAssistantTurnSegment::Tool {
                    tool_id: observation.tool_id.clone(),
                });
                Some(self.upsert_tool(observation).clone())
            }
            ToolActivityPhase::Updated
            | ToolActivityPhase::Completed
            | ToolActivityPhase::Failed => Some(self.upsert_tool(observation).clone()),
        }
    }

    fn upsert_tool(&mut self, observation: ToolActivityObservation) -> &ToolState {
        match self.tools.entry(observation.tool_id.clone()) {
            Entry::Occupied(mut entry) => {
                entry.get_mut().apply_observation(&observation);
                entry.into_mut()
            }
            Entry::Vacant(entry) => entry.insert(ToolState::from_observation(observation)),
        }
    }

    fn push_text_segment(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        match self.turn_segments.last_mut() {
            Some(OrderedAssistantTurnSegment::Text { text: current }) => current.push_str(text),
            Some(OrderedAssistantTurnSegment::Tool { .. })
            | Some(OrderedAssistantTurnSegment::Thinking { .. })
            | None => {
                self.turn_segments.push(OrderedAssistantTurnSegment::Text {
                    text: text.to_owned(),
                });
            }
        }
    }

    fn push_thinking_segment(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        match self.turn_segments.last_mut() {
            Some(OrderedAssistantTurnSegment::Thinking { text: current }) => current.push_str(text),
            Some(OrderedAssistantTurnSegment::Text { .. })
            | Some(OrderedAssistantTurnSegment::Tool { .. })
            | None => {
                self.turn_segments
                    .push(OrderedAssistantTurnSegment::Thinking {
                        text: text.to_owned(),
                    });
            }
        }
    }

    fn has_tool_anchor(&self, tool_id: &ToolId) -> bool {
        self.turn_segments.iter().any(|segment| {
            matches!(
                segment,
                OrderedAssistantTurnSegment::Tool { tool_id: current } if current == tool_id
            )
        })
    }
}

#[derive(Debug, Eq, PartialEq)]
enum OrderedAssistantTurnSegment {
    Text { text: String },
    Thinking { text: String },
    Tool { tool_id: ToolId },
}

struct AssistantSnapshotDelta {
    text: Option<TextSnapshotDelta>,
    thinking: Option<TextSnapshotDelta>,
}

#[derive(Debug, Eq, PartialEq)]
struct TextSnapshotDelta {
    text: String,
    replace: bool,
    previous_snapshot_was_empty: bool,
}

fn diff_full_snapshot(
    sent_snapshot: &mut String,
    source_snapshot: &str,
) -> Option<TextSnapshotDelta> {
    let sent_len = sent_snapshot.len();
    if source_snapshot.len() <= sent_len || !source_snapshot.starts_with(sent_snapshot.as_str()) {
        return None;
    }
    let delta = source_snapshot.get(sent_len..)?.to_owned();
    let previous_snapshot_was_empty = sent_snapshot.is_empty();
    sent_snapshot.clear();
    sent_snapshot.push_str(source_snapshot);
    Some(TextSnapshotDelta {
        text: delta,
        replace: false,
        previous_snapshot_was_empty,
    })
}

#[derive(Clone)]
struct ToolActivityObservation {
    tool_id: ToolId,
    tool_name: Option<String>,
    phase: ToolActivityPhase,
    input: Option<Value>,
    input_text: Option<String>,
    summary: Option<String>,
    output: Option<Value>,
    details: Option<Value>,
    is_error: Option<bool>,
}

#[derive(Clone)]
struct ToolState {
    tool_name: Option<String>,
    phase: ToolActivityPhase,
    input: Option<Value>,
    input_text: Option<String>,
    summary: Option<String>,
    output: Option<Value>,
    details: Option<Value>,
    is_error: Option<bool>,
}

impl ToolState {
    fn from_observation(observation: ToolActivityObservation) -> Self {
        Self {
            tool_name: observation.tool_name,
            phase: observation.phase,
            input: observation.input,
            input_text: observation.input_text,
            summary: observation.summary,
            output: observation.output,
            details: observation.details,
            is_error: observation.is_error,
        }
    }

    fn apply_observation(&mut self, observation: &ToolActivityObservation) {
        self.phase = observation.phase;
        if observation.tool_name.is_some() {
            self.tool_name = observation.tool_name.clone();
        }
        if observation.input.is_some() {
            self.input = observation.input.clone();
        }
        if observation.input_text.is_some() {
            self.input_text = observation.input_text.clone();
        }
        if observation.summary.is_some() {
            self.summary = observation.summary.clone();
        }
        if observation.output.is_some() {
            self.output = observation.output.clone();
        }
        if observation.details.is_some() {
            self.details = observation.details.clone();
        }
        if observation.is_error.is_some() {
            self.is_error = observation.is_error;
        }
    }

    fn as_change(&self, run_id: RunId, tool_id: ToolId) -> CanonicalSessionChange {
        CanonicalSessionChange::ToolActivity {
            run_id,
            tool_id,
            tool_name: self.tool_name.clone(),
            phase: self.phase,
            input: self.input.clone(),
            input_text: self.input_text.clone(),
            summary: self.summary.clone(),
            output: self.output.clone(),
            details: self.details.clone(),
            is_error: self.is_error,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ApprovalState {
    Requested,
    Resolved,
}

fn produce(
    event: SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,
    route_key: Option<String>,
) -> Option<CanonicalIngressResult> {
    CanonicalSessionDeltaProducer::from_native_event(&event, source_epoch, route_key)
        .map(CanonicalIngressResult::Produced)
}

fn produce_debugged(
    stage: &'static str,
    event: SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,
    route_key: Option<String>,
) -> Option<CanonicalIngressResult> {
    let result = produce(event, source_epoch, route_key);
    if let Some(CanonicalIngressResult::Produced(delta)) = result.as_ref() {
        trace_canonical_changes(stage, delta.changes());
    }
    result
}

fn produce_changes(
    event: SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,
    route_key: Option<String>,
    changes: Vec<CanonicalSessionChange>,
) -> Option<CanonicalIngressResult> {
    CanonicalSessionDeltaProducer::from_native_changes(&event, source_epoch, route_key, changes)
        .map(CanonicalIngressResult::Produced)
}

fn produce_changes_debugged(
    stage: &'static str,
    event: SessionEventEnvelope,
    source_epoch: Option<GatewayEpoch>,
    route_key: Option<String>,
    changes: Vec<CanonicalSessionChange>,
) -> Option<CanonicalIngressResult> {
    trace_canonical_changes(stage, &changes);
    produce_changes(event, source_epoch, route_key, changes)
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
