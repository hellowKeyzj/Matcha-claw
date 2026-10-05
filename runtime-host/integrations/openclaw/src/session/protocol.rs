use crate::gateway::wire::{GatewayEvent, GatewayResponse};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{Error as _, IgnoredAny},
};
use serde_json::{Map, Value};
use std::fmt;

pub const CHAT_SEND_METHOD: &str = "chat.send";
pub const CHAT_ABORT_METHOD: &str = "chat.abort";
pub const SESSIONS_ABORT_METHOD: &str = "sessions.abort";
pub const SESSIONS_LIST_METHOD: &str = "sessions.list";
pub const SESSIONS_DESCRIBE_METHOD: &str = "sessions.describe";
pub const SESSIONS_PATCH_METHOD: &str = "sessions.patch";
pub const SESSIONS_CREATE_METHOD: &str = "sessions.create";
pub const SESSIONS_DELETE_METHOD: &str = "sessions.delete";
pub const CHAT_HISTORY_METHOD: &str = "chat.history";
const MAX_CHAT_SESSION_KEY_UTF16: usize = 512;
const MAX_SESSION_LABEL_BYTES: usize = 512;
const DEFAULT_CHAT_HISTORY_LIMIT: usize = 200;
const MAX_CHAT_HISTORY_LIMIT: u64 = 1_000;
const MAX_CHAT_HISTORY_MAX_CHARS: u64 = 500_000;
const MAX_HISTORY_MESSAGE_BYTES: usize = 128 * 1024;
const MAX_HISTORY_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_SESSION_UPDATE_TEXT_BYTES: usize = 128 * 1024;
const MAX_SESSION_UPDATE_STOP_REASON_BYTES: usize = 256;
const MAX_SESSION_ACTIVITY_TEXT_BYTES: usize = 16 * 1024;
const MAX_SESSION_ACTIVITY_ID_BYTES: usize = 256;
const MAX_SESSION_RUNTIME_DETAIL_TEXT_BYTES: usize = 300;
const MAX_SESSION_TOOL_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_SESSION_TOOL_DETAILS_BYTES: usize = 128 * 1024;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;
const MAX_CHAT_ATTACHMENTS: usize = 16;
const MAX_CHAT_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_BASE64_BYTES: usize = MAX_CHAT_ATTACHMENT_BYTES.div_ceil(3) * 4;

#[derive(Default)]
enum OptionalHistoryBound {
    #[default]
    Missing,
    Value(u64),
}

impl<'de> Deserialize<'de> for OptionalHistoryBound {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        u64::deserialize(deserializer).map(Self::Value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ValidationError(&'static str);
impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}
impl std::error::Error for ValidationError {}
macro_rules! identity {
    ($name:ident, $error:literal) => {
        #[derive(Clone, Eq, Hash, PartialEq, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);
        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(stringify!($name))
            }
        }
        impl $name {
            pub fn try_new(value: impl Into<String>) -> Result<Self, ValidationError> {
                non_empty(value, $error).map(Self)
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::try_new(String::deserialize(deserializer)?).map_err(D::Error::custom)
            }
        }
    };
}
identity!(SessionKey, "session key must be a non-empty string");

#[derive(Clone, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct AgentId(String);

impl AgentId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = non_empty(value, "agent id must be a non-empty string")?;
        valid_agent_id(&value)
            .then_some(Self(value))
            .ok_or(ValidationError("agent id is invalid"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AgentId")
    }
}

impl<'de> Deserialize<'de> for AgentId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_new(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

identity!(
    EndpointSessionId,
    "endpoint session id must be a non-empty string"
);
identity!(
    NativeSessionId,
    "native session id must be a non-empty string"
);
identity!(ModelRef, "model reference must be a non-empty string");
identity!(RunId, "run id must be a non-empty string");
identity!(MessageId, "message id must be a non-empty string");
#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    #[serde(rename = "type")]
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_type: Option<String>,
    mime_type: String,
    file_name: String,
    content: String,
}

impl fmt::Debug for ChatAttachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatAttachment")
            .field("has_type", &self.attachment_type.is_some())
            .field("has_mime_type", &!self.mime_type.is_empty())
            .field("has_file_name", &!self.file_name.is_empty())
            .field("content_bytes", &self.content.len())
            .finish()
    }
}

impl ChatAttachment {
    pub fn try_new(
        mime_type: impl Into<String>,
        file_name: impl Into<String>,
        content: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        let mime_type = non_empty(
            mime_type,
            "chat attachment mime type must be a non-empty string",
        )?;
        let file_name = non_empty(
            file_name,
            "chat attachment file name must be a non-empty string",
        )?;
        if !is_safe_file_name(&file_name) {
            return Err(ValidationError("chat attachment file name is invalid"));
        }
        let content = non_empty(
            content,
            "chat attachment content must be a non-empty base64 string",
        )?;
        if !is_strict_base64(&content) {
            return Err(ValidationError(
                "chat attachment content must be a valid base64 string",
            ));
        }
        if content.len() > MAX_CHAT_ATTACHMENT_BASE64_BYTES {
            return Err(ValidationError(
                "chat attachment content exceeds size limit",
            ));
        }
        let padding_bytes = content
            .bytes()
            .rev()
            .take_while(|byte| *byte == b'=')
            .count();
        let decoded_bytes = content.len() / 4 * 3 - padding_bytes;
        if decoded_bytes > MAX_CHAT_ATTACHMENT_BYTES {
            return Err(ValidationError(
                "chat attachment content exceeds size limit",
            ));
        }
        BASE64.decode(&content).map_err(|_| {
            ValidationError("chat attachment content must be a valid base64 string")
        })?;
        Ok(Self {
            attachment_type: None,
            mime_type,
            file_name,
            content,
        })
    }

    pub fn with_type(mut self, attachment_type: impl Into<String>) -> Self {
        self.attachment_type = Some(attachment_type.into());
        self
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendParams {
    session_key: SessionKey,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    deliver: Option<bool>,
    idempotency_key: RunId,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<ChatAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_provenance_receipt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    intent: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}
impl fmt::Debug for ChatSendParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatSendParams")
            .field("has_message", &!self.message.is_empty())
            .field("has_delivery", &self.deliver.is_some())
            .field(
                "has_system_provenance_receipt",
                &self.system_provenance_receipt.is_some(),
            )
            .finish_non_exhaustive()
    }
}
impl ChatSendParams {
    pub fn try_new(
        session_key: SessionKey,
        message: impl Into<String>,
        idempotency_key: RunId,
    ) -> Result<Self, ValidationError> {
        if session_key.as_str().encode_utf16().count() > MAX_CHAT_SESSION_KEY_UTF16 {
            return Err(ValidationError("chat send session key is too long"));
        }
        Ok(Self {
            session_key,
            message: message.into(),
            deliver: None,
            idempotency_key,
            attachments: Vec::new(),
            system_provenance_receipt: None,
            intent: None,
            agent_id: None,
            session_id: None,
        })
    }

    pub(crate) fn with_goal_start(mut self, agent_id: String, session_id: Option<String>, issued_at_ms: u64) -> Self {
        self.intent = Some(serde_json::json!({ "kind": "session-goal-start", "version": 1, "issuedAtMs": issued_at_ms }));
        self.agent_id = Some(agent_id);
        self.session_id = session_id;
        self
    }

    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn idempotency_key(&self) -> &RunId {
        &self.idempotency_key
    }

    pub fn with_delivery(mut self, deliver: bool) -> Self {
        self.deliver = Some(deliver);
        self
    }

    pub fn with_system_provenance_receipt(mut self, receipt: impl Into<String>) -> Self {
        self.system_provenance_receipt = Some(receipt.into());
        self
    }

    pub fn try_with_attachment(
        mut self,
        attachment: ChatAttachment,
    ) -> Result<Self, ValidationError> {
        if self.attachments.len() == MAX_CHAT_ATTACHMENTS {
            return Err(ValidationError("too many chat attachments"));
        }
        self.attachments.push(attachment);
        Ok(self)
    }
}

fn is_safe_file_name(value: &str) -> bool {
    !value.contains(['/', '\\'])
        && !value.chars().any(char::is_control)
        && value != "."
        && value != ".."
}

fn is_strict_base64(value: &str) -> bool {
    !value.is_empty()
        && value.len().is_multiple_of(4)
        && value
            .as_bytes()
            .iter()
            .enumerate()
            .all(|(index, byte)| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => true,
                b'=' => index >= value.len().saturating_sub(2),
                _ => false,
            })
        && !value[..value.len().saturating_sub(2)].contains('=')
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAbortParams {
    session_key: SessionKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<RunId>,
}
impl fmt::Debug for ChatAbortParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatAbortParams")
            .field("has_run_id", &self.run_id.is_some())
            .finish_non_exhaustive()
    }
}
impl ChatAbortParams {
    pub fn new(session_key: SessionKey) -> Self {
        Self {
            session_key,
            run_id: None,
        }
    }

    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn for_run(mut self, run_id: RunId) -> Self {
        self.run_id = Some(run_id);
        self
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAbortParams {
    key: SessionKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<RunId>,
}
impl fmt::Debug for SessionAbortParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionAbortParams")
            .field("has_run_id", &self.run_id.is_some())
            .finish_non_exhaustive()
    }
}
impl SessionAbortParams {
    pub fn new(key: SessionKey) -> Self {
        Self { key, run_id: None }
    }

    pub fn for_run(mut self, run_id: RunId) -> Self {
        self.run_id = Some(run_id);
        self
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryParams {
    session_key: SessionKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_chars: Option<u64>,
}

impl fmt::Debug for ChatHistoryParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatHistoryParams")
            .field("has_limit", &self.limit.is_some())
            .field("has_offset", &self.offset.is_some())
            .field("has_max_chars", &self.max_chars.is_some())
            .finish_non_exhaustive()
    }
}

impl ChatHistoryParams {
    pub fn new(session_key: SessionKey) -> Self {
        Self {
            session_key,
            agent_id: None,
            cursor: None,
            limit: None,
            offset: None,
            max_chars: None,
        }
    }

    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn try_with_limit(mut self, limit: u64) -> Result<Self, ValidationError> {
        if !(1..=MAX_CHAT_HISTORY_LIMIT).contains(&limit) {
            return Err(ValidationError(
                "chat history limit must be between 1 and 1000",
            ));
        }
        self.limit = Some(limit);
        Ok(self)
    }

    pub fn try_for_agent(mut self, agent_id: String) -> Result<Self, ValidationError> {
        self.agent_id = Some(AgentId::try_new(agent_id)?);
        Ok(self)
    }

    pub fn try_with_cursor(mut self, cursor: String) -> Result<Self, ValidationError> {
        if self.offset.is_some() || cursor.is_empty() || cursor.len() > 8192 {
            return Err(ValidationError("chat history cursor is invalid"));
        }
        self.cursor = Some(cursor);
        Ok(self)
    }

    pub fn try_with_offset(mut self, offset: u64) -> Result<Self, ValidationError> {
        if self.cursor.is_some() || offset > MAX_SAFE_SEQUENCE {
            return Err(ValidationError("chat history offset exceeds safe integer"));
        }
        self.offset = Some(offset);
        Ok(self)
    }

    pub fn try_with_max_chars(mut self, max_chars: u64) -> Result<Self, ValidationError> {
        if !(1..=MAX_CHAT_HISTORY_MAX_CHARS).contains(&max_chars) {
            return Err(ValidationError(
                "chat history max chars must be between 1 and 500000",
            ));
        }
        self.max_chars = Some(max_chars);
        Ok(self)
    }

    pub(crate) fn limit(&self) -> usize {
        self.limit
            .map_or(DEFAULT_CHAT_HISTORY_LIMIT, |limit| limit as usize)
    }
}

impl<'de> Deserialize<'de> for ChatHistoryParams {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct RawParams {
            session_key: SessionKey,
            #[serde(default)]
            agent_id: Option<AgentId>,
            #[serde(default)]
            cursor: Option<String>,
            #[serde(default)]
            limit: OptionalHistoryBound,
            #[serde(default)]
            offset: OptionalHistoryBound,
            #[serde(default)]
            max_chars: OptionalHistoryBound,
        }

        let raw = RawParams::deserialize(deserializer)?;
        let mut params = Self::new(raw.session_key);
        params.agent_id = raw.agent_id;
        if let Some(cursor) = raw.cursor { params = params.try_with_cursor(cursor).map_err(D::Error::custom)?; }
        let params = match raw.limit {
            OptionalHistoryBound::Value(limit) => params.try_with_limit(limit),
            OptionalHistoryBound::Missing => Ok(params),
        }
        .map_err(D::Error::custom)?;
        let params = match raw.offset {
            OptionalHistoryBound::Value(offset) => params.try_with_offset(offset),
            OptionalHistoryBound::Missing => Ok(params),
        }
        .map_err(D::Error::custom)?;
        match raw.max_chars {
            OptionalHistoryBound::Value(max_chars) => params.try_with_max_chars(max_chars),
            OptionalHistoryBound::Missing => Ok(params),
        }
        .map_err(D::Error::custom)
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryMessage {
    pub role: HistoryRole,
    pub text: String,
}

impl fmt::Debug for HistoryMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HistoryMessage")
            .field("role", &self.role)
            .field("text_bytes", &self.text.len())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryRole {
    User,
    Assistant,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatHistoryResult {
    pub messages: Vec<HistoryMessage>,
}

impl fmt::Debug for ChatHistoryResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatHistoryResult")
            .field("message_count", &self.messages.len())
            .finish()
    }
}

