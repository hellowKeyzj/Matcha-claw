use std::time::Instant;

use platform::trace::session_trace;
use serde_json::{Map, Value, json};

use super::LlmClientError;
use super::types::{
    LlmCredential, LlmFinishReason, LlmGenerationOptions, LlmMessage, LlmMessageContent,
    LlmMessagePart, LlmRequest, LlmResponse, LlmRole, LlmStreamEvent, LlmStreamSink, LlmUsage,
};

#[derive(Debug, Clone, PartialEq)]
pub struct OpenAiResponsesRequest {
    pub base_url: String,
    pub credential: LlmCredential,
    pub model: String,
    pub messages: Vec<LlmMessage>,
    pub stream: bool,
    pub options: LlmGenerationOptions,
    pub top_p: Option<f32>,
    pub stop: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiResponsesHttpRequest {
    pub endpoint: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

pub async fn generate(
    http: &reqwest::Client,
    request: LlmRequest,
) -> Result<LlmResponse, LlmClientError> {
    let http_request =
        build_openai_responses_http_request(&openai_responses_request(request, false));
    let payload = send_json(http, &http_request).await?;

    Ok(parse_openai_responses_text_response(&payload))
}

pub async fn stream_generate(
    http: &reqwest::Client,
    request: LlmRequest,
    sink: &mut dyn LlmStreamSink,
) -> Result<(), LlmClientError> {
    let http_request =
        build_openai_responses_http_request(&openai_responses_request(request, true));
    let mut builder = http
        .post(&http_request.endpoint)
        .body(http_request.body.to_string());
    for (name, value) in &http_request.headers {
        builder = builder.header(*name, value);
    }
    let started = Instant::now();
    let response = builder.send().await?;
    session_trace("runtime.team.provider.http.response", json!({
        "protocol": "open_ai_responses", "statusCode": response.status().as_u16(),
        "elapsedMs": started.elapsed().as_millis() as u64,
    }));
    if !response.status().is_success() {
        return Err(LlmClientError::Protocol(format!(
            "OpenAI Responses stream failed with HTTP {}",
            response.status()
        )));
    }
    super::consume_sse(response, sink, parse_openai_responses_sse_chunk).await
}

pub fn build_openai_responses_http_request(
    request: &OpenAiResponsesRequest,
) -> OpenAiResponsesHttpRequest {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(request.model.clone()));
    body.insert("input".into(), build_input(&request.messages));
    body.insert("stream".into(), Value::Bool(request.stream));

    if let Some(temperature) = request.options.temperature {
        body.insert("temperature".into(), json!(temperature));
    }
    if let Some(top_p) = request.top_p {
        body.insert("top_p".into(), json!(top_p));
    }
    if let Some(max_output_tokens) = request.options.max_output_tokens {
        body.insert("max_output_tokens".into(), json!(max_output_tokens));
    }
    if !request.stop.is_empty() {
        body.insert("stop".into(), json!(request.stop));
    }

    OpenAiResponsesHttpRequest {
        endpoint: responses_endpoint(&request.base_url),
        headers: vec![
            (
                "Authorization",
                format!("Bearer {}", request.credential.token()),
            ),
            ("Content-Type", "application/json".to_string()),
        ],
        body: Value::Object(body),
    }
}

pub fn parse_openai_responses_text_response(payload: &Value) -> LlmResponse {
    LlmResponse {
        text: extract_output_text(payload),
        finish_reason: extract_finish_reason(payload),
        usage: extract_usage(payload),
    }
}

pub fn parse_openai_responses_sse_chunk(chunk: &str) -> Vec<LlmStreamEvent> {
    let mut events = Vec::new();

    for frame in chunk.split("\n\n") {
        let data = frame
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .collect::<Vec<_>>()
            .join("\n");

        if data.is_empty() || data == "[DONE]" {
            continue;
        }

        match serde_json::from_str::<Value>(&data) {
            Ok(payload) => push_stream_events(&payload, &mut events),
            Err(error) => events.push(LlmStreamEvent::Diagnostic(format!(
                "invalid OpenAI Responses stream JSON: {error}"
            ))),
        }
    }

    events
}

pub fn parse_openai_responses_error(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;
    Some(
        error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .unwrap_or("OpenAI Responses provider error")
            .to_string(),
    )
}

async fn send_json(
    http: &reqwest::Client,
    request: &OpenAiResponsesHttpRequest,
) -> Result<Value, LlmClientError> {
    let started = Instant::now();
    let text = send_text(http, request).await?;
    serde_json::from_str(&text).map_err(|error| {
        session_trace("runtime.team.provider.http.parse-failed", json!({
            "protocol": "open_ai_responses", "class": "JsonDecode",
            "elapsedMs": started.elapsed().as_millis() as u64,
        }));
        LlmClientError::Protocol(format!("invalid OpenAI Responses JSON response: {error}"))
    })
}

async fn send_text(
    http: &reqwest::Client,
    request: &OpenAiResponsesHttpRequest,
) -> Result<String, LlmClientError> {
    let mut builder = http.post(&request.endpoint).body(request.body.to_string());
    for (name, value) in &request.headers {
        builder = builder.header(*name, value);
    }

    let started = Instant::now();
    let response = builder.send().await?;
    session_trace("runtime.team.provider.http.response", json!({
        "protocol": "open_ai_responses", "statusCode": response.status().as_u16(),
        "elapsedMs": started.elapsed().as_millis() as u64,
    }));
    let status = response.status();
    let text = response.text().await?;

    if status.is_success() {
        return Ok(text);
    }

    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|payload| parse_openai_responses_error(&payload))
        .unwrap_or_else(|| format!("OpenAI Responses request failed with HTTP {status}"));
    Err(LlmClientError::Protocol(message))
}

