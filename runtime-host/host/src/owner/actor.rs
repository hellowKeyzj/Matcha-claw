use matcha_agent::{
    peer::{
        RendererApprovalPhase, RendererEvent, RendererMessageLifecycle, RendererRunPhase,
        RendererToolPhase, SessionSubscriptionItem,
    },
    session::recovery::RecoveryReason as MatchaRecoveryReason,
};
use openclaw::{
    port::CanonicalIngressResult,
    session::projection::{AssistantTurnChunkKind, AssistantTurnSegment, CanonicalSessionChange},
};
use tokio::sync::mpsc;

use crate::{
    Host, HostPhase,
    composition::{HostEvent, HostEvents},
    sessions::{
        command::{SessionEvent, SessionIngestOutcome},
        matcha::matcha_event_changes,
        openclaw::openclaw_canonical_changes,
        state::{
            RecoveryReason, SessionChange, SessionContent, SessionIdentity, SessionItem,
            SessionProvider, SessionSourceBinding,
        },
    },
    transport::session_trace,
};

use super::{ActorExit, HostStatePublisher, ShutdownAttempt, ShutdownRequest};

#[derive(Default)]
struct OpenClawChangeTrace {
    assistant_turn_chunk_count: usize,
    assistant_turn_snapshot_count: usize,
    tool_activity_count: usize,
    runtime_activity_count: usize,
    terminal_count: usize,
    approval_requested_count: usize,
    approval_resolved_count: usize,
    recovery_required_count: usize,
    transcript_message_count: usize,
    assistant_text_length: usize,
    assistant_thinking_length: usize,
    assistant_segment_count: usize,
    assistant_text_segment_count: usize,
    assistant_text_segment_length: usize,
    assistant_thinking_segment_count: usize,
    assistant_tool_segment_count: usize,
}

impl OpenClawChangeTrace {
    fn observe(&mut self, change: &CanonicalSessionChange) {
        match change {
            CanonicalSessionChange::AssistantTurnChunk { kind, text, .. } => {
                self.assistant_turn_chunk_count += 1;
                self.assistant_segment_count += 1;
                match kind {
                    AssistantTurnChunkKind::Text => {
                        self.assistant_text_length += text.len();
                        self.assistant_text_segment_count += 1;
                        self.assistant_text_segment_length += text.len();
                    }
                    AssistantTurnChunkKind::Thinking => {
                        self.assistant_thinking_length += text.len();
                        self.assistant_thinking_segment_count += 1;
                    }
                }
            }
            CanonicalSessionChange::AssistantTurnSnapshot { snapshot } => {
                self.assistant_turn_snapshot_count += 1;
                self.assistant_text_length += snapshot.text.len();
                self.assistant_thinking_length += snapshot.thinking.as_ref().map_or(0, String::len);
                self.assistant_segment_count += snapshot.segments.len();
                for segment in &snapshot.segments {
                    self.observe_segment(segment);
                }
            }
            CanonicalSessionChange::ToolActivity { .. } => self.tool_activity_count += 1,
            CanonicalSessionChange::RuntimeActivity { .. }
            | CanonicalSessionChange::RuntimeActivityCleared { .. }
            | CanonicalSessionChange::RuntimeFallback { .. }
            | CanonicalSessionChange::RuntimeFallbackCleared { .. }
            | CanonicalSessionChange::GuardianNotice { .. } => self.runtime_activity_count += 1,
            CanonicalSessionChange::Terminal { .. } => self.terminal_count += 1,
            CanonicalSessionChange::ApprovalRequested { .. } => self.approval_requested_count += 1,
            CanonicalSessionChange::ApprovalResolved { .. } => self.approval_resolved_count += 1,
            CanonicalSessionChange::RecoveryRequired { .. } => self.recovery_required_count += 1,
            CanonicalSessionChange::TranscriptMessage { .. } => self.transcript_message_count += 1,
        }
    }

    fn observe_segment(&mut self, segment: &AssistantTurnSegment) {
        match segment {
            AssistantTurnSegment::Text { text } => {
                self.assistant_text_segment_count += 1;
                self.assistant_text_segment_length += text.len();
            }
            AssistantTurnSegment::Thinking { .. } => self.assistant_thinking_segment_count += 1,
            AssistantTurnSegment::ToolUse { .. } | AssistantTurnSegment::ToolResult { .. } => {
                self.assistant_tool_segment_count += 1;
            }
        }
    }
}

