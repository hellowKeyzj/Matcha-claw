use crate::{
    peer::{
        RendererApprovalPhase, RendererEvent, RendererEventEnvelope, RendererMessageLifecycle,
        RendererRunPhase, RendererToolPhase, SessionSubscriptionItem,
    },
    session::recovery::RecoveryReason as MatchaRecoveryReason,
};
use sessions_module::{
    command::{SessionEvent, SessionIngressEvent},
    state::{
        ApprovalPhase, ApprovalView, ItemStatus, RecoveryReason, RunPhase, SessionChange,
        SessionContent, SessionEventBinding, SessionIdentity, SessionItem, SessionProvider,
        ToolPhase, ToolView,
    },
};

pub fn matcha_session_event(item: SessionSubscriptionItem) -> Option<SessionIngressEvent> {
    match item {
        SessionSubscriptionItem::Event(event) => matcha_renderer_event(event),
        SessionSubscriptionItem::Recovery {
            route_key,
            session_key,
            run_id,
            recovery,
        } => matcha_recovery_event(route_key, session_key, run_id, recovery),
    }
}

fn matcha_renderer_event(event: RendererEventEnvelope) -> Option<SessionIngressEvent> {
    let route_key = event.route_key().to_owned();
    let session_key = event.session_key().to_owned();
    let run_id = event.run_id().to_owned();
    let cursor = event.source_cursor();
    let source_epoch = event.source_epoch();
    let changes = matcha_event_changes(event)?;
    let binding = SessionEventBinding::new(session_key.clone(), Some(route_key), source_epoch)?;
    let identity = SessionIdentity::new(session_key, SessionProvider::MatchaAgent, None)?;
    Some(SessionIngressEvent::new(
        identity,
        SessionEvent {
            binding,
            run_id: Some(run_id),
            cursor: Some(cursor),
            changes,
        },
    ))
}

