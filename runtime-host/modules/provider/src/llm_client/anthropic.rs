use serde_json::{Map, Value, json};

use super::{
    LlmClientError,
    types::{
        LlmCredential, LlmCredentialKind, LlmFinishReason, LlmMessage, LlmMessageContent,
        LlmMessagePart, LlmRequest, LlmResponse, LlmRole, LlmStreamEvent, LlmStreamSink, LlmUsage,
    },
};

const ANTHROPIC_VERSION: &str = "2023-06-01";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const DEFAULT_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct AnthropicMessagesRequest {
    pub base_url: String,
    pub credential: LlmCredential,
    pub credential_kind: LlmCredentialKind,
    pub model: String,
    pub messages: Vec<LlmMessage>,
    pub stream: bool,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub top_k: Option<u32>,
    pub stop_sequences: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnthropicMessagesHttpRequest {
    pub endpoint: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

pub async fn generate(
    http: &reqwest::Client,
    request: LlmRequest,
) -> Result<LlmResponse, LlmClientError> {
    let http_request = build_anthropic_messages_http_request(&anthropic_request(request, false));
    let payload = send_json(http, &http_request).await?;
    Ok(parse_anthropic_messages_text_response(&payload))
}

pub async fn stream_generate(
    http: &reqwest::Client,
    request: LlmRequest,
    sink: &mut dyn LlmStreamSink,
) -> Result<(), LlmClientError> {
    let http_request = build_anthropic_messages_http_request(&anthropic_request(request, true));
    let mut builder = http
        .post(&http_request.endpoint)
        .body(http_request.body.to_string());
    for (name, value) in &http_request.headers {
        builder = builder.header(*name, value);
    }
    let response = builder.send().await?;
    if !response.status().is_success() {
        return Err(LlmClientError::Protocol(format!(
            "Anthropic Messages stream failed with HTTP {}",
            response.status()
        )));
    }
    super::consume_sse(response, sink, parse_anthropic_messages_sse_chunk).await
}

pub fn build_anthropic_messages_http_request(
    request: &AnthropicMessagesRequest,
) -> AnthropicMessagesHttpRequest {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(request.model.clone()));
    body.insert(
        "max_tokens".into(),
        json!(request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)),
    );
    body.insert("stream".into(), Value::Bool(request.stream));
    body.insert("messages".into(), build_messages(&request.messages));

    if let Some(system) = build_system(&request.messages) {
        body.insert(
            "system".into(),
            json!([{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }]),
        );
    }
    if let Some(temperature) = request.temperature {
        body.insert("temperature".into(), json!(temperature));
    }
    if let Some(top_p) = request.top_p {
        body.insert("top_p".into(), json!(top_p));
    }
    if let Some(top_k) = request.top_k {
        body.insert("top_k".into(), json!(top_k));
    }
    if !request.stop_sequences.is_empty() {
        body.insert("stop_sequences".into(), json!(request.stop_sequences));
    }

    AnthropicMessagesHttpRequest {
        endpoint: messages_endpoint(&request.base_url),
        headers: headers(&request.credential, request.credential_kind),
        body: Value::Object(body),
    }
}

pub fn parse_anthropic_messages_text_response(payload: &Value) -> LlmResponse {
    LlmResponse {
        text: extract_text(payload),
        finish_reason: payload
            .get("stop_reason")
            .and_then(Value::as_str)
            .map(map_stop_reason),
        usage: extract_usage(payload),
    }
}

pub fn parse_anthropic_messages_sse_chunk(chunk: &str) -> Vec<LlmStreamEvent> {
    let mut events = Vec::new();

    for frame in chunk.split("\n\n") {
        let event_name = frame
            .lines()
            .find_map(|line| line.trim_start().strip_prefix("event:"))
            .map(str::trim);
        let data = frame
            .lines()
            .filter_map(|line| line.trim_start().strip_prefix("data:"))
            .map(str::trim)
            .collect::<Vec<_>>()
            .join("\n");

        if data.is_empty() || data == "[DONE]" {
            continue;
        }

        match serde_json::from_str::<Value>(&data) {
            Ok(payload) => push_stream_event(event_name, &payload, &mut events),
            Err(error) => events.push(LlmStreamEvent::Diagnostic(error.to_string())),
        }
    }

    events
}

