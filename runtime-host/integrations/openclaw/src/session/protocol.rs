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
pub const SESSIONS_LIST_METHOD: &str = "sessions.list";
pub const SESSIONS_PATCH_METHOD: &str = "sessions.patch";
pub const SESSIONS_CREATE_METHOD: &str = "sessions.create";
pub const SESSIONS_DELETE_METHOD: &str = "sessions.delete";
pub const CHAT_HISTORY_METHOD: &str = "chat.history";
const MAX_CHAT_SESSION_KEY_UTF16: usize = 512;
const DEFAULT_CHAT_HISTORY_LIMIT: usize = 200;
const MAX_CHAT_HISTORY_LIMIT: u64 = 1_000;
const MAX_CHAT_HISTORY_MAX_CHARS: u64 = 500_000;
const MAX_HISTORY_MESSAGE_BYTES: usize = 128 * 1024;
const MAX_HISTORY_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_SESSION_UPDATE_TEXT_BYTES: usize = 128 * 1024;
const MAX_SESSION_UPDATE_STOP_REASON_BYTES: usize = 256;
const MAX_SESSION_ACTIVITY_TEXT_BYTES: usize = 16 * 1024;
const MAX_SESSION_ACTIVITY_ID_BYTES: usize = 256;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;
const MAX_CHAT_ATTACHMENTS: usize = 16;
const MAX_CHAT_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
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
}
impl fmt::Debug for ChatSendParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatSendParams")
            .field("has_message", &!self.message.is_empty())
            .field("has_delivery", &self.deliver.is_some())
            .finish_non_exhaustive()
    }
}
impl ChatSendParams {
    pub fn try_new(
        session_key: SessionKey,
        message: impl Into<String>,
        run_id: RunId,
    ) -> Result<Self, ValidationError> {
        if session_key.as_str().encode_utf16().count() > MAX_CHAT_SESSION_KEY_UTF16 {
            return Err(ValidationError("chat send session key is too long"));
        }
        Ok(Self {
            session_key,
            message: message.into(),
            deliver: None,
            idempotency_key: run_id,
            attachments: Vec::new(),
        })
    }
    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn run_id(&self) -> &RunId {
        &self.idempotency_key
    }

    pub fn with_delivery(mut self, deliver: bool) -> Self {
        self.deliver = Some(deliver);
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
    limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_chars: Option<u64>,
}

impl fmt::Debug for ChatHistoryParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatHistoryParams")
            .field("has_limit", &self.limit.is_some())
            .field("has_max_chars", &self.max_chars.is_some())
            .finish_non_exhaustive()
    }
}

impl ChatHistoryParams {
    pub fn new(session_key: SessionKey) -> Self {
        Self {
            session_key,
            limit: None,
            max_chars: None,
        }
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
            limit: OptionalHistoryBound,
            #[serde(default)]
            max_chars: OptionalHistoryBound,
        }

        let raw = RawParams::deserialize(deserializer)?;
        let params = Self::new(raw.session_key);
        let params = match raw.limit {
            OptionalHistoryBound::Value(limit) => params.try_with_limit(limit),
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
}

impl SessionCreateParams {
    pub fn try_new(
        agent_id: AgentId,
        endpoint_session_id: EndpointSessionId,
    ) -> Result<Self, ValidationError> {
        let key = AgentScopedSessionKey::try_new(agent_id.clone(), endpoint_session_id)?;
        Ok(Self { key, agent_id })
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
    native_session_id: EndpointSessionId,
}

impl SessionCreateResult {
    pub fn native_session_id(&self) -> &EndpointSessionId {
        &self.native_session_id
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
    native_session_id: EndpointSessionId,
}

impl SessionIdentityReadback {
    pub fn key(&self) -> &SessionKey {
        &self.key
    }

