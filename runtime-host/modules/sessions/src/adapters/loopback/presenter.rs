use serde_json::{Value, json};

use crate::state::{
    ApprovalPhase, ApprovalView, ItemStatus, MissingFact, OmissionReason, RunPhase, RunProgress,
    RunStartupPhase, RuntimeActivity, RuntimeErrorDetail, RuntimeErrorKind, RuntimeIssue,
    RuntimeView, SessionCompleteness, SessionContent, SessionFact, SessionItem, SessionProvider,
    SessionView, SessionWindow, ToolPhase, ToolView, public_media_reference,
};

pub(crate) fn session_view(view: &SessionView) -> Value {
    json!({
        "sessionKey": &view.session_key,
        "endpointSessionId": &view.endpoint_session_id,
        "modelState": &view.model_state,
        "identity": identity_value(view),
        "epoch": view.epoch,
        "seq": view.seq,
        "cursor": view.cursor,
        "items": fact_value(&view.items, items_value),
        "tools": fact_value(&view.tools, tools_value),
        "approvals": fact_value(&view.approvals, approvals_value),
        "runtime": fact_value(&view.runtime, runtime_value),
        "window": fact_value(&view.window, window_value),
        "completeness": completeness_value(&view.completeness),
    })
}

fn fact_value<T>(fact: &SessionFact<T>, map: impl Fn(&T) -> Value) -> Value {
    match fact {
        SessionFact::Complete(facts) => json!({ "complete": map(facts) }),
        SessionFact::Incomplete { facts, gaps } => {
            json!({ "incomplete": { "facts": map(facts), "gaps": gaps.iter().map(|fact| missing_fact(*fact)).collect::<Vec<_>>() } })
        }
        SessionFact::Unavailable => json!("unavailable"),
        SessionFact::Unknown => json!("unknown"),
    }
}

fn items_value(items: &Vec<SessionItem>) -> Value {
    Value::Array(items.iter().map(item_value).collect())
}

fn item_value(item: &SessionItem) -> Value {
    match item {
        SessionItem::UserMessage {
            item_id,
            message_id,
            text,
            content,
            status,
        } => json!({
            "kind": "userMessage",
            "itemId": item_id,
            "messageId": message_id,
            "text": text,
            "content": content.iter().map(content_value).collect::<Vec<_>>(),
            "status": item_status(*status),
        }),
        SessionItem::AssistantTurn {
            item_id,
            run_id,
            message_id,
            status,
            segments,
            text,
        } => json!({
            "kind": "assistantTurn",
            "itemId": item_id,
            "runId": run_id,
            "messageId": message_id,
            "status": item_status(*status),
            "segments": segments.iter().map(content_value).collect::<Vec<_>>(),
            "text": text,
        }),
        SessionItem::System {
            item_id,
            text,
            status,
        } => json!({
            "kind": "system",
            "itemId": item_id,
            "text": text,
            "status": item_status(*status),
        }),
    }
}

fn content_value(content: &SessionContent) -> Value {
    match content {
        SessionContent::Text { text } => json!({ "kind": "text", "text": text }),
        SessionContent::Thinking { text } => json!({ "kind": "thinking", "text": text }),
        SessionContent::LargeText {
            text,
            content_ref,
            total_bytes,
            loaded_bytes,
        } => json!({
            "kind": "largeText",
            "text": text,
            "contentRef": content_ref,
            "totalBytes": total_bytes,
            "loadedBytes": loaded_bytes,
        }),
        SessionContent::ToolUse { name, tool_call_id } => json!({
            "kind": "toolUse",
            "name": name,
            "toolCallId": tool_call_id,
        }),
        SessionContent::ToolResult {
            tool_call_id,
            summary,
            is_error,
        } => json!({
            "kind": "toolResult",
            "toolCallId": tool_call_id,
            "summary": summary,
            "isError": is_error,
        }),
        SessionContent::Media {
            media_type,
            reference,
        } => public_media_reference(reference).map_or_else(
            || json!({ "kind": "omitted", "reason": "unsafe_media" }),
            |reference| {
                json!({
                    "kind": "media",
                    "mediaType": media_type,
                    "reference": reference,
                })
            },
        ),
        SessionContent::Omitted { reason } => {
            json!({ "kind": "omitted", "reason": omission_reason(*reason) })
        }
    }
}

fn tools_value(tools: &Vec<ToolView>) -> Value {
    Value::Array(tools.iter().map(tool_value).collect())
}