fn openclaw_change_trace(changes: &[CanonicalSessionChange]) -> serde_json::Value {
    let mut trace = OpenClawChangeTrace::default();
    for change in changes {
        trace.observe(change);
    }
    serde_json::json!({
        "changeCount": changes.len(),
        "assistantTurnChunkCount": trace.assistant_turn_chunk_count,
        "assistantTurnSnapshotCount": trace.assistant_turn_snapshot_count,
        "toolActivityCount": trace.tool_activity_count,
        "runtimeActivityCount": trace.runtime_activity_count,
        "terminalCount": trace.terminal_count,
        "approvalRequestedCount": trace.approval_requested_count,
        "approvalResolvedCount": trace.approval_resolved_count,
        "recoveryRequiredCount": trace.recovery_required_count,
        "transcriptMessageCount": trace.transcript_message_count,
        "assistantTextLength": trace.assistant_text_length,
        "assistantThinkingLength": trace.assistant_thinking_length,
        "assistantSegmentCount": trace.assistant_segment_count,
        "assistantTextSegmentCount": trace.assistant_text_segment_count,
        "assistantTextSegmentLength": trace.assistant_text_segment_length,
        "assistantThinkingSegmentCount": trace.assistant_thinking_segment_count,
        "assistantToolSegmentCount": trace.assistant_tool_segment_count,
    })
}

#[derive(Default)]
struct SessionChangeTrace {
    message_delta_count: usize,
    message_delta_length: usize,
    message_updated_count: usize,
    tool_updated_count: usize,
    runtime_changed_count: usize,
    assistant_turn_count: usize,
    assistant_text_length: usize,
    assistant_segment_count: usize,
    assistant_text_segment_count: usize,
    assistant_text_segment_length: usize,
    assistant_thinking_segment_count: usize,
    assistant_tool_segment_count: usize,
}

impl SessionChangeTrace {
    fn observe(&mut self, change: &SessionChange) {
        match change {
            SessionChange::MessageDelta { text, .. } => {
                self.message_delta_count += 1;
                self.message_delta_length += text.len();
            }
            SessionChange::MessageUpdated { item } | SessionChange::MessageReplaced { item } => {
                self.message_updated_count += 1;
                self.observe_item(item);
            }
            SessionChange::ToolUpdated { .. } => self.tool_updated_count += 1,
            SessionChange::RuntimeChanged { .. } | SessionChange::RuntimeNoticeUpdated { .. } => {
                self.runtime_changed_count += 1;
            }
            SessionChange::RunPhaseChanged { .. }
            | SessionChange::ApprovalUpdated { .. }
            | SessionChange::WindowChanged { .. }
            | SessionChange::RecoveryRequired { .. } => {}
        }
    }

    fn observe_item(&mut self, item: &SessionItem) {
        if let SessionItem::AssistantTurn { text, segments, .. } = item {
            self.assistant_turn_count += 1;
            self.assistant_text_length += text.len();
            self.assistant_segment_count += segments.len();
            for segment in segments {
                self.observe_segment(segment);
            }
        }
    }

    fn observe_segment(&mut self, segment: &SessionContent) {
        match segment {
            SessionContent::Text { text } => {
                self.assistant_text_segment_count += 1;
                self.assistant_text_segment_length += text.len();
            }
            SessionContent::Thinking { .. } => self.assistant_thinking_segment_count += 1,
            SessionContent::ToolUse { .. } | SessionContent::ToolResult { .. } => {
                self.assistant_tool_segment_count += 1;
            }
            SessionContent::LargeText { .. }
            | SessionContent::Media { .. }
            | SessionContent::Omitted { .. } => {}
        }
    }
}

fn session_change_trace(changes: &[SessionChange]) -> serde_json::Value {
    let mut trace = SessionChangeTrace::default();
    for change in changes {
        trace.observe(change);
    }
    serde_json::json!({
        "changeCount": changes.len(),
        "changeKinds": matcha_change_kinds(changes),
        "messageDeltaCount": trace.message_delta_count,
        "messageDeltaLength": trace.message_delta_length,
        "messageUpdatedCount": trace.message_updated_count,
        "toolUpdatedCount": trace.tool_updated_count,
        "runtimeChangedCount": trace.runtime_changed_count,
        "assistantTurnCount": trace.assistant_turn_count,
        "assistantTextLength": trace.assistant_text_length,
        "assistantSegmentCount": trace.assistant_segment_count,
        "assistantTextSegmentCount": trace.assistant_text_segment_count,
        "assistantTextSegmentLength": trace.assistant_text_segment_length,
        "assistantThinkingSegmentCount": trace.assistant_thinking_segment_count,
        "assistantToolSegmentCount": trace.assistant_tool_segment_count,
    })
}

enum Next {
    Shutdown(ShutdownRequest),
    Event(Option<HostEvent>),
}