impl ChatHistoryResult {
    fn from_peer(messages: Vec<PeerHistoryMessage>, limit: usize) -> Self {
        let messages = messages
            .into_iter()
            .filter_map(PeerHistoryMessage::into_public)
            .collect();
        Self {
            messages: trim_history(messages, limit),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerChatHistoryResult {
    messages: Vec<PeerHistoryMessage>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PeerHistoryMessage {
    Object(PeerHistoryMessageObject),
    Other(IgnoredAny),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerHistoryMessageObject {
    role: Option<String>,
    content: Option<PeerHistoryContent>,
}

impl PeerHistoryMessage {
    fn into_public(self) -> Option<HistoryMessage> {
        let Self::Object(message) = self else {
            return None;
        };
        let role = match message.role.as_deref() {
            Some("user") => HistoryRole::User,
            Some("assistant") => HistoryRole::Assistant,
            _ => return None,
        };
        let text = message.content?.into_text()?;
        (!text.is_empty()).then_some(HistoryMessage { role, text })
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PeerHistoryContent {
    Text(String),
    Blocks(Vec<PeerHistoryBlock>),
    Other(IgnoredAny),
}

impl PeerHistoryContent {
    fn into_text(self) -> Option<String> {
        match self {
            Self::Text(text) => Some(text),
            Self::Blocks(blocks) => {
                let text = blocks
                    .into_iter()
                    .filter_map(PeerHistoryBlock::into_text)
                    .collect::<Vec<_>>()
                    .join("\n");
                (!text.is_empty()).then_some(text)
            }
            Self::Other(_) => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PeerHistoryBlock {
    Object(PeerHistoryBlockObject),
    Other(IgnoredAny),
}

impl PeerHistoryBlock {
    fn into_text(self) -> Option<String> {
        let Self::Object(block) = self else {
            return None;
        };
        (block.kind == "text").then_some(block.text?)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerHistoryBlockObject {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

fn trim_history(mut messages: Vec<HistoryMessage>, limit: usize) -> Vec<HistoryMessage> {
    if messages.len() > limit {
        messages.drain(..messages.len() - limit);
    }

    for message in &mut messages {
        truncate_utf8(&mut message.text, MAX_HISTORY_MESSAGE_BYTES);
    }

    while history_response_bytes(&messages) > MAX_HISTORY_RESPONSE_BYTES {
        if messages.len() > 1 {
            messages.remove(0);
            continue;
        }
        if let Some(message) = messages.first_mut() {
            let overhead = history_response_bytes(&[HistoryMessage {
                role: message.role,
                text: String::new(),
            }]);
            truncate_utf8(
                &mut message.text,
                MAX_HISTORY_RESPONSE_BYTES.saturating_sub(overhead),
            );
        }
        break;
    }
    messages
}

fn history_response_bytes(messages: &[HistoryMessage]) -> usize {
    serde_json::to_vec(&ChatHistoryResult {
        messages: messages.to_vec(),
    })
    .map_or(usize::MAX, |encoded| encoded.len())
}

fn truncate_utf8(text: &mut String, limit: usize) {
    if text.len() <= limit {
        return;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct AgentScopedSessionKey(String);

impl AgentScopedSessionKey {
    pub fn try_new(
        agent_id: AgentId,
        endpoint_session_id: EndpointSessionId,
    ) -> Result<Self, ValidationError> {
        let agent_id = agent_id.as_str();
        let endpoint_session_id = endpoint_session_id.as_str();
        if endpoint_session_id.trim() != endpoint_session_id
            || endpoint_session_id
                .get(..6)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("agent:"))
            || endpoint_session_id
                .split(':')
                .any(|segment| segment.is_empty())
        {
            return Err(ValidationError("agent-scoped session key is invalid"));
        }
        Ok(Self(format!("agent:{agent_id}:{endpoint_session_id}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AgentScopedSessionKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AgentScopedSessionKey")
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct SessionCreateParams {
    key: AgentScopedSessionKey,
    #[serde(rename = "agentId")]
    agent_id: AgentId,
    model: ModelRef,
}

impl SessionCreateParams {
    pub fn try_new(
        agent_id: AgentId,
        endpoint_session_id: EndpointSessionId,
        model: ModelRef,
    ) -> Result<Self, ValidationError> {
        let key = AgentScopedSessionKey::try_new(agent_id.clone(), endpoint_session_id)?;
        Ok(Self {
            key,
            agent_id,
            model,
        })
    }

    pub fn key(&self) -> &AgentScopedSessionKey {
        &self.key
    }
}

impl fmt::Debug for SessionCreateParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCreateParams")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct SessionDeleteParams {
    key: AgentScopedSessionKey,
}

impl SessionDeleteParams {
    pub fn new(key: AgentScopedSessionKey) -> Self {
        Self { key }
    }

    pub fn key(&self) -> &AgentScopedSessionKey {
        &self.key
    }
}

impl fmt::Debug for SessionDeleteParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionDeleteParams")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionCreateResult {
    native_session_id: NativeSessionId,
    model_state: Option<sessions_module::state::SessionModelState>,
}

impl SessionCreateResult {
    pub fn native_session_id(&self) -> &NativeSessionId {
        &self.native_session_id
    }

    pub fn model_state(&self) -> Option<sessions_module::state::SessionModelState> {
        self.model_state.clone()
    }
}

impl fmt::Debug for SessionCreateResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCreateResult")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionIdentityReadback {
    key: SessionKey,
    native_session_id: NativeSessionId,
}

impl SessionIdentityReadback {
    pub fn key(&self) -> &SessionKey {
        &self.key
    }

    pub fn native_session_id(&self) -> &NativeSessionId {
        &self.native_session_id
    }
}

impl fmt::Debug for SessionIdentityReadback {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionIdentityReadback")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionPermissionMode {
    ReadOnly,
    Guarded,
    Workspace,
    Full,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionDeleteResult {
    pub deleted: bool,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct SessionModelPatchParams {
    key: SessionKey,
    model: Option<ModelRef>,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPermissionPatchParams {
    key: SessionKey,
    permission_mode: Option<SessionPermissionMode>,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLabelPatchParams {
    key: SessionKey,
    label: String,
}

impl SessionPermissionPatchParams {
    pub fn new(key: SessionKey, selection: Option<SessionPermissionMode>) -> Self {
        Self {
            key,
            permission_mode: selection,
        }
    }

    pub fn key(&self) -> &SessionKey {
        &self.key
    }

    pub const fn selection(&self) -> Option<SessionPermissionMode> {
        self.permission_mode
    }
}

impl fmt::Debug for SessionPermissionPatchParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionPermissionPatchParams")
            .field("selection", &self.permission_mode)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionPermissionPatchResult {
    pub key: SessionKey,
    pub mode: Option<SessionPermissionMode>,
}

impl<'de> Deserialize<'de> for SessionPermissionPatchResult {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            ok: bool,
            key: SessionKey,
            #[serde(default, rename = "path")]
            _path: Option<IgnoredAny>,
            entry: Option<PermissionPatchEntry>,
        }

        let payload = Payload::deserialize(deserializer)?;
        payload
            .ok
            .then_some(Self {
                key: payload.key,
                mode: payload.entry.and_then(|entry| entry.permission_mode),
            })
            .ok_or_else(|| D::Error::custom("sessions.patch permission result must be successful"))
    }
}

impl fmt::Debug for SessionPermissionPatchResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionPermissionPatchResult")
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionPatchEntry {
    #[serde(default, deserialize_with = "deserialize_session_permission_mode")]
    permission_mode: Option<SessionPermissionMode>,
}

fn deserialize_session_permission_mode<'de, D>(
    deserializer: D,
) -> Result<Option<SessionPermissionMode>, D::Error>
where
    D: Deserializer<'de>,
{
    session_permission_mode(Value::deserialize(deserializer)?).map_err(D::Error::custom)
}

fn session_permission_mode(value: Value) -> Result<Option<SessionPermissionMode>, &'static str> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) if value == "default" => Ok(None),
        value => serde_json::from_value(value)
            .map(Some)
            .map_err(|_| "session permission mode is invalid"),
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPermissionProjection {
    pub supported: bool,
    pub mode: Option<SessionPermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<SessionPermissionMode>,
    pub pending: bool,
    pub can_select_full: bool,
    pub options: Vec<SessionPermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SessionPermissionProjection {
    pub fn supported(
        mode: Option<SessionPermissionMode>,
        default_mode: Option<SessionPermissionMode>,
        pending: bool,
        can_select_full: bool,
    ) -> Self {
        Self {
            supported: true,
            mode,
            default_mode,
            pending,
            can_select_full,
            options: SessionPermissionMode::options().to_vec(),
            reason: None,
        }
    }

    pub fn unsupported(reason: impl Into<String>) -> Self {
        Self {
            supported: false,
            mode: None,
            default_mode: None,
            pending: false,
            can_select_full: false,
            options: Vec::new(),
            reason: Some(reason.into()),
        }
    }
}

impl fmt::Debug for SessionPermissionProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionPermissionProjection")
            .field("supported", &self.supported)
            .field("mode", &self.mode)
            .field("default_mode", &self.default_mode)
            .field("pending", &self.pending)
            .field("can_select_full", &self.can_select_full)
            .field("option_count", &self.options.len())
            .field("has_reason", &self.reason.is_some())
            .finish()
    }
}

impl SessionPermissionMode {
    pub const fn options() -> &'static [Self; 4] {
        &[Self::ReadOnly, Self::Guarded, Self::Workspace, Self::Full]
    }
}

impl SessionLabelPatchParams {
    pub fn try_new(key: SessionKey, label: impl Into<String>) -> Result<Self, ValidationError> {
        Ok(Self {
            key,
            label: parse_session_label(label.into())?,
        })
    }

    pub fn key(&self) -> &SessionKey {
        &self.key
    }
}

impl fmt::Debug for SessionLabelPatchParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionLabelPatchParams")
            .field("has_label", &true)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionLabelPatchResult {
    pub key: SessionKey,
}

impl<'de> Deserialize<'de> for SessionLabelPatchResult {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            ok: bool,
            key: SessionKey,
            #[serde(default, rename = "path")]
            _path: Option<IgnoredAny>,
            #[serde(default, rename = "entry")]
            _entry: Option<IgnoredAny>,
        }

        let payload = Payload::deserialize(deserializer)?;
        payload
            .ok
            .then_some(Self { key: payload.key })
            .ok_or_else(|| D::Error::custom("sessions.patch label result must be successful"))
    }
}

impl fmt::Debug for SessionLabelPatchResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionLabelPatchResult")
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for SessionModelPatchParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionModelPatchParams")
            .field("has_model", &self.model.is_some())
            .finish_non_exhaustive()
    }
}
impl SessionModelPatchParams {
    pub fn new(key: SessionKey, model: Option<ModelRef>) -> Self {
        Self { key, model }
    }

    pub fn key(&self) -> &SessionKey {
        &self.key
    }
}
#[derive(Clone, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_minutes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    configured_agents_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    include_derived_titles: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    include_last_message: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    search: Option<String>,
}
impl fmt::Debug for SessionsListParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionsListParams")
            .field("has_limit", &self.limit.is_some())
            .field("has_active_minutes", &self.active_minutes.is_some())
            .field(
                "has_configured_agents_only",
                &self.configured_agents_only.is_some(),
            )
            .field(
                "has_include_derived_titles",
                &self.include_derived_titles.is_some(),
            )
            .field(
                "has_include_last_message",
                &self.include_last_message.is_some(),
            )
            .field("has_agent_id", &self.agent_id.is_some())
            .field("has_search", &self.search.is_some())
            .finish()
    }
}
#[derive(Clone, Eq, PartialEq)]
pub struct SessionModelPatchResult {
    pub key: SessionKey,
    pub resolved: ResolvedSessionModel,
}
impl<'de> Deserialize<'de> for SessionModelPatchResult {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            ok: bool,
            key: SessionKey,
            resolved: ResolvedSessionModel,
            #[serde(default, rename = "path")]
            _path: Option<IgnoredAny>,
            #[serde(default, rename = "entry")]
            _entry: Option<IgnoredAny>,
        }

        let payload = Payload::deserialize(deserializer)?;
        if !payload.ok {
            return Err(D::Error::custom("sessions.patch result must be successful"));
        }
        Ok(Self {
            key: payload.key,
            resolved: payload.resolved,
        })
    }
}
impl fmt::Debug for SessionModelPatchResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionModelPatchResult")
            .field("has_resolved_model", &true)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSessionModel {
    pub model_provider: ModelRef,
    pub model: ModelRef,
    pub agent_runtime: SessionAgentRuntime,
}

impl ResolvedSessionModel {
    pub fn model_identity(&self) -> sessions_module::state::SessionModelIdentity {
        openclaw_model_identity(Some(self.model_provider.as_str()), self.model.as_str())
    }

    pub fn model_state(&self) -> sessions_module::state::SessionModelState {
        sessions_module::state::SessionModelState {
            selected: Some(self.model_identity()),
            active: None,
            override_source: Some(sessions_module::state::SessionModelOverrideSource::User),
            selection_id: None,
        }
    }
}
impl fmt::Debug for ResolvedSessionModel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedSessionModel")
            .field("agent_runtime_source", &self.agent_runtime.source)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionAgentRuntime {
    pub id: AgentRuntimeId,
    pub source: SessionAgentRuntimeSource,
}
impl fmt::Debug for SessionAgentRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionAgentRuntime")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}
identity!(
    AgentRuntimeId,
    "agent runtime id must be a non-empty string"
);
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionAgentRuntimeSource {
    Env,
    Agent,
    Defaults,
    Model,
    Provider,
    Implicit,
    SessionKey,
}
impl SessionsListParams {
    pub fn try_with_limit(mut self, value: u64) -> Result<Self, ValidationError> {
        self.limit = Some(positive(value, "sessions list limit must be positive")?);
        Ok(self)
    }
    pub fn try_with_active_minutes(mut self, value: u64) -> Result<Self, ValidationError> {
        self.active_minutes = Some(positive(value, "active minutes must be positive")?);
        Ok(self)
    }
    pub fn configured_agents_only(mut self) -> Self {
        self.configured_agents_only = Some(true);
        self
    }
    pub fn include_titles_and_last_message(mut self) -> Self {
        self.include_derived_titles = Some(true);
        self.include_last_message = Some(true);
        self
    }
    pub fn try_for_agent(mut self, value: impl Into<String>) -> Result<Self, ValidationError> {
        self.agent_id = Some(non_empty(value, "agent id must be a non-empty string")?);
        Ok(self)
    }
    pub fn try_with_search(mut self, value: impl Into<String>) -> Result<Self, ValidationError> {
        self.search = Some(non_empty(
            value,
            "sessions list search must be a non-empty string",
        )?);
        Ok(self)
    }
}
#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescribeParams {
    key: SessionKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
}
impl fmt::Debug for SessionDescribeParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionDescribeParams")
            .field("has_agent_id", &self.agent_id.is_some())
            .finish_non_exhaustive()
    }
}
impl SessionDescribeParams {
    pub fn new(key: SessionKey, agent_id: Option<&str>) -> Self {
        Self {
            key,
            agent_id: agent_id.map(str::to_owned),
        }
    }

    pub fn key(&self) -> &SessionKey {
        &self.key
    }
}
/// One `sessions.describe` row. The row carries the selected model as a bare model id next to
/// its provider, so [`Self::model_ref`] is the only place that rejoins them into a runtime ref.
#[derive(Clone, Eq, PartialEq)]
pub struct SessionDescribeRow {
    pub key: Option<String>,
    pub session_id: Option<String>,
    pub goal: sessions_module::goal::SessionGoalView,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub agent_id: Option<AgentId>,
    pub model_override_source: Option<SessionModelOverrideSource>,
}
impl<'de> Deserialize<'de> for SessionDescribeRow {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let payload = Value::deserialize(deserializer)?;
        let object = payload
            .as_object()
            .ok_or_else(|| D::Error::custom("sessions.describe session must be an object"))?;
        let session_info = object.get("sessionInfo").and_then(Value::as_object);
        let metadata = object.get("metadata").and_then(Value::as_object);
        let read = |name: &str| {
            session_wire_field(object, session_info, metadata, &[name]).unwrap_or(Value::Null)
        };
        Ok(Self {
            key: serde_json::from_value(read("key")).map_err(D::Error::custom)?,
            session_id: serde_json::from_value(read("sessionId")).map_err(D::Error::custom)?,
            goal: match super::goal::view(&payload).map_err(D::Error::custom)? {
                sessions_module::goal::SessionGoalView::Unknown => sessions_module::goal::SessionGoalView::Known { goal: None },
                goal => goal,
            },
            model: serde_json::from_value(read("model")).map_err(D::Error::custom)?,
            model_provider: serde_json::from_value(read("modelProvider"))
                .map_err(D::Error::custom)?,
            agent_id: serde_json::from_value(read("agentId")).map_err(D::Error::custom)?,
            model_override_source: serde_json::from_value(read("modelOverrideSource"))
                .map_err(D::Error::custom)?,
        })
    }
}
impl SessionDescribeRow {
    /// Rejoins the row's selected model into the canonical `provider/model` runtime ref shared
    /// with [`crate::native_config::ProviderModelRuntimeIdentity::runtime_model_ref`].
    pub fn model_ref(&self) -> Option<String> {
        Some(openclaw_model_ref(
            self.model_provider.as_deref(),
            self.model.as_deref()?,
        ))
    }

    pub fn model_state(&self) -> Option<sessions_module::state::SessionModelState> {
        let model = self.model.as_deref()?;
        Some(sessions_module::state::SessionModelState {
            selected: Some(openclaw_model_identity(
                self.model_provider.as_deref(),
                model,
            )),
            active: None,
            override_source: self.model_override_source.map(|source| match source {
                SessionModelOverrideSource::User => {
                    sessions_module::state::SessionModelOverrideSource::User
                }
                SessionModelOverrideSource::Auto => {
                    sessions_module::state::SessionModelOverrideSource::Auto
                }
            }),
            selection_id: None,
        })
    }
}
impl fmt::Debug for SessionDescribeRow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionDescribeRow")
            .field("has_model", &self.model.is_some())
            .field("has_model_provider", &self.model_provider.is_some())
            .field("has_agent_id", &self.agent_id.is_some())
            .field("model_override_source", &self.model_override_source)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionModelOverrideSource {
    User,
    Auto,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChatSendStatus {
    Started,
    InFlight,
    Ok,
}
#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendResult {
    pub run_id: RunId,
    pub status: ChatSendStatus,
}
impl fmt::Debug for ChatSendResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatSendResult")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatAbortResult {
    pub ok: bool,
    pub aborted: bool,
    pub run_ids: Vec<RunId>,
}
impl fmt::Debug for ChatAbortResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatAbortResult")
            .field("ok", &self.ok)
            .field("aborted", &self.aborted)
            .field("run_count", &self.run_ids.len())
            .finish()
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionAbortResult {
    pub ok: bool,
    pub aborted_run_id: Option<RunId>,
    pub status: SessionAbortStatus,
}
impl fmt::Debug for SessionAbortResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionAbortResult")
            .field("ok", &self.ok)
            .field("has_aborted_run_id", &self.aborted_run_id.is_some())
            .field("status", &self.status)
            .finish()
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionAbortStatus {
    Aborted,
    NoActiveRun,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Direct,
    Group,
    Global,
    Unknown,
}

#[derive(Clone, Eq, PartialEq)]
pub struct AgentScopedSessionSummary {
    pub session_key: SessionKey,
    pub agent_id: AgentId,
    pub native_session_id: NativeSessionId,
}

#[derive(Clone, PartialEq)]
pub struct SessionSummary {
    pub key: SessionKey,
    pub native_session_id: Option<NativeSessionId>,
    pub kind: SessionKind,
    pub agent_id: Option<AgentId>,
    pub label: Option<String>,
    pub display_name: Option<String>,
    pub derived_title: Option<String>,
    pub updated_at: Option<u64>,
    pub status: Option<String>,
    pub has_active_run: Option<bool>,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub active_model: Option<String>,
    pub active_model_provider: Option<String>,
    pub model_override_source: Option<SessionModelOverrideSource>,
    pub permission_mode: Option<SessionPermissionMode>,
    pub permission_mode_pending: Option<bool>,
}

impl<'de> Deserialize<'de> for SessionSummary {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut payload = Value::deserialize(deserializer)?;
        let object = payload
            .as_object_mut()
            .ok_or_else(|| D::Error::custom("session summary must be an object"))?;
        let session_info = object.get("sessionInfo").and_then(Value::as_object);
        let metadata = object.get("metadata").and_then(Value::as_object);
        let key = session_wire_field(object, session_info, metadata, &["key", "sessionKey"])
            .ok_or_else(|| D::Error::custom("session summary key is required"))?;
        let kind = session_wire_field(object, session_info, metadata, &["kind"])
            .ok_or_else(|| D::Error::custom("session summary kind is required"))?;
        for field in [
            "spawnedBy",
            "spawnedWorkspaceDir",
            "forkedFromParent",
            "spawnDepth",
            "subagentRole",
            "subagentControlScope",
            "lastMessagePreview",
            "lastMessage",
            "channel",
            "subject",
            "groupChannel",
            "space",
            "chatType",
            "origin",
            "systemSent",
            "abortedLastRun",
            "thinkingLevel",
            "thinkingLevels",
            "thinkingOptions",
            "thinkingDefault",
            "fastMode",
            "verboseLevel",
            "traceLevel",
            "reasoningLevel",
            "elevatedLevel",
            "sendPolicy",
            "inputTokens",
            "outputTokens",
            "totalTokens",
            "totalTokensFresh",
            "estimatedCostUsd",
            "subagentRunState",
            "hasActiveSubagentRun",
            "parentSessionKey",
            "childSessions",
            "responseUsage",
            "agentRuntime",
            "contextTokens",
            "deliveryContext",
            "lastChannel",
            "lastTo",
            "lastAccountId",
            "lastThreadId",
            "compactionCheckpointCount",
            "latestCompactionCheckpoint",
            "pluginExtensions",
        ] {
            if object.contains_key(field) {
                let _: IgnoredAny =
                    serde_json::from_value(object[field].clone()).map_err(D::Error::custom)?;
            }
        }
        let read = |name: &str| object.get(name).cloned().unwrap_or(Value::Null);
        Ok(Self {
            key: serde_json::from_value(key).map_err(D::Error::custom)?,
            native_session_id: serde_json::from_value(
                session_wire_field(object, session_info, metadata, &["sessionId"])
                    .unwrap_or(Value::Null),
            )
            .map_err(D::Error::custom)?,
            kind: serde_json::from_value(kind).map_err(D::Error::custom)?,
            agent_id: serde_json::from_value(
                session_wire_field(object, session_info, metadata, &["agentId"])
                    .unwrap_or(Value::Null),
            )
            .map_err(D::Error::custom)?,
            label: serde_json::from_value(read("label")).map_err(D::Error::custom)?,
            display_name: serde_json::from_value(read("displayName")).map_err(D::Error::custom)?,
            derived_title: serde_json::from_value(read("derivedTitle"))
                .map_err(D::Error::custom)?,
            updated_at: serde_json::from_value(
                session_wire_field(object, session_info, metadata, &["updatedAt"])
                    .unwrap_or(Value::Null),
            )
            .map_err(D::Error::custom)?,
            status: serde_json::from_value(read("status")).map_err(D::Error::custom)?,
            has_active_run: serde_json::from_value(read("hasActiveRun"))
                .map_err(D::Error::custom)?,
            model: serde_json::from_value(read("model")).map_err(D::Error::custom)?,
            model_provider: serde_json::from_value(read("modelProvider"))
                .map_err(D::Error::custom)?,
            active_model: serde_json::from_value(read("activeModel")).map_err(D::Error::custom)?,
            active_model_provider: serde_json::from_value(read("activeModelProvider"))
                .map_err(D::Error::custom)?,
            model_override_source: serde_json::from_value(read("modelOverrideSource"))
                .map_err(D::Error::custom)?,
            permission_mode: session_permission_mode(read("permissionMode"))
                .map_err(D::Error::custom)?,
            permission_mode_pending: serde_json::from_value(read("permissionModePending"))
                .map_err(D::Error::custom)?,
        })
    }
}

fn session_wire_field(
    object: &Map<String, Value>,
    session_info: Option<&Map<String, Value>>,
    metadata: Option<&Map<String, Value>>,
    names: &[&str],
) -> Option<Value> {
    names
        .iter()
        .find_map(|name| object.get(*name).cloned())
        .or_else(|| {
            session_info.and_then(|session_info| {
                names
                    .iter()
                    .find_map(|name| session_info.get(*name).cloned())
            })
        })
        .or_else(|| {
            metadata.and_then(|metadata| names.iter().find_map(|name| metadata.get(*name).cloned()))
        })
}

impl SessionSummary {
    pub fn model_state(&self) -> Option<sessions_module::state::SessionModelState> {
        let model = self.model.as_deref()?;
        Some(sessions_module::state::SessionModelState {
            selected: Some(openclaw_model_identity(
                self.model_provider.as_deref(),
                model,
            )),
            active: self.active_model.as_deref().map(|active_model| {
                openclaw_model_identity(self.active_model_provider.as_deref(), active_model)
            }),
            override_source: self.model_override_source.map(|source| match source {
                SessionModelOverrideSource::User => {
                    sessions_module::state::SessionModelOverrideSource::User
                }
                SessionModelOverrideSource::Auto => {
                    sessions_module::state::SessionModelOverrideSource::Auto
                }
            }),
            selection_id: None,
        })
    }