fn matcha_recovery_event(
    route_key: String,
    session_key: String,
    run_id: String,
    recovery: crate::session::recovery::SessionRecovery,
) -> Option<SessionIngressEvent> {
    let cursor = recovery.native_cursor()?;
    let binding = SessionEventBinding::new(
        session_key.clone(),
        Some(route_key),
        recovery.source_epoch(),
    )?;
    let identity = SessionIdentity::new(session_key, SessionProvider::MatchaAgent, None)?;
    Some(SessionIngressEvent::new(
        identity,
        SessionEvent {
            binding,
            run_id: Some(run_id),
            cursor: Some(cursor.sequence().get()),
            changes: vec![SessionChange::RecoveryRequired {
                reason: matcha_recovery_reason(recovery.reason()),
            }],
        },
    ))
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

pub fn matcha_event_changes(event: RendererEventEnvelope) -> Option<Vec<SessionChange>> {
    let run_id = event.run_id().to_owned();
    let event = event.into_event();
    match event {
        RendererEvent::Run { phase, .. } => Some(vec![SessionChange::RunPhaseChanged {
            run_id,
            phase: match phase {
                RendererRunPhase::Started => RunPhase::Started,
                RendererRunPhase::WaitingForApproval => RunPhase::WaitingForApproval,
                RendererRunPhase::CancellationRequested => RunPhase::CancellationRequested,
                RendererRunPhase::Completed => RunPhase::Completed,
                RendererRunPhase::Cancelled => RunPhase::Cancelled,
                RendererRunPhase::Failed => RunPhase::Failed,
                RendererRunPhase::Interrupted => RunPhase::Interrupted,
            },
        }]),
        RendererEvent::Message {
            message_id,
            lifecycle,
            text_delta,
            thinking_delta,
            message_text,
            thinking_text,
            ..
        } => matcha_message_changes(
            run_id,
            message_id,
            lifecycle,
            text_delta,
            thinking_delta,
            message_text,
            thinking_text,
        ),
        RendererEvent::Tool {
            tool_call_id,
            name,
            phase,
            input,
            input_text,
            summary,
            output,
            is_error,
            ..
        } => Some(vec![SessionChange::ToolUpdated {
            tool: ToolView {
                tool_call_id,
                run_id: Some(run_id),
                name,
                phase: match phase {
                    RendererToolPhase::Started => ToolPhase::Started,
                    RendererToolPhase::Updated => ToolPhase::Updated,
                    RendererToolPhase::Completed => ToolPhase::Completed,
                    RendererToolPhase::Failed => ToolPhase::Failed,
                },
                input,
                input_text,
                summary,
                output,
                details: None,
                is_error,
            },
        }]),
        RendererEvent::Approval {
            approval_id,
            phase,
            option_ids,
            ..
        } => Some(vec![SessionChange::ApprovalUpdated {
            approval: ApprovalView {
                approval_id,
                run_id: Some(run_id),
                phase: match phase {
                    RendererApprovalPhase::Requested => ApprovalPhase::Requested,
                    RendererApprovalPhase::Resolved => ApprovalPhase::Resolved,
                },
                option_ids,
            },
        }]),
    }
}

fn matcha_message_changes(
    run_id: String,
    message_id: String,
    lifecycle: RendererMessageLifecycle,
    text_delta: Option<String>,
    thinking_delta: Option<String>,
    message_text: Option<String>,
    thinking_text: Option<String>,
) -> Option<Vec<SessionChange>> {
    let status = match lifecycle {
        RendererMessageLifecycle::Started | RendererMessageLifecycle::Delta => {
            ItemStatus::Streaming
        }
        RendererMessageLifecycle::Completed => ItemStatus::Final,
    };
    if thinking_delta.is_some() || thinking_text.is_some() {
        let text = message_text.or(text_delta).unwrap_or_default();
        let thinking = thinking_text.or(thinking_delta);
        return Some(vec![SessionChange::MessageUpdated {
            item: SessionItem::AssistantTurn {
                item_id: message_id.clone(),
                run_id: Some(run_id),
                message_id: Some(message_id),
                status,
                segments: matcha_message_segments(&text, thinking),
                text,
            },
        }]);
    }
    let (text, replace) = match lifecycle {
        RendererMessageLifecycle::Started => (String::new(), false),
        RendererMessageLifecycle::Delta => match text_delta {
            Some(text) => (text, false),
            None => {
                return Some(vec![SessionChange::RecoveryRequired {
                    reason: RecoveryReason::NativeUnknown,
                }]);
            }
        },
        RendererMessageLifecycle::Completed => match message_text {
            Some(text) => (text, true),
            None => (String::new(), false),
        },
    };
    Some(vec![SessionChange::MessageDelta {
        item_id: message_id.clone(),
        run_id: Some(run_id),
        message_id: Some(message_id),
        text,
        replace,
        status,
    }])
}

fn matcha_message_segments(
    message_text: &str,
    thinking_text: Option<String>,
) -> Vec<SessionContent> {
    let mut segments = Vec::with_capacity(
        usize::from(thinking_text.is_some()) + usize::from(!message_text.is_empty()),
    );
    if let Some(thinking) = thinking_text {
        segments.push(SessionContent::Thinking { text: thinking });
    }
    if !message_text.is_empty() {
        segments.push(SessionContent::Text {
            text: message_text.to_owned(),
        });
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(event: RendererEvent) -> RendererEventEnvelope {
        RendererEventEnvelope::new(
            "route-1".to_owned(),
            "session-1".to_owned(),
            "run-1".to_owned(),
            1,
            None,
            event,
        )
    }

    #[test]
    fn plain_matcha_message_uses_delta_fast_path() {
        let changes = matcha_event_changes(envelope(RendererEvent::Message {
            sequence: 1,
            message_id: "message-1".to_owned(),
            lifecycle: RendererMessageLifecycle::Delta,
            text_delta: Some("hello".to_owned()),
            thinking_delta: None,
            message_text: Some("hello".to_owned()),
            thinking_text: None,
        }))
        .unwrap();

        assert_eq!(
            changes,
            vec![SessionChange::MessageDelta {
                item_id: "message-1".to_owned(),
                run_id: Some("run-1".to_owned()),
                message_id: Some("message-1".to_owned()),
                text: "hello".to_owned(),
                replace: false,
                status: ItemStatus::Streaming,
            }]
        );
    }

    #[test]
    fn thinking_matcha_message_projects_full_assistant_turn() {
        let changes = matcha_event_changes(envelope(RendererEvent::Message {
            sequence: 1,
            message_id: "message-1".to_owned(),
            lifecycle: RendererMessageLifecycle::Delta,
            text_delta: None,
            thinking_delta: Some("thinking".to_owned()),
            message_text: Some("answer".to_owned()),
            thinking_text: Some("thinking".to_owned()),
        }))
        .unwrap();

        assert_eq!(
            changes,
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
                            text: "answer".to_owned(),
                        },
                    ],
                    text: "answer".to_owned(),
                },
            }]
        );
    }

    #[test]
    fn tool_projection_preserves_payload_fields() {
        let changes = matcha_event_changes(envelope(RendererEvent::Tool {
            sequence: 1,
            tool_call_id: "tool-call-1".to_owned(),
            name: Some("Read".to_owned()),
            phase: RendererToolPhase::Completed,
            input: Some(json!({"file_path":"src/main.rs"})),
            input_text: Some("{\n  \"file_path\": \"src/main.rs\"\n}".to_owned()),
            summary: Some("done".to_owned()),
            output: Some(json!({"ok":true})),
            is_error: Some(false),
        }))
        .unwrap();

        assert_eq!(
            changes,
            vec![SessionChange::ToolUpdated {
                tool: ToolView {
                    tool_call_id: "tool-call-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    name: Some("Read".to_owned()),
                    phase: ToolPhase::Completed,
                    input: Some(json!({"file_path":"src/main.rs"})),
                    input_text: Some("{\n  \"file_path\": \"src/main.rs\"\n}".to_owned()),
                    summary: Some("done".to_owned()),
                    output: Some(json!({"ok":true})),
                    details: None,
                    is_error: Some(false),
                },
            }]
        );
    }
}