pub(super) async fn run(
    mut host: Host,
    mut events: HostEvents,
    mut shutdown: mpsc::Receiver<ShutdownRequest>,
    output: mpsc::Sender<HostEvent>,
    state: HostStatePublisher,
) -> ActorExit {
    let mut events_open = true;
    state.publish(host.state());
    loop {
        let next = next(Some(&mut events), &mut events_open, &mut shutdown).await;
        match next {
            Next::Shutdown(reply) => {
                return shutdown_after_operations(&mut host, reply, &mut shutdown).await;
            }
            Next::Event(Some(HostEvent::OpenClawCanonical(ingress))) => {
                let (session_key, binding, run_id, cursor, changes) = match ingress {
                    CanonicalIngressResult::Produced(delta) => {
                        let session_key = delta.session_key().as_str().to_owned();
                        let route_key = delta.route_key().map(str::to_owned);
                        let source_epoch = delta.source_epoch();
                        let run_id = delta.run_id().map(|id| id.as_str().to_owned());
                        let cursor = delta.source_cursor();
                        session_trace::log_unscoped(
                            "runtime.openclaw.event.received",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": route_key.as_deref(),
                                "runId": run_id.as_deref(),
                                "sourceCursor": cursor,
                                "sourceEpoch": source_epoch,
                                "canonical": openclaw_change_trace(delta.changes()),
                            }),
                        );
                        let binding =
                            SessionSourceBinding::new(session_key.clone(), route_key, source_epoch)
                                .expect("valid binding");
                        let changes = openclaw_canonical_changes(
                            delta.changes(),
                            delta.run_id().map(|id| id.as_str()),
                        );
                        session_trace::log_unscoped(
                            "runtime.openclaw.event.projected",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": binding.route_key(),
                                "runId": run_id.as_deref(),
                                "sourceCursor": cursor,
                                "sourceEpoch": source_epoch,
                                "host": session_change_trace(&changes),
                            }),
                        );
                        (session_key, binding, run_id, cursor, changes)
                    }
                    CanonicalIngressResult::Unknown { provenance } => {
                        let session_key = provenance.session_key().as_str().to_owned();
                        let route_key = provenance.route_key().map(str::to_owned);
                        let source_epoch = provenance.source_epoch();
                        let cursor = provenance.source_cursor();
                        session_trace::log_unscoped(
                            "runtime.openclaw.event.unknown",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": route_key.as_deref(),
                                "sourceCursor": cursor,
                                "sourceEpoch": source_epoch,
                            }),
                        );
                        let binding =
                            SessionSourceBinding::new(session_key.clone(), route_key, source_epoch)
                                .expect("valid binding");
                        let changes = vec![SessionChange::RecoveryRequired {
                            reason: RecoveryReason::NativeUnknown,
                        }];
                        (session_key, binding, None, cursor, changes)
                    }
                };

                let identity =
                    SessionIdentity::new(session_key.clone(), SessionProvider::OpenClaw, None)
                        .expect("valid identity");
                let event = SessionEvent {
                    binding: binding.clone(),
                    run_id: run_id.clone(),
                    cursor,
                    changes,
                };
                let outcome = host.sessions().ingest_event(identity, event).await;
                match outcome {
                    Ok(SessionIngestOutcome::Applied(delta)) => {
                        let delta_seq = delta.seq;
                        let delta_cursor = delta.cursor;
                        let delta_trace = session_change_trace(&delta.changes);
                        let published = host.publish_session_delta(delta);
                        session_trace::log_unscoped(
                            "runtime.openclaw.event.published",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": binding.route_key(),
                                "runId": run_id.as_deref(),
                                "sourceCursor": cursor,
                                "sourceEpoch": binding.source_epoch(),
                                "deltaSeq": delta_seq,
                                "deltaCursor": delta_cursor,
                                "host": delta_trace,
                                "published": published,
                            }),
                        );
                        if !published {
                            return host.shutdown().await.map(|_| ());
                        }
                    }
                    Ok(SessionIngestOutcome::Duplicate { cursor }) => session_trace::log_unscoped(
                        "runtime.openclaw.event.ingest-dropped",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": binding.route_key(),
                            "runId": run_id.as_deref(),
                            "sourceCursor": cursor,
                            "sourceEpoch": binding.source_epoch(),
                            "reason": "duplicate",
                        }),
                    ),
                    Ok(SessionIngestOutcome::Stale { cursor, received }) => {
                        session_trace::log_unscoped(
                            "runtime.openclaw.event.ingest-dropped",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": binding.route_key(),
                                "runId": run_id.as_deref(),
                                "sourceCursor": cursor,
                                "receivedCursor": received,
                                "sourceEpoch": binding.source_epoch(),
                                "reason": "stale",
                            }),
                        )
                    }
                    Ok(SessionIngestOutcome::Gap { expected, received }) => {
                        session_trace::log_unscoped(
                            "runtime.openclaw.event.ingest-dropped",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": binding.route_key(),
                                "runId": run_id.as_deref(),
                                "expectedCursor": expected,
                                "receivedCursor": received,
                                "sourceEpoch": binding.source_epoch(),
                                "reason": "gap",
                            }),
                        )
                    }
                    Ok(SessionIngestOutcome::Rejected { reason }) => session_trace::log_unscoped(
                        "runtime.openclaw.event.ingest-dropped",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": binding.route_key(),
                            "runId": run_id.as_deref(),
                            "sourceCursor": cursor,
                            "sourceEpoch": binding.source_epoch(),
                            "reason": reason,
                        }),
                    ),
                    Ok(SessionIngestOutcome::RuntimeNotFound) => session_trace::log_unscoped(
                        "runtime.openclaw.event.ingest-dropped",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": binding.route_key(),
                            "runId": run_id.as_deref(),
                            "sourceCursor": cursor,
                            "sourceEpoch": binding.source_epoch(),
                            "reason": "runtime-not-found",
                        }),
                    ),
                    Ok(SessionIngestOutcome::RuntimeNoSessionSupport) => {
                        session_trace::log_unscoped(
                            "runtime.openclaw.event.ingest-dropped",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": binding.route_key(),
                                "runId": run_id.as_deref(),
                                "sourceCursor": cursor,
                                "sourceEpoch": binding.source_epoch(),
                                "reason": "runtime-no-session-support",
                            }),
                        )
                    }
                    Err(_) => session_trace::log_unscoped(
                        "runtime.openclaw.event.ingest-error",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": binding.route_key(),
                            "runId": run_id.as_deref(),
                            "sourceCursor": cursor,
                            "sourceEpoch": binding.source_epoch(),
                        }),
                    ),
                }
            }
            Next::Event(Some(HostEvent::Matcha(SessionSubscriptionItem::Event(event)))) => {
                let route_key = event.route_key().to_owned();
                let session_key = event.session_key().to_owned();
                let source_epoch = event.source_epoch();
                let cursor = event.source_cursor();
                let run_id = event.run_id().to_owned();
                session_trace::log_unscoped(
                    "runtime.matcha.event.received",
                    serde_json::json!({
                        "sessionKey": &session_key,
                        "routeKey": &route_key,
                        "runId": &run_id,
                        "sourceCursor": cursor,
                        "sourceEpoch": source_epoch,
                        "eventKind": matcha_renderer_event_kind(event.event()),
                        "event": matcha_renderer_event_shape(event.event()),
                    }),
                );
                let changes = match matcha_event_changes(event) {
                    Some(changes) => changes,
                    None => {
                        session_trace::log_unscoped(
                            "runtime.matcha.event.ignored",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": &route_key,
                                "runId": &run_id,
                                "sourceCursor": cursor,
                                "sourceEpoch": source_epoch,
                            }),
                        );
                        continue;
                    }
                };
                let change_kinds = matcha_change_kinds(&changes);
                session_trace::log_unscoped(
                    "runtime.matcha.event.projected",
                    serde_json::json!({
                        "sessionKey": &session_key,
                        "routeKey": &route_key,
                        "runId": &run_id,
                        "sourceCursor": cursor,
                        "sourceEpoch": source_epoch,
                        "changeKinds": change_kinds,
                    }),
                );
                let Some(binding) = SessionSourceBinding::new(
                    session_key.clone(),
                    Some(route_key.clone()),
                    source_epoch,
                ) else {
                    session_trace::log_unscoped(
                        "runtime.matcha.event.binding-rejected",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": &route_key,
                            "runId": &run_id,
                            "sourceCursor": cursor,
                            "sourceEpoch": source_epoch,
                        }),
                    );
                    continue;
                };
                let identity =
                    SessionIdentity::new(session_key.clone(), SessionProvider::MatchaAgent, None)
                        .expect("valid identity");
                let event = SessionEvent {
                    binding,
                    run_id: Some(run_id.clone()),
                    cursor: Some(cursor),
                    changes,
                };
                let outcome = host.sessions().ingest_event(identity, event).await;
                match outcome {
                    Ok(SessionIngestOutcome::Applied(delta)) => {
                        let delta_seq = delta.seq;
                        let delta_cursor = delta.cursor;
                        let delta_change_kinds = matcha_change_kinds(&delta.changes);
                        let published = host.publish_session_delta(delta);
                        session_trace::log_unscoped(
                            "runtime.matcha.event.published",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": &route_key,
                                "runId": &run_id,
                                "sourceCursor": cursor,
                                "sourceEpoch": source_epoch,
                                "deltaSeq": delta_seq,
                                "deltaCursor": delta_cursor,
                                "changeKinds": delta_change_kinds,
                                "published": published,
                            }),
                        );
                    }
                    Ok(SessionIngestOutcome::Duplicate { cursor }) => session_trace::log_unscoped(
                        "runtime.matcha.event.ingest-dropped",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": &route_key,
                            "runId": &run_id,
                            "sourceCursor": cursor,
                            "sourceEpoch": source_epoch,
                            "reason": "duplicate",
                        }),
                    ),
                    Ok(SessionIngestOutcome::Stale { cursor, received }) => {
                        session_trace::log_unscoped(
                            "runtime.matcha.event.ingest-dropped",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": &route_key,
                                "runId": &run_id,
                                "sourceCursor": cursor,
                                "receivedCursor": received,
                                "sourceEpoch": source_epoch,
                                "reason": "stale",
                            }),
                        )
                    }
                    Ok(SessionIngestOutcome::Gap { expected, received }) => {
                        session_trace::log_unscoped(
                            "runtime.matcha.event.ingest-dropped",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": &route_key,
                                "runId": &run_id,
                                "expectedCursor": expected,
                                "receivedCursor": received,
                                "sourceEpoch": source_epoch,
                                "reason": "gap",
                            }),
                        )
                    }
                    Ok(SessionIngestOutcome::Rejected { reason }) => session_trace::log_unscoped(
                        "runtime.matcha.event.ingest-dropped",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": &route_key,
                            "runId": &run_id,
                            "sourceCursor": cursor,
                            "sourceEpoch": source_epoch,
                            "reason": reason,
                        }),
                    ),
                    Ok(SessionIngestOutcome::RuntimeNotFound) => session_trace::log_unscoped(
                        "runtime.matcha.event.ingest-dropped",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": &route_key,
                            "runId": &run_id,
                            "sourceCursor": cursor,
                            "sourceEpoch": source_epoch,
                            "reason": "runtime-not-found",
                        }),
                    ),
                    Ok(SessionIngestOutcome::RuntimeNoSessionSupport) => {
                        session_trace::log_unscoped(
                            "runtime.matcha.event.ingest-dropped",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": &route_key,
                                "runId": &run_id,
                                "sourceCursor": cursor,
                                "sourceEpoch": source_epoch,
                                "reason": "runtime-no-session-support",
                            }),
                        )
                    }
                    Err(_) => session_trace::log_unscoped(
                        "runtime.matcha.event.ingest-error",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": &route_key,
                            "runId": &run_id,
                            "sourceCursor": cursor,
                            "sourceEpoch": source_epoch,
                        }),
                    ),
                }
            }
            Next::Event(Some(HostEvent::Matcha(SessionSubscriptionItem::Recovery {
                route_key,
                session_key,
                run_id,
                recovery,
            }))) => {
                let source_epoch = recovery.source_epoch();
                let reason = matcha_recovery_reason_kind(recovery.reason());
                session_trace::log_unscoped(
                    "runtime.matcha.recovery.received",
                    serde_json::json!({
                        "routeKey": &route_key,
                        "runId": &run_id,
                        "sourceEpoch": source_epoch,
                        "reason": reason,
                        "hasNativeCursor": recovery.native_cursor().is_some(),
                    }),
                );
                let Some(cursor) = recovery.native_cursor() else {
                    session_trace::log_unscoped(
                        "runtime.matcha.recovery.shutdown",
                        serde_json::json!({
                            "routeKey": &route_key,
                            "sessionKey": &session_key,
                            "runId": &run_id,
                            "sourceEpoch": source_epoch,
                            "reason": "missing-native-cursor",
                        }),
                    );
                    return host.shutdown().await.map(|_| ());
                };
                let source_cursor = cursor.sequence().get();
                let Some(binding) = SessionSourceBinding::new(
                    session_key.clone(),
                    Some(route_key.clone()),
                    recovery.source_epoch(),
                ) else {
                    session_trace::log_unscoped(
                        "runtime.matcha.recovery.shutdown",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": &route_key,
                            "runId": &run_id,
                            "sourceCursor": source_cursor,
                            "sourceEpoch": source_epoch,
                            "reason": "binding-rejected",
                        }),
                    );
                    return host.shutdown().await.map(|_| ());
                };
                let identity =
                    SessionIdentity::new(session_key.clone(), SessionProvider::MatchaAgent, None)
                        .expect("valid matcha identity");
                let changes = vec![SessionChange::RecoveryRequired {
                    reason: matcha_recovery_reason(recovery.reason()),
                }];
                let event = SessionEvent {
                    binding,
                    run_id: Some(run_id.clone()),
                    cursor: Some(source_cursor),
                    changes,
                };
                let outcome = host.sessions().ingest_event(identity, event).await;
                match outcome {
                    Ok(SessionIngestOutcome::Applied(delta)) => {
                        let delta_seq = delta.seq;
                        let delta_cursor = delta.cursor;
                        let delta_change_kinds = matcha_change_kinds(&delta.changes);
                        let published = host.publish_session_delta(delta);
                        session_trace::log_unscoped(
                            "runtime.matcha.recovery.published",
                            serde_json::json!({
                                "sessionKey": &session_key,
                                "routeKey": &route_key,
                                "runId": &run_id,
                                "sourceCursor": source_cursor,
                                "sourceEpoch": source_epoch,
                                "deltaSeq": delta_seq,
                                "deltaCursor": delta_cursor,
                                "changeKinds": delta_change_kinds,
                                "published": published,
                            }),
                        );
                    }
                    Ok(SessionIngestOutcome::Rejected { reason }) => session_trace::log_unscoped(
                        "runtime.matcha.recovery.ingest-dropped",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": &route_key,
                            "runId": &run_id,
                            "sourceCursor": source_cursor,
                            "sourceEpoch": source_epoch,
                            "reason": reason,
                        }),
                    ),
                    Ok(_) => session_trace::log_unscoped(
                        "runtime.matcha.recovery.ingest-dropped",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": &route_key,
                            "runId": &run_id,
                            "sourceCursor": source_cursor,
                            "sourceEpoch": source_epoch,
                            "reason": "not-applied",
                        }),
                    ),
                    Err(_) => session_trace::log_unscoped(
                        "runtime.matcha.recovery.ingest-error",
                        serde_json::json!({
                            "sessionKey": &session_key,
                            "routeKey": &route_key,
                            "runId": &run_id,
                            "sourceCursor": source_cursor,
                            "sourceEpoch": source_epoch,
                        }),
                    ),
                }
            }
            Next::Event(Some(event @ HostEvent::OpenClawRuntime)) => {
                state.publish(host.state());
                if output.send(event).await.is_err() {
                    return host.shutdown().await.map(|_| ());
                }
            }
            Next::Event(Some(event)) => {
                if output.send(event).await.is_err() {
                    return host.shutdown().await.map(|_| ());
                }
            }
            Next::Event(None) => events_open = false,
        }
    }
}

