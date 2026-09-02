use std::fmt;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Serialize, de::DeserializeOwned};

use crate::protocol::wire::{
    APP_SERVER_PROTOCOL_VERSION, JsonRpcId, JsonRpcRequest, JsonRpcResponse,
};

use super::model::{
    InitializeResult, RunId, SessionCancelResult, SessionId, SessionListResult,
    SessionPromptResult, SessionRecord, SessionSnapshot, SessionTranscriptResult, ValidationError,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    client_name: Option<String>,
    protocol_version: &'static str,
}

impl InitializeParams {
    pub fn new(client_name: impl Into<String>) -> Self {
        Self {
            client_name: Some(client_name.into()),
            protocol_version: APP_SERVER_PROTOCOL_VERSION,
        }
    }

    pub fn anonymous() -> Self {
        Self {
            client_name: None,
            protocol_version: APP_SERVER_PROTOCOL_VERSION,
        }
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateParams {
    cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<SessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
}

impl fmt::Debug for SessionCreateParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCreateParams")
            .field("has_cwd", &true)
            .field("has_session_id", &self.session_id.is_some())
            .field("has_title", &self.title.is_some())
            .field("has_model", &self.model.is_some())
            .field("has_permission_mode", &self.permission_mode.is_some())
            .finish()
    }
}

impl SessionCreateParams {
    pub fn try_new(cwd: impl Into<String>) -> Result<Self, ValidationError> {
        Ok(Self {
            cwd: session_cwd(cwd)?,
            session_id: None,
            title: None,
            model: None,
            permission_mode: None,
        })
    }

    pub fn with_session_id(mut self, session_id: SessionId) -> Self {
        self.session_id = Some(session_id);
        self
    }

    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn with_permission_mode(mut self, permission_mode: impl Into<String>) -> Self {
        self.permission_mode = Some(permission_mode.into());
        self
    }
}

macro_rules! session_params {
    ($name:ident) => {
        #[derive(Clone, Eq, PartialEq, Serialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            session_id: SessionId,
        }

        impl $name {
            pub fn new(session_id: SessionId) -> Self {
                Self { session_id }
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter
                    .debug_struct(stringify!($name))
                    .field("has_session_id", &true)
                    .finish()
            }
        }
    };
}

session_params!(SessionLoadParams);
session_params!(SessionSnapshotParams);
session_params!(SessionTranscriptParams);

const ATTACHMENT_PROMPT_PAYLOAD_VERSION: &str = "attachments-v1";
const MAX_ATTACHMENTS: usize = 16;
const MAX_ATTACHMENT_DECODED_BYTES: usize = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_DECODED_BYTES: usize = 20 * 1024 * 1024;
const MAX_ATTACHMENT_BASE64_BYTES: usize = MAX_ATTACHMENT_DECODED_BYTES.div_ceil(3) * 4;
const MAX_ATTACHMENTS_BASE64_BYTES: usize = MAX_ATTACHMENTS_DECODED_BYTES.div_ceil(3) * 4;

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAttachment {
    name: String,
    media_type: String,
    data: String,
}

impl fmt::Debug for PromptAttachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PromptAttachment")
            .field("has_name", &true)
            .field("has_media_type", &true)
            .field("has_data", &true)
            .finish()
    }
}

impl PromptAttachment {
    pub fn try_new(
        name: impl Into<String>,
        media_type: impl Into<String>,
        data: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        let name = name.into();
        let media_type = media_type.into();
        let data = data.into();
        if !is_safe_attachment_name(&name) {
            return Err(ValidationError::new("attachment name is invalid"));
        }
        if !is_valid_media_type(&media_type) {
            return Err(ValidationError::new("attachment media type is invalid"));
        }
        if data.is_empty() || data.len() > MAX_ATTACHMENT_BASE64_BYTES {
            return Err(ValidationError::new(
                "attachment data exceeds the base64 size limit",
            ));
        }
        let decoded = STANDARD
            .decode(&data)
            .map_err(|_| ValidationError::new("attachment data must be canonical base64"))?;
        if STANDARD.encode(&decoded) != data {
            return Err(ValidationError::new(
                "attachment data must be canonical base64",
            ));
        }
        if decoded.len() > MAX_ATTACHMENT_DECODED_BYTES {
            return Err(ValidationError::new(
                "attachment data exceeds the decoded size limit",
            ));
        }
        Ok(Self {
            name,
            media_type,
            data,
        })
    }

