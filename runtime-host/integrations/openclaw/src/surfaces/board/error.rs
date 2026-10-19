use ::board::{BoardFailure, BoardMethod};

use crate::gateway::{client::GatewayClientError, wire::GatewayError};

pub(super) fn connection_failure(error: GatewayClientError) -> BoardFailure {
    match error {
        GatewayClientError::Authentication => BoardFailure::Forbidden,
        GatewayClientError::Protocol
        | GatewayClientError::RpcFailed
        | GatewayClientError::SecretCleanupFailed => BoardFailure::Unknown,
        _ => BoardFailure::Unavailable,
    }
}

pub(super) fn native_failure(error: &GatewayError) -> BoardFailure {
    match error.board_error_reason() {
        Some("unsupported") => return BoardFailure::Unsupported,
        Some("invalid") => return BoardFailure::Invalid,
        Some("forbidden") => return BoardFailure::Forbidden,
        Some("stale") => return BoardFailure::Stale,
        Some("expired") => return BoardFailure::Expired,
        Some("missing-source") => return BoardFailure::MissingSource,
        Some("unavailable") => return BoardFailure::Unavailable,
        Some("unknown") => return BoardFailure::Unknown,
        _ => {}
    }
    let message = error.message();
    match error.code() {
        "INVALID_REQUEST"
            if BoardMethod::ALL
                .iter()
                .any(|method| message == format!("unknown method: {}", method.as_str())) =>
        {
            BoardFailure::Unsupported
        }
        "FORBIDDEN" | "UNAUTHORIZED" => BoardFailure::Forbidden,
        "INVALID_REQUEST"
            if message == "board widget view ticket is stale"
                || message == "board widget session identity changed; reload the dashboard"
                || message.starts_with("board widget revision changed: ")
                || message.starts_with("board widget instance changed: ") =>
        {
            BoardFailure::Stale
        }
        "INVALID_REQUEST" if message.starts_with("board MCP App widget not found: ") => {
            BoardFailure::Unknown
        }
        "INVALID_REQUEST"
            if message.starts_with("board widget tool is not granted: ")
                || message.starts_with("board widget data binding is not allowed: ")
                || message.starts_with("board widget action verb is not allowed: ")
                || message.starts_with("unauthorized role: ")
                || message.starts_with("missing scope: ") =>
        {
            BoardFailure::Forbidden
        }
        "INVALID_REQUEST"
            if message == "board widget content kind is unavailable"
                || (message.starts_with("widget kind \"")
                    && message.ends_with(
                        " is unavailable; enable the plugin that provides it and retry",
                    )) =>
        {
            BoardFailure::Unavailable
        }
        "INVALID_REQUEST" => BoardFailure::Invalid,
        "UNAVAILABLE" => BoardFailure::Unavailable,
        _ => BoardFailure::Unknown,
    }
}