async fn next(
    mut events: Option<&mut HostEvents>,
    events_open: &mut bool,
    shutdown: &mut mpsc::Receiver<ShutdownRequest>,
) -> Next {
    tokio::select! {
        biased;
        Some(reply) = shutdown.recv() => Next::Shutdown(reply),
        event = wait_for_events(&mut events), if *events_open => Next::Event(event),
    }
}

async fn wait_for_events(events: &mut Option<&mut HostEvents>) -> Option<HostEvent> {
    match events.as_deref_mut() {
        Some(events) => events.next().await,
        None => std::future::pending().await,
    }
}

fn matcha_recovery_reason(reason: &MatchaRecoveryReason) -> RecoveryReason {
    match reason {
        MatchaRecoveryReason::CursorGap { .. } => RecoveryReason::CursorGap,
        MatchaRecoveryReason::CursorStale { .. } => RecoveryReason::CursorStale,
        MatchaRecoveryReason::EventOverflow | MatchaRecoveryReason::BroadcastLagged { .. } => {
            RecoveryReason::EventOverflow
        }
        MatchaRecoveryReason::ConnectionClosed { .. } | MatchaRecoveryReason::Restart => {
            RecoveryReason::NativeUnavailable
        }
        MatchaRecoveryReason::ReplayBoundary { .. }
        | MatchaRecoveryReason::ProjectionRejected { .. } => RecoveryReason::NativeUnknown,
    }
}