fn openai_responses_request(request: LlmRequest, stream: bool) -> OpenAiResponsesRequest {
    let top_p = request.options.top_p;
    let stop = request.options.stop.clone();
    OpenAiResponsesRequest {
        base_url: request.endpoint.endpoint().as_str().to_string(),
        credential: request.credential,
        model: request.model,
        messages: request.messages,
        stream,
        options: request.options,
        top_p,
        stop,
    }
}

fn responses_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/responses") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/responses")
    }
}

fn build_input(messages: &[LlmMessage]) -> Value {
    if messages.len() == 1 && messages[0].role == LlmRole::User {
        if let Some(text) = messages[0].as_text_only() {
            return Value::String(text.to_owned());
        }
    }

    Value::Array(
        messages
            .iter()
            .map(|message| {
                json!({
                    "role": role_name(message.role),
                    "content": build_content(message),
                })
            })
            .collect(),
    )
}

fn build_content(message: &LlmMessage) -> Value {
    let text_type = match message.role {
        LlmRole::Assistant => "output_text",
        LlmRole::System | LlmRole::User => "input_text",
    };
    match &message.content {
        LlmMessageContent::Text(text) => json!([{"type": text_type, "text": text}]),
        LlmMessageContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    LlmMessagePart::Text(text) => json!({"type": text_type, "text": text}),
                    LlmMessagePart::Image(image) => json!({
                        "type": "input_image",
                        "detail": "auto",
                        "image_url": image.data_url(),
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

fn extract_output_text(payload: &Value) -> String {
    if let Some(text) = payload.get("output_text").and_then(Value::as_str) {
        return text.to_string();
    }

    payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|part| {
            let kind = part.get("type").and_then(Value::as_str)?;
            if kind == "output_text" || kind == "text" {
                part.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

fn extract_finish_reason(payload: &Value) -> Option<LlmFinishReason> {
    match payload.get("status").and_then(Value::as_str) {
        Some("completed") => return Some(LlmFinishReason::Stop),
        Some("failed") => return Some(LlmFinishReason::Other("failed".to_string())),
        Some("incomplete") => {
            return payload
                .get("incomplete_details")
                .and_then(|details| details.get("reason"))
                .and_then(Value::as_str)
                .map(map_finish_reason)
                .or(Some(LlmFinishReason::Length));
        }
        _ => {}
    }

    payload
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(map_finish_reason)
}

fn map_finish_reason(reason: &str) -> LlmFinishReason {
    match reason {
        "stop" => LlmFinishReason::Stop,
        "length" | "max_output_tokens" => LlmFinishReason::Length,
        "content_filter" => LlmFinishReason::ContentFilter,
        other => LlmFinishReason::Other(other.to_string()),
    }
}

fn extract_usage(payload: &Value) -> Option<LlmUsage> {
    let usage = payload.get("usage").or_else(|| {
        payload
            .get("response")
            .and_then(|response| response.get("usage"))
    })?;

    Some(LlmUsage {
        input_tokens: usage.get("input_tokens").and_then(number_to_u32),
        output_tokens: usage.get("output_tokens").and_then(number_to_u32),
        total_tokens: usage.get("total_tokens").and_then(number_to_u32),
    })
}

fn number_to_u32(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|value| u32::try_from(value).ok())
}

fn push_stream_events(payload: &Value, events: &mut Vec<LlmStreamEvent>) {
    match payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "response.output_text.delta" => {
            if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                events.push(LlmStreamEvent::TextDelta(delta.to_string()));
            }
        }
        "response.output_text.done" => {
            if let Some(text) = payload.get("text").and_then(Value::as_str) {
                events.push(LlmStreamEvent::FinalText(text.to_string()));
            }
        }
        "response.failed" => events.push(LlmStreamEvent::Diagnostic(
            "OpenAI Responses stream failed".into(),
        )),
        "response.completed" | "response.incomplete" => {
            let response = payload.get("response").unwrap_or(payload);
            if let Some(usage) = extract_usage(response) {
                events.push(LlmStreamEvent::Usage(usage));
            }
            if let Some(reason) = extract_finish_reason(response) {
                events.push(LlmStreamEvent::FinishReason(reason));
            }
            if let Some(error) = parse_openai_responses_error(response) {
                events.push(LlmStreamEvent::Diagnostic(error));
            }
        }
        "error" => events.push(LlmStreamEvent::Diagnostic(
            payload
                .get("error")
                .and_then(error_message)
                .unwrap_or_else(|| "OpenAI Responses stream error".to_string()),
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
    fn builds_endpoint_headers_and_simple_input() {
        let request = build_openai_responses_http_request(&OpenAiResponsesRequest {
            base_url: "https://api.openai.com/v1/".to_string(),
            credential: LlmCredential::new("token"),
            model: "gpt-5".to_string(),
            messages: vec![LlmMessage::text(LlmRole::User, "hello")],
            stream: false,
            options: LlmGenerationOptions {
                max_output_tokens: Some(128),
                temperature: Some(0.2),
                ..Default::default()
            },
            top_p: Some(0.9),
            stop: vec!["END".to_string()],
        });

        assert_eq!(request.endpoint, "https://api.openai.com/v1/responses");
        assert_eq!(
            request.headers[0],
            ("Authorization", "Bearer token".to_string())
        );
        assert_eq!(request.body["input"], "hello");
        assert_eq!(request.body["max_output_tokens"], 128);
        assert!((request.body["top_p"].as_f64().unwrap() - 0.9).abs() < 0.000_001);
    }

    #[test]
    fn keeps_existing_responses_endpoint() {
        assert_eq!(
            responses_endpoint("https://example.test/v1/responses/"),
            "https://example.test/v1/responses"
        );
    }

    #[test]
    fn builds_role_content_array_for_history() {
        let request = build_openai_responses_http_request(&OpenAiResponsesRequest {
            base_url: "https://api.openai.com/v1".to_string(),
            credential: LlmCredential::new("token"),
            model: "gpt-5".to_string(),
            messages: vec![
                LlmMessage::text(LlmRole::System, "be terse"),
                LlmMessage::text(LlmRole::Assistant, "old"),
            ],
            stream: true,
            options: LlmGenerationOptions::default(),
            top_p: None,
            stop: Vec::new(),
        });

        assert_eq!(request.body["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(
            request.body["input"][1]["content"][0]["type"],
            "output_text"
        );
    }

    #[test]
    fn builds_user_text_and_image_content() {
        let request = build_openai_responses_http_request(&OpenAiResponsesRequest {
            base_url: "https://api.openai.com/v1".to_string(),
            credential: LlmCredential::new("token"),
            model: "gpt-5".to_string(),
            messages: vec![LlmMessage::parts(
                LlmRole::User,
                vec![
                    LlmMessagePart::Text("describe".to_string()),
                    LlmMessagePart::Image(super::super::types::LlmImageContent::new(
                        "image/png",
                        "aGVsbG8=",
                    )),
                ],
            )],
            stream: false,
            options: LlmGenerationOptions::default(),
            top_p: None,
            stop: Vec::new(),
        });

        assert_eq!(
            request.body["input"][0]["content"],
            json!([
                {"type": "input_text", "text": "describe"},
                {
                    "type": "input_image",
                    "detail": "auto",
                    "image_url": "data:image/png;base64,aGVsbG8=",
                },
            ])
        );
    }

    #[test]
    fn parses_output_text_finish_and_usage() {
        let parsed = parse_openai_responses_text_response(&json!({
            "status": "completed",
            "output": [{"content": [
                {"type": "output_text", "text": "hello "},
                {"type": "text", "text": "world"}
            ]}],
            "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
        }));

        assert_eq!(parsed.text, "hello world");
        assert_eq!(parsed.finish_reason, Some(LlmFinishReason::Stop));
        assert_eq!(
            parsed.usage,
            Some(LlmUsage {
                input_tokens: Some(1),
                output_tokens: Some(2),
                total_tokens: Some(3),
            })
        );
    }

    #[test]
    fn parses_sse_text_terminal_usage_and_error() {
        let events = parse_openai_responses_sse_chunk(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n\
             data: {\"type\":\"response.output_text.done\",\"text\":\"hi\"}\n\n\
             data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n\
             data: {\"type\":\"error\",\"error\":{\"message\":\"bad\"}}\n\n",
        );

        assert_eq!(events[0], LlmStreamEvent::TextDelta("hi".to_string()));
        assert_eq!(events[1], LlmStreamEvent::FinalText("hi".to_string()));
        assert_eq!(
            events[2],
            LlmStreamEvent::Usage(LlmUsage {
                input_tokens: Some(1),
                output_tokens: Some(2),
                total_tokens: Some(3),
            })
        );
        assert_eq!(
            events[3],
            LlmStreamEvent::FinishReason(LlmFinishReason::Stop)
        );
        assert_eq!(events[4], LlmStreamEvent::Diagnostic("bad".to_string()));
    }
}