    pub fn agent_scoped_catalog_entry(&self) -> Option<AgentScopedSessionSummary> {
        let native_session_id = self.native_session_id.clone()?;
        let key = self.key.as_str();
        let agent_id = match key.strip_prefix("agent:") {
            Some(scoped_key) => {
                let (agent_id, suffix) = scoped_key.split_once(':')?;
                if suffix.split(':').any(str::is_empty) {
                    return None;
                }
                return Some(AgentScopedSessionSummary {
                    session_key: self.key.clone(),
                    agent_id: AgentId::try_new(agent_id).ok()?,
                    native_session_id,
                });
            }
            None => self.agent_id.clone()?,
        };
        if key.split(':').any(str::is_empty) {
            return None;
        }
        Some(AgentScopedSessionSummary {
            session_key: SessionKey::try_new(format!("agent:{}:{key}", agent_id.as_str())).ok()?,
            agent_id,
            native_session_id,
        })
    }
}

impl fmt::Debug for SessionSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionSummary")
            .field("has_label", &self.label.is_some())
            .field("has_display_name", &self.display_name.is_some())
            .field("has_derived_title", &self.derived_title.is_some())
            .field("has_updated_at", &self.updated_at.is_some())
            .field("has_status", &self.status.is_some())
            .field("has_active_run", &self.has_active_run)
            .field("has_model", &self.model.is_some())
            .field("permission_mode", &self.permission_mode)
            .field("permission_mode_pending", &self.permission_mode_pending)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, PartialEq)]
pub struct SessionsListResult {
    pub timestamp_ms: u64,
    pub count: u64,
    pub total_count: Option<u64>,
    pub limit_applied: Option<u64>,
    pub has_more: Option<bool>,
    pub sessions: Vec<SessionSummary>,
}

impl<'de> Deserialize<'de> for SessionsListResult {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            #[serde(rename = "ts")]
            timestamp_ms: u64,
            count: u64,
            total_count: Option<u64>,
            limit_applied: Option<u64>,
            has_more: Option<bool>,
            sessions: Vec<SessionSummary>,
        }

        let payload = Payload::deserialize(deserializer)?;
        Ok(Self {
            timestamp_ms: payload.timestamp_ms,
            count: payload.count,
            total_count: payload.total_count,
            limit_applied: payload.limit_applied,
            has_more: payload.has_more,
            sessions: payload.sessions,
        })
    }
}