fn matcha_recovery_reason_kind(reason: &MatchaRecoveryReason) -> &'static str {
    match reason {
        MatchaRecoveryReason::CursorGap { .. } => "cursor-gap",
        MatchaRecoveryReason::CursorStale { .. } => "cursor-stale",
        MatchaRecoveryReason::EventOverflow => "event-overflow",
        MatchaRecoveryReason::BroadcastLagged { .. } => "broadcast-lagged",
        MatchaRecoveryReason::ConnectionClosed { .. } => "connection-closed",
        MatchaRecoveryReason::Restart => "restart",
        MatchaRecoveryReason::ReplayBoundary { .. } => "replay-boundary",
        MatchaRecoveryReason::ProjectionRejected { .. } => "projection-rejected",
    }
}

fn matcha_renderer_event_kind(event: &RendererEvent) -> &'static str {
    match event {
        RendererEvent::Run { .. } => "run",
        RendererEvent::Message { .. } => "message",
        RendererEvent::Tool { .. } => "tool",
        RendererEvent::Approval { .. } => "approval",
    }
}

fn matcha_renderer_event_shape(event: &RendererEvent) -> serde_json::Value {
    match event {
        RendererEvent::Run { sequence, phase } => serde_json::json!({
            "sequence": sequence,
            "phase": matcha_run_phase(*phase),
        }),
        RendererEvent::Message {
            sequence,
            message_id,
            lifecycle,
            text_delta,
            thinking_delta,
            message_text,
            thinking_text,
        } => serde_json::json!({
            "sequence": sequence,
            "messageId": message_id,
            "lifecycle": matcha_message_lifecycle(*lifecycle),
            "hasTextDelta": text_delta.is_some(),
            "textDeltaLength": text_delta.as_ref().map_or(0, String::len),
            "hasThinkingDelta": thinking_delta.is_some(),
            "thinkingDeltaLength": thinking_delta.as_ref().map_or(0, String::len),
            "hasMessageText": message_text.is_some(),
            "messageTextLength": message_text.as_ref().map_or(0, String::len),
            "hasThinkingText": thinking_text.is_some(),
            "thinkingTextLength": thinking_text.as_ref().map_or(0, String::len),
        }),
        RendererEvent::Tool {
            sequence,
            tool_call_id,
            name,
            phase,
            input,
            input_text,
            summary,
            output,
            is_error,
        } => serde_json::json!({
            "sequence": sequence,
            "toolCallId": tool_call_id,
            "hasName": name.is_some(),
            "phase": matcha_tool_phase(*phase),
            "hasInput": input.is_some(),
            "inputTextLength": input_text.as_ref().map_or(0, String::len),
            "hasSummary": summary.is_some(),
            "summaryLength": summary.as_ref().map_or(0, String::len),
            "hasOutput": output.is_some(),
            "isError": is_error,
        }),
        RendererEvent::Approval {
            sequence,
            approval_id,
            phase,
            option_ids,
        } => serde_json::json!({
            "sequence": sequence,
            "approvalId": approval_id,
            "phase": matcha_approval_phase(*phase),
            "optionCount": option_ids.len(),
        }),
    }
}

