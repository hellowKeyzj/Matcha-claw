use crate::session::{
    events::TerminalOutcome,
    projection::{
        AssistantTurnChunkKind, AssistantTurnSegment, AssistantTurnSnapshot, AssistantTurnStatus,
        CanonicalRunProgress, CanonicalRuntimeActivity, CanonicalSessionChange,
    },
    protocol::{ChatStatusPhase, RuntimeFallbackDetail, RuntimeGuardianNotice, ToolActivityPhase},
};

use sessions_module::{
    command::{SessionEvent, SessionIngressEvent},
    state::{
        ApprovalPhase, ApprovalView, ItemStatus, RecoveryReason, RunPhase, RunProgress,
        RunStartupPhase, RuntimeActivity, RuntimeErrorDetail, RuntimeErrorKind, RuntimeNotice,
        RuntimeNoticeKind, RuntimeView, SessionChange, SessionContent, SessionEventBinding,
        SessionItem, ToolPhase, ToolView,
    },
};

pub fn openclaw_session_event(
    ingress: &crate::port::CanonicalIngressResult,
    binding: SessionEventBinding,
) -> Option<SessionIngressEvent> {
    match ingress {
        crate::port::CanonicalIngressResult::Produced(delta) => {
            let session_key = delta.session_key().as_str().to_owned();
            if binding.session_key() != session_key || binding.source_epoch() != delta.source_epoch() {
                return None;
            }
            let identity = binding.identity().clone();
            Some(SessionIngressEvent::new(
                identity,
                SessionEvent {
                    binding,
                    run_id: None,
                    cursor: delta.source_cursor(),
                    changes: openclaw_canonical_changes(delta.changes()),
                    history_refresh: false,
                },
            ))
        }
        crate::port::CanonicalIngressResult::Unknown { provenance } => {
            let session_key = provenance.session_key().as_str().to_owned();
            if binding.session_key() != session_key || binding.source_epoch() != provenance.source_epoch() {
                return None;
            }
            let identity = binding.identity().clone();
            Some(SessionIngressEvent::new(
                identity,
                SessionEvent {
                    binding,
                    run_id: None,
                    cursor: provenance.source_cursor(),
                    changes: vec![SessionChange::RecoveryRequired {
                        reason: RecoveryReason::NativeUnknown,
                    }],
                    history_refresh: false,
                },
            ))
        }
    }
}

