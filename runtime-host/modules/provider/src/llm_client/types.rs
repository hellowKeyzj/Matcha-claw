use std::{fmt, future::Future, pin::Pin};

use crate::{ProviderApiProtocol, ProviderEndpoint};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LlmEndpoint {
    endpoint: ProviderEndpoint,
    protocol: ProviderApiProtocol,
}

impl LlmEndpoint {
    pub const fn new(endpoint: ProviderEndpoint, protocol: ProviderApiProtocol) -> Self {
        Self { endpoint, protocol }
    }

    pub fn endpoint(&self) -> &ProviderEndpoint {
        &self.endpoint
    }

    pub const fn protocol(&self) -> ProviderApiProtocol {
        self.protocol
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct LlmCredential {
    token: String,
    kind: LlmCredentialKind,
}

impl LlmCredential {
    pub fn new(token: impl Into<String>) -> Self {
        Self::api_key(token)
    }

    pub fn api_key(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            kind: LlmCredentialKind::ApiKey,
        }
    }

    pub fn bearer(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            kind: LlmCredentialKind::Bearer,
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub const fn kind(&self) -> LlmCredentialKind {
        self.kind
    }
}

impl fmt::Debug for LlmCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LlmCredential")
            .field("token", &"<redacted>")
            .field("kind", &self.kind)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LlmCredentialKind {
    ApiKey,
    Bearer,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LlmRequest {
    pub endpoint: LlmEndpoint,
    pub credential: LlmCredential,
    pub model: String,
    pub messages: Vec<LlmMessage>,
    pub options: LlmGenerationOptions,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: LlmMessageContent,
}

impl LlmMessage {
    pub fn text(role: LlmRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: LlmMessageContent::Text(content.into()),
        }
    }

    pub fn parts(role: LlmRole, parts: Vec<LlmMessagePart>) -> Self {
        Self {
            role,
            content: LlmMessageContent::Parts(parts),
        }
    }

    pub fn as_text_only(&self) -> Option<&str> {
        match &self.content {
            LlmMessageContent::Text(text) => Some(text),
            LlmMessageContent::Parts(parts) => match parts.as_slice() {
                [LlmMessagePart::Text(text)] => Some(text),
                _ => None,
            },
        }
    }

    pub fn text_content(&self) -> String {
        match &self.content {
            LlmMessageContent::Text(text) => text.clone(),
            LlmMessageContent::Parts(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    LlmMessagePart::Text(text) => Some(text.as_str()),
                    LlmMessagePart::Image(_) => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
        }
    }

    pub fn has_image(&self) -> bool {
        matches!(
            &self.content,
            LlmMessageContent::Parts(parts)
                if parts.iter().any(|part| matches!(part, LlmMessagePart::Image(_)))
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LlmMessageContent {
    Text(String),
    Parts(Vec<LlmMessagePart>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LlmMessagePart {
    Text(String),
    Image(LlmImageContent),
}

#[derive(Clone, Eq, PartialEq)]
pub struct LlmImageContent {
    mime_type: String,
    data_base64: String,
}

impl LlmImageContent {
    pub fn new(mime_type: impl Into<String>, data_base64: impl Into<String>) -> Self {
        Self {
            mime_type: mime_type.into(),
            data_base64: data_base64.into(),
        }
    }

    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub fn data_base64(&self) -> &str {
        &self.data_base64
    }

    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime_type, self.data_base64)
    }
}

impl fmt::Debug for LlmImageContent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LlmImageContent")
            .field("mime_type", &self.mime_type)
            .field("data_base64", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LlmRole {
    System,
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LlmGenerationOptions {
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub top_k: Option<u32>,
    pub stop: Vec<String>,
}

impl LlmGenerationOptions {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Default for LlmGenerationOptions {
    fn default() -> Self {
        Self {
            max_output_tokens: None,
            temperature: None,
            top_p: None,
            top_k: None,
            stop: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LlmResponse {
    pub text: String,
    pub finish_reason: Option<LlmFinishReason>,
    pub usage: Option<LlmUsage>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LlmUsage {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LlmFinishReason {
    Stop,
    Length,
    ContentFilter,
    ToolUse,
    Other(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LlmStreamEvent {
    TextDelta(String),
    FinalText(String),
    FinishReason(LlmFinishReason),
    Usage(LlmUsage),
    Diagnostic(String),
}

pub trait LlmStreamSink: Send {
    fn send<'a>(
        &'a mut self,
        event: LlmStreamEvent,
    ) -> Pin<Box<dyn Future<Output = Result<(), crate::llm_client::LlmClientError>> + Send + 'a>>;
}