fn matcha_run_phase(phase: RendererRunPhase) -> &'static str {
    match phase {
        RendererRunPhase::Started => "started",
        RendererRunPhase::WaitingForApproval => "waiting-for-approval",
        RendererRunPhase::CancellationRequested => "cancellation-requested",
        RendererRunPhase::Completed => "completed",
        RendererRunPhase::Cancelled => "cancelled",
        RendererRunPhase::Failed => "failed",
        RendererRunPhase::Interrupted => "interrupted",
    }
}

fn matcha_message_lifecycle(lifecycle: RendererMessageLifecycle) -> &'static str {
    match lifecycle {
        RendererMessageLifecycle::Started => "started",
        RendererMessageLifecycle::Delta => "delta",
        RendererMessageLifecycle::Completed => "completed",
    }
}

fn matcha_tool_phase(phase: RendererToolPhase) -> &'static str {
    match phase {
        RendererToolPhase::Started => "started",
        RendererToolPhase::Updated => "updated",
        RendererToolPhase::Completed => "completed",
        RendererToolPhase::Failed => "failed",
    }
}

fn matcha_approval_phase(phase: RendererApprovalPhase) -> &'static str {
    match phase {
        RendererApprovalPhase::Requested => "requested",
        RendererApprovalPhase::Resolved => "resolved",
    }
}