pub fn openclaw_canonical_changes(changes: &[CanonicalSessionChange]) -> Vec<SessionChange> {
    let mut projected = Vec::with_capacity(changes.len().saturating_mul(2));

    for change in changes {
        match change {
            CanonicalSessionChange::RunStarted { run_id } => {
                projected.push(SessionChange::RunPhaseChanged {
                    run_id: run_id.as_str().to_owned(),
                    phase: RunPhase::Started,
                });
            }
            CanonicalSessionChange::AssistantTurnChunk {
                run_id,
                message_id,
                kind: AssistantTurnChunkKind::Text,
                text,
                replace,
                status,
            } => {
                projected.push(SessionChange::MessageDelta {
                    item_id: message_item_id(
                        run_id.as_str(),
                        message_id.as_ref().map(|id| id.as_str()),
                    ),
                    run_id: Some(run_id.as_str().to_owned()),
                    message_id: message_id.as_ref().map(|id| id.as_str().to_owned()),
                    text: text.clone(),
                    replace: *replace,
                    status: assistant_status(*status),
                });
            }
            CanonicalSessionChange::AssistantTurnChunk {
                run_id,
                message_id,
                kind: AssistantTurnChunkKind::Thinking,
                text,
                replace: _,
                status,
            } => {
                projected.push(SessionChange::MessageUpdated {
                    item: assistant_thinking_chunk_item(
                        run_id,
                        message_id.as_ref(),
                        text,
                        assistant_status(*status),
                    ),
                });
            }
            CanonicalSessionChange::AssistantTurnSnapshot { snapshot } => {
                projected.push(SessionChange::MessageUpdated {
                    item: assistant_snapshot_item(snapshot),
                });
            }
            CanonicalSessionChange::ToolActivity {
                run_id,
                tool_id,
                tool_name,
                phase,
                summary,
                input,
                input_text,
                output,
                details,
                is_error,
            } => {
                projected.push(SessionChange::ToolUpdated {
                    tool: ToolView {
                        tool_call_id: crate::session::adapters::timeline::tool_call_id(Some(run_id.as_str()), tool_id.as_str()),
                        run_id: Some(run_id.as_str().to_owned()),
                        name: tool_name.clone(),
                        phase: match phase {
                            ToolActivityPhase::Started => ToolPhase::Started,
                            ToolActivityPhase::Updated => ToolPhase::Updated,
                            ToolActivityPhase::Completed => ToolPhase::Completed,
                            ToolActivityPhase::Failed => ToolPhase::Failed,
                        },
                        input: input.clone(),
                        input_text: input_text.clone(),
                        summary: summary.clone(),
                        output: output.clone(),
                        details: details.clone(),
                        is_error: (*is_error)
                            .or_else(|| matches!(phase, ToolActivityPhase::Failed).then_some(true)),
                    },
                });
            }
            CanonicalSessionChange::RuntimeActivity { run_id, activity } => {
                projected.push(SessionChange::RuntimeChanged {
                    runtime: RuntimeView {
                        phase: RunPhase::Started,
                        active_run_id: Some(run_id.as_str().to_owned()),
                        issue: None,
                        run_progress: None,
                        runtime_activity: Some(runtime_activity(*activity)),
                        error_detail: None,
                    },
                });
            }
            CanonicalSessionChange::RuntimeActivityCleared { run_id, .. } => {
                projected.push(SessionChange::RuntimeChanged {
                    runtime: RuntimeView {
                        phase: RunPhase::Started,
                        active_run_id: Some(run_id.as_str().to_owned()),
                        issue: None,
                        run_progress: None,
                        runtime_activity: None,
                        error_detail: None,
                    },
                });
            }
            CanonicalSessionChange::RunProgress { run_id, progress } => {
                projected.push(SessionChange::RuntimeChanged {
                    runtime: RuntimeView {
                        phase: RunPhase::Started,
                        active_run_id: Some(run_id.as_str().to_owned()),
                        issue: None,
                        run_progress: Some(run_progress(*progress)),
                        runtime_activity: None,
                        error_detail: None,
                    },
                });
            }
            CanonicalSessionChange::RuntimeFallback { run_id, detail } => {
                projected.push(SessionChange::RuntimeChanged {
                    runtime: RuntimeView {
                        phase: RunPhase::Started,
                        active_run_id: Some(run_id.as_str().to_owned()),
                        issue: None,
                        run_progress: None,
                        runtime_activity: None,
                        error_detail: Some(runtime_fallback_detail(detail)),
                    },
                });
            }
            CanonicalSessionChange::RuntimeFallbackCleared { run_id } => {
                projected.push(SessionChange::RuntimeChanged {
                    runtime: RuntimeView {
                        phase: RunPhase::Started,
                        active_run_id: Some(run_id.as_str().to_owned()),
                        issue: None,
                        run_progress: None,
                        runtime_activity: None,
                        error_detail: None,
                    },
                });
            }
            CanonicalSessionChange::GuardianNotice { run_id, notice } => {
                projected.push(SessionChange::RuntimeNoticeUpdated {
                    notice: runtime_guardian_notice(run_id.as_str(), notice),
                });
            }
            CanonicalSessionChange::Terminal {
                outcome,
                run_id,
                error_kind,
                error_message,
                stop_reason,
                error_detail,
                ..
            } => {
                let phase = match outcome {
                    TerminalOutcome::Completed => RunPhase::Completed,
                    TerminalOutcome::Aborted => RunPhase::Cancelled,
                    TerminalOutcome::Error => RunPhase::Failed,
                };
                let error_detail = matches!(outcome, TerminalOutcome::Error)
                    .then(|| {
                        terminal_runtime_error_detail(
                            error_detail,
                            error_message,
                            error_kind,
                            stop_reason,
                        )
                    })
                    .flatten();
                projected.push(SessionChange::RunPhaseChanged {
                    run_id: run_id.as_str().to_owned(),
                    phase,
                });
                if let Some(error_detail) = error_detail {
                    projected.push(SessionChange::RuntimeChanged {
                        runtime: RuntimeView {
                            phase,
                            active_run_id: None,
                            issue: None,
                            run_progress: None,
                            runtime_activity: None,
                            error_detail: Some(error_detail),
                        },
                    });
                }
            }
            CanonicalSessionChange::ApprovalRequested {
                run_id,
                approval_id,
                option_ids,
            } => {
                projected.push(SessionChange::ApprovalUpdated {
                    approval: ApprovalView {
                        approval_id: approval_id.as_str().to_owned(),
                        run_id: Some(run_id.as_str().to_owned()),
                        phase: ApprovalPhase::Requested,
                        option_ids: option_ids
                            .iter()
                            .map(|option_id| option_id.as_str().to_owned())
                            .collect(),
                    },
                });
            }
            CanonicalSessionChange::ApprovalResolved {
                run_id,
                approval_id,
                option_ids,
            } => {
                projected.push(SessionChange::ApprovalUpdated {
                    approval: ApprovalView {
                        approval_id: approval_id.as_str().to_owned(),
                        run_id: Some(run_id.as_str().to_owned()),
                        phase: ApprovalPhase::Resolved,
                        option_ids: option_ids
                            .iter()
                            .map(|option_id| option_id.as_str().to_owned())
                            .collect(),
                    },
                });
            }
            CanonicalSessionChange::RecoveryRequired { reason } => {
                projected.push(SessionChange::RecoveryRequired {
                    reason: match reason {
                        crate::session::projection::CanonicalRecoveryReason::CursorGap => {
                            RecoveryReason::CursorGap
                        }
                        crate::session::projection::CanonicalRecoveryReason::CursorStale => {
                            RecoveryReason::CursorStale
                        }
                        crate::session::projection::CanonicalRecoveryReason::EpochChanged => {
                            RecoveryReason::EpochChanged
                        }
                        crate::session::projection::CanonicalRecoveryReason::EventOverflow => {
                            RecoveryReason::EventOverflow
                        }
                        crate::session::projection::CanonicalRecoveryReason::NativeUnavailable => {
                            RecoveryReason::NativeUnavailable
                        }
                        crate::session::projection::CanonicalRecoveryReason::NativeUnknown => {
                            RecoveryReason::NativeUnknown
                        }
                    },
                });
            }
            CanonicalSessionChange::ItemsReplaced { old_item_ids, anchor, items } => {
                projected.push(SessionChange::ItemsReplaced {
                    old_item_ids: old_item_ids.clone(), anchor: anchor.clone(), items: items.clone(),
                });
            }
            CanonicalSessionChange::TranscriptMessage { .. } => {}
        }
    }
    projected
}

