use openclaw::session::{
    events::TerminalOutcome,
    projection::CanonicalSessionChange,
    protocol::{MessageActivityLifecycle, ToolActivityPhase},
};

use super::state::{
    ItemStatus, RecoveryReason, RunPhase, SessionChange, SessionContent, SessionItem, ToolPhase,
    ToolView,
};

pub(crate) fn openclaw_canonical_changes(
    changes: &[CanonicalSessionChange],
    run_id: Option<&str>,
) -> Vec<SessionChange> {
    let mut projected = Vec::with_capacity(changes.len() + 1);

    // Emit RunPhaseChanged::Started if any activity changes present
    if let Some(run_id) = run_id {
        if changes.iter().any(|change| {
            matches!(
                change,
                CanonicalSessionChange::RunDelta { .. }
                    | CanonicalSessionChange::MessageActivity { .. }
                    | CanonicalSessionChange::ToolActivity { .. }
            )
        }) {
            projected.push(SessionChange::RunPhaseChanged {
                run_id: run_id.to_owned(),
                phase: RunPhase::Started,
            });
        }
    }

    for change in changes {
        match change {
            CanonicalSessionChange::RunDelta {
                run_id,
                message_id,
                text,
                replace,
            } => {
                projected.push(SessionChange::MessageDelta {
                    item_id: message_id
                        .as_ref()
                        .map(|id| id.as_str().to_owned())
                        .unwrap_or_else(|| run_id.as_str().to_owned()),
                    run_id: Some(run_id.as_str().to_owned()),
                    message_id: message_id.as_ref().map(|id| id.as_str().to_owned()),
                    text: text.clone(),
                    replace: *replace,
                    status: ItemStatus::Streaming,
                });
            }
            CanonicalSessionChange::MessageActivity {
                run_id,
                message_id,
                lifecycle,
                text,
            } => {
                projected.push(SessionChange::MessageDelta {
                    item_id: message_id.as_str().to_owned(),
                    run_id: Some(run_id.as_str().to_owned()),
                    message_id: Some(message_id.as_str().to_owned()),
                    text: text.clone().unwrap_or_default(),
                    replace: false,
                    status: match lifecycle {
                        MessageActivityLifecycle::Started | MessageActivityLifecycle::Delta => {
                            ItemStatus::Streaming
                        }
                        MessageActivityLifecycle::Completed => ItemStatus::Final,
                    },
                });
            }
            CanonicalSessionChange::ToolActivity {
                run_id,
                tool_id,
                tool_name,
                phase,
                summary,
            } => {
                projected.push(SessionChange::ToolUpdated {
                    tool: ToolView {
                        tool_call_id: tool_id.as_str().to_owned(),
                        run_id: Some(run_id.as_str().to_owned()),
                        name: tool_name.clone(),
                        phase: match phase {
                            ToolActivityPhase::Started => ToolPhase::Started,
                            ToolActivityPhase::Updated => ToolPhase::Updated,
                            ToolActivityPhase::Completed => ToolPhase::Completed,
                            ToolActivityPhase::Failed => ToolPhase::Failed,
                        },
                        summary: summary.clone(),
                        is_error: matches!(phase, ToolActivityPhase::Failed).then_some(true),
                    },
                });
            }
            CanonicalSessionChange::Terminal {
                outcome,
                run_id,
                message_id,
                message_text,
                ..
            } => {
                if let Some(text) = message_text {
                    projected.push(SessionChange::MessageDelta {
                        item_id: message_id
                            .as_ref()
                            .map(|id| id.as_str().to_owned())
                            .unwrap_or_else(|| run_id.as_str().to_owned()),
                        run_id: Some(run_id.as_str().to_owned()),
                        message_id: message_id.as_ref().map(|id| id.as_str().to_owned()),
                        text: text.clone(),
                        replace: true,
                        status: match outcome {
                            TerminalOutcome::Completed => ItemStatus::Final,
                            TerminalOutcome::Aborted => ItemStatus::Aborted,
                            TerminalOutcome::Error => ItemStatus::Error,
                        },
                    });
                }
                projected.push(SessionChange::RunPhaseChanged {
                    run_id: run_id.as_str().to_owned(),
                    phase: match outcome {
                        TerminalOutcome::Completed => RunPhase::Completed,
                        TerminalOutcome::Aborted => RunPhase::Cancelled,
                        TerminalOutcome::Error => RunPhase::Failed,
                    },
                });
            }
            CanonicalSessionChange::RecoveryRequired { reason } => {
                projected.push(SessionChange::RecoveryRequired {
                    reason: match reason {
                        openclaw::session::projection::CanonicalRecoveryReason::CursorGap => {
                            RecoveryReason::CursorGap
                        }
                        openclaw::session::projection::CanonicalRecoveryReason::CursorStale => {
                            RecoveryReason::CursorStale
                        }
                        openclaw::session::projection::CanonicalRecoveryReason::EpochChanged => {
                            RecoveryReason::EpochChanged
                        }
                        openclaw::session::projection::CanonicalRecoveryReason::EventOverflow => {
                            RecoveryReason::EventOverflow
                        }
                        openclaw::session::projection::CanonicalRecoveryReason::NativeUnavailable => {
                            RecoveryReason::NativeUnavailable
                        }
                        openclaw::session::projection::CanonicalRecoveryReason::NativeUnknown => {
                            RecoveryReason::NativeUnknown
                        }
                    },
                });
            }
        }
    }
    projected
}

#[cfg(test)]
mod tests {
    use openclaw::session::protocol::{RunId, ToolId};

    use super::*;

    #[test]
    fn preserves_openclaw_live_tool_name() {
        let changes = openclaw_canonical_changes(
            &[CanonicalSessionChange::ToolActivity {
                run_id: RunId::try_new("run-1").unwrap(),
                tool_id: ToolId::try_new("tool-1").unwrap(),
                tool_name: Some("read".to_owned()),
                phase: ToolActivityPhase::Started,
                summary: None,
            }],
            Some("run-1"),
        );

        assert!(matches!(
            changes.as_slice(),
            [
                SessionChange::RunPhaseChanged { .. },
                SessionChange::ToolUpdated { tool }
            ] if tool.tool_call_id == "tool-1" && tool.name.as_deref() == Some("read")
        ));
    }
}