    fn encoded_len(&self) -> usize {
        self.data.len()
    }

    fn decoded_len(&self) -> usize {
        ((self.data.len() / 4) * 3)
            - if self.data.ends_with("==") {
                2
            } else if self.data.ends_with('=') {
                1
            } else {
                0
            }
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPromptPayload {
    version: &'static str,
    attachments: Vec<PromptAttachment>,
}

impl fmt::Debug for AttachmentPromptPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttachmentPromptPayload")
            .field("version", &self.version)
            .field("attachment_count", &self.attachments.len())
            .finish()
    }
}

impl AttachmentPromptPayload {
    pub fn try_new(attachments: Vec<PromptAttachment>) -> Result<Self, ValidationError> {
        if attachments.is_empty() || attachments.len() > MAX_ATTACHMENTS {
            return Err(ValidationError::new(
                "attachment count is outside the supported limit",
            ));
        }
        if attachments
            .iter()
            .map(PromptAttachment::encoded_len)
            .sum::<usize>()
            > MAX_ATTACHMENTS_BASE64_BYTES
        {
            return Err(ValidationError::new(
                "attachments exceed the base64 size limit",
            ));
        }
        if attachments
            .iter()
            .map(PromptAttachment::decoded_len)
            .sum::<usize>()
            > MAX_ATTACHMENTS_DECODED_BYTES
        {
            return Err(ValidationError::new(
                "attachments exceed the decoded size limit",
            ));
        }
        Ok(Self {
            version: ATTACHMENT_PROMPT_PAYLOAD_VERSION,
            attachments,
        })
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptParams {
    session_id: SessionId,
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<AttachmentPromptPayload>,
}

impl fmt::Debug for SessionPromptParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionPromptParams")
            .field("has_session_id", &true)
            .field("has_prompt", &true)
            .field("has_run_id", &self.run_id.is_some())
            .field("has_attachments", &self.payload.is_some())
            .finish()
    }
}

impl SessionPromptParams {
    pub fn try_new(
        session_id: SessionId,
        prompt: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        Ok(Self {
            session_id,
            prompt: non_empty(prompt, "prompt must be a non-empty string")?,
            run_id: None,
            payload: None,
        })
    }

    pub fn with_run_id(mut self, run_id: RunId) -> Self {
        self.run_id = Some(run_id);
        self
    }

    pub fn with_attachments(mut self, payload: AttachmentPromptPayload) -> Self {
        self.payload = Some(payload);
        self
    }
}

fn is_safe_attachment_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.trim() == value
        && value != "."
        && value != ".."
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b' ' | b'-'))
}

fn is_valid_media_type(value: &str) -> bool {
    let Some((kind, subtype)) = value.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && !subtype.contains('/')
        && kind.bytes().all(is_media_token_byte)
        && subtype.bytes().all(is_media_token_byte)
}

fn is_media_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
        )
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCancelParams {
    session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

impl fmt::Debug for SessionCancelParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCancelParams")
            .field("has_session_id", &true)
            .field("has_run_id", &self.run_id.is_some())
            .field("has_reason", &self.reason.is_some())
            .finish()
    }
}