fn tool_value(tool: &ToolView) -> Value {
    json!({
        "toolCallId": &tool.tool_call_id,
        "runId": &tool.run_id,
        "name": &tool.name,
        "phase": tool_phase(tool.phase),
        "input": &tool.input,
        "inputText": &tool.input_text,
        "summary": &tool.summary,
        "output": &tool.output,
        "details": &tool.details,
        "isError": &tool.is_error,
    })
}

fn approvals_value(approvals: &Vec<ApprovalView>) -> Value {
    Value::Array(approvals.iter().map(approval_value).collect())
}

fn approval_value(approval: &ApprovalView) -> Value {
    json!({
        "approvalId": &approval.approval_id,
        "runId": &approval.run_id,
        "phase": approval_phase(approval.phase),
        "optionIds": &approval.option_ids,
    })
}

fn runtime_value(runtime: &RuntimeView) -> Value {
    json!({
        "phase": run_phase(runtime.phase),
        "activeRunId": &runtime.active_run_id,
        "issue": runtime.issue.map(runtime_issue),
        "runProgress": runtime.run_progress.map(run_progress),
        "runtimeActivity": runtime.runtime_activity.map(runtime_activity),
        "errorDetail": runtime.error_detail.as_ref().map(runtime_error_detail),
    })
}

fn runtime_error_detail(detail: &RuntimeErrorDetail) -> Value {
    json!({
        "kind": runtime_error_kind(detail.kind),
        "failoverReason": &detail.failover_reason,
        "providerRuntimeFailureKind": &detail.provider_runtime_failure_kind,
        "providerErrorType": &detail.provider_error_type,
        "providerErrorMessagePreview": &detail.provider_error_message_preview,
        "httpStatus": detail.http_status,
    })
}

fn identity_value(view: &SessionView) -> Value {
    let mut identity = json!({
        "sessionKey": &view.identity.session_key,
        "endpoint": {
            "kind": &view.identity.endpoint.kind,
            "runtimeAdapterId": session_provider(view.identity.endpoint.runtime_adapter_id),
            "runtimeInstanceId": &view.identity.endpoint.runtime_instance_id,
        },
    });
    if let Some(agent_id) = &view.identity.agent_id {
        identity["agentId"] = json!(agent_id);
    }
    identity
}

fn window_value(window: &SessionWindow) -> Value {
    json!({
        "totalItemCount": window.total_item_count,
        "windowStartOffset": window.window_start_offset,
        "windowEndOffset": window.window_end_offset,
        "hasMore": window.has_more,
        "hasNewer": window.has_newer,
        "isAtLatest": window.is_at_latest,
    })
}

fn completeness_value(completeness: &SessionCompleteness) -> Value {
    match completeness {
        SessionCompleteness::Complete => json!("complete"),
        SessionCompleteness::Incomplete { missing } => {
            json!({ "incomplete": { "missing": missing.iter().map(|fact| missing_fact(*fact)).collect::<Vec<_>>() } })
        }
        SessionCompleteness::Unavailable => json!("unavailable"),
        SessionCompleteness::Unknown => json!("unknown"),
    }
}

fn session_provider(provider: SessionProvider) -> &'static str {
    match provider {
        SessionProvider::OpenClaw => "openclaw",
        SessionProvider::MatchaAgent => "matcha-agent",
    }
}

fn item_status(status: ItemStatus) -> &'static str {
    match status {
        ItemStatus::Pending => "pending",
        ItemStatus::Streaming => "streaming",
        ItemStatus::WaitingForTool => "waiting_for_tool",
        ItemStatus::Final => "final",
        ItemStatus::Error => "error",
        ItemStatus::Aborted => "aborted",
    }
}

fn tool_phase(phase: ToolPhase) -> &'static str {
    match phase {
        ToolPhase::Started => "started",
        ToolPhase::Updated => "updated",
        ToolPhase::Completed => "completed",
        ToolPhase::Failed => "failed",
    }
}

fn approval_phase(phase: ApprovalPhase) -> &'static str {
    match phase {
        ApprovalPhase::Requested => "requested",
        ApprovalPhase::Resolved => "resolved",
    }
}

fn run_phase(phase: RunPhase) -> &'static str {
    match phase {
        RunPhase::Queued => "queued",
        RunPhase::Started => "started",
        RunPhase::WaitingForApproval => "waiting_for_approval",
        RunPhase::CancellationRequested => "cancellation_requested",
        RunPhase::Cancelled => "cancelled",
        RunPhase::Completed => "completed",
        RunPhase::Failed => "failed",
        RunPhase::Interrupted => "interrupted",
    }
}