fn runtime_activity(activity: CanonicalRuntimeActivity) -> RuntimeActivity {
    match activity {
        CanonicalRuntimeActivity::Compacting => RuntimeActivity::Compacting,
    }
}

fn run_progress(progress: CanonicalRunProgress) -> RunProgress {
    match progress {
        CanonicalRunProgress::Startup { phase } => RunProgress::Startup {
            phase: run_startup_phase(phase),
        },
        CanonicalRunProgress::Retrying {
            attempt,
            max_attempts,
        } => RunProgress::Retrying {
            attempt,
            max_attempts,
        },
    }
}

fn run_startup_phase(phase: ChatStatusPhase) -> RunStartupPhase {
    match phase {
        ChatStatusPhase::PreparingWorkspace => RunStartupPhase::PreparingWorkspace,
        ChatStatusPhase::NamingWorktree => RunStartupPhase::NamingWorktree,
        ChatStatusPhase::CreatingWorktree => RunStartupPhase::CreatingWorktree,
        ChatStatusPhase::RunningSetup => RunStartupPhase::RunningSetup,
        ChatStatusPhase::ProvisioningEnvironment => RunStartupPhase::ProvisioningEnvironment,
        ChatStatusPhase::PreparingContext => RunStartupPhase::PreparingContext,
        ChatStatusPhase::StartingModel => RunStartupPhase::StartingModel,
    }
}