impl SessionCancelParams {
    pub fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            run_id: None,
            reason: None,
        }
    }

    pub fn with_run_id(mut self, run_id: RunId) -> Self {
        self.run_id = Some(run_id);
        self
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionProviderRuntime {
    #[serde(rename = "anthropicMessages", rename_all = "camelCase")]
    AnthropicMessages {
        #[serde(skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
    },
    #[serde(rename = "googleGenerativeAi", rename_all = "camelCase")]
    GoogleGenerativeAi {
        #[serde(skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
    },
    #[serde(rename = "openAiChatCompletions", rename_all = "camelCase")]
    OpenAiChatCompletions {
        #[serde(skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
    },
    #[serde(rename = "openAiResponses", rename_all = "camelCase")]
    OpenAiResponses {
        #[serde(skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
    },
}

impl SessionProviderRuntime {
    pub fn anthropic_messages(base_url: Option<String>, api_key: Option<String>) -> Self {
        Self::AnthropicMessages { base_url, api_key }
    }

    pub fn google_generative_ai(base_url: Option<String>, api_key: Option<String>) -> Self {
        Self::GoogleGenerativeAi { base_url, api_key }
    }

    pub fn open_ai_chat_completions(base_url: Option<String>, api_key: Option<String>) -> Self {
        Self::OpenAiChatCompletions { base_url, api_key }
    }

    pub fn open_ai_responses(base_url: Option<String>, api_key: Option<String>) -> Self {
        Self::OpenAiResponses { base_url, api_key }
    }
}

impl fmt::Debug for SessionProviderRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AnthropicMessages { base_url, api_key } => formatter
                .debug_struct("SessionProviderRuntime::AnthropicMessages")
                .field("has_base_url", &base_url.is_some())
                .field("has_api_key", &api_key.is_some())
                .finish(),
            Self::GoogleGenerativeAi { base_url, api_key } => formatter
                .debug_struct("SessionProviderRuntime::GoogleGenerativeAi")
                .field("has_base_url", &base_url.is_some())
                .field("has_api_key", &api_key.is_some())
                .finish(),
            Self::OpenAiChatCompletions { base_url, api_key } => formatter
                .debug_struct("SessionProviderRuntime::OpenAiChatCompletions")
                .field("has_base_url", &base_url.is_some())
                .field("has_api_key", &api_key.is_some())
                .finish(),
            Self::OpenAiResponses { base_url, api_key } => formatter
                .debug_struct("SessionProviderRuntime::OpenAiResponses")
                .field("has_base_url", &base_url.is_some())
                .field("has_api_key", &api_key.is_some())
                .finish(),
        }
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetModelParams {
    session_id: SessionId,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_selection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_runtime: Option<SessionProviderRuntime>,
}

impl fmt::Debug for SessionSetModelParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionSetModelParams")
            .field("has_session_id", &true)
            .field("has_model", &true)
            .field("has_model_selection_id", &self.model_selection_id.is_some())
            .field(
                "has_provider_fingerprint",
                &self.provider_fingerprint.is_some(),
            )
            .field("has_provider_runtime", &self.provider_runtime.is_some())
            .finish()
    }
}

impl SessionSetModelParams {
    pub fn try_new(
        session_id: SessionId,
        model: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        Ok(Self {
            session_id,
            model: non_empty(model, "model must be a non-empty string")?,
            model_selection_id: None,
            provider_fingerprint: None,
            provider_runtime: None,
        })
    }

    pub fn with_model_selection_id(mut self, model_selection_id: impl Into<String>) -> Self {
        self.model_selection_id = Some(model_selection_id.into());
        self
    }

    pub fn with_provider_fingerprint(mut self, provider_fingerprint: impl Into<String>) -> Self {
        self.provider_fingerprint = Some(provider_fingerprint.into());
        self
    }

    pub fn with_provider_runtime(mut self, provider_runtime: SessionProviderRuntime) -> Self {
        self.provider_runtime = Some(provider_runtime);
        self
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetModeParams {
    session_id: SessionId,
    mode: String,
}

impl fmt::Debug for SessionSetModeParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionSetModeParams")
            .field("has_session_id", &true)
            .field("has_mode", &true)
            .finish()
    }
}

impl SessionSetModeParams {
    pub fn try_new(
        session_id: SessionId,
        mode: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        Ok(Self {
            session_id,
            mode: non_empty(mode, "mode must be a non-empty string")?,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RequestError {
    method: &'static str,
}

impl fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "could not encode {} request", self.method)
    }
}

impl std::error::Error for RequestError {}

#[derive(Clone, PartialEq)]
pub(crate) enum ResponseError {
    MismatchedId,
    Remote { code: i64, session_not_found: bool },
    InvalidResult { method: &'static str },
    InvalidEvent,
}

impl fmt::Debug for ResponseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MismatchedId => formatter.write_str("ResponseError::MismatchedId"),
            Self::Remote {
                code,
                session_not_found,
            } => formatter
                .debug_struct("ResponseError::Remote")
                .field("code", code)
                .field("session_not_found", session_not_found)
                .finish(),
            Self::InvalidResult { .. } => formatter.write_str("ResponseError::InvalidResult"),
            Self::InvalidEvent => formatter.write_str("ResponseError::InvalidEvent"),
        }
    }
}

impl fmt::Display for ResponseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MismatchedId => formatter.write_str("response id did not match request"),
            Self::Remote { .. } => formatter.write_str("peer rejected request"),
            Self::InvalidResult { method } => write!(formatter, "invalid {method} result"),
            Self::InvalidEvent => formatter.write_str("invalid event notification"),
        }
    }
}

