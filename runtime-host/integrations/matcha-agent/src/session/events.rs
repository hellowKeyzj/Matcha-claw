use std::fmt;

use super::{
    interaction,
    model::{ClassifiedErrorKind, RunRecord, RunStatus, valid_uuid},
    projection::{self, Streaming},
    rpc::{self, Failure},
};
use crate::client::Event;
use serde_json::Value;
use sessions_module::{
    question::{QuestionAvailability, QuestionDelivery, QuestionTarget},
    state::{
        ApprovalPhase, ApprovalView, ItemAnchor, RunPhase, RuntimeIssue, RuntimeView,
        SessionChange, SessionFact, SessionItem, SessionView, ToolView,
    },
};

#[derive(Clone, Eq, PartialEq)]
pub struct ProjectedRunError {
    pub kind: ClassifiedErrorKind,
    pub message_preview: Option<String>,
}
impl fmt::Debug for ProjectedRunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProjectedRunError")
            .field("kind", &self.kind)
            .field("has_preview", &self.message_preview.is_some())
            .finish()
    }
}

pub(crate) struct Projected {
    pub changes: Vec<SessionChange>,
    pub history_refresh: bool,
}
pub(crate) fn project(
    streaming: &mut Streaming,
    event: &Event,
    view: &SessionView,
) -> Result<Projected, Failure> {
    let mut changes = Vec::new();
    let mut history_refresh = false;
    match event.kind.as_str() {
        "native.message" => {
            if let Some(projected) = streaming.observe(&event.payload)? {
                let items = items(&view.items);
                let item_id = projected.message.item.item_id();
                let position = items
                    .iter()
                    .position(|item| projected.retired.iter().any(|id| id == item.item_id()))
                    .or_else(|| items.iter().position(|item| item.item_id() == item_id))
                    .unwrap_or(items.len());
                let anchor = items[..position]
                    .iter()
                    .rev()
                    .find(|item| {
                        item.item_id() != item_id
                            && !projected.retired.iter().any(|id| id == item.item_id())
                    })
                    .map_or(ItemAnchor::Start, |item| ItemAnchor::After {
                        item_id: item.item_id().to_owned(),
                    });
                changes.push(SessionChange::ItemsReplaced {
                    old_item_ids: projected.retired,
                    anchor,
                    items: vec![projected.message.item],
                });
                let mut tools = tools(&view.tools).to_vec();
                for tool in projected.message.tools {
                    let tool_id = tool.tool_call_id.clone();
                    projection::merge_tool(&mut tools, tool)?;
                    // The Host envelope is bounded to 16 changes; the native history read
                    // recovers additional tool facts through the existing resync path.
                    if changes.len() == 16 {
                        history_refresh = true;
                        continue;
                    }
                    changes.push(SessionChange::ToolUpdated {
                        tool: tools
                            .iter()
                            .find(|tool| tool.tool_call_id == tool_id)
                            .ok_or(Failure::InvalidReadback)?
                            .clone(),
                    });
                }
            }
        }
        "run.terminal" => {
            let run: RunRecord = rpc::decode(event.payload.clone())?;
            if !run.validate(&event.session_id)
                || event.run_id.as_deref() != Some(run.run_id.as_str())
                || !run.status.terminal()
            {
                return Err(Failure::InvalidReadback);
            }
            changes.push(SessionChange::RunPhaseChanged {
                run_id: run.run_id.clone(),
                phase: run.status.phase(),
            });
            let active = match &view.runtime {
                SessionFact::Complete(runtime) | SessionFact::Incomplete { facts: runtime, .. } => {
                    runtime.active_run_id.as_deref()
                }
                _ => None,
            };
            if active.is_none_or(|active| active == run.run_id) {
                changes.push(SessionChange::RuntimeChanged {
                    runtime: runtime(run.status, None),
                });
            }
            history_refresh = true;
        }
        "cli.started" => {
            if event
                .payload
                .get("instanceId")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err(Failure::InvalidReadback);
            }
            if let Some(run) = &event.run_id {
                if !valid_uuid(run) {
                    return Err(Failure::InvalidReadback);
                }
                changes.push(SessionChange::RunPhaseChanged {
                    run_id: run.clone(),
                    phase: RunPhase::Started,
                });
            }
        }
        kind if kind.starts_with("interaction.") => {
            // Questions are not permission approvals. Their typed list is refreshed by
            // Host's existing history_refresh -> session.resync path after this seq is consumed.
            history_refresh = true;
            if event.payload.get("category").and_then(Value::as_str) == Some("permission") {
                let target = QuestionTarget {
                    session_id: field(&event.payload, "sessionId")?,
                    instance_id: field(&event.payload, "instanceId")?,
                    native_request_id: field(&event.payload, "nativeRequestId")?,
                };
                if target.session_id != event.session_id {
                    return Err(Failure::InvalidReadback);
                }
                let receipt = interaction::receipt(&event.payload, &target)
                    .ok_or(Failure::InvalidReadback)?;
                let approval_id = interaction::approval_id(&target)?;
                let requested = receipt.availability == QuestionAvailability::Pending
                    && receipt.delivery == QuestionDelivery::NotSent;
                changes.push(SessionChange::ApprovalUpdated {
                    approval: ApprovalView {
                        approval_id,
                        run_id: receipt.run_id,
                        phase: if requested {
                            ApprovalPhase::Requested
                        } else {
                            ApprovalPhase::Resolved
                        },
                        option_ids: if requested {
                            vec!["allow".into(), "deny".into()]
                        } else {
                            Vec::new()
                        },
                    },
                });
            }
        }
        _ => {}
    }
    Ok(Projected {
        changes,
        history_refresh,
    })
}
fn field(value: &Value, key: &str) -> Result<String, Failure> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(Failure::InvalidReadback)
}
pub(crate) fn runtime(status: RunStatus, active_run_id: Option<String>) -> RuntimeView {
    RuntimeView {
        phase: status.phase(),
        active_run_id,
        issue: (status == RunStatus::OutcomeUnknown).then_some(RuntimeIssue::Unknown),
        run_progress: None,
        runtime_activity: None,
        error_detail: None,
    }
}
fn items(fact: &SessionFact<Vec<SessionItem>>) -> &[SessionItem] {
    match fact {
        SessionFact::Complete(items) | SessionFact::Incomplete { facts: items, .. } => items,
        _ => &[],
    }
}
fn tools(fact: &SessionFact<Vec<ToolView>>) -> &[ToolView] {
    match fact {
        SessionFact::Complete(tools) | SessionFact::Incomplete { facts: tools, .. } => tools,
        _ => &[],
    }
}
