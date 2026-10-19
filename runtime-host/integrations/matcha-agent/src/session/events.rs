use std::fmt;

use super::{
    interaction,
    model::{ClassifiedErrorKind, RunRecord, RunStatus, valid_uuid},
    projection::{self, Streaming},
    rpc::{self, Failure},
};
use crate::client::Event;
use serde_json::{Value, json};
use sessions_module::{
    question::{QuestionAvailability, QuestionDelivery, QuestionTarget},
    state::{
        ApprovalPhase, ApprovalView, ItemAnchor, RuntimeIssue, RuntimeView, SessionChange,
        SessionFact, SessionItem, SessionState, ToolView,
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
    pub run: Option<RunRecord>,
}
pub(crate) fn project(
    streaming: &mut Streaming,
    event: &Event,
    state: &SessionState,
) -> Result<Projected, Failure> {
    let mut changes = Vec::new();
    let mut history_refresh = false;
    let mut run_fact = None;
    match event.kind.as_str() {
        "native.message" | "cli.started" | "cli.exited" | "cli.fault" => {
            if let Some(projected) = streaming.observe(event)? {
                let items = items(state.items());
                let replaced = |item: &SessionItem| {
                    projected.retired.iter().any(|id| id == item.item_id())
                        || projected
                            .messages
                            .iter()
                            .any(|message| message.item.item_id() == item.item_id())
                };
                let position = items.iter().position(replaced).unwrap_or(items.len());
                let anchor = items[..position]
                    .iter()
                    .rev()
                    .find(|item| !replaced(item))
                    .map_or(ItemAnchor::Start, |item| ItemAnchor::After {
                        item_id: item.item_id().to_owned(),
                    });
                let mut incoming_items = Vec::new();
                let mut incoming_tools = Vec::new();
                for message in projected.messages {
                    // Live user messages acknowledge input or carry tool results; history owns user rows.
                    if !matches!(message.item, SessionItem::UserMessage { .. }) {
                        incoming_items.push(message.item);
                    }
                    incoming_tools.extend(message.tools);
                }
                if !incoming_items.is_empty() || !projected.retired.is_empty() {
                    changes.push(SessionChange::ItemsReplaced {
                        old_item_ids: projected.retired,
                        anchor,
                        items: incoming_items,
                    });
                }
                if !incoming_tools.is_empty() {
                    let mut tools = tools(state.tools()).to_vec();
                    for tool in incoming_tools {
                        let tool_id = tool.tool_call_id.clone();
                        projection::merge_tool(&mut tools, tool).inspect_err(|error| {
                            trace_failure(event, "native.message.tool_merge_failed", error)
                        })?;
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
                                .ok_or(Failure::InvalidReadback)
                                .inspect_err(|error| {
                                    trace_failure(event, "native.message.tool_not_found", error)
                                })?
                                .clone(),
                        });
                    }
                }
            }
        }
        "run.changed" | "run.terminal" => {
            let run: RunRecord = rpc::decode(event.payload.clone())
                .inspect_err(|error| trace_failure(event, "run.decode_failed", error))?;
            if !run.validate(&event.session_id)
                || event.run_id.as_deref() != Some(run.run_id.as_str())
                || run.status.terminal() != (event.kind == "run.terminal")
            {
                let reason = if run.session_id != event.session_id {
                    "run.session_mismatch"
                } else if !valid_uuid(&run.run_id) {
                    "run.run_id_invalid"
                } else if !valid_uuid(&run.message_id) {
                    "run.message_id_invalid"
                } else if event.run_id.as_deref() != Some(run.run_id.as_str()) {
                    "run.run_id_mismatch"
                } else {
                    "run.status_mismatch"
                };
                trace_failure(event, reason, &Failure::InvalidReadback);
                return Err(Failure::InvalidReadback);
            }
            let runtime = run_runtime(&run, state.runtime());
            if (run.status.terminal() || runtime.is_some()) && !state.has_terminal_run(&run.run_id)
            {
                changes.push(SessionChange::RunPhaseChanged {
                    run_id: run.run_id.clone(),
                    phase: run.status.phase(),
                });
            }
            if let Some(runtime) = runtime {
                changes.push(SessionChange::RuntimeChanged { runtime });
            }
            history_refresh = run.status.terminal();
            run_fact = Some(run);
        }
        kind if kind.starts_with("interaction.") => {
            // Questions are not permission approvals. Their typed list is refreshed by
            // Host's existing history_refresh -> session.resync path after this seq is consumed.
            history_refresh = true;
            if event.payload.get("category").and_then(Value::as_str) == Some("permission") {
                let target = QuestionTarget {
                    session_id: field(&event.payload, "sessionId").inspect_err(|error| {
                        trace_failure(event, "interaction.session_id_field_invalid", error)
                    })?,
                    instance_id: field(&event.payload, "instanceId").inspect_err(|error| {
                        trace_failure(event, "interaction.instance_id_field_invalid", error)
                    })?,
                    native_request_id: field(&event.payload, "nativeRequestId").inspect_err(
                        |error| {
                            trace_failure(
                                event,
                                "interaction.native_request_id_field_invalid",
                                error,
                            )
                        },
                    )?,
                };
                if target.session_id != event.session_id {
                    trace_failure(
                        event,
                        "interaction.session_mismatch",
                        &Failure::InvalidReadback,
                    );
                    return Err(Failure::InvalidReadback);
                }
                let receipt = interaction::receipt(&event.payload, &target)
                    .ok_or(Failure::InvalidReadback)
                    .inspect_err(|error| {
                        trace_failure(event, "interaction.receipt_invalid", error)
                    })?;
                let approval_id = interaction::approval_id(&target).inspect_err(|error| {
                    trace_failure(event, "interaction.approval_id_invalid", error)
                })?;
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
        run: run_fact,
    })
}
fn trace_failure(event: &Event, reason: &'static str, error: &Failure) {
    platform::trace::runtime_trace("matcha.session.event.rejected", || {
        json!({
            "reason": reason,
            "sessionHash": platform::trace::identifier_hash(&event.session_id),
            "nativeSeq": event.seq,
            "eventKind": trace_kind(&event.kind),
            "row": projection::trace_shape(&event.payload),
            "failure": error.trace_summary(),
        })
    });
}
pub(crate) fn trace_kind(kind: &str) -> &'static str {
    match kind {
        "native.message" => "native.message",
        "run.changed" => "run.changed",
        "run.terminal" => "run.terminal",
        "cli.started" => "cli.started",
        "cli.exited" => "cli.exited",
        "cli.fault" => "cli.fault",
        "interaction.requested" => "interaction.requested",
        "interaction.recovered" => "interaction.recovered",
        "interaction.response_reserved" => "interaction.response_reserved",
        "interaction.response_delivery" => "interaction.response_delivery",
        "interaction.native_cancelled" => "interaction.native_cancelled",
        "interaction.orphan_cancel" => "interaction.orphan_cancel",
        "interaction.instance_closed" => "interaction.instance_closed",
        _ => "other",
    }
}
fn field(value: &Value, key: &str) -> Result<String, Failure> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(Failure::InvalidReadback)
}
pub(crate) fn run_runtime(
    run: &RunRecord,
    current: &SessionFact<RuntimeView>,
) -> Option<RuntimeView> {
    let active = match current {
        SessionFact::Complete(runtime) | SessionFact::Incomplete { facts: runtime, .. } => {
            runtime.active_run_id.as_deref()
        }
        _ => None,
    };
    if (run.status.terminal() || run.status == RunStatus::Queued)
        && active.is_some_and(|id| id != run.run_id)
    {
        return None;
    }
    Some(runtime(
        run.status,
        (!run.status.terminal()).then(|| run.run_id.clone()),
    ))
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