impl std::error::Error for ResponseError {}

macro_rules! request_helper {
    ($name:ident, $method:literal, $params:ty) => {
        pub(crate) fn $name(
            id: JsonRpcId,
            params: $params,
        ) -> Result<JsonRpcRequest, RequestError> {
            request(id, $method, params)
        }
    };
}

request_helper!(initialize_request, "initialize", InitializeParams);
request_helper!(
    session_create_request,
    "session.create",
    SessionCreateParams
);
request_helper!(session_load_request, "session.load", SessionLoadParams);
request_helper!(
    session_snapshot_request,
    "session.snapshot",
    SessionSnapshotParams
);
request_helper!(
    session_prompt_request,
    "session.prompt",
    SessionPromptParams
);
request_helper!(
    session_transcript_request,
    "session.transcript",
    SessionTranscriptParams
);
request_helper!(
    session_cancel_request,
    "session.cancel",
    SessionCancelParams
);
request_helper!(
    session_set_model_request,
    "session.setModel",
    SessionSetModelParams
);
request_helper!(
    session_set_mode_request,
    "session.setMode",
    SessionSetModeParams
);

pub(crate) fn session_list_request(id: JsonRpcId) -> JsonRpcRequest {
    JsonRpcRequest::new(id, "session.list", None)
}

macro_rules! response_helper {
    ($name:ident, $method:literal, $result:ty) => {
        pub(crate) fn $name(
            expected_id: &JsonRpcId,
            response: JsonRpcResponse,
        ) -> Result<$result, ResponseError> {
            decode_result(expected_id, response, $method)
        }
    };
}

response_helper!(
    decode_session_create_result,
    "session.create",
    SessionRecord
);
response_helper!(decode_session_load_result, "session.load", SessionRecord);
response_helper!(
    decode_session_snapshot_result,
    "session.snapshot",
    SessionSnapshot
);
response_helper!(
    decode_session_list_result,
    "session.list",
    SessionListResult
);
response_helper!(
    decode_session_prompt_result,
    "session.prompt",
    SessionPromptResult
);
response_helper!(
    decode_session_transcript_result,
    "session.transcript",
    SessionTranscriptResult
);
response_helper!(
    decode_session_cancel_result,
    "session.cancel",
    SessionCancelResult
);
response_helper!(
    decode_session_set_model_result,
    "session.setModel",
    SessionRecord
);
response_helper!(
    decode_session_set_mode_result,
    "session.setMode",
    SessionRecord
);

pub(crate) fn decode_initialize_result(
    expected_id: &JsonRpcId,
    response: JsonRpcResponse,
) -> Result<InitializeResult, ResponseError> {
    let result: InitializeResult = decode_result(expected_id, response, "initialize")?;
    if result.protocol_version != APP_SERVER_PROTOCOL_VERSION || !result.capabilities.is_v1() {
        return Err(ResponseError::InvalidResult {
            method: "initialize",
        });
    }
    Ok(result)
}

pub(crate) fn request<T: Serialize>(
    id: JsonRpcId,
    method: &'static str,
    params: T,
) -> Result<JsonRpcRequest, RequestError> {
    let params = serde_json::to_value(params).map_err(|_| RequestError { method })?;
    Ok(JsonRpcRequest::new(id, method, Some(params)))
}

pub(crate) fn decode_result<T: DeserializeOwned>(
    expected_id: &JsonRpcId,
    response: JsonRpcResponse,
    method: &'static str,
) -> Result<T, ResponseError> {
    let result = match response {
        JsonRpcResponse::Success(success) => {
            if &success.id != expected_id {
                return Err(ResponseError::MismatchedId);
            }
            success.result
        }
        JsonRpcResponse::Failure(failure) => {
            if failure.id.as_ref() != Some(expected_id) {
                return Err(ResponseError::MismatchedId);
            }
            return Err(ResponseError::Remote {
                code: failure.error.code,
                session_not_found: failure.error.is_session_not_found(),
            });
        }
    };
    serde_json::from_value(result).map_err(|_| ResponseError::InvalidResult { method })
}

fn non_empty(value: impl Into<String>, message: &'static str) -> Result<String, ValidationError> {
    let value = value.into();
    if value.trim().is_empty() {
        return Err(ValidationError::new(message));
    }
    Ok(value)
}