pub fn parse_anthropic_messages_error(payload: &Value) -> Option<String> {
    payload
        .get("error")
        .and_then(error_message)
        .or_else(|| error_message(payload))
}

async fn send_json(
    http: &reqwest::Client,
    request: &AnthropicMessagesHttpRequest,
) -> Result<Value, LlmClientError> {
    let text = send_text(http, request).await?;
    serde_json::from_str(&text).map_err(|error| {
        LlmClientError::Protocol(format!("invalid Anthropic Messages JSON response: {error}"))
    })
}

async fn send_text(
    http: &reqwest::Client,
    request: &AnthropicMessagesHttpRequest,
) -> Result<String, LlmClientError> {
    let mut builder = http.post(&request.endpoint).body(request.body.to_string());
    for (name, value) in &request.headers {
        builder = builder.header(*name, value);
    }

    let response = builder.send().await?;
    let status = response.status();
    let text = response.text().await?;
    if status.is_success() {
        return Ok(text);
    }

    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|payload| parse_anthropic_messages_error(&payload))
        .unwrap_or_else(|| format!("Anthropic Messages request failed with HTTP {status}"));
    Err(LlmClientError::Protocol(message))
}

fn anthropic_request(request: LlmRequest, stream: bool) -> AnthropicMessagesRequest {
    let credential_kind = request.credential.kind();
    let options = request.options;
    AnthropicMessagesRequest {
        base_url: request.endpoint.endpoint().as_str().to_string(),
        credential: request.credential,
        credential_kind,
        model: request.model,
        messages: request.messages,
        stream,
        max_tokens: options.max_output_tokens,
        temperature: options.temperature,
        top_p: options.top_p,
        top_k: options.top_k,
        stop_sequences: options.stop,
    }
}

fn messages_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/messages") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/messages")
    }
}

fn headers(
    credential: &LlmCredential,
    credential_kind: LlmCredentialKind,
) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        ("anthropic-version", ANTHROPIC_VERSION.to_string()),
        ("Content-Type", "application/json".to_string()),
    ];
    match credential_kind {
        LlmCredentialKind::ApiKey => headers.push(("x-api-key", credential.token().to_string())),
        LlmCredentialKind::Bearer => {
            headers.push(("Authorization", format!("Bearer {}", credential.token())));
            headers.push(("anthropic-beta", OAUTH_BETA.to_string()));
        }
    }
    headers
}

fn build_system(messages: &[LlmMessage]) -> Option<String> {
    let system = messages
        .iter()
        .filter(|message| message.role == LlmRole::System)
        .map(LlmMessage::text_content)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!system.is_empty()).then_some(system)
}

fn build_messages(messages: &[LlmMessage]) -> Value {
    Value::Array(
        messages
            .iter()
            .filter(|message| message.role != LlmRole::System)
            .map(|message| {
                json!({
                    "role": role_name(message.role),
                    "content": build_content(&message.content),
                })
            })
            .collect(),
    )
}

fn build_content(content: &LlmMessageContent) -> Value {
    match content {
        LlmMessageContent::Text(text) => json!([{"type": "text", "text": text}]),
        LlmMessageContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    LlmMessagePart::Text(text) => json!({"type": "text", "text": text}),
                    LlmMessagePart::Image(image) => json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.mime_type(),
                            "data": image.data_base64(),
                        },
                    }),
                })
                .collect(),
        ),
    }
}

fn role_name(role: LlmRole) -> &'static str {
    match role {
        LlmRole::System => "system",
        LlmRole::User => "user",
        LlmRole::Assistant => "assistant",
    }
}