fn runtime_fallback_detail(detail: &RuntimeFallbackDetail) -> RuntimeErrorDetail {
    RuntimeErrorDetail {
        kind: RuntimeErrorKind::Fallback,
        failover_reason: detail.failover_reason.clone(),
        provider_runtime_failure_kind: detail.provider_runtime_failure_kind.clone(),
        provider_error_type: detail.provider_error_type.clone(),
        provider_error_message_preview: detail.provider_error_message_preview.clone(),
        http_status: detail.http_status,
    }
}

fn runtime_guardian_notice(run_id: &str, notice: &RuntimeGuardianNotice) -> RuntimeNotice {
    RuntimeNotice {
        run_id: run_id.to_owned(),
        kind: match notice.phase {
            crate::session::protocol::RuntimeGuardianPhase::Reviewing => {
                RuntimeNoticeKind::GuardianReviewing
            }
            crate::session::protocol::RuntimeGuardianPhase::Approved => {
                RuntimeNoticeKind::GuardianApproved
            }
            crate::session::protocol::RuntimeGuardianPhase::Denied => {
                RuntimeNoticeKind::GuardianDenied
            }
            crate::session::protocol::RuntimeGuardianPhase::Warning => {
                RuntimeNoticeKind::GuardianWarning
            }
            crate::session::protocol::RuntimeGuardianPhase::StrictReviewRequired => {
                RuntimeNoticeKind::GuardianStrictReviewRequired
            }
        },
        command: notice.command.clone(),
        risk_level: notice.risk_level.clone(),
        rationale: notice.rationale.clone(),
        message: notice.message.clone(),
    }
}

pub fn terminal_runtime_error_detail(
    value: &Option<serde_json::Value>,
    error_message: &Option<String>,
    error_kind: &Option<crate::session::protocol::SessionErrorKind>,
    stop_reason: &Option<String>,
) -> Option<RuntimeErrorDetail> {
    let mut detail = value
        .as_ref()
        .and_then(runtime_error_detail)
        .unwrap_or_else(empty_runtime_error_detail);
    if detail.provider_error_message_preview.is_none() {
        detail.provider_error_message_preview = error_message.clone();
    }
    if detail.provider_error_type.is_none() {
        detail.provider_error_type = error_kind.map(session_error_kind).map(str::to_owned);
    }
    if detail.failover_reason.is_none() {
        detail.failover_reason = stop_reason.clone();
    }
    runtime_error_detail_if_present(detail)
}

fn empty_runtime_error_detail() -> RuntimeErrorDetail {
    RuntimeErrorDetail {
        kind: RuntimeErrorKind::Error,
        failover_reason: None,
        provider_runtime_failure_kind: None,
        provider_error_type: None,
        provider_error_message_preview: None,
        http_status: None,
    }
}

fn runtime_error_detail(value: &serde_json::Value) -> Option<RuntimeErrorDetail> {
    let object = value.as_object()?;
    runtime_error_detail_if_present(RuntimeErrorDetail {
        kind: RuntimeErrorKind::Error,
        failover_reason: object
            .get("failoverReason")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        provider_runtime_failure_kind: object
            .get("providerRuntimeFailureKind")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        provider_error_type: object
            .get("providerErrorType")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        provider_error_message_preview: object
            .get("providerErrorMessagePreview")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        http_status: object
            .get("httpStatus")
            .and_then(serde_json::Value::as_u64)
            .and_then(|status| u16::try_from(status).ok()),
    })
}

fn runtime_error_detail_if_present(detail: RuntimeErrorDetail) -> Option<RuntimeErrorDetail> {
    (detail.failover_reason.is_some()
        || detail.provider_runtime_failure_kind.is_some()
        || detail.provider_error_type.is_some()
        || detail.provider_error_message_preview.is_some()
        || detail.http_status.is_some())
    .then_some(detail)
}