    pub fn native_session_id(&self) -> &EndpointSessionId {
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
pub struct SessionLabelPatchParams {
    key: SessionKey,
    label: String,
}

impl SessionLabelPatchParams {
    pub fn try_new(key: SessionKey, label: impl Into<String>) -> Result<Self, ValidationError> {
        Ok(Self {
            key,
            label: non_empty(label, "session label must be a non-empty string")?,
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
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
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
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedSessionModel {
    pub model_provider: ModelRef,
    pub model: ModelRef,
    pub agent_runtime: SessionAgentRuntime,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChatSendStatus {
    Started,
    InFlight,
    Ok,
}
#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    pub endpoint_session_id: String,
}

#[derive(Clone, PartialEq)]
pub struct SessionSummary {
    pub key: SessionKey,
    pub kind: SessionKind,
    pub agent_id: Option<AgentId>,
    pub label: Option<String>,
    pub display_name: Option<String>,
    pub derived_title: Option<String>,
    pub updated_at: Option<u64>,
    pub status: Option<String>,
    pub has_active_run: Option<bool>,
    pub model: Option<String>,
}

impl<'de> Deserialize<'de> for SessionSummary {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut payload = Value::deserialize(deserializer)?;
        let object = payload
            .as_object_mut()
            .ok_or_else(|| D::Error::custom("session summary must be an object"))?;
        let key = object
            .get("key")
            .cloned()
            .ok_or_else(|| D::Error::custom("session summary key is required"))?;
        let kind = object
            .get("kind")
            .cloned()
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
            "sessionId",
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
            "startedAt",
            "endedAt",
            "runtimeMs",
            "parentSessionKey",
            "childSessions",
            "responseUsage",
            "modelProvider",
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
            kind: serde_json::from_value(kind).map_err(D::Error::custom)?,
            agent_id: serde_json::from_value(read("agentId")).map_err(D::Error::custom)?,
            label: serde_json::from_value(read("label")).map_err(D::Error::custom)?,
            display_name: serde_json::from_value(read("displayName")).map_err(D::Error::custom)?,
            derived_title: serde_json::from_value(read("derivedTitle"))
                .map_err(D::Error::custom)?,
            updated_at: serde_json::from_value(read("updatedAt")).map_err(D::Error::custom)?,
            status: serde_json::from_value(read("status")).map_err(D::Error::custom)?,
            has_active_run: serde_json::from_value(read("hasActiveRun"))
                .map_err(D::Error::custom)?,
            model: serde_json::from_value(read("model")).map_err(D::Error::custom)?,
        })
    }
}

impl SessionSummary {
    pub fn agent_scoped_catalog_entry(&self) -> Option<AgentScopedSessionSummary> {
        let key = self.key.as_str();
        let agent_id = match key.strip_prefix("agent:") {
            Some(scoped_key) => {
                let (agent_id, endpoint_session_id) = scoped_key.split_once(':')?;
                if endpoint_session_id.split(':').any(str::is_empty) {
                    return None;
                }
                return Some(AgentScopedSessionSummary {
                    session_key: self.key.clone(),
                    agent_id: AgentId::try_new(agent_id).ok()?,
                    endpoint_session_id: endpoint_session_id.to_owned(),
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
            endpoint_session_id: key.to_owned(),
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
    InvalidSessionsListResult,
    InvalidSessionModelPatchResult,
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
            Self::InvalidSessionsListResult => "sessions.list result is invalid",
            Self::InvalidSessionModelPatchResult => "sessions.patch model result is invalid",
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
pub fn decode_session_model_patch_result(
    id: &str,
    response: GatewayResponse,
) -> Result<SessionModelPatchResult, ProtocolError> {
    decode_result(id, response, ProtocolError::InvalidSessionModelPatchResult)
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

pub fn decode_session_create_result(
    id: &str,
    response: GatewayResponse,
    expected_key: &AgentScopedSessionKey,
) -> Result<SessionCreateResult, ProtocolError> {
    let result: PeerSessionCreateResult =
        decode_result(id, response, ProtocolError::InvalidSessionCreateResult)?;
    (result.ok && result.key == expected_key.as_str())
        .then_some(SessionCreateResult {
            native_session_id: result.session_id,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PeerSessionCreateResult {
    ok: bool,
    key: String,
    #[serde(rename = "sessionId")]
    session_id: EndpointSessionId,
    #[serde(default, rename = "entry")]
    _entry: Option<IgnoredAny>,
    #[serde(default, rename = "runStarted")]
    _run_started: Option<IgnoredAny>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    Delta,
    Final,
    Aborted,
    Error,
}
#[derive(Clone, PartialEq)]
pub struct ChatEvent {
    pub run_id: RunId,
    pub session_key: SessionKey,
    pub sequence: u64,
    pub state: ChatState,
    pub delta_text: Option<String>,
    pub replace: bool,
    pub message_text: Option<String>,
    pub error_kind: Option<SessionErrorKind>,
    pub stop_reason: Option<String>,
}
impl fmt::Debug for ChatEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatEvent")
            .field("sequence", &self.sequence)
            .field("state", &self.state)
            .field("has_delta_text", &self.delta_text.is_some())
            .field("replace", &self.replace)
            .field("has_message_text", &self.message_text.is_some())
            .field("error_kind", &self.error_kind)
            .field("has_stop_reason", &self.stop_reason.is_some())
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
        Some("delta") => ChatState::Delta,
        Some("final") => ChatState::Final,
        Some("aborted") => ChatState::Aborted,
        Some("error") => ChatState::Error,
        _ => return Err(ProtocolError::InvalidSessionEvent),
    };
    if object.keys().any(|key| !allowed_chat_field(state, key))
        || (state == ChatState::Delta && !matches!(object.get("deltaText"), Some(Value::String(_))))
        || object
            .get("spawnedBy")
            .is_some_and(|value| !matches!(value, Value::String(text) if !text.is_empty()))
        || object
            .get("replace")
            .is_some_and(|value| !value.is_boolean())
        || ["stopReason", "errorMessage"]
            .into_iter()
            .any(|key| object.get(key).is_some_and(|value| !value.is_string()))
        || object
            .get("errorKind")
            .is_some_and(|value| SessionErrorKind::parse(value).is_none())
    {
        return Err(ProtocolError::InvalidSessionEvent);
    }
    let delta_text = bounded_text(object.get("deltaText"), MAX_SESSION_UPDATE_TEXT_BYTES)?;
    let message_text = object
        .get("message")
        .and_then(message_content_text)
        .map(|text| bounded_text_value(text, MAX_SESSION_UPDATE_TEXT_BYTES))
        .transpose()?;
    let sequence: u64 = required(object, "seq")?;
    if sequence > MAX_SAFE_SEQUENCE {
        return Err(ProtocolError::InvalidSessionEvent);
    }
    let stop_reason = bounded_text(
        object.get("stopReason"),
        MAX_SESSION_UPDATE_STOP_REASON_BYTES,
    )?;
    Ok(ChatEvent {
        run_id: required(object, "runId")?,
        session_key: required(object, "sessionKey")?,
        sequence,
        state,
        delta_text,
        replace: object
            .get("replace")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        message_text,
        error_kind: object.get("errorKind").and_then(SessionErrorKind::parse),
        stop_reason,
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

fn message_content_text(message: &Value) -> Option<&str> {
    message.get("content").and_then(|content| {
        content.as_str().or_else(|| {
            content.as_array().and_then(|blocks| {
                let first = blocks.first()?;
                first.get("text").and_then(Value::as_str)
            })
        })
    })
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
            bounded_text_value(text, MAX_SESSION_ACTIVITY_TEXT_BYTES)
        })
        .transpose()
}

fn project_message_activity(
    object: &Map<String, Value>,
    message_id: Option<&MessageId>,
    embedded_message_id: Option<&MessageId>,
) -> Result<Option<SessionActivityKind>, ProtocolError> {
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
    Ok(Some(SessionActivityKind::Message {
        message_id,
        lifecycle,
        text,
    }))
}

fn project_tool_activity(
    object: &Map<String, Value>,
) -> Result<Option<SessionActivityKind>, ProtocolError> {
    let phase = object
        .get("phase")
        .and_then(Value::as_str)
        .ok_or(ProtocolError::InvalidSessionEvent)?;
    let tool_id = bounded_activity_id(
        object.get("toolCallId").or_else(|| object.get("toolId")),
        ProtocolError::InvalidSessionEvent,
    )?;
    let phase = match phase {
        "started" => ToolActivityPhase::Started,
        "updated" => ToolActivityPhase::Updated,
        "completed" => ToolActivityPhase::Completed,
        "failed" => ToolActivityPhase::Failed,
        _ => return Err(ProtocolError::InvalidSessionEvent),
    };
    let summary = activity_text(
        object
            .get("summary")
            .or_else(|| object.get("text"))
            .or_else(|| object.get("result")),
    )?;
    Ok(Some(SessionActivityKind::Tool {
        tool_id,
        phase,
        summary,
    }))
}

fn allowed_chat_field(state: ChatState, field: &str) -> bool {
    matches!(
        field,
        "runId" | "sessionKey" | "spawnedBy" | "seq" | "state" | "message"
    ) || (state == ChatState::Delta && matches!(field, "deltaText" | "replace" | "usage"))
        || (matches!(state, ChatState::Final | ChatState::Error) && field == "usage")
        || (matches!(
            state,
            ChatState::Final | ChatState::Aborted | ChatState::Error
        ) && field == "stopReason")
        || (state == ChatState::Error && matches!(field, "errorMessage" | "errorKind"))
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionEventKind {
    Chat,
    Message,
    Tool,
    Changed,
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

identity!(ToolId, "tool id must be a non-empty string");

#[derive(Clone, Eq, PartialEq)]
pub enum SessionActivityKind {
    Message {
        message_id: MessageId,
        lifecycle: MessageActivityLifecycle,
        text: Option<String>,
    },
    Tool {
        tool_id: ToolId,
        phase: ToolActivityPhase,
        summary: Option<String>,
    },
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionActivity {
    pub gateway_sequence: Option<u64>,
    pub session_key: SessionKey,
    pub run_id: RunId,
    pub kind: SessionActivityKind,
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
}

impl SessionActivityKind {
    pub fn message_id(&self) -> Option<&MessageId> {
        match self {
            Self::Message { message_id, .. } => Some(message_id),
            Self::Tool { .. } => None,
        }
    }
    pub fn tool_id(&self) -> Option<&ToolId> {
        match self {
            Self::Message { .. } => None,
            Self::Tool { tool_id, .. } => Some(tool_id),
        }
    }
    pub fn message_lifecycle(&self) -> Option<MessageActivityLifecycle> {
        match self {
            Self::Message { lifecycle, .. } => Some(*lifecycle),
            Self::Tool { .. } => None,
        }
    }
    pub fn tool_phase(&self) -> Option<ToolActivityPhase> {
        match self {
            Self::Message { .. } => None,
            Self::Tool { phase, .. } => Some(*phase),
        }
    }
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Message { text, .. } => text.as_deref(),
            Self::Tool { summary, .. } => summary.as_deref(),
        }
    }
}

impl fmt::Debug for SessionActivity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionActivity")
            .field("has_gateway_sequence", &self.gateway_sequence.is_some())
            .field("kind", &self.kind)
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
            Self::Tool { phase, summary, .. } => formatter
                .debug_struct("Tool")
                .field("phase", phase)
                .field("has_summary", &summary.is_some())
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
    let kind = match event.name.as_str() {
        "chat" => SessionEventKind::Chat,
        "session.message" => SessionEventKind::Message,
        "session.tool" => SessionEventKind::Tool,
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
    let session_key: SessionKey = required(object, "sessionKey")?;
    let run_id: Option<RunId> = optional(object, "runId")?;
    let activity = match kind {
        SessionEventKind::Message if run_id.is_some() && object.get("lifecycle").is_some() => {
            project_message_activity(object, message_id.as_ref(), embedded_message_id.as_ref())?
        }
        SessionEventKind::Tool if run_id.is_some() => project_tool_activity(object)?,
        SessionEventKind::Message | SessionEventKind::Tool => None,
        SessionEventKind::Chat | SessionEventKind::Changed => None,
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
                kind: activity,
            })
        }
        (Some(_), None) => return Err(ProtocolError::InvalidSessionEvent),
        (None, _) => None,
    };
    let envelope = SessionEventEnvelope {
        gateway_sequence: event.sequence,
        kind,
        session_key,
        run_id,
        message_id,
        embedded_message_id,
        chat,
        activity,
    };
    Ok(Some(envelope))
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
            serde_json::to_value(ChatHistoryParams::new(key())).unwrap(),
            json(r#"{"sessionKey":"agent:main:session-1"}"#)
        );
        let history = ChatHistoryParams::new(key())
            .try_with_limit(25)
            .unwrap()
            .try_with_max_chars(10_000)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&history).unwrap(),
            json(r#"{"sessionKey":"agent:main:session-1","limit":25,"maxChars":10000}"#)
        );
        for raw in [
            r#"{"sessionKey":"agent:main:session-1","limit":0,"maxChars":1}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":1001,"maxChars":1}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":1,"maxChars":0}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":1,"maxChars":500001}"#,
            r#"{"sessionKey":"agent:main:session-1","limit":null}"#,
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
            .unwrap();
        assert_eq!(
            serde_json::to_value(list).unwrap(),
            json(
                r#"{"limit":25,"activeMinutes":120,"configuredAgentsOnly":true,"includeDerivedTitles":true,"includeLastMessage":true,"agentId":"main"}"#
            )
        );
        assert!(SessionsListParams::default().try_with_limit(0).is_err());
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
            r#"{"runId":"run-7","sessionKey":"agent:main:session-1","seq":8,"state":"delta"}"#,
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
        )
        .unwrap();
        assert_eq!(
            create.key().as_str(),
            "agent:mct-team:team-endpoint-session-run-1-reviewer"
        );
        assert_eq!(
            serde_json::to_value(&create).unwrap(),
            json(
                r#"{"key":"agent:mct-team:team-endpoint-session-run-1-reviewer","agentId":"mct-team"}"#
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
    fn native_chat_send_result_rejects_unknown_fields() {
        assert!(
            decode_chat_send_result(
                "s",
                success("s", r#"{"runId":"run-7","status":"started","future":true}"#),
            )
            .is_err()
        );
    }

    #[test]
    fn native_response_schemas_reject_unknown_fields() {
        let expected_key = SessionCreateParams::try_new(
            AgentId::try_new("mct-team").unwrap(),
            EndpointSessionId::try_new("team-session").unwrap(),
        )
        .unwrap()
        .key()
        .clone();

        assert!(
            decode_chat_abort_result(
                "abort",
                success(
                    "abort",
                    r#"{"ok":true,"aborted":true,"runIds":["run-7"],"future":true}"#,
                ),
            )
            .is_err()
        );
        let list = decode_sessions_list_result(
            "list",
            success(
                "list",
                r#"{"ts":42,"count":1,"future":true,"sessions":[{"key":"agent:main:session-1","kind":"direct","future":true}]}"#,
            ),
        )
        .unwrap();
        assert_eq!(list.sessions[0].key.as_str(), "agent:main:session-1");
        assert!(
            decode_session_create_result(
                "create",
                success(
                    "create",
                    r#"{"ok":true,"key":"agent:mct-team:team-session","future":true}"#,
                ),
                &expected_key,
            )
            .is_err()
        );
        assert!(decode_session_delete_result(
            "delete",
            success(
                "delete",
                r#"{"ok":true,"key":"agent:mct-team:team-session","deleted":true,"future":true}"#,
            ),
            &expected_key,
        )
        .is_err());
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
            r#"{"sessionKey":"agent:main:session-1","runId":"run-7","phase":"failed","toolCallId":"tool-9","summary":"bounded summary","input":{"secret":"omit"},"output":{"secret":"omit"}}"#,
        ))
        .unwrap()
        .unwrap();
        assert!(matches!(
            tool.activity.as_ref().unwrap().kind(),
            SessionActivityKind::Tool { phase: ToolActivityPhase::Failed, summary: Some(summary), .. } if summary == "bounded summary"
        ));
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
                r#"{"ok":true,"path":"not-projected","key":"agent:main:session-1","entry":{"not":"projected"},"resolved":{"modelProvider":"anthropic","model":"anthropic/claude-opus-4-7","agentRuntime":{"id":"acpx","source":"session-key"}}}"#,
            ),
        )
        .unwrap();
        assert_eq!(patch.key, key());
        assert_eq!(patch.resolved.model.as_str(), "anthropic/claude-opus-4-7");
        assert_eq!(
            patch.resolved.agent_runtime.source,
            SessionAgentRuntimeSource::SessionKey
        );
        assert!(decode_session_model_patch_result(
            "p",
            success(
                "p",
                r#"{"ok":true,"key":"agent:main:session-1","resolved":{"modelProvider":"anthropic","model":"anthropic/claude-opus-4-7","agentRuntime":{"id":"acpx","source":"future"}}}"#,
            ),
        )
        .is_err());
        let projection = decode_session_event(event("session.message", r#"{"sessionKey":"agent:main:session-1","runId":"run-7","messageId":"message-3","message":{},"future":true}"#)).unwrap().unwrap();
        assert_eq!(projection.kind, SessionEventKind::Message);
        assert_eq!(projection.run_id.unwrap().as_str(), "run-7");
        assert_eq!(projection.message_id.unwrap().as_str(), "message-3");
        let chat = decode_session_event(event("chat", r#"{"runId":"run-7","sessionKey":"agent:main:session-1","seq":8,"state":"delta","deltaText":"hi","replace":false}"#)).unwrap().unwrap().chat.unwrap();
        assert_eq!(
            (chat.session_key.as_str(), chat.run_id.as_str()),
            ("agent:main:session-1", "run-7")
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
            success("future", r#"{"messages":[],"future":true}"#),
            1,
        )
        .unwrap();
        assert!(history.messages.is_empty());
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
        let session_create = SessionCreateParams::try_new(agent_id, endpoint_session_id).unwrap();
        let run_id = RunId::try_new(RUN).unwrap();
        let message_id = MessageId::try_new(MESSAGE).unwrap();
        let model_ref = ModelRef::try_new(PAYLOAD).unwrap();
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
}
