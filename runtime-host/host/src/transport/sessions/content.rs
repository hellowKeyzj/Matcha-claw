use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::timeline::{ContentCommand, ContentOutcome, ContentOutcome::Complete, Provider},
    transport::authorization::CapabilityDecisionVerifier,
};

const CAPABILITY_ID: &str = "session.management";
const OPERATION: &str = "sessions.content.load";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_INSTANCE_ID: &str = "local";
const SCOPE_KIND: &str = "session";
const TARGET_KIND: &str = "session";
const AUTHORIZATION_ENDPOINT: &str = "/api/sessions/content";
const AUTHORIZATION_SCOPE: &str = "sessions:read";
const AUTHORIZATION_SUBJECT: &str = "session-content";
const DEFAULT_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl Request {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        let request: Self = serde_json::from_value(value).map_err(|_| DecodeError::Invalid)?;
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                CAPABILITY_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), DecodeError> {
        (self.id == CAPABILITY_ID
            && self.operation_id == OPERATION
            && self.scope.kind == SCOPE_KIND
            && self.target.kind == TARGET_KIND
            && self.target.identity == self.scope.identity
            && self.input.session_identity == self.scope.identity
            && self.input.session_key == self.scope.identity.session_key
            && self.scope.identity.endpoint.is_local_provider())
        .then_some(())
        .ok_or(DecodeError::Invalid)?;
        self.command().map(|_| ()).ok_or(DecodeError::Invalid)
    }

    pub(crate) fn into_command(self) -> Option<ContentCommand> {
        self.command()
    }

    fn command(&self) -> Option<ContentCommand> {
        ContentCommand::new(
            self.scope.identity.endpoint.provider()?,
            self.input.session_key.clone(),
            Some(self.scope.identity.agent_id.clone()),
            self.input.endpoint_session_id.clone(),
            self.input.content_ref.clone(),
            self.input.offset,
            self.input.limit.unwrap_or(DEFAULT_LIMIT),
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: String,
    identity: Identity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
    identity: Identity,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    session_key: String,
    session_identity: Identity,
    #[serde(default)]
    endpoint_session_id: Option<String>,
    content_ref: String,
    offset: u64,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Identity {
    endpoint: Endpoint,
    agent_id: String,
    session_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn provider(&self) -> Option<Provider> {
        (self.kind == RUNTIME_KIND && self.runtime_instance_id == RUNTIME_INSTANCE_ID).then_some(
            match self.runtime_adapter_id.as_str() {
                "openclaw" => Some(Provider::OpenClaw),
                "matcha-agent" => Some(Provider::Matcha),
                _ => None,
            },
        )?
    }

    fn is_local_provider(&self) -> bool {
        self.provider().is_some()
    }
}

pub(crate) enum Delivery {
    Complete(crate::sessions::timeline::ContentChunk),
    Unavailable,
}

impl Delivery {
    pub(crate) fn from_outcome(outcome: ContentOutcome) -> Self {
        match outcome {
            Complete(chunk) => Self::Complete(chunk),
            ContentOutcome::Unavailable(_) => Self::Unavailable,
        }
    }

    pub(crate) const fn status_code(&self) -> u16 {
        match self {
            Self::Complete(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Complete(chunk) => serde_json::json!({
                "contentRef": &chunk.content_ref,
                "offset": chunk.offset,
                "text": &chunk.text,
                "nextOffset": chunk.next_offset,
                "totalBytes": chunk.total_bytes,
                "complete": chunk.complete,
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session content is unavailable",
            }),
        }
    }
}