const fn session_error_kind(kind: crate::session::protocol::SessionErrorKind) -> &'static str {
    match kind {
        crate::session::protocol::SessionErrorKind::Refusal => "refusal",
        crate::session::protocol::SessionErrorKind::Timeout => "timeout",
        crate::session::protocol::SessionErrorKind::RateLimit => "rate_limit",
        crate::session::protocol::SessionErrorKind::ContextLength => "context_length",
        crate::session::protocol::SessionErrorKind::Unknown => "unknown",
    }
}

fn message_item_id(run_id: &str, message_id: Option<&str>) -> String {
    message_id.unwrap_or(run_id).to_owned()
}

fn assistant_turn_item(
    item_id: &str,
    run_id: Option<&str>,
    message_id: Option<&str>,
    status: ItemStatus,
    segments: Vec<SessionContent>,
    text: String,
) -> SessionItem {
    SessionItem::AssistantTurn {
        item_id: item_id.to_owned(),
        run_id: run_id.map(str::to_owned),
        message_id: message_id.map(str::to_owned),
        status,
        segments,
        text,
    }
}

fn assistant_snapshot_item(snapshot: &AssistantTurnSnapshot) -> SessionItem {
    assistant_turn_item(
        &message_item_id(
            snapshot.run_id.as_str(),
            snapshot.message_id.as_ref().map(|id| id.as_str()),
        ),
        Some(snapshot.run_id.as_str()),
        snapshot.message_id.as_ref().map(|id| id.as_str()),
        assistant_status(snapshot.status),
        assistant_snapshot_segments(&snapshot.segments),
        snapshot.text.clone(),
    )
}

fn assistant_thinking_chunk_item(
    run_id: &crate::session::protocol::RunId,
    message_id: Option<&crate::session::protocol::MessageId>,
    text: &str,
    status: ItemStatus,
) -> SessionItem {
    assistant_turn_item(
        &message_item_id(run_id.as_str(), message_id.map(|id| id.as_str())),
        Some(run_id.as_str()),
        message_id.map(|id| id.as_str()),
        status,
        vec![SessionContent::Thinking {
            text: text.to_owned(),
        }],
        String::new(),
    )
}

fn assistant_snapshot_segments(segments: &[AssistantTurnSegment]) -> Vec<SessionContent> {
    segments.iter().map(assistant_snapshot_segment).collect()
}

fn assistant_snapshot_segment(segment: &AssistantTurnSegment) -> SessionContent {
    match segment {
        AssistantTurnSegment::Text { text } => SessionContent::Text { text: text.clone() },
        AssistantTurnSegment::Thinking { text } => SessionContent::Thinking { text: text.clone() },
        AssistantTurnSegment::ToolUse { tool_id, tool_name } => SessionContent::ToolUse {
            name: tool_name.clone().unwrap_or_else(|| "unknown".to_owned()),
            tool_call_id: tool_id.as_str().to_owned(),
        },
        AssistantTurnSegment::ToolResult {
            tool_id,
            summary,
            is_error,
        } => SessionContent::ToolResult {
            tool_call_id: tool_id.as_str().to_owned(),
            summary: summary.clone(),
            is_error: *is_error,
        },
    }
}

const fn assistant_status(status: AssistantTurnStatus) -> ItemStatus {
    match status {
        AssistantTurnStatus::Streaming => ItemStatus::Streaming,
        AssistantTurnStatus::WaitingForTool => ItemStatus::WaitingForTool,
        AssistantTurnStatus::Final => ItemStatus::Final,
        AssistantTurnStatus::Aborted => ItemStatus::Aborted,
        AssistantTurnStatus::Error => ItemStatus::Error,
    }
}

#[cfg(test)]
mod tests {
    use crate::session::{
        projection::{
            AssistantTurnChunkKind, AssistantTurnSegment, AssistantTurnSnapshot,
            AssistantTurnStatus, CanonicalRuntimeActivity,
        },
        protocol::{ApprovalId, ApprovalOptionId, MessageId, RunId, ToolId},
    };
    use serde_json::json;

    use super::*;

