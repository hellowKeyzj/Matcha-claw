use matcha_agent::peer::{
    RendererApprovalPhase, RendererEvent, RendererEventEnvelope, RendererMessageLifecycle,
    RendererRunPhase, RendererToolPhase,
};

use super::state::{
    ApprovalPhase, ApprovalView, ItemStatus, RecoveryReason, RunPhase, SessionChange,
    SessionContent, SessionItem, ToolPhase, ToolView,
};

pub(crate) fn matcha_event_changes(event: RendererEventEnvelope) -> Option<Vec<SessionChange>> {
    let run_id = event.run_id().to_owned();
    let event = event.into_event();
    match event {
        RendererEvent::Run { phase, .. } => Some(vec![SessionChange::RunPhaseChanged {
            run_id,
            phase: match phase {
                RendererRunPhase::Started => RunPhase::Started,
                RendererRunPhase::WaitingForApproval => RunPhase::WaitingForApproval,
                RendererRunPhase::Completed => RunPhase::Completed,
                RendererRunPhase::Cancelled => RunPhase::Cancelled,
                RendererRunPhase::Failed => RunPhase::Failed,
                RendererRunPhase::Interrupted => RunPhase::Interrupted,
            },
        }]),
        RendererEvent::Message {
            message_id,
            lifecycle,
            message_text: Some(text),
            ..
        } => Some(vec![SessionChange::MessageUpdated {
            item: SessionItem::AssistantTurn {
                item_id: message_id.clone(),
                run_id: Some(run_id),
                message_id: Some(message_id),
                status: match lifecycle {
                    RendererMessageLifecycle::Started => ItemStatus::Streaming,
                    RendererMessageLifecycle::Delta => ItemStatus::Streaming,
                    RendererMessageLifecycle::Completed => ItemStatus::Final,
                },
                segments: vec![SessionContent::Text { text: text.clone() }],
                text,
            },
        }]),
        RendererEvent::Message { .. } => Some(vec![SessionChange::RecoveryRequired {
            reason: RecoveryReason::NativeUnknown,
        }]),
        RendererEvent::Tool {
            tool_call_id,
            phase,
            ..
        } => Some(vec![SessionChange::ToolUpdated {
            tool: ToolView {
                tool_call_id,
                run_id: Some(run_id),
                name: None,
                phase: match phase {
                    RendererToolPhase::Started => ToolPhase::Started,
                    RendererToolPhase::Updated => ToolPhase::Updated,
                    RendererToolPhase::Completed => ToolPhase::Completed,
                    RendererToolPhase::Failed => ToolPhase::Failed,
                },
                summary: None,
                is_error: None,
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
