use serde_json::{Map, Value, json};

use super::LlmClientError;
use super::types::{
    LlmFinishReason, LlmMessage, LlmMessageContent, LlmMessagePart, LlmRequest, LlmResponse,
    LlmRole, LlmStreamEvent, LlmStreamSink, LlmUsage,
};

#[derive(Debug, Clone, PartialEq)]
pub struct OpenAiChatRequest {
    pub base_url: String,
    pub token: String,
    pub model: String,
    pub messages: Vec<LlmMessage>,
    pub stream: bool,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub max_tokens: Option<u32>,
    pub stop: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiChatHttpRequest {
    pub endpoint: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

pub async fn generate(
    http: &reqwest::Client,
    request: LlmRequest,
) -> Result<LlmResponse, LlmClientError> {
    let response = send_json(http, openai_request(request, false)).await?;
    Ok(parse_openai_chat_text_response(&response))
}

pub async fn stream_generate(
    http: &reqwest::Client,
    request: LlmRequest,
    sink: &mut dyn LlmStreamSink,
) -> Result<(), LlmClientError> {
    let response = request_builder(http, &openai_request(request, true))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await?;
        let error = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|payload| parse_openai_chat_error(&payload))
            .unwrap_or_else(|| format!("OpenAI chat stream failed with HTTP {status}"));
        return Err(LlmClientError::Protocol(error));
    }

    super::consume_sse(response, sink, parse_openai_chat_sse_chunk).await
}

pub fn build_openai_chat_http_request(request: &OpenAiChatRequest) -> OpenAiChatHttpRequest {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(request.model.clone()));
    body.insert("messages".into(), build_messages(&request.messages));
    body.insert("stream".into(), Value::Bool(request.stream));

    if let Some(temperature) = request.temperature {
        body.insert("temperature".into(), json!(temperature));
    }
    if let Some(top_p) = request.top_p {
        body.insert("top_p".into(), json!(top_p));
    }
    if let Some(max_tokens) = request.max_tokens {
        body.insert("max_tokens".into(), json!(max_tokens));
    }
    if !request.stop.is_empty() {
        body.insert("stop".into(), json!(request.stop));
    }

    OpenAiChatHttpRequest {
        endpoint: chat_completions_endpoint(&request.base_url),
        headers: vec![
            ("Authorization", format!("Bearer {}", request.token)),
            ("Content-Type", "application/json".to_string()),
        ],
        body: Value::Object(body),
    }
}

pub fn parse_openai_chat_text_response(payload: &Value) -> LlmResponse {
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());

    LlmResponse {
        text: choice
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .map(extract_content_text)
            .unwrap_or_default(),
        finish_reason: choice
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(Value::as_str)
            .map(map_finish_reason),
        usage: extract_usage(payload),
    }
}

pub fn parse_openai_chat_sse_chunk(chunk: &str) -> Vec<LlmStreamEvent> {
    let mut events = Vec::new();

    for frame in chunk.split("\n\n") {
        let Some(data) = sse_frame_data(frame) else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }

        match serde_json::from_str::<Value>(&data) {
            Ok(payload) => push_stream_events(&payload, &mut events),
            Err(error) => events.push(LlmStreamEvent::Diagnostic(format!(
                "invalid OpenAI chat stream JSON: {error}"
            ))),
        }
    }

    events
}

pub fn parse_openai_chat_error(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;
    let mut message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or("OpenAI Chat Completions provider error")
        .to_string();

    if let Some(kind) = error.get("type").and_then(Value::as_str) {
        message.push_str(" (type: ");
        message.push_str(kind);
        message.push(')');
    }
    if let Some(code) = error.get("code") {
        message.push_str(" (code: ");
        message.push_str(&code.to_string());
        message.push(')');
    }

    Some(message)
}

async fn send_json(
    http: &reqwest::Client,
    request: OpenAiChatRequest,
) -> Result<Value, LlmClientError> {
    let response = request_builder(http, &request).send().await?;
    let status = response.status();
    let text = response.text().await?;
    let payload = serde_json::from_str::<Value>(&text).map_err(|error| {
        LlmClientError::Protocol(format!("invalid OpenAI chat JSON response: {error}"))
    })?;
    if status.is_success() {
        Ok(payload)
    } else {
        Err(LlmClientError::Protocol(
            parse_openai_chat_error(&payload)
                .unwrap_or_else(|| format!("OpenAI chat request failed with HTTP {status}")),
        ))
    }
}

fn request_builder(http: &reqwest::Client, request: &OpenAiChatRequest) -> reqwest::RequestBuilder {
    let request = build_openai_chat_http_request(request);
    let mut builder = http.post(&request.endpoint);
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    builder.body(request.body.to_string())
}

fn sse_frame_data(frame: &str) -> Option<String> {
    let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n");
    (!data.is_empty()).then_some(data)
}

fn openai_request(request: LlmRequest, stream: bool) -> OpenAiChatRequest {
    OpenAiChatRequest {
        base_url: request.endpoint.endpoint().as_str().to_string(),
        token: request.credential.token().to_string(),
        model: request.model,
        messages: request.messages,
        stream,
        temperature: request.options.temperature,
        top_p: request.options.top_p,
        max_tokens: request.options.max_output_tokens,
        stop: request.options.stop,
    }
}