    #[test]
    fn run_started_projects_run_phase_started() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::RunStarted {
            run_id: RunId::try_new("run-1").unwrap(),
        }]);

        assert_eq!(
            changes,
            vec![SessionChange::RunPhaseChanged {
                run_id: "run-1".to_owned(),
                phase: RunPhase::Started,
            }]
        );
    }

    #[test]
    fn assistant_turn_text_delta_projects_message_delta_without_run_start() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::AssistantTurnChunk {
            run_id: RunId::try_new("run-1").unwrap(),
            message_id: Some(MessageId::try_new("message-1").unwrap()),
            kind: AssistantTurnChunkKind::Text,
            text: "hello".to_owned(),
            replace: false,
            status: AssistantTurnStatus::Streaming,
        }]);

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
    fn assistant_turn_text_delta_uses_run_id_without_message_id() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::AssistantTurnChunk {
            run_id: RunId::try_new("run-1").unwrap(),
            message_id: None,
            kind: AssistantTurnChunkKind::Text,
            text: "hello".to_owned(),
            replace: false,
            status: AssistantTurnStatus::Streaming,
        }]);

        assert!(matches!(
            changes.as_slice(),
            [SessionChange::MessageDelta {
                item_id,
                message_id: None,
                ..
            }] if item_id == "run-1"
        ));
    }

    #[test]
    fn preserves_openclaw_live_tool_name() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::ToolActivity {
            run_id: RunId::try_new("run-1").unwrap(),
            tool_id: ToolId::try_new("tool-1").unwrap(),
            tool_name: Some("read".to_owned()),
            phase: ToolActivityPhase::Started,
            summary: None,
            input: None,
            input_text: None,
            output: None,
            details: None,
            is_error: None,
        }]);

        assert!(matches!(
            changes.as_slice(),
            [SessionChange::ToolUpdated { tool }]
                if tool.tool_call_id == "tool-1" && tool.name.as_deref() == Some("read")
        ));
    }

    #[test]
    fn live_tool_preserves_canonical_public_bounded_payload() {
        // This layer projects only canonical public/bounded fields; raw private payloads are never logged here.
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::ToolActivity {
            run_id: RunId::try_new("run-1").unwrap(),
            tool_id: ToolId::try_new("tool-1").unwrap(),
            tool_name: Some("read".to_owned()),
            phase: ToolActivityPhase::Failed,
            summary: Some("read failed".to_owned()),
            input: Some(json!({ "path": "Cargo.toml" })),
            input_text: Some("{\"path\":\"Cargo.toml\"}".to_owned()),
            output: Some(json!({ "content": "workspace" })),
            details: Some(json!({ "lineCount": 1 })),
            is_error: Some(false),
        }]);

        assert!(matches!(
            changes.as_slice(),
            [SessionChange::ToolUpdated { tool }]
                if tool.input == Some(json!({ "path": "Cargo.toml" }))
                && tool.input_text.as_deref() == Some("{\"path\":\"Cargo.toml\"}")
                && tool.output == Some(json!({ "content": "workspace" }))
                && tool.details == Some(json!({ "lineCount": 1 }))
                && tool.summary.as_deref() == Some("read failed")
                && tool.is_error == Some(false)
                && tool.phase == ToolPhase::Failed
        ));
    }

    #[test]
    fn assistant_turn_snapshot_preserves_canonical_segment_order() {
        let changes =
            openclaw_canonical_changes(&[CanonicalSessionChange::AssistantTurnSnapshot {
                snapshot: AssistantTurnSnapshot::new(
                    RunId::try_new("run-1").unwrap(),
                    Some(MessageId::try_new("message-1").unwrap()),
                    vec![
                        AssistantTurnSegment::Text {
                            text: "before".to_owned(),
                        },
                        AssistantTurnSegment::ToolUse {
                            tool_id: ToolId::try_new("tool-1").unwrap(),
                            tool_name: Some("read".to_owned()),
                        },
                        AssistantTurnSegment::ToolResult {
                            tool_id: ToolId::try_new("tool-1").unwrap(),
                            summary: Some("done".to_owned()),
                            is_error: false,
                        },
                        AssistantTurnSegment::Text {
                            text: "after".to_owned(),
                        },
                    ],
                    "before\nafter",
                    None,
                    AssistantTurnStatus::Streaming,
                ),
            }]);

        assert_eq!(
            changes,
            vec![SessionChange::MessageUpdated {
                item: SessionItem::AssistantTurn {
                    item_id: "message-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    message_id: Some("message-1".to_owned()),
                    status: ItemStatus::Streaming,
                    segments: vec![
                        SessionContent::Text {
                            text: "before".to_owned(),
                        },
                        SessionContent::ToolUse {
                            name: "read".to_owned(),
                            tool_call_id: "tool-1".to_owned(),
                        },
                        SessionContent::ToolResult {
                            tool_call_id: "tool-1".to_owned(),
                            summary: Some("done".to_owned()),
                            is_error: false,
                        },
                        SessionContent::Text {
                            text: "after".to_owned(),
                        },
                    ],
                    text: "before\nafter".to_owned(),
                },
            }]
        );
    }

    #[test]
    fn assistant_turn_snapshot_precedes_terminal_run_phase() {
        let changes = openclaw_canonical_changes(&[
            CanonicalSessionChange::RunStarted {
                run_id: RunId::try_new("run-1").unwrap(),
            },
            CanonicalSessionChange::AssistantTurnSnapshot {
                snapshot: AssistantTurnSnapshot::new(
                    RunId::try_new("run-1").unwrap(),
                    Some(MessageId::try_new("message-1").unwrap()),
                    vec![AssistantTurnSegment::Text {
                        text: "final".to_owned(),
                    }],
                    "final",
                    None,
                    AssistantTurnStatus::Final,
                ),
            },
            CanonicalSessionChange::Terminal {
                run_id: RunId::try_new("run-1").unwrap(),
                outcome: TerminalOutcome::Completed,
                message_id: Some(MessageId::try_new("message-1").unwrap()),
                error_kind: None,
                error_message: None,
                stop_reason: None,
                error_detail: None,
            },
        ]);

        assert!(matches!(
            changes.as_slice(),
            [
                SessionChange::RunPhaseChanged {
                    phase: RunPhase::Started,
                    ..
                },
                SessionChange::MessageUpdated { item },
                SessionChange::RunPhaseChanged {
                    phase: RunPhase::Completed,
                    ..
                }
            ] if matches!(item, SessionItem::AssistantTurn { status: ItemStatus::Final, .. })
        ));
    }

    #[test]
    fn runtime_activity_projects_compacting_runtime_change() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::RuntimeActivity {
            run_id: RunId::try_new("run-1").unwrap(),
            activity: CanonicalRuntimeActivity::Compacting,
        }]);

        assert_eq!(
            changes,
            vec![SessionChange::RuntimeChanged {
                runtime: RuntimeView {
                    phase: RunPhase::Started,
                    active_run_id: Some("run-1".to_owned()),
                    issue: None,
                    run_progress: None,
                    runtime_activity: Some(RuntimeActivity::Compacting),
                    error_detail: None,
                },
            }]
        );
    }

    #[test]
    fn runtime_notice_projects_guardian_delta() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::GuardianNotice {
            run_id: RunId::try_new("run-1").unwrap(),
            notice: RuntimeGuardianNotice {
                phase: crate::session::protocol::RuntimeGuardianPhase::Warning,
                command: Some("cargo test".to_owned()),
                risk_level: Some("medium".to_owned()),
                rationale: None,
                message: None,
            },
        }]);

        assert!(matches!(
            changes.as_slice(),
            [SessionChange::RuntimeNoticeUpdated { notice }]
                if notice.run_id == "run-1"
                    && notice.kind == RuntimeNoticeKind::GuardianWarning
                    && notice.command.as_deref() == Some("cargo test")
                    && notice.risk_level.as_deref() == Some("medium")
        ));
    }

    #[test]
    fn runtime_fallback_clear_projects_runtime_change() {
        let changes =
            openclaw_canonical_changes(&[CanonicalSessionChange::RuntimeFallbackCleared {
                run_id: RunId::try_new("run-1").unwrap(),
            }]);

        assert!(matches!(
            changes.as_slice(),
            [SessionChange::RuntimeChanged { runtime }]
                if runtime.active_run_id.as_deref() == Some("run-1")
                && runtime.runtime_activity.is_none()
                && runtime.error_detail.is_none()
        ));
    }

    #[test]
    fn terminal_error_projects_message_only_error_detail_runtime_change() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::Terminal {
            run_id: RunId::try_new("run-1").unwrap(),
            outcome: TerminalOutcome::Error,
            message_id: None,
            error_kind: Some(crate::session::protocol::SessionErrorKind::RateLimit),
            error_message: Some("provider overloaded".to_owned()),
            stop_reason: Some("gateway_error".to_owned()),
            error_detail: None,
        }]);

        assert!(matches!(
            changes.as_slice(),
            [
                SessionChange::RunPhaseChanged { run_id, phase: RunPhase::Failed },
                SessionChange::RuntimeChanged { runtime }
            ] if run_id == "run-1"
                && runtime.phase == RunPhase::Failed
                && runtime.active_run_id.is_none()
                && runtime.error_detail.as_ref().is_some_and(|detail| detail.kind == RuntimeErrorKind::Error
                    && detail.failover_reason.as_deref() == Some("gateway_error")
                    && detail.provider_error_type.as_deref() == Some("rate_limit")
                    && detail.provider_error_message_preview.as_deref() == Some("provider overloaded")
                    && detail.http_status.is_none())
        ));
    }

    #[test]
    fn terminal_error_detail_wins_and_missing_fields_are_filled() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::Terminal {
            run_id: RunId::try_new("run-1").unwrap(),
            outcome: TerminalOutcome::Error,
            message_id: None,
            error_kind: Some(crate::session::protocol::SessionErrorKind::RateLimit),
            error_message: Some("provider overloaded".to_owned()),
            stop_reason: Some("gateway_error".to_owned()),
            error_detail: Some(json!({
                "failoverReason":"rate_limit",
                "httpStatus":429
            })),
        }]);

        assert!(matches!(
            changes.as_slice(),
            [
                SessionChange::RunPhaseChanged { run_id, phase: RunPhase::Failed },
                SessionChange::RuntimeChanged { runtime }
            ] if run_id == "run-1"
                && runtime.phase == RunPhase::Failed
                && runtime.active_run_id.is_none()
                && runtime.error_detail.as_ref().is_some_and(|detail| detail.kind == RuntimeErrorKind::Error
                    && detail.failover_reason.as_deref() == Some("rate_limit")
                    && detail.provider_error_type.as_deref() == Some("rate_limit")
                    && detail.provider_error_message_preview.as_deref() == Some("provider overloaded")
                    && detail.http_status == Some(429))
        ));
    }

    #[test]
    fn approval_requested_projects_public_approval_update() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::ApprovalRequested {
            run_id: RunId::try_new("run-1").unwrap(),
            approval_id: ApprovalId::try_new("approval-1").unwrap(),
            option_ids: vec![
                ApprovalOptionId::try_new("approve").unwrap(),
                ApprovalOptionId::try_new("deny").unwrap(),
            ],
        }]);

        assert_eq!(
            changes,
            vec![SessionChange::ApprovalUpdated {
                approval: ApprovalView {
                    approval_id: "approval-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    phase: ApprovalPhase::Requested,
                    option_ids: vec!["approve".to_owned(), "deny".to_owned()],
                },
            }]
        );
    }

    #[test]
    fn approval_resolved_projects_public_approval_update() {
        let changes = openclaw_canonical_changes(&[CanonicalSessionChange::ApprovalResolved {
            run_id: RunId::try_new("run-1").unwrap(),
            approval_id: ApprovalId::try_new("approval-1").unwrap(),
            option_ids: vec![
                ApprovalOptionId::try_new("approve").unwrap(),
                ApprovalOptionId::try_new("deny").unwrap(),
            ],
        }]);

        assert_eq!(
            changes,
            vec![SessionChange::ApprovalUpdated {
                approval: ApprovalView {
                    approval_id: "approval-1".to_owned(),
                    run_id: Some("run-1".to_owned()),
                    phase: ApprovalPhase::Resolved,
                    option_ids: vec!["approve".to_owned(), "deny".to_owned()],
                },
            }]
        );
    }
}