fn extract_text(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| {
            (part.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| part.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>()
        .join("")
}

fn extract_usage(payload: &Value) -> Option<LlmUsage> {
    let usage = payload.get("usage")?;
    Some(LlmUsage {
        input_tokens: usage.get("input_tokens").and_then(number_to_u32),
        output_tokens: usage.get("output_tokens").and_then(number_to_u32),
        total_tokens: None,
    })
}

fn number_to_u32(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|value| u32::try_from(value).ok())
}

fn map_stop_reason(reason: &str) -> LlmFinishReason {
    match reason {
        "end_turn" | "stop_sequence" => LlmFinishReason::Stop,
        "max_tokens" => LlmFinishReason::Length,
        "tool_use" => LlmFinishReason::ToolUse,
        "refusal" => LlmFinishReason::ContentFilter,
        other => LlmFinishReason::Other(other.to_string()),
    }
}

fn push_stream_event(event_name: Option<&str>, payload: &Value, events: &mut Vec<LlmStreamEvent>) {
    match payload
        .get("type")
        .and_then(Value::as_str)
        .or(event_name)
        .unwrap_or_default()
    {
        "content_block_delta" => {
            if payload
                .get("delta")
                .and_then(|delta| delta.get("type"))
                .and_then(Value::as_str)
                == Some("text_delta")
            {
                if let Some(text) = payload
                    .get("delta")
                    .and_then(|delta| delta.get("text"))
                    .and_then(Value::as_str)
                {
                    events.push(LlmStreamEvent::TextDelta(text.to_string()));
                }
            }
        }
        "message_delta" => {
            if let Some(reason) = payload
                .get("delta")
                .and_then(|delta| delta.get("stop_reason"))
                .and_then(Value::as_str)
            {
                events.push(LlmStreamEvent::FinishReason(map_stop_reason(reason)));
            }
            if let Some(usage) = extract_usage(payload) {
                events.push(LlmStreamEvent::Usage(usage));
            }
        }
        "message_stop" => events.push(LlmStreamEvent::FinalText(String::new())),
        "error" => events.push(LlmStreamEvent::Diagnostic(
            parse_anthropic_messages_error(payload)
                .unwrap_or_else(|| "Anthropic Messages stream error".to_string()),
        )),
        _ => {}
    }
}

fn error_message(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_endpoint_headers_system_and_messages() {
        let request = build_anthropic_messages_http_request(&AnthropicMessagesRequest {
            base_url: "https://api.anthropic.com/v1/".to_string(),
            credential: LlmCredential::new("token"),
            credential_kind: LlmCredentialKind::Bearer,
            model: "claude-opus-5".to_string(),
            messages: vec![
                LlmMessage::text(LlmRole::System, "be terse"),
                LlmMessage::text(LlmRole::User, "hi"),
            ],
            stream: true,
            max_tokens: None,
            temperature: Some(0.2),
            top_p: Some(0.9),
            top_k: Some(40),
            stop_sequences: vec!["END".to_string()],
        });

        assert_eq!(request.endpoint, "https://api.anthropic.com/v1/messages");
        assert!(
            request
                .headers
                .contains(&("anthropic-beta", OAUTH_BETA.to_string()))
        );
        assert_eq!(
            request.body["system"],
            json!([{ "type": "text", "text": "be terse", "cache_control": { "type": "ephemeral" } }])
        );
        assert_eq!(request.body["max_tokens"], DEFAULT_MAX_TOKENS);
        assert_eq!(request.body["messages"][0]["role"], "user");
        assert!((request.body["top_p"].as_f64().unwrap() - 0.9).abs() < 0.000_001);
        assert_eq!(request.body["top_k"], 40);
        assert_eq!(request.body["stop_sequences"][0], "END");
    }

    #[test]
    fn builds_user_text_and_image_content() {
        let request = build_anthropic_messages_http_request(&AnthropicMessagesRequest {
            base_url: "https://api.anthropic.com/v1".to_string(),
            credential: LlmCredential::new("token"),
            credential_kind: LlmCredentialKind::ApiKey,
            model: "claude-opus-5".to_string(),
            messages: vec![LlmMessage::parts(
                LlmRole::User,
                vec![
                    LlmMessagePart::Text("describe".to_string()),
                    LlmMessagePart::Image(super::super::types::LlmImageContent::new(
                        "image/png",
                        "abc123",
                    )),
                ],
            )],
            stream: false,
            max_tokens: Some(128),
            temperature: None,
            top_p: None,
            top_k: None,
            stop_sequences: Vec::new(),
        });

        assert_eq!(
            request.body["messages"],
            json!([{
                "role": "user",
                "content": [
                    { "type": "text", "text": "describe" },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "abc123" } }
                ]
            }])
        );
    }

    #[test]
    fn builds_cacheable_system_text_blocks_without_images() {
        let request = build_anthropic_messages_http_request(&AnthropicMessagesRequest {
            base_url: "https://api.anthropic.com/v1".to_string(),
            credential: LlmCredential::new("token"),
            credential_kind: LlmCredentialKind::ApiKey,
            model: "claude-opus-5".to_string(),
            messages: vec![LlmMessage::parts(
                LlmRole::System,
                vec![
                    LlmMessagePart::Text("rule one".to_string()),
                    LlmMessagePart::Image(super::super::types::LlmImageContent::new(
                        "image/jpeg",
                        "ignored",
                    )),
                    LlmMessagePart::Text("rule two".to_string()),
                ],
            )],
            stream: false,
            max_tokens: Some(128),
            temperature: None,
            top_p: None,
            top_k: None,
            stop_sequences: Vec::new(),
        });

        assert_eq!(
            request.body["system"],
            json!([{ "type": "text", "text": "rule one\n\nrule two", "cache_control": { "type": "ephemeral" } }])
        );
        assert_eq!(request.body["messages"], json!([]));
    }

    #[test]
    fn keeps_existing_messages_endpoint() {
        assert_eq!(
            messages_endpoint("https://example.test/v1/messages/"),
            "https://example.test/v1/messages"
        );
    }

    #[test]
    fn uses_api_key_header_without_oauth_beta() {
        let request = build_anthropic_messages_http_request(&AnthropicMessagesRequest {
            base_url: "https://api.anthropic.com/v1".to_string(),
            credential: LlmCredential::new("token"),
            credential_kind: LlmCredentialKind::ApiKey,
            model: "claude-opus-5".to_string(),
            messages: Vec::new(),
            stream: false,
            max_tokens: Some(128),
            temperature: None,
            top_p: None,
            top_k: None,
            stop_sequences: Vec::new(),
        });

        assert!(
            request
                .headers
                .contains(&("x-api-key", "token".to_string()))
        );
        assert!(
            !request
                .headers
                .iter()
                .any(|(name, _)| *name == "anthropic-beta")
        );
    }

    #[test]
    fn parses_text_finish_and_usage() {
        let parsed = parse_anthropic_messages_text_response(&json!({
            "content": [
                {"type": "text", "text": "hello "},
                {"type": "tool_use", "name": "skip"},
                {"type": "thinking", "thinking": "skip"},
                {"type": "text", "text": "world"}
            ],
            "stop_reason": "max_tokens",
            "usage": {"input_tokens": 1, "output_tokens": 2}
        }));

        assert_eq!(parsed.text, "hello world");
        assert_eq!(parsed.finish_reason, Some(LlmFinishReason::Length));
        assert_eq!(
            parsed.usage,
            Some(LlmUsage {
                input_tokens: Some(1),
                output_tokens: Some(2),
                total_tokens: None,
            })
        );
    }

    #[test]
    fn parses_sse_text_delta_terminal_usage_and_error() {
        let events = parse_anthropic_messages_sse_chunk(
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n\
             event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n\
             event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n\
             event: error\ndata: {\"type\":\"error\",\"error\":{\"message\":\"bad\"}}\n\n",
        );

        assert_eq!(events[0], LlmStreamEvent::TextDelta("hi".to_string()));
        assert_eq!(
            events[1],
            LlmStreamEvent::FinishReason(LlmFinishReason::Stop)
        );
        assert_eq!(
            events[2],
            LlmStreamEvent::Usage(LlmUsage {
                input_tokens: None,
                output_tokens: Some(2),
                total_tokens: None,
            })
        );
        assert_eq!(events[3], LlmStreamEvent::FinalText(String::new()));
        assert_eq!(events[4], LlmStreamEvent::Diagnostic("bad".to_string()));
    }
}
