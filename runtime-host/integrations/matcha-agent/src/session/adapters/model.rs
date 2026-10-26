use crate::session::rpc::{Failure, FailureKind};
use serde_json::{Value, json};
use sessions_module::send::{SessionSendCommand, SessionSendOutcome};

pub(super) fn send_failure(error: Failure) -> SessionSendOutcome {
    match error.kind() {
        FailureKind::Rejected => SessionSendOutcome::Rejected,
        FailureKind::Unavailable | FailureKind::Cancelled => SessionSendOutcome::Unavailable,
        FailureKind::Unknown => SessionSendOutcome::Unknown,
    }
}

pub(super) fn unsupported_budget(
    budget: &organization::TaskExecutionBudget,
) -> Vec<organization::TaskBudgetDimension> {
    use organization::TaskBudgetDimension::*;
    let mut dimensions = vec![
        Steps,
        SourceReads,
        Rows,
        Bytes,
        ModelCalls,
        InputTokens,
        OutputTokens,
    ];
    if budget.max_wall_time_ms == 0
        || budget.max_wall_time_ms > 9_007_199_254_740_991
        || tokio::time::Instant::now()
            .checked_add(std::time::Duration::from_millis(budget.max_wall_time_ms))
            .is_none()
    {
        dimensions.push(WallTime);
    }
    if budget.max_cost.is_some() {
        dimensions.push(Cost);
    }
    if budget.deadline_unix_ms.is_some() {
        dimensions.push(Deadline);
    }
    dimensions
}

pub(super) fn native_budget(budget: &organization::TaskExecutionBudget) -> Value {
    json!({
        "maxWallTimeMs":budget.max_wall_time_ms,
        "maxSteps":budget.max_steps, "maxSourceReads":budget.max_source_reads,
        "maxRows":budget.max_rows, "maxBytes":budget.max_bytes,
        "maxModelCalls":budget.max_model_calls, "maxInputTokens":budget.max_input_tokens,
        "maxOutputTokens":budget.max_output_tokens,
        "maxCost":budget.max_cost.as_ref().map(|cost| json!({"amount":cost.amount,"currency":cost.currency})),
        "deadlineUnixMs":budget.deadline_unix_ms,
    })
}

pub(super) fn content(command: &SessionSendCommand) -> Result<Value, SessionSendOutcome> {
    if command.attachments.is_empty() {
        return if command.message.is_empty() {
            Err(SessionSendOutcome::Rejected)
        } else {
            Ok(json!(command.message))
        };
    }
    let mut blocks = Vec::new();
    if !command.message.is_empty() {
        blocks.push(json!({"type":"text","text":command.message}));
    }
    for attachment in &command.attachments {
        let kind = match attachment.mime_type.as_str() {
            "image/jpeg" | "image/png" | "image/gif" | "image/webp" => "image",
            "application/pdf" => "document",
            _ => return Err(SessionSendOutcome::Unsupported),
        };
        blocks.push(json!({"type":kind,"source":{"type":"base64","media_type":attachment.mime_type,"data":attachment.content}}));
    }
    Ok(Value::Array(blocks))
}
