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