fn matcha_change_kinds(changes: &[SessionChange]) -> Vec<&'static str> {
    changes
        .iter()
        .map(|change| match change {
            SessionChange::RunPhaseChanged { .. } => "runPhaseChanged",
            SessionChange::MessageDelta { .. } => "messageDelta",
            SessionChange::MessageUpdated { .. } => "messageUpdated",
            SessionChange::MessageReplaced { .. } => "messageReplaced",
            SessionChange::ToolUpdated { .. } => "toolUpdated",
            SessionChange::ApprovalUpdated { .. } => "approvalUpdated",
            SessionChange::RuntimeChanged { .. } => "runtimeChanged",
            SessionChange::RuntimeNoticeUpdated { .. } => "runtimeNoticeUpdated",
            SessionChange::WindowChanged { .. } => "windowChanged",
            SessionChange::RecoveryRequired { .. } => "recoveryRequired",
        })
        .collect()
}

async fn shutdown_after_operations(
    host: &mut Host,
    reply: ShutdownRequest,
    shutdown: &mut mpsc::Receiver<ShutdownRequest>,
) -> ActorExit {
    if let Some(exit) = shutdown_host(host, reply).await {
        return exit;
    }
    retry_shutdown(host, shutdown).await
}

async fn retry_shutdown(
    host: &mut Host,
    shutdown: &mut mpsc::Receiver<ShutdownRequest>,
) -> ActorExit {
    while let Some(reply) = shutdown.recv().await {
        if let Some(exit) = shutdown_host(host, reply).await {
            return exit;
        }
    }
    host.shutdown().await.map(|_| ())
}