fn session_cwd(value: impl Into<String>) -> Result<String, ValidationError> {
    let value = value.into();
    if value.trim().is_empty()
        || value.len() > 32_768
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ValidationError::new("session cwd is invalid"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::wire::{JsonRpcMessage, decode, encode};

    fn id(value: &str) -> JsonRpcId {
        JsonRpcId::String(value.to_owned())
    }

    fn session_id() -> SessionId {
        SessionId::try_new("session-1").unwrap()
    }

    fn assert_frame(request: JsonRpcRequest, expected: &str) {
        let frame = encode(&JsonRpcMessage::from(request)).unwrap();
        assert!(frame.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&frame).unwrap(),
            serde_json::from_str::<serde_json::Value>(expected).unwrap(),
        );
    }

    fn response(frame: &str) -> JsonRpcResponse {
        match decode(frame).unwrap() {
            JsonRpcMessage::Response(response) => response,
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn optional_request_params_are_omitted_and_typed_attachments_are_encoded() {
        assert_frame(
            initialize_request(id("anonymous"), InitializeParams::anonymous()).unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"anonymous\",\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"matcha-agent-app-server-v1\"}}\n",
        );
        assert_frame(
            session_create_request(
                id("create"),
                SessionCreateParams::try_new("E:/workspace-canary")
                    .unwrap()
                    .with_session_id(session_id()),
            )
            .unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"create\",\"method\":\"session.create\",\"params\":{\"cwd\":\"E:/workspace-canary\",\"sessionId\":\"session-1\"}}\n",
        );
        assert_frame(
            session_prompt_request(
                id("prompt"),
                SessionPromptParams::try_new(session_id(), "hello").unwrap(),
            )
            .unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"prompt\",\"method\":\"session.prompt\",\"params\":{\"sessionId\":\"session-1\",\"prompt\":\"hello\"}}\n",
        );
        assert_frame(
            session_prompt_request(
                id("prompt-attachments"),
                SessionPromptParams::try_new(session_id(), "hello")
                    .unwrap()
                    .with_attachments(
                        AttachmentPromptPayload::try_new(vec![
                            PromptAttachment::try_new("review.pdf", "application/pdf", "aGVsbG8=")
                                .unwrap(),
                        ])
                        .unwrap(),
                    ),
            )
            .unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"prompt-attachments\",\"method\":\"session.prompt\",\"params\":{\"sessionId\":\"session-1\",\"prompt\":\"hello\",\"payload\":{\"version\":\"attachments-v1\",\"attachments\":[{\"name\":\"review.pdf\",\"mediaType\":\"application/pdf\",\"data\":\"aGVsbG8=\"}]}}}\n",
        );
        assert_frame(
            session_set_model_request(
                id("set-model"),
                SessionSetModelParams::try_new(session_id(), "ark-code-latest")
                    .unwrap()
                    .with_model_selection_id("ark/ark-code-latest")
                    .with_provider_fingerprint("matcha-provider:v1:test")
                    .with_provider_runtime(SessionProviderRuntime::open_ai_chat_completions(
                        Some("https://ark.example/v1".to_owned()),
                        Some("ark-secret".to_owned()),
                    )),
            )
            .unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"set-model\",\"method\":\"session.setModel\",\"params\":{\"sessionId\":\"session-1\",\"model\":\"ark-code-latest\",\"modelSelectionId\":\"ark/ark-code-latest\",\"providerFingerprint\":\"matcha-provider:v1:test\",\"providerRuntime\":{\"kind\":\"openAiChatCompletions\",\"baseUrl\":\"https://ark.example/v1\",\"apiKey\":\"ark-secret\"}}}\n",
        );
        assert_frame(
            session_set_model_request(
                id("set-model-responses"),
                SessionSetModelParams::try_new(session_id(), "gpt-5")
                    .unwrap()
                    .with_provider_runtime(SessionProviderRuntime::open_ai_responses(
                        Some("https://api.openai.com/v1".to_owned()),
                        Some("openai-secret".to_owned()),
                    )),
            )
            .unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"set-model-responses\",\"method\":\"session.setModel\",\"params\":{\"sessionId\":\"session-1\",\"model\":\"gpt-5\",\"providerRuntime\":{\"kind\":\"openAiResponses\",\"baseUrl\":\"https://api.openai.com/v1\",\"apiKey\":\"openai-secret\"}}}\n",
        );
        assert_frame(
            session_cancel_request(id("cancel"), SessionCancelParams::new(session_id())).unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"cancel\",\"method\":\"session.cancel\",\"params\":{\"sessionId\":\"session-1\"}}\n",
        );
    }

    #[test]
    fn request_params_debug_reports_presence_without_values() {
        let session_canary = "session-debug-canary";
        let run_canary = "run-debug-canary";
        let cwd_canary = "E:/workspace-debug-canary";
        let title_canary = "title-debug-canary";
        let prompt_canary = "prompt-debug-canary";
        let model_canary = "model-debug-canary";
        let reason_canary = "reason-debug-canary";
        let session_id = SessionId::try_new(session_canary).unwrap();
        let run_id = RunId::try_new(run_canary).unwrap();

        let debug = [
            format!(
                "{:?}",
                SessionCreateParams::try_new(cwd_canary)
                    .unwrap()
                    .with_session_id(session_id.clone())
                    .with_title(title_canary)
                    .with_model(model_canary)
                    .with_permission_mode("permission-debug-canary")
            ),
            format!("{:?}", SessionLoadParams::new(session_id.clone())),
            format!("{:?}", SessionTranscriptParams::new(session_id.clone())),
            format!(
                "{:?}",
                SessionPromptParams::try_new(session_id.clone(), prompt_canary)
                    .unwrap()
                    .with_run_id(run_id.clone())
                    .with_attachments(
                        AttachmentPromptPayload::try_new(vec![
                            PromptAttachment::try_new(
                                "debug-image-canary.png",
                                "image/png",
                                "ZGVidWctaW1hZ2UtY2FuYXJ5"
                            )
                            .unwrap(),
                        ])
                        .unwrap(),
                    )
            ),
            format!(
                "{:?}",
                SessionCancelParams::new(session_id.clone())
                    .with_run_id(run_id)
                    .with_reason(reason_canary)
            ),
            format!(
                "{:?}",
                SessionSetModelParams::try_new(session_id.clone(), model_canary)
                    .unwrap()
                    .with_model_selection_id("model-selection-debug-canary")
                    .with_provider_fingerprint("provider-fingerprint-debug-canary")
                    .with_provider_runtime(SessionProviderRuntime::open_ai_chat_completions(
                        Some("https://provider-runtime-debug-canary".to_owned()),
                        Some("provider-api-key-debug-canary".to_owned()),
                    ))
            ),
            format!(
                "{:?}",
                SessionSetModeParams::try_new(session_id, "mode-debug-canary").unwrap()
            ),
        ]
        .join("\n");

        assert!(debug.contains("SessionCreateParams { has_cwd: true"));
        assert!(debug.contains("SessionLoadParams { has_session_id: true }"));
        assert!(debug.contains("SessionTranscriptParams { has_session_id: true }"));
        assert!(debug.contains("SessionPromptParams { has_session_id: true, has_prompt: true"));
        assert!(debug.contains("has_run_id: true, has_attachments: true }"));
        assert!(debug.contains("SessionCancelParams { has_session_id: true, has_run_id: true"));
        assert!(debug.contains(
            "SessionSetModelParams { has_session_id: true, has_model: true, has_model_selection_id: true, has_provider_fingerprint: true, has_provider_runtime: true }"
        ));
        assert!(debug.contains("SessionSetModeParams { has_session_id: true, has_mode: true }"));
        for canary in [
            session_canary,
            run_canary,
            cwd_canary,
            title_canary,
            prompt_canary,
            model_canary,
            reason_canary,
            "mode-debug-canary",
            "debug-image-canary",
            "permission-debug-canary",
            "model-selection-debug-canary",
            "provider-fingerprint-debug-canary",
            "https://provider-runtime-debug-canary",
            "provider-api-key-debug-canary",
        ] {
            assert!(!debug.contains(canary), "Debug leaked {canary}");
        }
    }

    #[test]
    fn session_cwd_validation_only_rejects_invalid_wire_shape() {
        for cwd in ["", "   ", "E:/workspace\n", "E:/workspace\u{7f}"] {
            assert!(SessionCreateParams::try_new(cwd).is_err());
        }
        assert!(SessionCreateParams::try_new("E:/workspace").is_ok());
        assert!(SessionCreateParams::try_new(".git").is_ok());
        assert!(SessionCreateParams::try_new("E:/missing-or-sensitive").is_ok());
        assert!(SessionCreateParams::try_new("x".repeat(32_768)).is_ok());
        assert!(SessionCreateParams::try_new("x".repeat(32_769)).is_err());
    }

    #[test]
    fn attachments_require_canonical_base64_and_fixed_limits() {
        assert!(PromptAttachment::try_new("image.png", "image/png", "aGVsbG8=").is_ok());
        for data in ["", "aGV sbG8=", "aGVsbG8", "aGVsbG8=="] {
            assert!(PromptAttachment::try_new("image.png", "image/png", data).is_err());
        }
        for (name, media_type) in [
            ("../image.png", "image/png"),
            ("image.png", "not a media type"),
        ] {
            assert!(PromptAttachment::try_new(name, media_type, "aGVsbG8=").is_err());
        }
        let attachment =
            PromptAttachment::try_new("review.pdf", "application/pdf", "aGVsbG8=").unwrap();
        assert!(AttachmentPromptPayload::try_new(vec![]).is_err());
        assert!(AttachmentPromptPayload::try_new(vec![attachment; MAX_ATTACHMENTS + 1]).is_err());
    }

    #[test]
    fn response_error_debug_and_display_keep_only_remote_code() {
        let error = ResponseError::Remote {
            code: -32603,
            session_not_found: false,
        };

        assert_eq!(
            format!("{error:?}"),
            "ResponseError::Remote { code: -32603, session_not_found: false }"
        );
        assert_eq!(error.to_string(), "peer rejected request");
    }

    #[test]
    fn result_decoders_preserve_run_identity_and_redact_failures() {
        let init = decode_initialize_result(
            &id("init"),
            response(r#"{"jsonrpc":"2.0","id":"init","result":{"protocolVersion":"matcha-agent-app-server-v1","serverVersion":"2.2.1","capabilities":{"eventReplay":true,"snapshots":true,"approvals":true,"sdkMessageEnvelope":true,"blobStore":true,"sessionTranscript":true}}}"#),
        ).unwrap();
        assert_eq!(init.server_version, "2.2.1");

        let prompt = decode_session_prompt_result(
            &id("prompt"),
            response(r#"{"jsonrpc":"2.0","id":"prompt","result":{"runId":"run-9"}}"#),
        )
        .unwrap();
        assert_eq!(prompt.run_id.as_str(), "run-9");

        let snapshot = decode_session_snapshot_result(
            &id("snapshot"),
            response(r#"{"jsonrpc":"2.0","id":"snapshot","result":{"session":{"sessionId":"session-1","createdAt":"created-at","updatedAt":"updated-at","runtime":"matcha-agent","lastSeq":3,"lastSnapshotVersion":2,"workerState":{"state":"unloaded","reason":"notStarted"}},"version":2,"updatedAt":"snapshot-updated-at","runs":[{"runId":"run-1","sessionId":"session-1","promptId":"prompt-secret","status":{"type":"completed","completedAt":"completed-at","stopReason":"end_turn"}}],"messages":[],"pendingApprovals":[]}}"#),
        )
        .unwrap();
        assert_eq!(snapshot.version, 2);
        assert_eq!(snapshot.runs.len(), 1);
        let snapshot_debug = format!("{snapshot:?}");
        for canary in ["session-1", "prompt-secret", "snapshot-updated-at"] {
            assert!(!snapshot_debug.contains(canary));
        }

        let mismatch = decode_session_prompt_result(
            &id("expected"),
            response(r#"{"jsonrpc":"2.0","id":"secret-id","result":{"runId":"run-1"}}"#),
        )
        .unwrap_err();
        assert_eq!(mismatch.to_string(), "response id did not match request");
        assert!(!mismatch.to_string().contains("secret-id"));

        let remote = decode_session_prompt_result(
            &id("prompt"),
            response(r#"{"jsonrpc":"2.0","id":"prompt","error":{"code":-32603,"message":"secret prompt failed","data":{"kind":"open"}}}"#),
        ).unwrap_err();
        assert_eq!(remote.to_string(), "peer rejected request");
        assert!(!remote.to_string().contains("secret prompt"));

        let invalid = decode_initialize_result(
            &id("init"),
            response(r#"{"jsonrpc":"2.0","id":"init","result":{"protocolVersion":"future-secret","serverVersion":"x","capabilities":{"eventReplay":true,"snapshots":true,"approvals":true,"sdkMessageEnvelope":true,"blobStore":true,"sessionTranscript":true}}}"#),
        ).unwrap_err();
        assert_eq!(invalid.to_string(), "invalid initialize result");
        assert!(!invalid.to_string().contains("future-secret"));
    }
}