impl fmt::Debug for SessionsListResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionsListResult")
            .field("count", &self.count)
            .field("total_count", &self.total_count)
            .field("limit_applied", &self.limit_applied)
            .field("has_more", &self.has_more)
            .field("session_count", &self.sessions.len())
            .finish()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProtocolError {
    MismatchedResponse,
    Rejected,
    InvalidChatSendResult,
    InvalidChatAbortResult,
    InvalidSessionAbortResult,
    InvalidSessionsListResult,
    InvalidSessionDescribeResult,
    InvalidSessionGoalResult,
    InvalidSessionModelPatchResult,
    InvalidSessionPermissionPatchResult,
    InvalidSessionLabelPatchResult,
    InvalidSessionCreateResult,
    InvalidSessionDeleteResult,
    InvalidChatHistoryResult,
    InvalidSessionEvent,
}
impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MismatchedResponse => "gateway response did not match the session request",
            Self::Rejected => "gateway rejected the session request",
            Self::InvalidChatSendResult => "chat.send result is invalid",
            Self::InvalidChatAbortResult => "chat.abort result is invalid",
            Self::InvalidSessionAbortResult => "sessions.abort result is invalid",
            Self::InvalidSessionsListResult => "sessions.list result is invalid",
            Self::InvalidSessionDescribeResult => "sessions.describe result is invalid",
            Self::InvalidSessionGoalResult => "session goal result is invalid",
            Self::InvalidSessionModelPatchResult => "sessions.patch model result is invalid",
            Self::InvalidSessionPermissionPatchResult => {
                "sessions.patch permission result is invalid"
            }
            Self::InvalidSessionLabelPatchResult => "sessions.patch label result is invalid",
            Self::InvalidSessionCreateResult => "sessions.create result is invalid",
            Self::InvalidSessionDeleteResult => "sessions.delete result is invalid",
            Self::InvalidChatHistoryResult => "chat.history result is invalid",
            Self::InvalidSessionEvent => "session event is invalid",
        })
    }
}
impl std::error::Error for ProtocolError {}
pub fn decode_chat_send_result(
    id: &str,
    response: GatewayResponse,
) -> Result<ChatSendResult, ProtocolError> {
    decode_result(id, response, ProtocolError::InvalidChatSendResult)
}
pub fn decode_chat_abort_result(
    id: &str,
    response: GatewayResponse,
) -> Result<ChatAbortResult, ProtocolError> {
    let result: ChatAbortResult =
        decode_result(id, response, ProtocolError::InvalidChatAbortResult)?;
    result
        .ok
        .then_some(result)
        .ok_or(ProtocolError::InvalidChatAbortResult)
}
pub fn decode_session_abort_result(
    id: &str,
    response: GatewayResponse,
) -> Result<SessionAbortResult, ProtocolError> {
    let result: SessionAbortResult =
        decode_result(id, response, ProtocolError::InvalidSessionAbortResult)?;
    result
        .ok
        .then_some(result)
        .ok_or(ProtocolError::InvalidSessionAbortResult)
}
pub fn decode_sessions_list_result(
    id: &str,
    response: GatewayResponse,
) -> Result<SessionsListResult, ProtocolError> {
    let result: SessionsListResult =
        decode_result(id, response, ProtocolError::InvalidSessionsListResult)?;
    let count = u64::try_from(result.sessions.len())
        .map_err(|_| ProtocolError::InvalidSessionsListResult)?;
    if result.count != count
        || result.total_count.is_some_and(|total| total < count)
        || result.limit_applied == Some(0)
        || matches!((result.has_more, result.total_count), (Some(more), Some(total)) if more != (count < total))
    {
        return Err(ProtocolError::InvalidSessionsListResult);
    }
    Ok(result)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionDescribeEnvelope {
    session: Option<SessionDescribeRow>,
}
pub fn decode_session_describe_result(
    id: &str,
    response: GatewayResponse,
) -> Result<Option<SessionDescribeRow>, ProtocolError> {
    let result: SessionDescribeEnvelope =
        decode_result(id, response, ProtocolError::InvalidSessionDescribeResult)?;
    Ok(result.session)
}
pub fn decode_session_model_patch_result(
    id: &str,
    response: GatewayResponse,
    expected_key: &SessionKey,
) -> Result<SessionModelPatchResult, ProtocolError> {
    let result: SessionModelPatchResult =
        decode_result(id, response, ProtocolError::InvalidSessionModelPatchResult)?;
    (result.key == *expected_key)
        .then_some(result)
        .ok_or(ProtocolError::InvalidSessionModelPatchResult)
}

pub fn decode_session_label_patch_result(
    id: &str,
    response: GatewayResponse,
    expected_key: &SessionKey,
) -> Result<SessionLabelPatchResult, ProtocolError> {
    let result: SessionLabelPatchResult =
        decode_result(id, response, ProtocolError::InvalidSessionLabelPatchResult)?;
    (result.key == *expected_key)
        .then_some(result)
        .ok_or(ProtocolError::InvalidSessionLabelPatchResult)
}

pub fn decode_session_permission_patch_result(
    id: &str,
    response: GatewayResponse,
    expected_key: &SessionKey,
) -> Result<SessionPermissionPatchResult, ProtocolError> {
    let result: SessionPermissionPatchResult = decode_result(
        id,
        response,
        ProtocolError::InvalidSessionPermissionPatchResult,
    )?;
    (result.key == *expected_key)
        .then_some(result)
        .ok_or(ProtocolError::InvalidSessionPermissionPatchResult)
}

pub fn decode_session_create_result(
    id: &str,
    response: GatewayResponse,
    expected_key: &AgentScopedSessionKey,
) -> Result<SessionCreateResult, ProtocolError> {
    let result: PeerSessionCreateResult =
        decode_result(id, response, ProtocolError::InvalidSessionCreateResult)?;
    (result.ok && result.key == expected_key.as_str())
        .then_some(SessionCreateResult {
            native_session_id: result.native_session_id,
            model_state: result.model_state,
        })
        .ok_or(ProtocolError::InvalidSessionCreateResult)
}

pub fn decode_session_delete_result(
    id: &str,
    response: GatewayResponse,
    expected_key: &AgentScopedSessionKey,
) -> Result<SessionDeleteResult, ProtocolError> {
    let result: PeerSessionDeleteResult =
        decode_result(id, response, ProtocolError::InvalidSessionDeleteResult)?;
    (result.ok && result.key == expected_key.as_str())
        .then_some(SessionDeleteResult {
            deleted: result.deleted,
        })
        .ok_or(ProtocolError::InvalidSessionDeleteResult)
}

pub fn decode_chat_history_result(
    id: &str,
    response: GatewayResponse,
    limit: usize,
) -> Result<ChatHistoryResult, ProtocolError> {
    let peer: PeerChatHistoryResult =
        decode_result(id, response, ProtocolError::InvalidChatHistoryResult)?;
    Ok(ChatHistoryResult::from_peer(peer.messages, limit))
}

struct PeerSessionCreateResult {
    ok: bool,
    key: String,
    native_session_id: NativeSessionId,
    model_state: Option<sessions_module::state::SessionModelState>,
}

impl<'de> Deserialize<'de> for PeerSessionCreateResult {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ResolvedModel {
            model_provider: ModelRef,
            model: ModelRef,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Entry {
            model_override_source: Option<SessionModelOverrideSource>,
        }
        #[derive(Deserialize)]
        struct ModelProjection {
            resolved: Option<ResolvedModel>,
            entry: Option<Entry>,
        }

        let payload = Value::deserialize(deserializer)?;
        let projection = ModelProjection::deserialize(&payload).map_err(D::Error::custom)?;
        let model_state = projection.resolved.map(|resolved| {
            sessions_module::state::SessionModelState {
                selected: Some(openclaw_model_identity(
                    Some(resolved.model_provider.as_str()),
                    resolved.model.as_str(),
                )),
                active: None,
                override_source: projection
                    .entry
                    .and_then(|entry| entry.model_override_source)
                    .map(|source| match source {
                        SessionModelOverrideSource::User => {
                            sessions_module::state::SessionModelOverrideSource::User
                        }
                        SessionModelOverrideSource::Auto => {
                            sessions_module::state::SessionModelOverrideSource::Auto
                        }
                    }),
                selection_id: None,
            }
        });
        let object = payload
            .as_object()
            .ok_or_else(|| D::Error::custom("sessions.create result must be an object"))?;
        let session_info = object.get("sessionInfo").and_then(Value::as_object);
        let metadata = object.get("metadata").and_then(Value::as_object);
        let ok = object
            .get("ok")
            .cloned()
            .ok_or_else(|| D::Error::custom("sessions.create ok is required"))?;
        let key = session_wire_field(object, session_info, metadata, &["key", "sessionKey"])
            .ok_or_else(|| D::Error::custom("sessions.create key is required"))?;
        let native_session_id = session_wire_field(
            object,
            session_info,
            metadata,
            &["nativeSessionId", "sessionId"],
        )
        .ok_or_else(|| D::Error::custom("sessions.create native session id is required"))?;
        Ok(Self {
            ok: serde_json::from_value(ok).map_err(D::Error::custom)?,
            key: serde_json::from_value(key).map_err(D::Error::custom)?,
            native_session_id: serde_json::from_value(native_session_id)
                .map_err(D::Error::custom)?,
            model_state,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerSessionDeleteResult {
    ok: bool,
    key: String,
    deleted: bool,
    #[serde(default, rename = "archived")]
    _archived: Option<IgnoredAny>,
}

fn decode_result<T: for<'de> Deserialize<'de>>(
    id: &str,
    response: GatewayResponse,
    invalid: ProtocolError,
) -> Result<T, ProtocolError> {
    if response.request_id() != id {
        return Err(ProtocolError::MismatchedResponse);
    }
    match response {
        GatewayResponse::Success {
            payload: Some(value),
            ..
        } => serde_json::from_value(value).map_err(|_| invalid),
        GatewayResponse::Success { payload: None, .. } => Err(invalid),
        GatewayResponse::Failure { .. } => Err(ProtocolError::Rejected),
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatState {
    Status,
    Delta,
    Final,
    Aborted,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatStatusPhase {
    PreparingWorkspace,
    NamingWorktree,
    CreatingWorktree,
    RunningSetup,
    ProvisioningEnvironment,
    PreparingContext,
    StartingModel,
}

impl ChatStatusPhase {
    fn parse(value: Option<&Value>) -> Option<Self> {
        match value.and_then(Value::as_str)? {
            "preparing_workspace" => Some(Self::PreparingWorkspace),
            "naming_worktree" => Some(Self::NamingWorktree),
            "creating_worktree" => Some(Self::CreatingWorktree),
            "running_setup" => Some(Self::RunningSetup),
            "provisioning_environment" => Some(Self::ProvisioningEnvironment),
            "preparing_context" => Some(Self::PreparingContext),
            "starting_model" => Some(Self::StartingModel),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChatStatusRetry {
    pub attempt: u8,
    pub max_attempts: u8,
}

impl ChatStatusRetry {
    fn parse(value: &Value) -> Result<Self, ProtocolError> {
        let object = value
            .as_object()
            .ok_or(ProtocolError::InvalidSessionEvent)?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "attempt" | "maxAttempts" | "reason"))
            || object.get("reason").and_then(Value::as_str) != Some("rate_limit")
        {
            return Err(ProtocolError::InvalidSessionEvent);
        }
        let attempt = status_retry_attempt(object.get("attempt"))?;
        let max_attempts = status_retry_attempt(object.get("maxAttempts"))?;
        Ok(Self {
            attempt,
            max_attempts,
        })
    }
}

fn status_retry_attempt(value: Option<&Value>) -> Result<u8, ProtocolError> {
    let attempt = value
        .and_then(Value::as_u64)
        .and_then(|attempt| u8::try_from(attempt).ok())
        .ok_or(ProtocolError::InvalidSessionEvent)?;
    (1..=10)
        .contains(&attempt)
        .then_some(attempt)
        .ok_or(ProtocolError::InvalidSessionEvent)
}

#[derive(Clone, PartialEq)]
pub struct ChatEvent {
    pub run_id: RunId,
    pub session_key: SessionKey,
    pub sequence: u64,
    pub state: ChatState,
    pub status_phase: Option<ChatStatusPhase>,
    pub status_retry: Option<ChatStatusRetry>,
    pub delta_text: Option<String>,
    pub replace: bool,
    pub message_text: Option<String>,
    pub message_thinking: Option<String>,
    pub error_kind: Option<SessionErrorKind>,
    pub error_message: Option<String>,
    pub stop_reason: Option<String>,
    pub error_detail: Option<Value>,
}
impl fmt::Debug for ChatEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatEvent")
            .field("sequence", &self.sequence)
            .field("state", &self.state)
            .field("status_phase", &self.status_phase)
            .field("has_status_retry", &self.status_retry.is_some())
            .field("has_delta_text", &self.delta_text.is_some())
            .field("replace", &self.replace)
            .field("has_message_text", &self.message_text.is_some())
            .field("has_message_thinking", &self.message_thinking.is_some())
            .field("error_kind", &self.error_kind)
            .field("has_error_message", &self.error_message.is_some())
            .field("has_stop_reason", &self.stop_reason.is_some())
            .field("has_error_detail", &self.error_detail.is_some())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionErrorKind {
    Refusal,
    Timeout,
    RateLimit,
    ContextLength,
    Unknown,
}

impl SessionErrorKind {
    fn parse(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "refusal" => Some(Self::Refusal),
            "timeout" => Some(Self::Timeout),
            "rate_limit" => Some(Self::RateLimit),
            "context_length" => Some(Self::ContextLength),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}
impl<'de> Deserialize<'de> for ChatEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        decode_chat_event(Value::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}
fn decode_chat_event(payload: Value) -> Result<ChatEvent, ProtocolError> {
    let object = payload
        .as_object()
        .ok_or(ProtocolError::InvalidSessionEvent)?;
    let state = match object.get("state").and_then(Value::as_str) {
        Some("status") => ChatState::Status,
        Some("delta") => ChatState::Delta,
        Some("final") => ChatState::Final,
        Some("aborted") => ChatState::Aborted,
        Some("error") => ChatState::Error,
        _ => return Err(ProtocolError::InvalidSessionEvent),
    };
    let status_phase = if state == ChatState::Status {
        Some(
            ChatStatusPhase::parse(object.get("phase"))
                .ok_or(ProtocolError::InvalidSessionEvent)?,
        )
    } else {
        None
    };
    let status_retry = if state == ChatState::Status {
        object
            .get("retry")
            .map(ChatStatusRetry::parse)
            .transpose()?
    } else {
        None
    };
    if object.keys().any(|key| !allowed_chat_field(state, key))
        || (state == ChatState::Delta
            && object.get("message").is_none()
            && !matches!(object.get("deltaText"), Some(Value::String(_))))
        || ["agentId", "spawnedBy"].into_iter().any(|key| {
            object
                .get(key)
                .is_some_and(|value| !non_empty_string(value))
        })
        || object
            .get("replace")
            .is_some_and(|value| !value.is_boolean())
        || object
            .get("yielded")
            .is_some_and(|value| !matches!(value, Value::Bool(true)))
        || ["stopReason", "errorMessage"]
            .into_iter()
            .any(|key| object.get(key).is_some_and(|value| !value.is_string()))
        || object
            .get("errorKind")
            .is_some_and(|value| SessionErrorKind::parse(value).is_none())
        || object
            .get("errorDetail")
            .is_some_and(|value| !valid_error_detail(value))
    {
        return Err(ProtocolError::InvalidSessionEvent);
    }
    let delta_text = bounded_text(object.get("deltaText"), MAX_SESSION_UPDATE_TEXT_BYTES)?;
    let message = object.get("message");
    let message_text = message
        .and_then(message_content_text)
        .map(|text| bounded_text_value(&text, MAX_SESSION_UPDATE_TEXT_BYTES))
        .transpose()?;
    let message_thinking = message
        .and_then(message_content_thinking)
        .map(|text| bounded_text_value(&text, MAX_SESSION_UPDATE_TEXT_BYTES))
        .transpose()?;
    let sequence: u64 = required(object, "seq")?;
    if sequence > MAX_SAFE_SEQUENCE {
        return Err(ProtocolError::InvalidSessionEvent);
    }
    let error_message = runtime_detail_text(object.get("errorMessage"))?;
    let stop_reason = bounded_text(
        object.get("stopReason"),
        MAX_SESSION_UPDATE_STOP_REASON_BYTES,
    )?;
    Ok(ChatEvent {
        run_id: required(object, "runId")?,
        session_key: required(object, "sessionKey")?,
        sequence,
        state,
        status_phase,
        status_retry,
        delta_text,
        replace: object
            .get("replace")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        message_text,
        message_thinking,
        error_kind: object.get("errorKind").and_then(SessionErrorKind::parse),
        error_message,
        stop_reason,
        error_detail: safe_error_detail(object.get("errorDetail")),
    })
}

fn bounded_text(value: Option<&Value>, limit: usize) -> Result<Option<String>, ProtocolError> {
    value
        .map(|value| {
            value
                .as_str()
                .ok_or(ProtocolError::InvalidSessionEvent)
                .and_then(|text| bounded_text_value(text, limit))
        })
        .transpose()
}

fn bounded_text_value(text: &str, limit: usize) -> Result<String, ProtocolError> {
    if text.len() > limit {
        return Err(ProtocolError::InvalidSessionEvent);
    }
    Ok(text.to_owned())
}

fn message_content_text(message: &Value) -> Option<String> {
    message_content_blocks(message, "text", "text")
}

fn message_content_thinking(message: &Value) -> Option<String> {
    message_content_blocks(message, "thinking", "thinking")
}

fn message_content_blocks(message: &Value, block_type: &str, text_key: &str) -> Option<String> {
    let content = message.get("content")?;
    if block_type == "text"
        && let Some(text) = content.as_str()
    {
        return Some(text.to_owned());
    }
    let text = content
        .as_array()?
        .iter()
        .filter_map(|block| {
            let object = block.as_object()?;
            if object.get("type").and_then(Value::as_str) != Some(block_type) {
                return None;
            }
            object.get(text_key).and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_owned();
    (!text.is_empty()).then_some(text)
}

fn non_empty_string(value: &Value) -> bool {
    matches!(value, Value::String(text) if !text.is_empty())
}

fn valid_error_detail(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().all(|(key, value)| match key.as_str() {
        "provider"
        | "model"
        | "failoverReason"
        | "providerRuntimeFailureKind"
        | "providerErrorType"
        | "providerErrorMessagePreview" => value.as_str().is_some_and(|text| text.len() <= 300),
        "httpStatus" => value
            .as_u64()
            .is_some_and(|status| (100..=599).contains(&status)),
        _ => false,
    })
}

fn safe_error_detail(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let mut detail = Map::new();
    for key in [
        "failoverReason",
        "providerRuntimeFailureKind",
        "providerErrorType",
        "providerErrorMessagePreview",
        "httpStatus",
    ] {
        if let Some(value) = object.get(key) {
            detail.insert(key.to_owned(), value.clone());
        }
    }
    (!detail.is_empty()).then_some(Value::Object(detail))
}

fn message_activity_text(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_owned());
    }
    let blocks = content.as_array()?;
    let text = blocks
        .iter()
        .filter_map(|block| {
            let object = block.as_object()?;
            if object.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            object.get("text").and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\\n");
    (!text.is_empty()).then_some(text)
}

fn bounded_activity_id<T>(value: Option<&Value>, error: ProtocolError) -> Result<T, ProtocolError>
where
    T: for<'de> Deserialize<'de>,
{
    let value = value.ok_or(error)?;
    let text = value.as_str().ok_or(error)?;
    if text.is_empty() || text.len() > MAX_SESSION_ACTIVITY_ID_BYTES {
        return Err(error);
    }
    serde_json::from_value(Value::String(text.to_owned())).map_err(|_| error)
}

fn activity_text(value: Option<&Value>) -> Result<Option<String>, ProtocolError> {
    value
        .map(|value| {
            let text = value.as_str().ok_or(ProtocolError::InvalidSessionEvent)?;
            if text.contains('\0') {
                return Err(ProtocolError::InvalidSessionEvent);
            }
            bounded_text_value(text, MAX_SESSION_ACTIVITY_TEXT_BYTES)
        })
        .transpose()
}

struct ProjectedSessionActivity {
    kind: SessionActivityKind,
    tool_payload: Option<ToolActivityPayload>,
}

fn activity_name(value: Option<&Value>) -> Result<Option<String>, ProtocolError> {
    value
        .map(|value| {
            let text = value.as_str().ok_or(ProtocolError::InvalidSessionEvent)?;
            if text.is_empty()
                || text.len() > MAX_SESSION_ACTIVITY_ID_BYTES
                || text.trim() != text
                || text.chars().any(char::is_control)
            {
                return Err(ProtocolError::InvalidSessionEvent);
            }
            Ok(text.to_owned())
        })
        .transpose()
}

fn optional_bool(object: &Map<String, Value>, key: &str) -> Result<Option<bool>, ProtocolError> {
    object
        .get(key)
        .map(|value| value.as_bool().ok_or(ProtocolError::InvalidSessionEvent))
        .transpose()
}

fn tool_payload_value(value: Option<&Value>) -> Result<Option<Value>, ProtocolError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if payload_contains_nul(value) {
        return Err(ProtocolError::InvalidSessionEvent);
    }
    let encoded = serde_json::to_vec(value).map_err(|_| ProtocolError::InvalidSessionEvent)?;
    if encoded.len() > MAX_SESSION_TOOL_PAYLOAD_BYTES {
        return Err(ProtocolError::InvalidSessionEvent);
    }
    Ok(Some(value.clone()))
}

fn tool_result_output(object: &Map<String, Value>) -> Option<&Value> {
    let result = object.get("result");
    if result
        .and_then(Value::as_object)
        .is_some_and(|result| result.len() == 1 && result.contains_key("details"))
    {
        return object.get("content").or_else(|| object.get("output"));
    }
    result
        .or_else(|| object.get("content"))
        .or_else(|| object.get("output"))
}

fn tool_details_value(values: [Option<&Value>; 2]) -> Result<Option<Value>, ProtocolError> {
    let mut details = Map::new();
    for value in values.into_iter().flatten() {
        let Some(object) = value.as_object() else {
            continue;
        };
        for key in [
            "browserTab",
            "changed",
            "created",
            "diff",
            "patch",
            "approvalReviews",
            "approvalReviewOutcome",
            "mcpAppPreview",
            "truncation",
            "fullOutputPath",
            "exitCode",
        ] {
            let projected = if key == "mcpAppPreview" {
                object.get(key).and_then(project_mcp_app_preview_value)
            } else {
                object.get(key).and_then(project_tool_detail_value)
            };
            if let Some(projected) = projected {
                details.insert(key.to_owned(), projected);
            }
        }
    }
    if details.is_empty() {
        return Ok(None);
    }
    let value = Value::Object(details);
    if payload_contains_nul(&value) {
        return Err(ProtocolError::InvalidSessionEvent);
    }
    let encoded = serde_json::to_vec(&value).map_err(|_| ProtocolError::InvalidSessionEvent)?;
    if encoded.len() > MAX_SESSION_TOOL_DETAILS_BYTES {
        return Err(ProtocolError::InvalidSessionEvent);
    }
    Ok(Some(value))
}

fn project_mcp_app_preview_value(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut projected = Map::new();
    for key in [
        "kind",
        "surface",
        "render",
        "title",
        "preferredHeight",
        "url",
        "viewId",
        "sandbox",
        "boardWidgetName",
    ] {
        if let Some(value) = object.get(key).and_then(project_tool_detail_value) {
            projected.insert(key.to_owned(), value);
        }
    }
    if let Some(value) = object
        .get("mcpApp")
        .and_then(project_mcp_app_descriptor_value)
    {
        projected.insert("mcpApp".to_owned(), value);
    }
    (!projected.is_empty()).then_some(Value::Object(projected))
}

fn project_mcp_app_descriptor_value(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut projected = Map::new();
    for key in [
        "viewId",
        "serverName",
        "toolName",
        "uiResourceUri",
        "toolCallId",
        "originSessionKey",
        "resultMetaState",
    ] {
        if let Some(value) = object.get(key).and_then(project_tool_detail_value) {
            projected.insert(key.to_owned(), value);
        }
    }
    (!projected.is_empty()).then_some(Value::Object(projected))
}

fn project_tool_detail_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Some(value.clone()),
        Value::Array(values) => Some(Value::Array(
            values
                .iter()
                .filter_map(project_tool_detail_value)
                .collect(),
        )),
        Value::Object(object) => {
            let mut projected = Map::new();
            for (key, value) in object {
                if key.contains('\0') {
                    return None;
                }
                if raw_tool_detail_key(key) {
                    continue;
                }
                if let Some(value) = project_tool_detail_value(value) {
                    projected.insert(key.clone(), value);
                }
            }
            Some(Value::Object(projected))
        }
    }
}

fn raw_tool_detail_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|char| *char != '_' && *char != '-')
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "rawassistanttext"
            | "toolinput"
            | "tooloutput"
            | "toolresult"
            | "privatepayload"
            | "html"
            | "input"
            | "output"
    ) || normalized.contains("secret")
        || normalized.starts_with("raw")
        || normalized.starts_with("private")
}

fn tool_payload_text(
    input: Option<&Value>,
    explicit: Option<&Value>,
) -> Result<Option<String>, ProtocolError> {
    if let Some(text) = tool_payload_text_value(explicit)? {
        return Ok(Some(text));
    }
    let Some(input) = input else {
        return Ok(None);
    };
    match input {
        Value::String(_) => tool_payload_text_value(Some(input)),
        value => {
            let text = serde_json::to_string_pretty(value)
                .map_err(|_| ProtocolError::InvalidSessionEvent)?;
            if text.len() > MAX_SESSION_TOOL_PAYLOAD_BYTES || text.contains('\0') {
                return Err(ProtocolError::InvalidSessionEvent);
            }
            Ok(Some(text))
        }
    }
}

fn tool_payload_text_value(value: Option<&Value>) -> Result<Option<String>, ProtocolError> {
    value
        .map(|value| {
            let text = value.as_str().ok_or(ProtocolError::InvalidSessionEvent)?;
            if text.contains('\0') {
                return Err(ProtocolError::InvalidSessionEvent);
            }
            bounded_text_value(text, MAX_SESSION_TOOL_PAYLOAD_BYTES)
        })
        .transpose()
}

fn payload_contains_nul(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\0'),
        Value::Array(values) => values.iter().any(payload_contains_nul),
        Value::Object(object) => object
            .iter()
            .any(|(key, value)| key.contains('\0') || payload_contains_nul(value)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn project_message_activity(
    object: &Map<String, Value>,
    message_id: Option<&MessageId>,
    embedded_message_id: Option<&MessageId>,
) -> Result<Option<ProjectedSessionActivity>, ProtocolError> {
    let lifecycle = object
        .get("lifecycle")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let message_id = message_id
        .or(embedded_message_id)
        .ok_or(ProtocolError::InvalidSessionEvent)?
        .clone();
    let lifecycle = match lifecycle {
        "started" => MessageActivityLifecycle::Started,
        "delta" => MessageActivityLifecycle::Delta,
        "completed" => MessageActivityLifecycle::Completed,
        _ => return Err(ProtocolError::InvalidSessionEvent),
    };
    let text = match lifecycle {
        MessageActivityLifecycle::Delta => {
            let message = object
                .get("message")
                .ok_or(ProtocolError::InvalidSessionEvent)?;
            let text = message_activity_text(message).ok_or(ProtocolError::InvalidSessionEvent)?;
            Some(bounded_text_value(&text, MAX_SESSION_ACTIVITY_TEXT_BYTES)?)
        }
        MessageActivityLifecycle::Started | MessageActivityLifecycle::Completed => None,
    };
    Ok(Some(ProjectedSessionActivity {
        kind: SessionActivityKind::Message {
            message_id,
            lifecycle,
            text,
        },
        tool_payload: None,
    }))
}

fn project_tool_activity(
    object: &Map<String, Value>,
) -> Result<Option<ProjectedSessionActivity>, ProtocolError> {
    let phase = object
        .get("phase")
        .and_then(Value::as_str)
        .ok_or(ProtocolError::InvalidSessionEvent)?;
    let tool_id = bounded_activity_id(
        object.get("toolCallId").or_else(|| object.get("toolId")),
        ProtocolError::InvalidSessionEvent,
    )?;
    let is_error = optional_bool(object, "isError")?;
    let phase = match phase {
        "start" | "started" => ToolActivityPhase::Started,
        "update" | "updated" => ToolActivityPhase::Updated,
        "result" if is_error == Some(true) => ToolActivityPhase::Failed,
        "result" | "completed" => ToolActivityPhase::Completed,
        "failed" => ToolActivityPhase::Failed,
        _ => return Err(ProtocolError::InvalidSessionEvent),
    };
    let tool_name = activity_name(object.get("name").or_else(|| object.get("toolName")))?;
    let input = tool_payload_value(
        object
            .get("args")
            .or_else(|| object.get("arguments"))
            .or_else(|| object.get("input"))
            .or_else(|| object.get("toolInput")),
    )?;
    let input_text = tool_payload_text(input.as_ref(), object.get("input_text"))?;
    let output = tool_payload_value(match phase {
        ToolActivityPhase::Updated => object
            .get("partialResult")
            .or_else(|| object.get("partial_result"))
            .or_else(|| object.get("output")),
        ToolActivityPhase::Completed | ToolActivityPhase::Failed => tool_result_output(object),
        ToolActivityPhase::Started => None,
    })?;
    let details = tool_details_value([
        object
            .get("result")
            .and_then(|result| result.get("details")),
        object.get("details"),
    ])?;
    let summary = activity_text(object.get("summary").or_else(|| object.get("text")))?;
    Ok(Some(ProjectedSessionActivity {
        kind: SessionActivityKind::Tool {
            tool_id,
            tool_name,
            phase,
            summary,
        },
        tool_payload: Some(ToolActivityPayload {
            input,
            input_text,
            output,
            details,
            is_error,
        }),
    }))
}

struct ProjectedAgentEvent {
    activity: Option<ProjectedSessionActivity>,
    approval: Option<SessionApprovalEvent>,
}

fn project_agent_event(
    object: &Map<String, Value>,
    session_key: SessionKey,
    run_id: Option<RunId>,
) -> Result<ProjectedAgentEvent, ProtocolError> {
    let stream = object
        .get("stream")
        .and_then(Value::as_str)
        .ok_or(ProtocolError::InvalidSessionEvent)?;
    let data = object
        .get("data")
        .and_then(Value::as_object)
        .ok_or(ProtocolError::InvalidSessionEvent)?;
    match stream {
        "tool" => Ok(ProjectedAgentEvent {
            activity: project_tool_activity(data)?,
            approval: None,
        }),
        "thinking" => {
            let Some(text) = activity_text(
                data.get("thinking")
                    .or_else(|| data.get("text"))
                    .or_else(|| data.get("content")),
            )?
            else {
                return Ok(ProjectedAgentEvent {
                    activity: None,
                    approval: None,
                });
            };
            Ok(ProjectedAgentEvent {
                activity: Some(ProjectedSessionActivity {
                    kind: SessionActivityKind::Thinking { text },
                    tool_payload: None,
                }),
                approval: None,
            })
        }
        "approval" => Ok(ProjectedAgentEvent {
            activity: None,
            approval: project_agent_approval_event(data, session_key, run_id)?,
        }),
        "compaction" => Ok(ProjectedAgentEvent {
            activity: project_compaction_activity(data)?,
            approval: None,
        }),
        "lifecycle" | "fallback" => Ok(ProjectedAgentEvent {
            activity: project_lifecycle_activity(stream, data)?,
            approval: None,
        }),
        "codex_app_server.guardian" => Ok(ProjectedAgentEvent {
            activity: project_guardian_activity(data)?,
            approval: None,
        }),
        _ => Ok(ProjectedAgentEvent {
            activity: None,
            approval: None,
        }),
    }
}

fn project_compaction_activity(
    data: &Map<String, Value>,
) -> Result<Option<ProjectedSessionActivity>, ProtocolError> {
    match data.get("phase").and_then(Value::as_str) {
        Some("start") => Ok(Some(ProjectedSessionActivity {
            kind: SessionActivityKind::Compaction {
                phase: RuntimeActivityPhase::Started,
            },
            tool_payload: None,
        })),
        Some("end")
            if data.get("completed").and_then(Value::as_bool) == Some(true)
                && data.get("willRetry").and_then(Value::as_bool) == Some(true) =>
        {
            Ok(Some(ProjectedSessionActivity {
                kind: SessionActivityKind::Compaction {
                    phase: RuntimeActivityPhase::Retrying,
                },
                tool_payload: None,
            }))
        }
        Some("end") => Ok(Some(ProjectedSessionActivity {
            kind: SessionActivityKind::Compaction {
                phase: RuntimeActivityPhase::Completed,
            },
            tool_payload: None,
        })),
        Some(_) | None => Ok(None),
    }
}

fn project_lifecycle_activity(
    stream: &str,
    data: &Map<String, Value>,
) -> Result<Option<ProjectedSessionActivity>, ProtocolError> {
    let phase = if stream == "fallback" {
        Some("fallback")
    } else {
        data.get("phase").and_then(Value::as_str)
    };
    match phase {
        Some("fallback") => {
            let Some(detail) = project_runtime_fallback_detail(data)? else {
                return Ok(None);
            };
            Ok(Some(ProjectedSessionActivity {
                kind: SessionActivityKind::Fallback { detail },
                tool_payload: None,
            }))
        }
        Some("fallback_cleared") => Ok(Some(ProjectedSessionActivity {
            kind: SessionActivityKind::FallbackCleared,
            tool_payload: None,
        })),
        Some("end") | Some("error") => Ok(Some(ProjectedSessionActivity {
            kind: SessionActivityKind::Compaction {
                phase: RuntimeActivityPhase::CompletedIfRetrying,
            },
            tool_payload: None,
        })),
        Some(_) | None => Ok(None),
    }
}

fn project_runtime_fallback_detail(
    data: &Map<String, Value>,
) -> Result<Option<RuntimeFallbackDetail>, ProtocolError> {
    let detail = RuntimeFallbackDetail {
        failover_reason: runtime_detail_text(
            data.get("reasonSummary")
                .or_else(|| data.get("reason"))
                .or_else(|| data.get("failoverReason")),
        )?,
        provider_runtime_failure_kind: runtime_detail_text(data.get("providerRuntimeFailureKind"))?,
        provider_error_type: runtime_detail_text(data.get("providerErrorType"))?,
        provider_error_message_preview: runtime_detail_text(
            data.get("providerErrorMessagePreview"),
        )?,
        http_status: data
            .get("httpStatus")
            .and_then(Value::as_u64)
            .filter(|status| (100..=599).contains(status))
            .and_then(|status| u16::try_from(status).ok()),
    };
    Ok((detail.failover_reason.is_some()
        || detail.provider_runtime_failure_kind.is_some()
        || detail.provider_error_type.is_some()
        || detail.provider_error_message_preview.is_some()
        || detail.http_status.is_some())
    .then_some(detail))
}

fn project_guardian_activity(
    data: &Map<String, Value>,
) -> Result<Option<ProjectedSessionActivity>, ProtocolError> {
    let phase = match data.get("phase").and_then(Value::as_str) {
        Some("started") => RuntimeGuardianPhase::Reviewing,
        Some("completed") => match data.get("status").and_then(Value::as_str) {
            Some("approved") => RuntimeGuardianPhase::Approved,
            Some("denied") => RuntimeGuardianPhase::Denied,
            _ => return Ok(None),
        },
        Some("warning") => RuntimeGuardianPhase::Warning,
        Some("strict_review_required") => RuntimeGuardianPhase::StrictReviewRequired,
        _ => return Ok(None),
    };
    Ok(Some(ProjectedSessionActivity {
        kind: SessionActivityKind::Guardian {
            notice: RuntimeGuardianNotice {
                phase,
                command: runtime_detail_text(data.get("command"))?,
                risk_level: runtime_detail_text(data.get("riskLevel"))?,
                rationale: runtime_detail_text(data.get("rationale"))?,
                message: runtime_detail_text(data.get("message"))?,
            },
        },
        tool_payload: None,
    }))
}

fn runtime_detail_text(value: Option<&Value>) -> Result<Option<String>, ProtocolError> {
    value
        .map(|value| {
            let text = value.as_str().ok_or(ProtocolError::InvalidSessionEvent)?;
            if text.contains('\0') {
                return Err(ProtocolError::InvalidSessionEvent);
            }
            bounded_text_value(text, MAX_SESSION_RUNTIME_DETAIL_TEXT_BYTES)
        })
        .transpose()
}

fn project_agent_approval_event(
    data: &Map<String, Value>,
    session_key: SessionKey,
    run_id: Option<RunId>,
) -> Result<Option<SessionApprovalEvent>, ProtocolError> {
    if data.get("phase").and_then(Value::as_str) != Some("requested")
        || data.get("kind").and_then(Value::as_str) != Some("exec")
        || data.get("status").and_then(Value::as_str) != Some("pending")
    {
        return Ok(None);
    }
    Ok(Some(SessionApprovalEvent {
        source: SessionApprovalSource::Exec,
        lifecycle: SessionApprovalLifecycle::Requested,
        approval_id: bounded_activity_id(
            data.get("approvalId").or_else(|| data.get("id")),
            ProtocolError::InvalidSessionEvent,
        )?,
        session_key,
        run_id,
        option_ids: approval_option_ids(data)?,
    }))
}

fn project_approval_event(
    source: SessionApprovalSource,
    lifecycle: SessionApprovalLifecycle,
    object: &Map<String, Value>,
    session_key: SessionKey,
    run_id: Option<RunId>,
) -> Result<SessionApprovalEvent, ProtocolError> {
    let request = object.get("request").and_then(Value::as_object);
    Ok(SessionApprovalEvent {
        source,
        lifecycle,
        approval_id: bounded_activity_id(
            object
                .get("id")
                .or_else(|| object.get("approvalId"))
                .or_else(|| object.get("requestId"))
                .or_else(|| request.and_then(|request| request.get("approvalId")))
                .or_else(|| request.and_then(|request| request.get("id"))),
            ProtocolError::InvalidSessionEvent,
        )?,
        session_key,
        run_id,
        option_ids: approval_option_ids(object)?,
    })
}

fn approval_option_ids(
    object: &Map<String, Value>,
) -> Result<Vec<ApprovalOptionId>, ProtocolError> {
    let request = object.get("request").and_then(Value::as_object);
    let mut option_ids = Vec::new();
    for value in [
        object.get("allowedDecisions"),
        request.and_then(|request| request.get("allowedDecisions")),
        object.get("options"),
        request.and_then(|request| request.get("options")),
    ]
    .into_iter()
    .flatten()
    {
        collect_approval_option_ids(value, &mut option_ids)?;
    }
    if option_ids.is_empty() {
        for option_id in ["allow-once", "deny"] {
            option_ids.push(
                ApprovalOptionId::try_new(option_id.to_owned())
                    .map_err(|_| ProtocolError::InvalidSessionEvent)?,
            );
        }
    }
    Ok(option_ids)
}

fn collect_approval_option_ids(
    value: &Value,
    option_ids: &mut Vec<ApprovalOptionId>,
) -> Result<(), ProtocolError> {
    let options = value.as_array().ok_or(ProtocolError::InvalidSessionEvent)?;
    for option in options {
        let id = option.as_str().or_else(|| {
            option
                .as_object()
                .and_then(|object| object.get("optionId").or_else(|| object.get("id")))
                .and_then(Value::as_str)
        });
        let Some(id) = id else {
            return Err(ProtocolError::InvalidSessionEvent);
        };
        if option_ids.iter().any(|option| option.as_str() == id) {
            continue;
        }
        option_ids.push(
            ApprovalOptionId::try_new(id.to_owned())
                .map_err(|_| ProtocolError::InvalidSessionEvent)?,
        );
    }
    Ok(())
}

fn session_key_for_event(
    kind: SessionEventKind,
    object: &Map<String, Value>,
) -> Result<Option<SessionKey>, ProtocolError> {
    if !matches!(
        kind,
        SessionEventKind::ApprovalRequested | SessionEventKind::ApprovalResolved
    ) {
        return required(object, "sessionKey").map(Some);
    }
    if let Some(session_key) = optional_value(object.get("sessionKey"))? {
        return Ok(Some(session_key));
    }
    object
        .get("request")
        .and_then(Value::as_object)
        .map(|request| optional_value(request.get("sessionKey")))
        .transpose()
        .map(Option::flatten)
}

fn run_id_for_event(
    kind: SessionEventKind,
    object: &Map<String, Value>,
) -> Result<Option<RunId>, ProtocolError> {
    let run_id = optional_value(object.get("runId"))?;
    if run_id.is_some()
        || !matches!(
            kind,
            SessionEventKind::ApprovalRequested | SessionEventKind::ApprovalResolved
        )
    {
        return Ok(run_id);
    }
    object
        .get("request")
        .and_then(Value::as_object)
        .map(|request| optional_value(request.get("runId")))
        .transpose()
        .map(Option::flatten)
}

fn project_changed_event(
    object: &Map<String, Value>,
    session_key: SessionKey,
    run_id: Option<RunId>,
) -> Result<Option<SessionChangedEvent>, ProtocolError> {
    let Some(run_id) = run_id else {
        return Ok(None);
    };
    let phase = match object.get("phase").and_then(Value::as_str) {
        Some("start") => SessionChangedPhase::Start,
        Some("end") => SessionChangedPhase::End,
        Some("error") => SessionChangedPhase::Error,
        _ => return Ok(None),
    };
    Ok(Some(SessionChangedEvent {
        session_key,
        run_id,
        phase,
    }))
}

fn optional_value<T>(value: Option<&Value>) -> Result<Option<T>, ProtocolError>
where
    T: for<'de> Deserialize<'de>,
{
    value
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| ProtocolError::InvalidSessionEvent)
}

fn allowed_chat_field(state: ChatState, field: &str) -> bool {
    matches!(
        field,
        "runId" | "sessionKey" | "agentId" | "spawnedBy" | "seq" | "state"
    ) || (state == ChatState::Status && matches!(field, "phase" | "retry"))
        || (state == ChatState::Delta
            && matches!(field, "message" | "deltaText" | "replace" | "usage"))
        || (state == ChatState::Final
            && matches!(field, "message" | "usage" | "stopReason" | "yielded"))
        || (state == ChatState::Aborted
            && matches!(field, "message" | "errorMessage" | "stopReason"))
        || (state == ChatState::Error
            && matches!(
                field,
                "message" | "errorMessage" | "errorKind" | "errorDetail" | "usage" | "stopReason"
            ))
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionEventKind {
    Chat,
    Message,
    Tool,
    Agent,
    ApprovalRequested,
    ApprovalResolved,
    Changed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionChangedPhase {
    Start,
    End,
    Error,
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionChangedEvent {
    pub session_key: SessionKey,
    pub run_id: RunId,
    pub phase: SessionChangedPhase,
}

impl fmt::Debug for SessionChangedEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionChangedEvent")
            .field("phase", &self.phase)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessageActivityLifecycle {
    Started,
    Delta,
    Completed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolActivityPhase {
    Started,
    Updated,
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionApprovalSource {
    Exec,
    Plugin,
    SystemAgent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionApprovalLifecycle {
    Requested,
    Resolved,
}

fn openclaw_model_ref(provider: Option<&str>, model: &str) -> String {
    let Some(provider) = provider else {
        return model.to_owned();
    };
    if model.starts_with(provider) && model.as_bytes().get(provider.len()) == Some(&b'/') {
        return model.to_owned();
    }
    format!("{provider}/{model}")
}

fn openclaw_model_identity(
    provider: Option<&str>,
    model: &str,
) -> sessions_module::state::SessionModelIdentity {
    sessions_module::state::SessionModelIdentity {
        provider: provider.map(str::to_owned),
        model: model.to_owned(),
        model_ref: openclaw_model_ref(provider, model),
    }
}

identity!(ToolId, "tool id must be a non-empty string");
identity!(ApprovalId, "approval id must be a non-empty string");
identity!(
    ApprovalOptionId,
    "approval option id must be a non-empty string"
);

#[derive(Clone, Eq, PartialEq)]
pub enum SessionActivityKind {
    Message {
        message_id: MessageId,
        lifecycle: MessageActivityLifecycle,
        text: Option<String>,
    },
    Tool {
        tool_id: ToolId,
        tool_name: Option<String>,
        phase: ToolActivityPhase,
        summary: Option<String>,
    },
    Thinking {
        text: String,
    },
    Compaction {
        phase: RuntimeActivityPhase,
    },
    Fallback {
        detail: RuntimeFallbackDetail,
    },
    FallbackCleared,
    Guardian {
        notice: RuntimeGuardianNotice,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeActivityPhase {
    Started,
    Retrying,
    Completed,
    CompletedIfRetrying,
}

#[derive(Clone, Eq, PartialEq)]
pub struct RuntimeFallbackDetail {
    pub failover_reason: Option<String>,
    pub provider_runtime_failure_kind: Option<String>,
    pub provider_error_type: Option<String>,
    pub provider_error_message_preview: Option<String>,
    pub http_status: Option<u16>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct RuntimeGuardianNotice {
    pub phase: RuntimeGuardianPhase,
    pub command: Option<String>,
    pub risk_level: Option<String>,
    pub rationale: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeGuardianPhase {
    Reviewing,
    Approved,
    Denied,
    Warning,
    StrictReviewRequired,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ToolActivityPayload {
    input: Option<Value>,
    input_text: Option<String>,
    output: Option<Value>,
    details: Option<Value>,
    is_error: Option<bool>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionActivity {
    pub gateway_sequence: Option<u64>,
    pub session_key: SessionKey,
    pub run_id: RunId,
    pub kind: SessionActivityKind,
    tool_payload: Option<ToolActivityPayload>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionApprovalEvent {
    pub source: SessionApprovalSource,
    pub lifecycle: SessionApprovalLifecycle,
    pub approval_id: ApprovalId,
    pub session_key: SessionKey,
    pub run_id: Option<RunId>,
    pub option_ids: Vec<ApprovalOptionId>,
}

impl ToolActivityPayload {
    pub fn input(&self) -> Option<&Value> {
        self.input.as_ref()
    }
    pub fn input_text(&self) -> Option<&str> {
        self.input_text.as_deref()
    }
    pub fn output(&self) -> Option<&Value> {
        self.output.as_ref()
    }
    pub fn details(&self) -> Option<&Value> {
        self.details.as_ref()
    }
    pub fn is_error(&self) -> Option<bool> {
        self.is_error
    }
}

impl fmt::Debug for ToolActivityPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolActivityPayload")
            .field("has_input", &self.input.is_some())
            .field(
                "input_text_bytes",
                &self.input_text.as_ref().map_or(0, String::len),
            )
            .field("has_output", &self.output.is_some())
            .field("has_details", &self.details.is_some())
            .field("is_error", &self.is_error)
            .finish()
    }
}

impl SessionActivity {
    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }
    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn kind(&self) -> &SessionActivityKind {
        &self.kind
    }
    pub fn gateway_sequence(&self) -> Option<u64> {
        self.gateway_sequence
    }
    pub fn tool_payload(&self) -> Option<&ToolActivityPayload> {
        self.tool_payload.as_ref()
    }
    pub fn input(&self) -> Option<&Value> {
        self.tool_payload
            .as_ref()
            .and_then(ToolActivityPayload::input)
    }
    pub fn input_text(&self) -> Option<&str> {
        self.tool_payload
            .as_ref()
            .and_then(ToolActivityPayload::input_text)
    }
    pub fn output(&self) -> Option<&Value> {
        self.tool_payload
            .as_ref()
            .and_then(ToolActivityPayload::output)
    }
    pub fn details(&self) -> Option<&Value> {
        self.tool_payload
            .as_ref()
            .and_then(ToolActivityPayload::details)
    }
    pub fn is_error(&self) -> Option<bool> {
        self.tool_payload
            .as_ref()
            .and_then(ToolActivityPayload::is_error)
    }
}

impl SessionActivityKind {
    pub fn message_id(&self) -> Option<&MessageId> {
        match self {
            Self::Message { message_id, .. } => Some(message_id),
            Self::Tool { .. }
            | Self::Thinking { .. }
            | Self::Compaction { .. }
            | Self::Fallback { .. }
            | Self::FallbackCleared
            | Self::Guardian { .. } => None,
        }
    }
    pub fn tool_id(&self) -> Option<&ToolId> {
        match self {
            Self::Tool { tool_id, .. } => Some(tool_id),
            Self::Message { .. }
            | Self::Thinking { .. }
            | Self::Compaction { .. }
            | Self::Fallback { .. }
            | Self::FallbackCleared
            | Self::Guardian { .. } => None,
        }
    }
    pub fn message_lifecycle(&self) -> Option<MessageActivityLifecycle> {
        match self {
            Self::Message { lifecycle, .. } => Some(*lifecycle),
            Self::Tool { .. }
            | Self::Thinking { .. }
            | Self::Compaction { .. }
            | Self::Fallback { .. }
            | Self::FallbackCleared
            | Self::Guardian { .. } => None,
        }
    }
    pub fn tool_phase(&self) -> Option<ToolActivityPhase> {
        match self {
            Self::Tool { phase, .. } => Some(*phase),
            Self::Message { .. }
            | Self::Thinking { .. }
            | Self::Compaction { .. }
            | Self::Fallback { .. }
            | Self::FallbackCleared
            | Self::Guardian { .. } => None,
        }
    }
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Message { text, .. } => text.as_deref(),
            Self::Tool { summary, .. } => summary.as_deref(),
            Self::Thinking { text } => Some(text),
            Self::Compaction { .. }
            | Self::Fallback { .. }
            | Self::FallbackCleared
            | Self::Guardian { .. } => None,
        }
    }
}

impl fmt::Debug for SessionActivity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionActivity")
            .field("has_gateway_sequence", &self.gateway_sequence.is_some())
            .field("kind", &self.kind)
            .field("has_tool_payload", &self.tool_payload.is_some())
            .finish()
    }
}

impl fmt::Debug for SessionActivityKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Message {
                lifecycle, text, ..
            } => formatter
                .debug_struct("Message")
                .field("lifecycle", lifecycle)
                .field("has_text", &text.is_some())
                .finish(),
            Self::Tool {
                phase,
                tool_name,
                summary,
                ..
            } => formatter
                .debug_struct("Tool")
                .field("phase", phase)
                .field("has_tool_name", &tool_name.is_some())
                .field("has_summary", &summary.is_some())
                .finish(),
            Self::Thinking { text } => formatter
                .debug_struct("Thinking")
                .field("text_bytes", &text.len())
                .finish(),
            Self::Compaction { phase } => formatter
                .debug_struct("Compaction")
                .field("phase", phase)
                .finish(),
            Self::Fallback { detail } => formatter
                .debug_struct("Fallback")
                .field("has_failover_reason", &detail.failover_reason.is_some())
                .field(
                    "has_provider_runtime_failure_kind",
                    &detail.provider_runtime_failure_kind.is_some(),
                )
                .field(
                    "has_provider_error_type",
                    &detail.provider_error_type.is_some(),
                )
                .field(
                    "has_provider_error_message_preview",
                    &detail.provider_error_message_preview.is_some(),
                )
                .field("has_http_status", &detail.http_status.is_some())
                .finish(),
            Self::FallbackCleared => formatter.debug_struct("FallbackCleared").finish(),
            Self::Guardian { notice } => formatter
                .debug_struct("Guardian")
                .field("phase", &notice.phase)
                .field("has_command", &notice.command.is_some())
                .field("has_risk_level", &notice.risk_level.is_some())
                .field("has_rationale", &notice.rationale.is_some())
                .field("has_message", &notice.message.is_some())
                .finish(),
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct SessionEventEnvelope {
    pub gateway_sequence: Option<u64>,
    pub kind: SessionEventKind,
    pub session_key: SessionKey,
    pub run_id: Option<RunId>,
    pub message_id: Option<MessageId>,
    pub(crate) embedded_message_id: Option<MessageId>,
    pub chat: Option<ChatEvent>,
    pub activity: Option<SessionActivity>,
    pub approval: Option<SessionApprovalEvent>,
    pub changed: Option<SessionChangedEvent>,
    pub(crate) transcript_message: Option<super::window::Message>,
    pub(crate) commentary: Option<(String, String)>,
}
impl fmt::Debug for SessionEventEnvelope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEventEnvelope")
            .field("gateway_sequence", &self.gateway_sequence)
            .field("has_run_id", &self.run_id.is_some())
            .field("has_message_id", &self.message_id.is_some())
            .field("has_chat", &self.chat.is_some())
            .finish_non_exhaustive()
    }
}
pub fn decode_session_event(
    event: GatewayEvent,
) -> Result<Option<SessionEventEnvelope>, ProtocolError> {
    let mut approval_source = None;
    let mut approval_lifecycle = None;
    let mut kind = match event.name.as_str() {
        "chat" => SessionEventKind::Chat,
        "session.message" => SessionEventKind::Message,
        "session.tool" => SessionEventKind::Tool,
        "agent" => SessionEventKind::Agent,
        "exec.approval.requested" => {
            approval_source = Some(SessionApprovalSource::Exec);
            approval_lifecycle = Some(SessionApprovalLifecycle::Requested);
            SessionEventKind::ApprovalRequested
        }
        "exec.approval.resolved" => {
            approval_source = Some(SessionApprovalSource::Exec);
            approval_lifecycle = Some(SessionApprovalLifecycle::Resolved);
            SessionEventKind::ApprovalResolved
        }
        "plugin.approval.requested" => {
            approval_source = Some(SessionApprovalSource::Plugin);
            approval_lifecycle = Some(SessionApprovalLifecycle::Requested);
            SessionEventKind::ApprovalRequested
        }
        "plugin.approval.resolved" => {
            approval_source = Some(SessionApprovalSource::Plugin);
            approval_lifecycle = Some(SessionApprovalLifecycle::Resolved);
            SessionEventKind::ApprovalResolved
        }
        "session.approval" => SessionEventKind::ApprovalRequested,
        "sessions.changed" => SessionEventKind::Changed,
        _ => return Ok(None),
    };
    let payload = event.payload.ok_or(ProtocolError::InvalidSessionEvent)?;
    let object = payload
        .as_object()
        .ok_or(ProtocolError::InvalidSessionEvent)?;
    if kind == SessionEventKind::Changed && !object.contains_key("sessionKey") {
        return Ok(None);
    }
    let chat = (kind == SessionEventKind::Chat)
        .then(|| decode_chat_event(payload.clone()))
        .transpose()?;
    let message_id = optional(object, "messageId")?;
    let embedded_message_id = embedded_message_id(object)?;
    let Some(session_key) = session_key_for_event(kind, object)? else {
        return Ok(None);
    };
    let run_id = run_id_for_event(kind, object)?;
    let mut approval = match (approval_source, approval_lifecycle) {
        (Some(source), Some(lifecycle)) => Some(project_approval_event(
            source,
            lifecycle,
            object,
            session_key.clone(),
            run_id.clone(),
        )?),
        _ => None,
    };
    let activity = match kind {
        SessionEventKind::Message if run_id.is_some() && object.get("lifecycle").is_some() => {
            project_message_activity(object, message_id.as_ref(), embedded_message_id.as_ref())?
        }
        SessionEventKind::Tool if run_id.is_some() => project_tool_activity(object)?,
        SessionEventKind::Agent => {
            let agent = project_agent_event(object, session_key.clone(), run_id.clone())?;
            if let Some(agent_approval) = agent.approval {
                kind = match agent_approval.lifecycle {
                    SessionApprovalLifecycle::Requested => SessionEventKind::ApprovalRequested,
                    SessionApprovalLifecycle::Resolved => SessionEventKind::ApprovalResolved,
                };
                approval = Some(agent_approval);
            }
            agent.activity
        }
        SessionEventKind::Message
        | SessionEventKind::Tool
        | SessionEventKind::Chat
        | SessionEventKind::ApprovalRequested
        | SessionEventKind::ApprovalResolved
        | SessionEventKind::Changed => None,
    };
    let activity = match (activity, run_id.as_ref()) {
        (Some(activity), Some(run_id)) => {
            if event
                .sequence
                .is_some_and(|sequence| sequence > MAX_SAFE_SEQUENCE)
            {
                return Err(ProtocolError::InvalidSessionEvent);
            }
            Some(SessionActivity {
                gateway_sequence: event.sequence,
                session_key: session_key.clone(),
                run_id: run_id.clone(),
                kind: activity.kind,
                tool_payload: activity.tool_payload,
            })
        }
        (Some(_), None) => return Err(ProtocolError::InvalidSessionEvent),
        (None, _) => None,
    };
    let changed = if kind == SessionEventKind::Changed {
        project_changed_event(object, session_key.clone(), run_id.clone())?
    } else {
        None
    };
    if event.name == "session.approval" {
        let decoded = decode_session_approval(object.get("approval").cloned().ok_or(ProtocolError::InvalidSessionEvent)?, session_key.clone())?;
        kind = match decoded.lifecycle {
            SessionApprovalLifecycle::Requested => SessionEventKind::ApprovalRequested,
            SessionApprovalLifecycle::Resolved => SessionEventKind::ApprovalResolved,
        };
        approval = Some(decoded);
    }
    let transcript_message = if kind == SessionEventKind::Message && object.get("message").and_then(|value| value.get("role")).is_some() {
        Some(super::window::decode_session_message(&payload).map_err(|_| ProtocolError::InvalidSessionEvent)?)
    } else { None };
    let run_id = run_id.or_else(|| transcript_message.as_ref().and_then(|message| message.run_id()).and_then(|run| RunId::try_new(run.to_owned()).ok()));
    let commentary = if kind == SessionEventKind::Agent && object.get("stream").and_then(Value::as_str) == Some("item") {
        let data = object.get("data").and_then(Value::as_object).ok_or(ProtocolError::InvalidSessionEvent)?;
        if data.get("kind").and_then(Value::as_str) == Some("preamble") {
            match data.get("itemId").or_else(|| data.get("id")) {
                Some(value) => {
                    let id = value.as_str().filter(|id| !id.trim().is_empty() && id.len() <= 256).ok_or(ProtocolError::InvalidSessionEvent)?;
                    Some((id.to_owned(), bounded_text(data.get("progressText"), MAX_SESSION_UPDATE_TEXT_BYTES)?.unwrap_or_default()))
                }
                None => None,
            }
        } else { None }
    } else { None };
    let envelope = SessionEventEnvelope {
        gateway_sequence: event.sequence,
        kind,
        session_key,
        run_id,
        message_id,
        embedded_message_id,
        chat,
        activity,
        approval,
        changed,
        transcript_message,
        commentary,
    };
    Ok(Some(envelope))
}

pub(crate) fn decode_session_approval(snapshot: Value, session_key: SessionKey) -> Result<SessionApprovalEvent, ProtocolError> {
    let object = snapshot.as_object().ok_or(ProtocolError::InvalidSessionEvent)?;
    let presentation = object.get("presentation").and_then(Value::as_object).ok_or(ProtocolError::InvalidSessionEvent)?;
    let source = match presentation.get("kind").and_then(Value::as_str) {
        Some("exec") => SessionApprovalSource::Exec,
        Some("plugin") => SessionApprovalSource::Plugin,
        Some("system-agent") => SessionApprovalSource::SystemAgent,
        _ => return Err(ProtocolError::InvalidSessionEvent),
    };
    let lifecycle = match object.get("status").and_then(Value::as_str) {
        Some("pending") => SessionApprovalLifecycle::Requested,
        Some("allowed" | "denied" | "expired" | "cancelled") => SessionApprovalLifecycle::Resolved,
        _ => return Err(ProtocolError::InvalidSessionEvent),
    };
    let options = presentation.get("allowedDecisions").and_then(Value::as_array).ok_or(ProtocolError::InvalidSessionEvent)?;
    if options.is_empty() || options.len() > 3 { return Err(ProtocolError::InvalidSessionEvent); }
    let option_ids = options.iter().map(|value| match value.as_str() {
        Some("allow-once" | "allow-always" | "deny") => ApprovalOptionId::try_new(value.as_str().unwrap().to_owned()).map_err(|_| ProtocolError::InvalidSessionEvent),
        _ => Err(ProtocolError::InvalidSessionEvent),
    }).collect::<Result<Vec<_>, _>>()?;
    Ok(SessionApprovalEvent { source, lifecycle, approval_id: required(object, "id")?, session_key, run_id: optional(object, "runId")?, option_ids })
}

fn embedded_message_id(object: &Map<String, Value>) -> Result<Option<MessageId>, ProtocolError> {
    let Some(message) = object.get("message") else {
        return Ok(None);
    };
    let Some(id) = message
        .pointer("/__openclaw/id")
        .or_else(|| message.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    MessageId::try_new(id.to_owned())
        .map(Some)
        .map_err(|_| ProtocolError::InvalidSessionEvent)
}

fn required<T: for<'de> Deserialize<'de>>(
    object: &Map<String, Value>,
    key: &str,
) -> Result<T, ProtocolError> {
    object
        .get(key)
        .cloned()
        .ok_or(ProtocolError::InvalidSessionEvent)
        .and_then(|value| {
            serde_json::from_value(value).map_err(|_| ProtocolError::InvalidSessionEvent)
        })
}
fn optional<T: for<'de> Deserialize<'de>>(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<T>, ProtocolError> {
    object
        .get(key)
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| ProtocolError::InvalidSessionEvent)
}
fn non_empty(value: impl Into<String>, error: &'static str) -> Result<String, ValidationError> {
    let value = value.into();
    (!value.is_empty())
        .then_some(value)
        .ok_or(ValidationError(error))
}

/// Mirrors OpenClaw's `parseSessionLabel`: the label is trimmed, must not be
/// blank, and is stored trimmed.
fn parse_session_label(value: String) -> Result<String, ValidationError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_SESSION_LABEL_BYTES {
        return Err(ValidationError("session label is invalid"));
    }
    Ok(trimmed.to_owned())
}
fn positive(value: u64, error: &'static str) -> Result<u64, ValidationError> {
    (value > 0).then_some(value).ok_or(ValidationError(error))
}

fn valid_agent_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && bytes.iter().all(|byte| !byte.is_ascii_uppercase())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::wire::GatewayError;
    fn json(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }
    fn key() -> SessionKey {
        SessionKey::try_new("agent:main:session-1").unwrap()
    }
    fn run() -> RunId {
        RunId::try_new("run-7").unwrap()
    }
    fn success(id: &str, raw: &str) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: id.into(),
            payload: Some(json(raw)),
        }
    }
    fn event(name: &str, raw: &str) -> GatewayEvent {
        GatewayEvent {
            name: name.into(),
            payload: Some(json(raw)),
            sequence: Some(91),
            state_version: None,
        }
    }

    fn assert_debug_redacts(value: &impl fmt::Debug, canaries: &[&str]) {
        let debug = format!("{value:?}");
        for canary in canaries {
            assert!(
                !debug.contains(canary),
                "debug output leaked {canary}: {debug}"
            );
        }
    }

    #[test]
    fn params_and_chat_attachment_validation() {
        let send = ChatSendParams::try_new(key(), "", run())
            .unwrap()
            .with_delivery(false);
        assert_eq!(
            serde_json::to_value(send).unwrap(),
            json(
                r#"{"sessionKey":"agent:main:session-1","message":"","deliver":false,"idempotencyKey":"run-7"}"#
            )
        );
        let with_receipt = ChatSendParams::try_new(key(), "hello", run())
            .unwrap()
            .with_system_provenance_receipt("system note");
        assert_eq!(
            serde_json::to_value(with_receipt).unwrap(),
            json(
                r#"{"sessionKey":"agent:main:session-1","message":"hello","idempotencyKey":"run-7","systemProvenanceReceipt":"system note"}"#
            )
        );
        let with_attachments = ChatSendParams::try_new(key(), "review this", run())
            .unwrap()
            .try_with_attachment(
                ChatAttachment::try_new("text/plain", "notes.txt", "aGVsbG8=").unwrap(),
            )
            .unwrap()
            .try_with_attachment(
                ChatAttachment::try_new("application/pdf", "review.pdf", "cGRm")
                    .unwrap()
                    .with_type("document"),
            )
            .unwrap()
            .try_with_attachment(
                ChatAttachment::try_new("application/zip", "archive.zip", "emlw").unwrap(),
            )
            .unwrap()
            .try_with_attachment(
                ChatAttachment::try_new("image/png", "diagram.png", "aW1hZ2U=")
                    .unwrap()
                    .with_type("image"),
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(with_attachments).unwrap(),
            json(
                r#"{"sessionKey":"agent:main:session-1","message":"review this","idempotencyKey":"run-7","attachments":[{"mimeType":"text/plain","fileName":"notes.txt","content":"aGVsbG8="},{"type":"document","mimeType":"application/pdf","fileName":"review.pdf","content":"cGRm"},{"mimeType":"application/zip","fileName":"archive.zip","content":"emlw"},{"type":"image","mimeType":"image/png","fileName":"diagram.png","content":"aW1hZ2U="}]}"#
            )
        );
        assert_eq!(
            serde_json::to_value(ChatAbortParams::new(key()).for_run(run())).unwrap(),
            json(r#"{"sessionKey":"agent:main:session-1","runId":"run-7"}"#)
        );
        assert_eq!(
            serde_json::to_value(SessionAbortParams::new(key()).for_run(run())).unwrap(),
            json(r#"{"key":"agent:main:session-1","runId":"run-7"}"#)
        );
        assert_eq!(
            serde_json::to_value(SessionModelPatchParams::new(
                key(),
                Some(ModelRef::try_new("anthropic/claude-opus-4-7").unwrap()),
            ))
            .unwrap(),
            json(r#"{"key":"agent:main:session-1","model":"anthropic/claude-opus-4-7"}"#)
        );
        assert_eq!(
            serde_json::to_value(SessionModelPatchParams::new(key(), None)).unwrap(),
            json(r#"{"key":"agent:main:session-1","model":null}"#)
        );
        assert_eq!(
            serde_json::to_value(SessionPermissionPatchParams::new(
                key(),
                Some(SessionPermissionMode::Full),
            ))
            .unwrap(),
            json(r#"{"key":"agent:main:session-1","permissionMode":"full"}"#)
        );
        assert_eq!(
            serde_json::to_value(SessionPermissionPatchParams::new(key(), None)).unwrap(),
            json(r#"{"key":"agent:main:session-1","permissionMode":null}"#)
        );
        assert_eq!(
            serde_json::to_value(ChatHistoryParams::new(key())).unwrap(),
            json(r#"{"sessionKey":"agent:main:session-1"}"#)
        );
        let history = ChatHistoryParams::new(key())
            .try_with_limit(25)
            .unwrap()
            .try_with_offset(40)
            .unwrap()
            .try_with_max_chars(10_000)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&history).unwrap(),
            json(
                r#"{"sessionKey":"agent:main:session-1","limit":25,"offset":40,"maxChars":10000}"#
            )
        );
        assert_eq!(
            serde_json::from_str::<ChatHistoryParams>(
                r#"{"sessionKey":"agent:main:session-1","limit":25,"offset":40,"maxChars":10000}"#,
            )
            .unwrap(),
            history,
        );
        for raw in [
            r#"{"sessionKey":"agent:main:session-1","limit":0,"maxChars":1}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":1001,"maxChars":1}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":1,"maxChars":0}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":1,"maxChars":500001}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":1,"offset":9007199254740992}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":null}"#,
            r#"{"sessionKey":"agent:main:session-1","offset":null}"#,
            r#"{"sessionKey":"agent:main:session-1","maxChars":null}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":1,"maxChars":1,"future":true}"#,
        ] {
            assert!(serde_json::from_str::<ChatHistoryParams>(raw).is_err());
        }
        let list = SessionsListParams::default()
            .try_with_limit(25)
            .unwrap()
            .try_with_active_minutes(120)
            .unwrap()
            .configured_agents_only()
            .include_titles_and_last_message()
            .try_for_agent("main")
            .unwrap()
            .try_with_search("agent:main:session-1")
            .unwrap();
        assert_eq!(
            serde_json::to_value(list).unwrap(),
            json(
                r#"{"limit":25,"activeMinutes":120,"configuredAgentsOnly":true,"includeDerivedTitles":true,"includeLastMessage":true,"agentId":"main","search":"agent:main:session-1"}"#
            )
        );
        assert!(SessionsListParams::default().try_with_limit(0).is_err());
        assert!(SessionsListParams::default().try_with_search("").is_err());
        assert!(
            ChatSendParams::try_new(SessionKey::try_new("x".repeat(513)).unwrap(), "x", run())
                .is_err()
        );
        for attachment in [
            ChatAttachment::try_new("", "review.pdf", "cGRm"),
            ChatAttachment::try_new("application/pdf", "", "aGVsbG8="),
            ChatAttachment::try_new("application/pdf", "../review.pdf", "aGVsbG8="),
            ChatAttachment::try_new(
                "application/pdf",
                "https://example.test/review.pdf",
                "aGVsbG8=",
            ),
            ChatAttachment::try_new("application/pdf", "review\0.pdf", "aGVsbG8="),
            ChatAttachment::try_new("application/pdf", "review.pdf", "not base64!"),
            ChatAttachment::try_new("application/pdf", "review.pdf", "aGVsbG8"),
        ] {
            assert!(attachment.is_err());
        }
        let attachment = ChatAttachment::try_new("application/pdf", "review.pdf", "cGRm").unwrap();
        let mut send = ChatSendParams::try_new(key(), "review", run()).unwrap();
        for _ in 0..MAX_CHAT_ATTACHMENTS {
            send = send.try_with_attachment(attachment.clone()).unwrap();
        }
        assert!(send.try_with_attachment(attachment).is_err());
        assert!(
            ChatAttachment::try_new(
                "application/pdf",
                "too-large.pdf",
                "A".repeat(MAX_CHAT_ATTACHMENT_BASE64_BYTES + 4),
            )
            .is_err()
        );
        assert!(
            SessionKey::try_new("").is_err()
                && ModelRef::try_new("").is_err()
                && RunId::try_new("").is_err()
        );
        for raw in [
            r#"{"runId":"run-7","sessionKey":"agent:main:session-1","seq":8,"state":"final","future":true}"#,
            r#"{"runId":"run-7","sessionKey":"agent:main:session-1","seq":8,"state":"error","errorKind":"future"}"#,
        ] {
            assert!(serde_json::from_str::<ChatEvent>(raw).is_err());
        }
    }
    #[test]
    fn agent_scoped_session_grammar_and_results_are_strict() {
        let create = SessionCreateParams::try_new(
            AgentId::try_new("mct-team").unwrap(),
            EndpointSessionId::try_new("team-endpoint-session-run-1-reviewer").unwrap(),
            ModelRef::try_new("provider/model").unwrap(),
        )
        .unwrap();
        assert_eq!(
            create.key().as_str(),
            "agent:mct-team:team-endpoint-session-run-1-reviewer"
        );
        assert_eq!(
            serde_json::to_value(&create).unwrap(),
            json(
                r#"{"key":"agent:mct-team:team-endpoint-session-run-1-reviewer","agentId":"mct-team","model":"provider/model"}"#
            )
        );
        assert_eq!(
            serde_json::to_value(SessionDeleteParams::new(create.key().clone())).unwrap(),
            json(r#"{"key":"agent:mct-team:team-endpoint-session-run-1-reviewer"}"#)
        );

        for agent in ["Mct-team", "-team"] {
            assert!(AgentId::try_new(agent).is_err());
        }
        for endpoint in [
            " agent:other:session",
            "agent:other:session",
            "Agent:other:session",
            "nested::session",
        ] {
            assert!(
                SessionCreateParams::try_new(
                    AgentId::try_new("mct-team").unwrap(),
                    EndpointSessionId::try_new(endpoint).unwrap(),
                    ModelRef::try_new("provider/model").unwrap(),
                )
                .is_err()
            );
        }

        let expected_key = create.key();
        let result = decode_session_create_result(
            "create",
            success(
                "create",
                r#"{"ok":true,"key":"agent:mct-team:team-endpoint-session-run-1-reviewer","sessionId":"private-id","entry":{"private":"state"}}"#,
            ),
            expected_key,
        )
        .unwrap();
        assert_eq!(result.native_session_id().as_str(), "private-id");
        assert_eq!(
            decode_session_delete_result(
                "delete",
                success(
                    "delete",
                    r#"{"ok":true,"key":"agent:mct-team:team-endpoint-session-run-1-reviewer","deleted":false,"archived":["private-path"]}"#,
                ),
                expected_key,
            ),
            Ok(SessionDeleteResult { deleted: false })
        );
        for response in [
            success(
                "other",
                r#"{"ok":true,"key":"agent:mct-team:team-endpoint-session-run-1-reviewer"}"#,
            ),
            success(
                "create",
                r#"{"ok":false,"key":"agent:mct-team:team-endpoint-session-run-1-reviewer"}"#,
            ),
            success(
                "create",
                r#"{"ok":true,"key":"agent:other:team-endpoint-session-run-1-reviewer"}"#,
            ),
        ] {
            assert!(decode_session_create_result("create", response, expected_key).is_err());
        }
        assert!(
            decode_session_delete_result(
                "delete",
                success(
                    "delete",
                    r#"{"ok":true,"key":"agent:mct-team:team-endpoint-session-run-1-reviewer"}"#,
                ),
                expected_key,
            )
            .is_err()
        );
    }

    #[test]
    fn native_chat_send_result_accepts_additive_fields() {
        let result = decode_chat_send_result(
            "s",
            success(
                "s",
                r#"{"runId":"run-7","status":"started","idempotencyReceipt":{"key":"run-7"},"future":true}"#,
            ),
        )
        .unwrap();
        assert_eq!(result.run_id, run());
        assert_eq!(result.status, ChatSendStatus::Started);
    }

    #[test]
    fn native_response_schemas_accept_additive_fields() {
        let expected_key = SessionCreateParams::try_new(
            AgentId::try_new("mct-team").unwrap(),
            EndpointSessionId::try_new("team-session").unwrap(),
            ModelRef::try_new("provider/model").unwrap(),
        )
        .unwrap()
        .key()
        .clone();

        let abort = decode_chat_abort_result(
            "abort",
            success(
                "abort",
                r#"{"ok":true,"aborted":true,"runIds":["run-7"],"future":true}"#,
            ),
        )
        .unwrap();
        assert_eq!(abort.run_ids, [run()]);
        let session_abort = decode_session_abort_result(
            "abort",
            success(
                "abort",
                r#"{"ok":true,"abortedRunId":"run-7","status":"aborted","future":true}"#,
            ),
        )
        .unwrap();
        assert_eq!(session_abort.aborted_run_id, Some(run()));
        assert_eq!(session_abort.status, SessionAbortStatus::Aborted);
        let list = decode_sessions_list_result(
            "list",
            success(
                "list",
                r#"{"ts":42,"count":1,"future":true,"sessions":[{"key":"agent:main:session-1","kind":"direct","derivedTitles":{"short":"hello"},"lastMessage":{"role":"user","content":"private"},"people":[{"id":"u1"}],"permissionMode":"guarded","permissionModePending":true,"toolOverrides":{},"lifecycleRevision":"rev-1","future":true}]}"#,
            ),
        )
        .unwrap();
        assert_eq!(list.sessions[0].key.as_str(), "agent:main:session-1");
        assert_eq!(
            list.sessions[0].permission_mode,
            Some(SessionPermissionMode::Guarded)
        );
        assert_eq!(list.sessions[0].permission_mode_pending, Some(true));
        let nested_list = decode_sessions_list_result(
            "list",
            success(
                "list",
                r#"{"ts":43,"count":2,"filter":{"agentId":"main"},"defaults":{"cwd":"private"},"sessions":[{"sessionInfo":{"key":"agent:main:nested","kind":"direct","agentId":"main","updatedAt":70,"nativeSessionId":"native-private"},"metadata":{"cwd":"private","defaults":{"model":"private"}},"archive":{"path":"private"}},{"metadata":{"sessionKey":"worker-session","kind":"direct","agentId":"worker","updatedAt":60,"nativeSessionId":"worker-private"},"defaults":{"cwd":"private"}}]}"#,
            ),
        )
        .unwrap();
        let nested = nested_list.sessions[0]
            .agent_scoped_catalog_entry()
            .unwrap();
        assert_eq!(nested.session_key.as_str(), "agent:main:nested");
        assert_eq!(nested.agent_id.as_str(), "main");
        assert_eq!(nested.endpoint_session_id, "nested");
        let metadata = nested_list.sessions[1]
            .agent_scoped_catalog_entry()
            .unwrap();
        assert_eq!(metadata.session_key.as_str(), "agent:worker:worker-session");
        assert_eq!(metadata.agent_id.as_str(), "worker");
        assert_eq!(metadata.endpoint_session_id, "worker-session");
        assert_eq!(nested_list.sessions[0].updated_at, Some(70));
        assert_eq!(nested_list.sessions[1].updated_at, Some(60));
        let create = decode_session_create_result(
            "create",
            success(
                "create",
                r#"{"ok":true,"key":"agent:mct-team:team-session","sessionId":"private-id","worktree":{"path":"private"},"messageSeq":1,"runId":"run-7","idempotencyReceipt":{"key":"run-7"},"future":true}"#,
            ),
            &expected_key,
        )
        .unwrap();
        assert_eq!(create.native_session_id().as_str(), "private-id");
        let nested_create = decode_session_create_result(
            "create",
            success(
                "create",
                r#"{"ok":true,"sessionInfo":{"key":"agent:mct-team:team-session","nativeSessionId":"native-private-id","defaults":{"cwd":"private"}},"metadata":{"key":"wrong","nativeSessionId":"wrong"},"archive":{"path":"private"},"future":true}"#,
            ),
            &expected_key,
        )
        .unwrap();
        assert_eq!(
            nested_create.native_session_id().as_str(),
            "native-private-id"
        );
        assert_eq!(
            decode_session_delete_result(
                "delete",
                success(
                    "delete",
                    r#"{"ok":true,"key":"agent:mct-team:team-session","deleted":true,"archived":["private-path"],"worktreePreserved":{"path":"private"},"future":true}"#,
                ),
                &expected_key,
            ),
            Ok(SessionDeleteResult { deleted: true })
        );
    }

    #[test]
    fn native_response_schemas_reject_missing_core_fields() {
        let expected_key = SessionCreateParams::try_new(
            AgentId::try_new("mct-team").unwrap(),
            EndpointSessionId::try_new("team-session").unwrap(),
            ModelRef::try_new("provider/model").unwrap(),
        )
        .unwrap()
        .key()
        .clone();

        assert_eq!(
            decode_chat_send_result(
                "send",
                success("send", r#"{"status":"started","future":true}"#)
            ),
            Err(ProtocolError::InvalidChatSendResult)
        );
        assert_eq!(
            decode_chat_send_result(
                "send",
                success("send", r#"{"runId":"run-7","future":true}"#)
            ),
            Err(ProtocolError::InvalidChatSendResult)
        );
        assert_eq!(
            decode_chat_abort_result(
                "abort",
                success("abort", r#"{"ok":true,"aborted":true,"future":true}"#),
            ),
            Err(ProtocolError::InvalidChatAbortResult)
        );
        assert_eq!(
            decode_chat_abort_result(
                "abort",
                success(
                    "abort",
                    r#"{"ok":false,"aborted":true,"runIds":["run-7"],"future":true}"#,
                ),
            ),
            Err(ProtocolError::InvalidChatAbortResult)
        );
        assert_eq!(
            decode_session_label_patch_result(
                "label",
                success("label", r#"{"ok":true,"future":true}"#),
                &key(),
            ),
            Err(ProtocolError::InvalidSessionLabelPatchResult)
        );
        assert_eq!(
            decode_session_model_patch_result(
                "patch",
                success(
                    "patch",
                    r#"{"ok":true,"key":"agent:main:session-1","future":true}"#
                ),
                &key(),
            ),
            Err(ProtocolError::InvalidSessionModelPatchResult)
        );
        assert_eq!(
            decode_session_create_result(
                "create",
                success(
                    "create",
                    r#"{"ok":true,"key":"agent:mct-team:team-session","future":true}"#
                ),
                &expected_key,
            ),
            Err(ProtocolError::InvalidSessionCreateResult)
        );
        assert_eq!(
            decode_session_delete_result(
                "delete",
                success(
                    "delete",
                    r#"{"ok":true,"key":"agent:mct-team:team-session","future":true}"#
                ),
                &expected_key,
            ),
            Err(ProtocolError::InvalidSessionDeleteResult)
        );
        assert_eq!(
            decode_chat_history_result("history", success("history", r#"{"future":true}"#), 1),
            Err(ProtocolError::InvalidChatHistoryResult)
        );
    }

    #[test]
    fn session_kind_serializes_as_native_wire_value() {
        assert_eq!(
            serde_json::to_value(SessionKind::Direct).unwrap(),
            serde_json::json!("direct")
        );
        assert_eq!(
            serde_json::to_value(SessionKind::Group).unwrap(),
            serde_json::json!("group")
        );
        assert_eq!(
            serde_json::to_value(SessionKind::Global).unwrap(),
            serde_json::json!("global")
        );
        assert_eq!(
            serde_json::to_value(SessionKind::Unknown).unwrap(),
            serde_json::json!("unknown")
        );
    }

    #[test]
    fn session_summary_catalog_entry_requires_agent_owner_and_preserves_native_session_id() {
        let list = decode_sessions_list_result(
            "list",
            success(
                "list",
                r#"{"ts":42,"count":10,"sessions":[{"key":"agent:main:opaque:rest","kind":"direct"},{"key":"main","kind":"direct","agentId":"main"},{"key":"worker-session","kind":"direct","agentId":"worker"},{"key":"agent:main","kind":"group"},{"key":"global:main:opaque","kind":"global"},{"key":"agent:INVALID:opaque","kind":"unknown"},{"key":"agent::opaque","kind":"direct"},{"key":"agent:main::opaque","kind":"direct"},{"key":"agent:main:opaque:","kind":"direct"},{"key":"agent:main:","kind":"direct"}]}"#,
            ),
        )
        .unwrap();

        let prefixed = list.sessions[0].agent_scoped_catalog_entry().unwrap();
        assert_eq!(prefixed.agent_id.as_str(), "main");
        assert_eq!(prefixed.session_key.as_str(), "agent:main:opaque:rest");
        assert_eq!(prefixed.endpoint_session_id, "opaque:rest");

        let main = list.sessions[1].agent_scoped_catalog_entry().unwrap();
        assert_eq!(main.agent_id.as_str(), "main");
        assert_eq!(main.session_key.as_str(), "agent:main:main");
        assert_eq!(main.endpoint_session_id, "main");

        let worker = list.sessions[2].agent_scoped_catalog_entry().unwrap();
        assert_eq!(worker.agent_id.as_str(), "worker");
        assert_eq!(worker.session_key.as_str(), "agent:worker:worker-session");
        assert_eq!(worker.endpoint_session_id, "worker-session");

        assert!(list.sessions[3].agent_scoped_catalog_entry().is_none());
        assert!(list.sessions[4].agent_scoped_catalog_entry().is_none());
        assert!(list.sessions[5].agent_scoped_catalog_entry().is_none());
        assert!(list.sessions[6].agent_scoped_catalog_entry().is_none());
        assert!(list.sessions[7].agent_scoped_catalog_entry().is_none());
        assert!(list.sessions[8].agent_scoped_catalog_entry().is_none());
        assert!(list.sessions[9].agent_scoped_catalog_entry().is_none());

        assert!(decode_sessions_list_result(
            "list",
            success(
                "list",
                r#"{"ts":42,"count":1,"sessions":[{"key":"agent:main:opaque","kind":"future"}]}"#,
            ),
        )
        .is_err());
    }

    #[test]
    fn session_activity_projection_is_bounded_and_source_backed() {
        let message = decode_session_event(event(
            "session.message",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","messageId":"message-3","lifecycle":"delta","message":{"content":[{"type":"text","text":"safe text"},{"type":"image","url":"secret-url"}],"id":"message-3","input":"secret-input"},"future":"ignored"}"#,
        ))
        .unwrap()
        .unwrap();
        let activity = message.activity.as_ref().unwrap();
        assert!(matches!(
            activity.kind(),
            SessionActivityKind::Message { lifecycle: MessageActivityLifecycle::Delta, text: Some(text), .. } if text == "safe text"
        ));
        assert!(!format!("{activity:?}").contains("secret"));

        let tool = decode_session_event(event(
            "session.tool",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"failed","toolCallId":"tool-9","name":"read","summary":"bounded summary","input":{"secret":"omit"},"output":{"secret":"omit"},"isError":true}"#,
        ))
        .unwrap()
        .unwrap();
        let activity = tool.activity.as_ref().unwrap();
        assert!(matches!(
            activity.kind(),
            SessionActivityKind::Tool {
                phase: ToolActivityPhase::Failed,
                tool_name: Some(name),
                summary: Some(summary),
                ..
            } if name == "read" && summary == "bounded summary"
        ));
        let payload = activity.tool_payload().unwrap();
        assert_eq!(payload.input(), Some(&serde_json::json!({"secret":"omit"})));
        assert_eq!(
            payload.output(),
            Some(&serde_json::json!({"secret":"omit"}))
        );
        assert_eq!(payload.is_error(), Some(true));
        assert!(payload.input_text().unwrap().contains("secret"));
        assert_debug_redacts(activity, &["secret", "omit"]);
        assert_debug_redacts(payload, &["secret", "omit"]);
        assert!(decode_session_event(event(
            "session.tool",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"completed","summary":"missing id"}"#,
        ))
        .is_err());
        let unassociated = decode_session_event(event(
            "session.tool",
            r#"{"sessionKey":"agent:main:session-1","phase":"started","toolCallId":"tool-9"}"#,
        ))
        .unwrap()
        .unwrap();
        assert!(unassociated.activity.is_none());
    }

    #[test]
    fn session_tool_native_payload_projection_is_semantic_and_safe() {
        let started = decode_session_event(event(
            "session.tool",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"start","toolId":"tool-9","toolName":"read","arguments":{"file_path":"secret.txt"}}"#,
        ))
        .unwrap()
        .unwrap();
        let started_activity = started.activity.as_ref().unwrap();
        assert!(matches!(
            started_activity.kind(),
            SessionActivityKind::Tool {
                phase: ToolActivityPhase::Started,
                tool_name: Some(name),
                summary: None,
                ..
            } if name == "read"
        ));
        let started_payload = started_activity.tool_payload().unwrap();
        assert_eq!(
            started_payload.input(),
            Some(&serde_json::json!({"file_path":"secret.txt"}))
        );
        assert_eq!(
            started_payload.input_text(),
            Some("{\n  \"file_path\": \"secret.txt\"\n}")
        );
        assert_eq!(started_payload.output(), None);
        assert_eq!(started_payload.is_error(), None);
        assert_debug_redacts(started_activity, &["secret.txt", "file_path"]);
        assert_debug_redacts(started_payload, &["secret.txt", "file_path"]);
        assert_debug_redacts(&started, &["secret.txt", "file_path"]);

        let updated = decode_session_event(event(
            "session.tool",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"update","toolCallId":"tool-9","input":"raw input","input_text":"shown input","partial_result":{"rows":[1,2]}}"#,
        ))
        .unwrap()
        .unwrap();
        let updated_activity = updated.activity.as_ref().unwrap();
        let updated_payload = updated_activity.tool_payload().unwrap();
        assert_eq!(
            updated_activity.kind().tool_phase(),
            Some(ToolActivityPhase::Updated)
        );
        assert_eq!(
            updated_payload.input(),
            Some(&serde_json::json!("raw input"))
        );
        assert_eq!(updated_payload.input_text(), Some("shown input"));
        assert_eq!(
            updated_payload.output(),
            Some(&serde_json::json!({"rows":[1,2]}))
        );
        assert_eq!(updated_payload.is_error(), None);

        let completed = decode_session_event(event(
            "session.tool",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"result","toolCallId":"tool-9","toolInput":{"q":"safe"},"content":[{"type":"text","text":"answer"}],"summary":"done","isError":false,"meta":{"raw":"omitted"}}"#,
        ))
        .unwrap()
        .unwrap();
        let completed_activity = completed.activity.as_ref().unwrap();
        let completed_payload = completed_activity.tool_payload().unwrap();
        assert!(matches!(
            completed_activity.kind(),
            SessionActivityKind::Tool {
                phase: ToolActivityPhase::Completed,
                summary: Some(summary),
                ..
            } if summary == "done"
        ));
        assert_eq!(
            completed_payload.input(),
            Some(&serde_json::json!({"q":"safe"}))
        );
        assert_eq!(
            completed_payload.output(),
            Some(&serde_json::json!([{ "type": "text", "text": "answer" }]))
        );
        assert_eq!(completed_payload.is_error(), Some(false));

        let details = decode_session_event(event(
            "session.tool",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"result","toolCallId":"tool-9","result":{"details":{"browserTab":{"title":"safe","rawAssistantText":"secret nested"},"changed":["a.txt"],"created":["b.txt"],"diff":{"path":"a.txt"},"approvalReviews":[{"status":"approved"}],"approvalReviewOutcome":"approved","mcpAppPreview":{"url":"https://preview.test","html":"secret html","toolResult":{"secret":"result"},"private":{"secret":true},"mcpApp":{"viewId":"view-1","toolResult":{"secret":"nested"}}},"truncation":{"truncated":true},"fullOutputPath":"C:/tmp/output.txt","exitCode":0,"rawAssistantText":"secret assistant","toolInput":{"secret":"input"},"toolOutput":"secret output","privatePayload":{"secret":true}}}}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(details.activity.as_ref().unwrap().output(), None);
        let projected = details.activity.as_ref().unwrap().details().unwrap();
        assert_eq!(
            projected,
            &serde_json::json!({
                "browserTab":{"title":"safe"},
                "changed":["a.txt"],
                "created":["b.txt"],
                "diff":{"path":"a.txt"},
                "approvalReviews":[{"status":"approved"}],
                "approvalReviewOutcome":"approved",
                "mcpAppPreview":{"url":"https://preview.test","mcpApp":{"viewId":"view-1"}},
                "truncation":{"truncated":true},
                "fullOutputPath":"C:/tmp/output.txt",
                "exitCode":0
            })
        );
        assert!(projected.get("rawAssistantText").is_none());
        assert!(projected.get("toolInput").is_none());
        assert!(projected.get("toolOutput").is_none());
        assert!(projected.get("privatePayload").is_none());
        assert_debug_redacts(
            details.activity.as_ref().unwrap(),
            &[
                "secret assistant",
                "secret nested",
                "secret output",
                "secret html",
                "secret result",
            ],
        );

        let top_level_details = decode_session_event(event(
            "session.tool",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"result","toolCallId":"tool-9","result":{"details":{"browserTab":{"title":"result"}}},"details":{"browserTab":{"title":"top"}}}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            top_level_details.activity.as_ref().unwrap().details(),
            Some(&serde_json::json!({"browserTab":{"title":"top"}}))
        );

        let failed = decode_session_event(event(
            "session.tool",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"result","toolCallId":"tool-9","output":{"error":"bad"},"isError":true}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            failed.activity.as_ref().unwrap().kind().tool_phase(),
            Some(ToolActivityPhase::Failed)
        );
        assert_eq!(
            failed
                .activity
                .as_ref()
                .unwrap()
                .tool_payload()
                .unwrap()
                .is_error(),
            Some(true)
        );

        for raw in [
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"start","toolCallId":"tool-9","input":{"bad\u0000key":true}}"#,
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"start","toolCallId":"tool-9","input":{"bad":"nul\u0000value"}}"#,
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"start","toolCallId":"tool-9","input_text":"bad\u0000text"}"#,
        ] {
            assert!(decode_session_event(event("session.tool", raw)).is_err());
        }

        let oversized = serde_json::json!({"blob":"x".repeat(MAX_SESSION_TOOL_PAYLOAD_BYTES)});
        let mut object = serde_json::Map::new();
        object.insert(
            "sessionKey".into(),
            serde_json::json!("agent:main:session-1"),
        );
        object.insert("runId".into(), serde_json::json!("run-7"));
        object.insert("phase".into(), serde_json::json!("start"));
        object.insert("toolCallId".into(), serde_json::json!("tool-9"));
        object.insert("input".into(), oversized);
        assert!(
            decode_session_event(GatewayEvent {
                name: "session.tool".into(),
                payload: Some(Value::Object(object)),
                sequence: Some(91),
                state_version: None,
            })
            .is_err()
        );
    }

    #[test]
    fn agent_tool_thinking_and_approval_events_decode() {
        let tool = decode_session_event(event(
            "agent",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","stream":"tool","data":{"phase":"start","toolCallId":"tool-9","name":"read","args":{"path":"README.md"}}}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(tool.kind, SessionEventKind::Agent);
        let activity = tool.activity.as_ref().unwrap();
        assert!(matches!(
            activity.kind(),
            SessionActivityKind::Tool { phase: ToolActivityPhase::Started, tool_name: Some(name), .. }
                if name == "read"
        ));
        assert_eq!(
            activity.input(),
            Some(&serde_json::json!({"path":"README.md"}))
        );

        let thinking = decode_session_event(event(
            "agent",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","stream":"thinking","data":{"thinking":"plan"}}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(thinking.kind, SessionEventKind::Agent);
        assert!(matches!(
            thinking.activity.as_ref().unwrap().kind(),
            SessionActivityKind::Thinking { text } if text == "plan"
        ));

        let legacy_approval = decode_session_event(event(
            "agent",
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","stream":"approval","data":{"phase":"requested","kind":"exec","status":"pending","approvalId":"approval-1","allowedDecisions":["allow-always","deny"]}}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(legacy_approval.kind, SessionEventKind::ApprovalRequested);
        let approval = legacy_approval.approval.as_ref().unwrap();
        assert_eq!(approval.approval_id.as_str(), "approval-1");
        assert_eq!(approval.run_id.as_ref().unwrap().as_str(), "run-7");
        assert_eq!(
            approval
                .option_ids
                .iter()
                .map(ApprovalOptionId::as_str)
                .collect::<Vec<_>>(),
            ["allow-always", "deny"]
        );

        let structured_approval = decode_session_event(event(
            "exec.approval.requested",
            r#"{"id":"approval-2","request":{"sessionKey":"agent:main:session-1","runId":"run-7","command":"git status"}}"#,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            structured_approval.kind,
            SessionEventKind::ApprovalRequested
        );
        assert_eq!(
            structured_approval
                .approval
                .as_ref()
                .unwrap()
                .option_ids
                .iter()
                .map(ApprovalOptionId::as_str)
                .collect::<Vec<_>>(),
            ["allow-once", "deny"]
        );
    }

    #[test]
    fn results_events_and_projection_evolution() {
        let send =
            decode_chat_send_result("s", success("s", r#"{"runId":"run-7","status":"started"}"#))
                .unwrap();
        assert_eq!(send.run_id, run());
        let abort = decode_chat_abort_result(
            "a",
            success("a", r#"{"ok":true,"aborted":true,"runIds":["run-7"]}"#),
        )
        .unwrap();
        assert_eq!(abort.run_ids, [run()]);
        let list = decode_sessions_list_result("l", success("l", r#"{"ts":42,"path":"ignored","count":1,"totalCount":2,"limitApplied":1,"hasMore":true,"defaults":{},"sessions":[{"key":"agent:main:session-1","kind":"direct","lastMessage":{"role":"user","content":"private"}}]}"#)).unwrap();
        assert_eq!(
            (list.sessions[0].key.clone(), list.has_more),
            (key(), Some(true))
        );
        let patch = decode_session_model_patch_result(
            "p",
            success(
                "p",
                r#"{"ok":true,"path":"not-projected","key":"agent:main:session-1","entry":{"not":"projected"},"expectedLifecycleRevision":"rev-1","permissionMode":"default","toolOverrides":{},"resolved":{"modelProvider":"anthropic","model":"anthropic/claude-opus-4-7","agentRuntime":{"id":"acpx","source":"session-key","lifecycleRevision":"rev-1","future":true},"permissionMode":"default","toolOverrides":{},"future":true},"future":true}"#,
            ),
            &key(),
        )
        .unwrap();
        assert_eq!(patch.key, key());
        assert_eq!(patch.resolved.model.as_str(), "anthropic/claude-opus-4-7");
        assert_eq!(
            patch.resolved.agent_runtime.source,
            SessionAgentRuntimeSource::SessionKey
        );
        let label = decode_session_label_patch_result(
            "label",
            success(
                "label",
                r#"{"ok":true,"key":"agent:main:session-1","path":"not-projected","entry":{"not":"projected"},"expectedMarkedUnreadAt":null,"lifecycleRevision":"rev-1","future":true}"#,
            ),
            &key(),
        )
        .unwrap();
        assert_eq!(label.key, key());
        assert!(decode_session_model_patch_result(
            "p",
            success(
                "p",
                r#"{"ok":true,"key":"agent:main:session-1","resolved":{"modelProvider":"anthropic","model":"anthropic/claude-opus-4-7","agentRuntime":{"id":"acpx","source":"future"}}}"#,
            ),
            &key(),
        )
        .is_err());
        let projection = decode_session_event(event("session.message", r#"{"sessionKey":"agent:main:session-1","runId":"run-7","messageId":"message-3","message":{},"future":true}"#)).unwrap().unwrap();
        assert_eq!(projection.kind, SessionEventKind::Message);
        assert_eq!(projection.run_id.unwrap().as_str(), "run-7");
        assert_eq!(projection.message_id.unwrap().as_str(), "message-3");
        let chat = decode_session_event(event("chat", r#"{"runId":"run-7","sessionKey":"agent:main:session-1","agentId":"main","seq":8,"state":"delta","replace":false,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"hi"}]}}"#)).unwrap().unwrap().chat.unwrap();
        assert_eq!(
            (
                chat.session_key.as_str(),
                chat.run_id.as_str(),
                chat.message_text.as_deref(),
                chat.message_thinking.as_deref()
            ),
            ("agent:main:session-1", "run-7", Some("hi"), Some("plan"))
        );
        assert_eq!(
            decode_session_event(event("chat", r#"{"runId":"run-7","sessionKey":"agent:main:session-1","agentId":"main","seq":9,"state":"status","phase":"preparing_context"}"#)).unwrap().unwrap().chat.unwrap().state,
            ChatState::Status
        );
        assert!(decode_session_event(event("chat", r#"{"runId":"run-7","sessionKey":"agent:main:session-1","agentId":"main","seq":9,"state":"status","phase":"compacting"}"#)).is_err());
        assert!(decode_session_event(event("chat", r#"{"runId":"run-7","sessionKey":"agent:main:session-1","agentId":"main","seq":10,"state":"final","yielded":true,"message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}"#)).is_ok());
        assert!(decode_session_event(event("chat", r#"{"runId":"run-7","sessionKey":"agent:main:session-1","agentId":"main","seq":11,"state":"aborted","errorMessage":"cancelled"}"#)).is_ok());
        let error_detail_chat = decode_session_event(event("chat", r#"{"runId":"run-7","sessionKey":"agent:main:session-1","agentId":"main","seq":12,"state":"error","errorKind":"timeout","errorMessage":"provider timeout","stopReason":"gateway_error","errorDetail":{"provider":"anthropic","httpStatus":504}}"#)).unwrap().unwrap().chat.unwrap();
        assert_eq!(
            error_detail_chat
                .error_detail
                .as_ref()
                .and_then(|value| value.get("httpStatus"))
                .and_then(Value::as_u64),
            Some(504)
        );
        assert_eq!(
            error_detail_chat.error_message.as_deref(),
            Some("provider timeout")
        );
        assert_eq!(
            error_detail_chat.error_kind,
            Some(SessionErrorKind::Timeout)
        );
        assert_eq!(
            error_detail_chat.stop_reason.as_deref(),
            Some("gateway_error")
        );
        assert!(
            error_detail_chat
                .error_detail
                .as_ref()
                .and_then(|value| value.get("provider"))
                .is_none()
        );
        assert!(
            decode_session_event(event("sessions.changed", r#"{"reason":"cleanup"}"#))
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn chat_history_projects_only_text_messages_and_enforces_budgets() {
        let history = decode_chat_history_result(
            "history",
            success(
                "history",
                r#"{
                    "sessionKey":"private-session",
                    "sessionId":"private-id",
                    "thinkingLevel":"high",
                    "fastMode":true,
                    "verboseLevel":"trace",
                    "messages":[
                        {"role":"tool","content":"omit"},
                        {"role":"user","content":"first"},
                        {"role":"assistant","content":[
                            {"type":"text","text":"second"},
                            {"type":"image","url":"private-media"},
                            {"type":"text","text":"third"},
                            {"type":"tool","details":{"private":"metadata"}},
                            null
                        ],"usage":{"private":"metadata"}},
                        {"role":"assistant","content":[{"type":"image","url":"private-media"}]},
                        null
                    ]
                }"#,
            ),
            2,
        )
        .unwrap();
        assert_eq!(
            history.messages,
            [
                HistoryMessage {
                    role: HistoryRole::User,
                    text: "first".into(),
                },
                HistoryMessage {
                    role: HistoryRole::Assistant,
                    text: "second\nthird".into(),
                },
            ]
        );
        assert_eq!(
            serde_json::to_value(&history).unwrap(),
            serde_json::json!(
                {"messages":[
                    {"role":"user","text":"first"},
                    {"role":"assistant","text":"second\nthird"}
                ]}
            )
        );

        let oversized = "你".repeat((MAX_HISTORY_MESSAGE_BYTES / 3) + 1);
        let bounded = decode_chat_history_result(
            "bounded",
            success(
                "bounded",
                &format!(
                    r#"{{"messages":[{{"role":"user","content":"old"}},{{"role":"assistant","content":"{oversized}"}}]}}"#
                ),
            ),
            2,
        )
        .unwrap();
        assert_eq!(bounded.messages.len(), 2);
        assert!(bounded.messages[1].text.len() <= MAX_HISTORY_MESSAGE_BYTES);
        assert!(
            bounded.messages[1]
                .text
                .is_char_boundary(bounded.messages[1].text.len())
        );
        assert!(history_response_bytes(&bounded.messages) <= MAX_HISTORY_RESPONSE_BYTES);

        let total_payload = (0..10)
            .map(|index| {
                format!(
                    r#"{{"role":"assistant","content":"{index}{}"}}"#,
                    "x".repeat(MAX_HISTORY_MESSAGE_BYTES)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let total = decode_chat_history_result(
            "total",
            success("total", &format!(r#"{{"messages":[{total_payload}]}}"#)),
            10,
        )
        .unwrap();
        assert!(total.messages.len() < 10);
        assert_eq!(
            total.messages.last().unwrap().text.chars().next(),
            Some('9')
        );
        assert!(history_response_bytes(&total.messages) <= MAX_HISTORY_RESPONSE_BYTES);

        let history = decode_chat_history_result(
            "future",
            success(
                "future",
                r#"{
                    "messages":[],
                    "pendingInputs":{"items":[{"id":"input-1","acceptedAt":2000,"state":"queued","message":{"role":"user","content":"private"}}],"total":1},
                    "inputReceipts":[{"runId":"run-0","state":"pending"}],
                    "inputConsumptions":[{"runId":"run-1","consumedByEventId":"event-1"}],
                    "inFlightRun":{"runId":"run-1","state":"started"},
                    "deltaCursor":"eyJhZ2VudElkIjoibWFpbiIsImxhc3RTZXEiOjQyLCJ2ZXJzaW9uIjoxfQ",
                    "sessionInfo":{"sessionId":"native-session-1"},
                    "metadata":{"cwd":"C:/secret"},
                    "defaults":{"model":"private"},
                    "completeSnapshot":true
                }"#,
            ),
            1,
        )
        .unwrap();
        assert!(history.messages.is_empty());
        assert_eq!(
            serde_json::to_value(&history).unwrap(),
            serde_json::json!({"messages":[]})
        );
        assert!(
            decode_chat_history_result(
                "invalid",
                success("invalid", r#"{"messages":"not-an-array"}"#),
                1,
            )
            .is_err()
        );
        assert_eq!(
            decode_chat_history_result("expected", success("other", r#"{"messages":[]}"#), 1)
                .unwrap_err(),
            ProtocolError::MismatchedResponse
        );
        assert_eq!(
            decode_chat_history_result(
                "rejected",
                GatewayResponse::Failure {
                    request_id: "rejected".into(),
                    error: GatewayError {
                        code: "private-code".into(),
                        message: "private-message".into(),
                        details: None,
                        retryable: None,
                        startup_sidecars: false,
                        restart_required: false,
                        retry_after_ms: None,
                    },
                },
                1,
            )
            .unwrap_err(),
            ProtocolError::Rejected
        );
    }

    #[test]
    fn debug_output_redacts_protocol_content_and_identities() {
        const PROMPT: &str = "prompt-canary-871f";
        const TEXT: &str = "text-canary-24ad";
        const PAYLOAD: &str = "payload-canary-c082";
        const SESSION: &str = "session-canary-960b";
        const RUN: &str = "run-canary-3e66";
        const MESSAGE: &str = "message-canary-58d1";
        const CANARIES: &[&str] = &[PROMPT, TEXT, PAYLOAD, SESSION, RUN, MESSAGE];

        let session_key = SessionKey::try_new(SESSION).unwrap();
        let agent_id = AgentId::try_new(TEXT).unwrap();
        let endpoint_session_id = EndpointSessionId::try_new(PAYLOAD).unwrap();
        let scoped_key =
            AgentScopedSessionKey::try_new(agent_id.clone(), endpoint_session_id.clone()).unwrap();
        let model_ref = ModelRef::try_new(PAYLOAD).unwrap();
        let session_create =
            SessionCreateParams::try_new(agent_id, endpoint_session_id, model_ref.clone()).unwrap();
        let run_id = RunId::try_new(RUN).unwrap();
        let message_id = MessageId::try_new(MESSAGE).unwrap();
        assert_debug_redacts(&session_key, CANARIES);
        assert_debug_redacts(&scoped_key, CANARIES);
        assert_debug_redacts(&session_create, CANARIES);
        assert_debug_redacts(&SessionDeleteParams::new(scoped_key), CANARIES);
        assert_debug_redacts(&run_id, CANARIES);
        assert_debug_redacts(&message_id, CANARIES);
        assert_debug_redacts(&model_ref, CANARIES);
        assert_debug_redacts(
            &SessionModelPatchParams::new(session_key.clone(), Some(model_ref.clone())),
            CANARIES,
        );

        let send_params = ChatSendParams::try_new(session_key.clone(), PROMPT, run_id.clone())
            .unwrap()
            .with_delivery(false);
        assert_debug_redacts(&send_params, CANARIES);
        let attachment = ChatAttachment::try_new("application/pdf", PAYLOAD, "c2VjcmV0LWltYWdl")
            .unwrap()
            .with_type("document");
        assert_debug_redacts(&attachment, &[PAYLOAD, "c2VjcmV0LWltYWdl"]);
        assert_debug_redacts(
            &ChatSendParams::try_new(session_key.clone(), PROMPT, run_id.clone())
                .unwrap()
                .try_with_attachment(attachment)
                .unwrap(),
            &[PROMPT, PAYLOAD, "c2VjcmV0LWltYWdl"],
        );
        assert_debug_redacts(
            &ChatAbortParams::new(session_key.clone()).for_run(run_id.clone()),
            CANARIES,
        );
        assert_debug_redacts(
            &SessionsListParams::default()
                .include_titles_and_last_message()
                .try_for_agent(TEXT)
                .unwrap(),
            CANARIES,
        );

        assert_debug_redacts(
            &ChatSendResult {
                run_id: run_id.clone(),
                status: ChatSendStatus::Started,
            },
            CANARIES,
        );
        assert_debug_redacts(
            &ChatAbortResult {
                ok: true,
                aborted: true,
                run_ids: vec![run_id.clone()],
            },
            CANARIES,
        );
        let summary = SessionSummary {
            key: session_key.clone(),
            kind: SessionKind::Direct,
            agent_id: None,
            label: Some(PROMPT.into()),
            display_name: Some(MESSAGE.into()),
            derived_title: Some(PAYLOAD.into()),
            updated_at: Some(42),
            status: Some(TEXT.into()),
            has_active_run: Some(true),
            model: Some(RUN.into()),
            model_provider: None,
            active_model: None,
            active_model_provider: None,
            model_override_source: None,
            permission_mode: None,
            permission_mode_pending: None,
        };
        assert_debug_redacts(&summary, CANARIES);
        assert_debug_redacts(
            &SessionsListResult {
                timestamp_ms: 42,
                count: 1,
                total_count: Some(1),
                limit_applied: Some(1),
                has_more: Some(false),
                sessions: vec![summary],
            },
            CANARIES,
        );
        let patch = decode_session_model_patch_result(
            "patch",
            success(
                "patch",
                &format!(
                    r#"{{"ok":true,"path":"{PAYLOAD}","key":"{SESSION}","entry":{{"prompt":"{PROMPT}"}},"resolved":{{"modelProvider":"{TEXT}","model":"{PAYLOAD}","agentRuntime":{{"id":"{MESSAGE}","source":"implicit"}}}}}}"#
                ),
            ),
            &session_key,
        )
        .unwrap();
        assert_debug_redacts(&patch, CANARIES);
        assert_debug_redacts(&patch.resolved, CANARIES);
        assert_debug_redacts(&patch.resolved.agent_runtime, CANARIES);

        let chat = decode_chat_event(serde_json::json!({
            "runId": RUN,
            "sessionKey": SESSION,
            "seq": 8,
            "state": "delta",
            "deltaText": TEXT,
            "message": { "text": PROMPT, "payload": PAYLOAD }
        }))
        .unwrap();
        assert_debug_redacts(&chat, CANARIES);
        assert_debug_redacts(
            &SessionEventEnvelope {
                gateway_sequence: Some(91),
                kind: SessionEventKind::Chat,
                session_key,
                run_id: Some(run_id),
                message_id: Some(message_id),
                embedded_message_id: None,
                chat: Some(chat),
                activity: None,
                approval: None,
                changed: None,
            },
            CANARIES,
        );
    }
    #[test]
    fn errors_are_fixed_and_redacted() {
        assert_eq!(
            decode_chat_send_result(
                "expected",
                success("canary", r#"{"runId":"run-7","status":"started"}"#)
            )
            .unwrap_err(),
            ProtocolError::MismatchedResponse
        );
        assert_eq!(
            decode_session_model_patch_result(
                "expected",
                success(
                    "canary",
                    r#"{"ok":true,"key":"agent:main:session-1","resolved":{"modelProvider":"anthropic","model":"anthropic/claude-opus-4-7","agentRuntime":{"id":"acpx","source":"implicit"}}}"#,
                ),
                &key(),
            )
            .unwrap_err(),
            ProtocolError::MismatchedResponse
        );
        let rejected = decode_chat_send_result(
            "s",
            GatewayResponse::Failure {
                request_id: "s".into(),
                error: GatewayError {
                    code: "peer-code-canary".into(),
                    message: "peer-message-canary".into(),
                    details: Some(json(r#"{"payload":"peer-payload-canary"}"#)),
                    retryable: None,
                    startup_sidecars: false,
                    restart_required: false,
                    retry_after_ms: None,
                },
            },
        )
        .unwrap_err();
        assert_eq!(rejected.to_string(), "gateway rejected the session request");
        assert_debug_redacts(
            &rejected,
            &[
                "peer-code-canary",
                "peer-message-canary",
                "peer-payload-canary",
            ],
        );
    }

    #[test]
    fn session_describe_reads_the_selected_model_pair_and_ignores_unknown_fields() {
        let describe = SessionDescribeParams::new(key(), None);
        assert_eq!(
            serde_json::to_value(&describe).unwrap(),
            serde_json::json!({"key": "agent:main:session-1"})
        );
        assert_eq!(
            serde_json::to_value(SessionDescribeParams::new(key(), Some("worker"))).unwrap(),
            serde_json::json!({"key": "agent:main:session-1", "agentId": "worker"})
        );

        let row = decode_session_describe_result(
            "describe",
            success(
                "describe",
                r#"{"session":{"key":"agent:main:session-1","model":"glm-5.2","modelProvider":"custom-cc367df7","agentId":"main","modelOverrideSource":"user","updatedAt":42,"future":true,"lastMessage":{"role":"user","content":"private"}}}"#,
            ),
        )
        .unwrap()
        .unwrap();
        assert_eq!(row.model.as_deref(), Some("glm-5.2"));
        assert_eq!(row.model_provider.as_deref(), Some("custom-cc367df7"));
        assert_eq!(row.agent_id.as_ref().map(AgentId::as_str), Some("main"));
        assert_eq!(
            row.model_override_source,
            Some(SessionModelOverrideSource::User)
        );
        assert_eq!(row.model_ref().as_deref(), Some("custom-cc367df7/glm-5.2"));
        assert_debug_redacts(&row, &["glm-5.2", "custom-cc367df7", "private"]);
    }

    #[test]
    fn session_describe_treats_a_missing_session_as_absent() {
        assert!(
            decode_session_describe_result(
                "describe",
                success("describe", r#"{"session":null,"future":true}"#),
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(
            decode_session_describe_result("missing", success("present", r#"{"session":null}"#),)
                .unwrap_err(),
            ProtocolError::MismatchedResponse,
        );
    }

    #[test]
    fn session_describe_normalizes_the_row_model_ref() {
        let row = |raw: &str| {
            decode_session_describe_result("describe", success("describe", raw))
                .unwrap()
                .unwrap()
        };
        assert_eq!(
            row(r#"{"session":{"model":"glm-5.2","modelProvider":"custom-cc367df7"}}"#)
                .model_ref()
                .as_deref(),
            Some("custom-cc367df7/glm-5.2")
        );
        assert_eq!(
            row(r#"{"session":{"model":"anthropic/claude-sonnet-4-6","modelProvider":"vercel-ai-gateway"}}"#)
                .model_ref()
                .as_deref(),
            Some("vercel-ai-gateway/anthropic/claude-sonnet-4-6")
        );
        assert_eq!(
            row(r#"{"session":{"model":"custom-cc367df7/glm-5.2","modelProvider":"custom-cc367df7"}}"#)
                .model_ref()
                .as_deref(),
            Some("custom-cc367df7/glm-5.2")
        );
        assert_eq!(
            row(r#"{"session":{"model":"custom-cc367df7/glm-5.2","modelProvider":"custom"}}"#)
                .model_ref()
                .as_deref(),
            Some("custom/custom-cc367df7/glm-5.2")
        );
        assert_eq!(
            row(r#"{"session":{"model":"glm-5.2"}}"#)
                .model_ref()
                .as_deref(),
            Some("glm-5.2")
        );
        assert_eq!(
            row(r#"{"session":{"modelProvider":"custom-cc367df7"}}"#).model_ref(),
            None
        );
        assert_eq!(row(r#"{"session":{}}"#).model_ref(), None);
    }
}
