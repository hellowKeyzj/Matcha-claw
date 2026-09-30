mod anthropic;
mod client;
mod error;
mod openai_chat;
mod openai_responses;
mod types;

async fn consume_sse(
    mut response: reqwest::Response,
    sink: &mut dyn types::LlmStreamSink,
    parse: fn(&str) -> Vec<types::LlmStreamEvent>,
) -> Result<(), error::LlmClientError> {
    const MAX_FRAME_BYTES: usize = 1024 * 1024;
    let mut buffer = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        buffer.extend_from_slice(&chunk);
        while let Some((end, separator)) = sse_frame_end(&buffer) {
            if end > MAX_FRAME_BYTES {
                return Err(error::LlmClientError::Protocol(
                    "provider stream frame is too large".into(),
                ));
            }
            let frame = std::str::from_utf8(&buffer[..end]).map_err(|_| {
                error::LlmClientError::Protocol("invalid provider stream UTF-8".into())
            })?;
            if emit_sse_frame(frame, sink, parse).await? {
                return Ok(());
            }
            buffer.drain(..end + separator);
        }
        if buffer.len() > MAX_FRAME_BYTES {
            return Err(error::LlmClientError::Protocol(
                "provider stream frame is too large".into(),
            ));
        }
    }
    if !buffer.is_empty() {
        let frame = std::str::from_utf8(&buffer)
            .map_err(|_| error::LlmClientError::Protocol("invalid provider stream UTF-8".into()))?;
        if emit_sse_frame(frame, sink, parse).await? {
            return Ok(());
        }
    }
    Err(error::LlmClientError::Protocol(
        "provider stream ended before completion".into(),
    ))
}

fn sse_frame_end(buffer: &[u8]) -> Option<(usize, usize)> {
    buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2))
        .into_iter()
        .chain(
            buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| (index, 4)),
        )
        .min_by_key(|(index, _)| *index)
}

async fn emit_sse_frame(
    frame: &str,
    sink: &mut dyn types::LlmStreamSink,
    parse: fn(&str) -> Vec<types::LlmStreamEvent>,
) -> Result<bool, error::LlmClientError> {
    if frame.lines().any(|line| {
        line.strip_prefix("data:")
            .is_some_and(|data| data.trim() == "[DONE]")
    }) {
        return Ok(true);
    }
    let terminal = frame.lines().any(|line| {
        line.strip_prefix("event:")
            .is_some_and(|event| event.trim() == "message_stop")
            || line.strip_prefix("data:").is_some_and(|data| {
                serde_json::from_str::<serde_json::Value>(data.trim())
                    .ok()
                    .is_some_and(|payload| {
                        matches!(
                            payload.get("type").and_then(serde_json::Value::as_str),
                            Some("message_stop" | "response.completed" | "response.incomplete")
                        )
                    })
            })
    });
    for event in parse(frame) {
        if matches!(event, types::LlmStreamEvent::Diagnostic(_)) {
            return Err(error::LlmClientError::Protocol(
                "provider stream reported an error".into(),
            ));
        }
        sink.send(event).await?;
    }
    Ok(terminal)
}

pub use client::LlmClient;
pub use error::LlmClientError;
pub use types::{
    LlmCredential, LlmCredentialKind, LlmEndpoint, LlmFinishReason, LlmGenerationOptions,
    LlmImageContent, LlmMessage, LlmMessageContent, LlmMessagePart, LlmRequest, LlmResponse,
    LlmRole, LlmStreamEvent, LlmStreamSink, LlmUsage,
};