fn runtime_issue(issue: RuntimeIssue) -> &'static str {
    match issue {
        RuntimeIssue::Unknown => "unknown",
        RuntimeIssue::Unavailable => "unavailable",
        RuntimeIssue::Timeout => "timeout",
        RuntimeIssue::Rejected => "rejected",
    }
}

fn run_progress(progress: RunProgress) -> Value {
    match progress {
        RunProgress::Startup { phase } => json!({
            "kind": "startup",
            "phase": run_startup_phase(phase),
        }),
        RunProgress::Retrying {
            attempt,
            max_attempts,
        } => json!({
            "kind": "retrying",
            "attempt": attempt,
            "maxAttempts": max_attempts,
        }),
    }
}

fn run_startup_phase(phase: RunStartupPhase) -> &'static str {
    match phase {
        RunStartupPhase::PreparingWorkspace => "preparing_workspace",
        RunStartupPhase::NamingWorktree => "naming_worktree",
        RunStartupPhase::CreatingWorktree => "creating_worktree",
        RunStartupPhase::RunningSetup => "running_setup",
        RunStartupPhase::ProvisioningEnvironment => "provisioning_environment",
        RunStartupPhase::PreparingContext => "preparing_context",
        RunStartupPhase::StartingModel => "starting_model",
    }
}

fn runtime_activity(activity: RuntimeActivity) -> &'static str {
    match activity {
        RuntimeActivity::Compacting => "compacting",
    }
}

fn runtime_error_kind(kind: RuntimeErrorKind) -> &'static str {
    match kind {
        RuntimeErrorKind::Fallback => "fallback",
        RuntimeErrorKind::Error => "error",
    }
}

fn omission_reason(reason: OmissionReason) -> &'static str {
    match reason {
        OmissionReason::Thinking => "thinking",
        OmissionReason::UnsafeMedia => "unsafe_media",
        OmissionReason::Unknown => "unknown",
    }
}

fn missing_fact(fact: MissingFact) -> &'static str {
    match fact {
        MissingFact::SessionIdentity => "session_identity",
        MissingFact::Catalog => "catalog",
        MissingFact::Usage => "usage",
        MissingFact::Artifacts => "artifacts",
        MissingFact::ContextTokens => "context_tokens",
        MissingFact::Tasks => "tasks",
        MissingFact::ReplayCursor => "replay_cursor",
        MissingFact::BoundedHistory => "bounded_history",
        MissingFact::PartialRuntime => "partial_runtime",
        MissingFact::EventOnly => "event_only",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::SessionIdentity;

    #[test]
    fn omits_unsafe_media_references() {
        let view = SessionView {
            session_key: "agent:main:demo".to_owned(),
            endpoint_session_id: Some("session-1".to_owned()),
            model_state: None,
            identity: SessionIdentity::new(
                "agent:main:demo",
                SessionProvider::OpenClaw,
                Some("main".to_owned()),
            )
            .expect("valid identity"),
            epoch: 1,
            seq: 1,
            cursor: 1,
            items: SessionFact::Complete(vec![SessionItem::UserMessage {
                item_id: "item-1".to_owned(),
                message_id: Some("message-1".to_owned()),
                text: String::new(),
                content: vec![
                    SessionContent::Media {
                        media_type: Some("image/png".to_owned()),
                        reference: "C:/private/image.png".to_owned(),
                    },
                    SessionContent::Media {
                        media_type: Some("image/png".to_owned()),
                        reference: "/private/image.png".to_owned(),
                    },
                    SessionContent::Media {
                        media_type: Some("image/png".to_owned()),
                        reference: "https://cdn.example.test/image.png?token=secret".to_owned(),
                    },
                    SessionContent::Media {
                        media_type: Some("image/png".to_owned()),
                        reference: "/api/chat/media/outgoing/session-1/image.png".to_owned(),
                    },
                ],
                status: ItemStatus::Final,
            }]),
            tools: SessionFact::Complete(Vec::new()),
            approvals: SessionFact::Complete(Vec::<ApprovalView>::new()),
            runtime: SessionFact::Complete(RuntimeView {
                phase: RunPhase::Completed,
                active_run_id: None,
                issue: None,
                run_progress: None,
                runtime_activity: None,
                error_detail: None,
            }),
            window: SessionFact::Complete(SessionWindow::latest(1)),
            completeness: SessionCompleteness::Complete,
        };

        let rendered = session_view(&view).to_string();
        assert!(!rendered.contains("C:/private"));
        assert!(!rendered.contains("/private"));
        assert!(!rendered.contains("token=secret"));
        assert!(rendered.contains("unsafe_media"));
        assert!(rendered.contains("/api/chat/media/outgoing/session-1/image.png"));
    }
}