fn chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn build_messages(messages: &[LlmMessage]) -> Value {
    Value::Array(
        messages
            .iter()
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
        LlmMessageContent::Text(text) => Value::String(text.clone()),
        LlmMessageContent::Parts(parts)
            if parts
                .iter()
                .all(|part| matches!(part, LlmMessagePart::Text(_))) =>
        {
            Value::String(
                parts
                    .iter()
                    .map(|part| match part {
                        LlmMessagePart::Text(text) => text.as_str(),
                        LlmMessagePart::Image(_) => unreachable!(),
                    })
                    .collect::<Vec<_>>()
                    .join(""),
            )
        }
        LlmMessageContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    LlmMessagePart::Text(text) => json!({"type": "text", "text": text}),
                    LlmMessagePart::Image(image) => json!({
                        "type": "image_url",
                        "image_url": {"url": image.data_url()},
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

fn push_stream_events(payload: &Value, events: &mut Vec<LlmStreamEvent>) {
    if let Some(usage) = extract_usage(payload) {
        events.push(LlmStreamEvent::Usage(usage));
    }

    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());

    if let Some(text) = choice
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get("content"))
        .and_then(Value::as_str)
    {
        events.push(LlmStreamEvent::TextDelta(text.to_string()));
    }

    if let Some(reason) = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
    {
        events.push(LlmStreamEvent::FinishReason(map_finish_reason(reason)));
    }

    if let Some(error) = parse_openai_chat_error(payload) {
        events.push(LlmStreamEvent::Diagnostic(error));
    }
}

fn extract_content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }

    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| {
            let kind = part.get("type").and_then(Value::as_str);
            if kind.is_none() || kind == Some("text") {
                part.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

fn map_finish_reason(reason: &str) -> LlmFinishReason {
    match reason {
        "stop" => LlmFinishReason::Stop,
        "length" => LlmFinishReason::Length,
        "content_filter" => LlmFinishReason::ContentFilter,
        "tool_calls" | "function_call" => LlmFinishReason::ToolUse,
        other => LlmFinishReason::Other(other.to_string()),
    }
}

fn extract_usage(payload: &Value) -> Option<LlmUsage> {
    let usage = payload.get("usage")?;
    Some(LlmUsage {
        input_tokens: usage.get("prompt_tokens").and_then(number_to_u32),
        output_tokens: usage.get("completion_tokens").and_then(number_to_u32),
        total_tokens: usage.get("total_tokens").and_then(number_to_u32),
    })
}

fn number_to_u32(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|value| u32::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_endpoint_headers_and_body() {
        let request = build_openai_chat_http_request(&OpenAiChatRequest {
            base_url: "https://api.openai.com/v1/".to_string(),
            token: "token".to_string(),
            model: "gpt-5".to_string(),
            messages: vec![LlmMessage::text(LlmRole::User, "hello")],
            stream: false,
            temperature: Some(0.2),
            top_p: Some(0.9),
            max_tokens: Some(128),
            stop: vec!["END".to_string()],
        });

        assert_eq!(
            request.endpoint,
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            request.headers[0],
            ("Authorization", "Bearer token".to_string())
        );
        assert_eq!(request.body["messages"][0]["role"], "user");
        assert_eq!(request.body["max_tokens"], 128);
    }

    #[test]
    fn keeps_existing_chat_completions_endpoint() {
        assert_eq!(
            chat_completions_endpoint("https://example.test/v1/chat/completions/"),
            "https://example.test/v1/chat/completions"
        );
    }

    #[test]
    fn builds_user_text_and_image_content_array() {
        let request = build_openai_chat_http_request(&OpenAiChatRequest {
            base_url: "https://api.openai.com/v1".to_string(),
            token: "token".to_string(),
            model: "gpt-5".to_string(),
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
            temperature: None,
            top_p: None,
            max_tokens: None,
            stop: Vec::new(),
        });

        assert_eq!(
            request.body,
            json!({
                "model": "gpt-5",
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "describe"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc123"}},
                    ],
                }],
                "stream": false,
            })
        );
    }

    #[test]
    fn flattens_all_text_parts_to_string() {
        let request = build_openai_chat_http_request(&OpenAiChatRequest {
            base_url: "https://api.openai.com/v1".to_string(),
            token: "token".to_string(),
            model: "gpt-5".to_string(),
            messages: vec![LlmMessage::parts(
                LlmRole::User,
                vec![
                    LlmMessagePart::Text("hello ".to_string()),
                    LlmMessagePart::Text("world".to_string()),
                ],
            )],
            stream: false,
            temperature: None,
            top_p: None,
            max_tokens: None,
            stop: Vec::new(),
        });

        assert_eq!(request.body["messages"][0]["content"], "hello world");
    }

    #[test]
    fn parses_text_part_response_finish_and_usage() {
        let response = parse_openai_chat_text_response(&json!({
            "choices": [{
                "message": {"content": [
                    {"type": "text", "text": "hello "},
                    {"type": "image_url", "text": "skip"},
                    {"text": "world"}
                ]},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
        }));

        assert_eq!(response.text, "hello world");
        assert_eq!(response.finish_reason, Some(LlmFinishReason::Stop));
        assert_eq!(
            response.usage,
            Some(LlmUsage {
                input_tokens: Some(1),
                output_tokens: Some(2),
                total_tokens: Some(3),
            })
        );
    }

    #[test]
    fn parses_sse_text_finish_usage_and_error() {
        let events = parse_openai_chat_sse_chunk(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n\
             data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n\n\
             data: {\"error\":{\"message\":\"bad\",\"type\":\"invalid_request_error\",\"code\":\"bad_code\"}}\n\n\
             data: [DONE]\n\n",
        );

        assert_eq!(events[0], LlmStreamEvent::TextDelta("hi".to_string()));
        assert_eq!(
            events[1],
            LlmStreamEvent::FinishReason(LlmFinishReason::Length)
        );
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
            LlmStreamEvent::Diagnostic(
                "bad (type: invalid_request_error) (code: \"bad_code\")".to_string()
            )
        );
    }
}