async fn shutdown_host(host: &mut Host, reply: ShutdownRequest) -> Option<ActorExit> {
    let result = host.shutdown().await;
    let terminal = host.admission_state().phase() == HostPhase::ShutDown;
    let _ = reply.send(ShutdownAttempt {
        result: result.clone(),
        terminal,
    });
    terminal.then(|| result.map(|_| ()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn session_ingest_rejection_does_not_shutdown_host() {
        let source = include_str!("actor.rs");
        let openclaw_branch = source
            .split_once("Next::Event(Some(HostEvent::OpenClawCanonical(ingress)))")
            .and_then(|(_, source)| source.split_once("Next::Event(Some(HostEvent::Matcha("))
            .map(|(branch, _)| branch)
            .expect("actor must retain the OpenClaw canonical event branch");
        let recovery_branch = source
            .split_once("Next::Event(Some(HostEvent::Matcha(SessionSubscriptionItem::Recovery {")
            .and_then(|(_, source)| {
                source.split_once("Next::Event(Some(event @ HostEvent::OpenClawRuntime))")
            })
            .map(|(branch, _)| branch)
            .expect("actor must retain the Matcha recovery event branch");

        for branch in [openclaw_branch, recovery_branch] {
            assert!(branch.contains("Ok(SessionIngestOutcome::Rejected"));
            assert!(!branch.contains("Ok(SessionIngestOutcome::Rejected { .. }) => {\n                        return host.shutdown()"));
            assert!(!branch.contains("Ok(SessionIngestOutcome::Rejected { reason }) => {\n                        return host.shutdown()"));
        }
    }

    #[test]
    fn openclaw_canonical_run_id_reaches_session_ingest() {
        let source = include_str!("actor.rs");
        let openclaw_branch = source
            .split_once("Next::Event(Some(HostEvent::OpenClawCanonical(ingress)))")
            .and_then(|(_, source)| source.split_once("Next::Event(Some(HostEvent::Matcha("))
            .map(|(branch, _)| branch)
            .expect("actor must retain the OpenClaw canonical event branch");

        assert!(
            openclaw_branch
                .contains("let run_id = delta.run_id().map(|id| id.as_str().to_owned());")
        );
        assert!(openclaw_branch.contains("run_id,"));
        assert!(!openclaw_branch.contains("run_id: None,"));
    }

    #[test]
    fn root_actor_keeps_teamrun_coordinator_state_out() {
        let source = include_str!("actor.rs");

        for removed in [
            concat!("Terminal", "Watches"),
            concat!("Delivery", "Reconciliation", "State"),
            concat!("Delivery", "Reconciliation", "Work"),
            concat!("Delivery", "Reconciliation", "Completion"),
            concat!("Team", "Trigger", "Cron"),
            concat!("Cron", "Tick"),
            concat!("Peer", "Maintenance", "Request"),
            concat!("reconcile", "_team", "_run", "_deliveries"),
            concat!("reconcile", "_team", "_trigger", "_cron"),
            concat!("schedule", "_ready", "_nodes", "("),
            concat!("pending", "_delivery", "_ids", "("),
            concat!("terminal", "_observation", "_deliveries", "("),
            concat!("claim", "_openclaw", "_delivery", "("),
            concat!("claim", "_matcha", "_delivery", "("),
            concat!("settle", "_openclaw", "_delivery", "("),
            concat!("settle", "_matcha", "_delivery", "("),
            concat!("observe", "_matcha", "_terminal", "("),
        ] {
            assert!(
                !source.contains(removed),
                "root actor retains TeamRun coordinator residue: {removed}"
            );
        }
    }
}
