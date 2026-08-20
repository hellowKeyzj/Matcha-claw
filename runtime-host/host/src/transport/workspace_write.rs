use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{WorkspaceWriteError, transport::authorization::CapabilityDecisionVerifier};

pub(crate) mod server;

const CAPABILITY_ID: &str = "workspace.file";
const OPERATION_ID: &str = "files.writeText";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_ADAPTER_ID: &str = "openclaw";
const RUNTIME_INSTANCE_ID: &str = "local";
const SCOPE_KIND: &str = "session";
const TARGET_KIND: &str = "workspace-file";
const AUTHORIZATION_ENDPOINT: &str = "/api/workspace/files/write-text";
const AUTHORIZATION_SCOPE: &str = "workspace-files:write";
const AUTHORIZATION_SUBJECT: &str = "workspace-write";
const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceWriteRequest {
    id: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl WorkspaceWriteRequest {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, RequestError> {
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| RequestError::Invalid)?;
        Self::decode_semantics(value)
    }

    fn decode_semantics(value: Value) -> Result<Self, RequestError> {
        let request: Self = serde_json::from_value(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), RequestError> {
        (self.id == CAPABILITY_ID
            && self.operation_id == OPERATION_ID
            && self.scope.kind == SCOPE_KIND
            && self.target.kind == TARGET_KIND
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.is_openclaw_local()
            && valid_session_key(&self.scope.session_key)
            && self.scope.session_key == self.input.session_key
            && valid_relative_path(&self.input.relative_path)
            && self.input.content.len() <= MAX_CONTENT_BYTES)
            .then_some(())
            .ok_or(RequestError::Invalid)
    }

    pub(crate) fn session_key(&self) -> &str {
        &self.input.session_key
    }

    pub(crate) fn relative_path(&self) -> &str {
        &self.input.relative_path
    }

    pub(crate) fn content(&self) -> &str {
        &self.input.content
    }
}

fn valid_session_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.as_bytes().contains(&0)
}

fn valid_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.as_bytes().contains(&0)
        && !value
            .as_bytes()
            .first()
            .is_some_and(|byte| matches!(byte, b'/' | b'\\'))
        && !value.contains(':')
        && value
            .split(['/', '\\'])
            .all(|component| component != "." && component != ".." && !component.is_empty())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Scope {
    kind: String,
    endpoint: Endpoint,
    #[serde(rename = "sessionKey")]
    session_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Input {
    endpoint: Endpoint,
    #[serde(rename = "sessionKey")]
    session_key: String,
    #[serde(rename = "relativePath")]
    relative_path: String,
    content: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    kind: String,
    #[serde(rename = "runtimeAdapterId")]
    runtime_adapter_id: String,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: String,
}

impl Endpoint {
    fn is_openclaw_local(&self) -> bool {
        self.kind == RUNTIME_KIND
            && self.runtime_adapter_id == RUNTIME_ADAPTER_ID
            && self.runtime_instance_id == RUNTIME_INSTANCE_ID
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceWriteDelivery {
    Ok(WorkspaceWriteResponse),
    InvalidPath,
    NotFile,
    TooLarge,
    OutcomeUnknown,
    Unavailable,
}

impl WorkspaceWriteDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
            Self::InvalidPath | Self::NotFile | Self::TooLarge | Self::OutcomeUnknown => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Ok(response) => serde_json::to_value(response)
                .expect("Workspace write public response is serializable"),
            Self::InvalidPath => error("Workspace write path is invalid"),
            Self::NotFile => error("Workspace write target is not a file"),
            Self::TooLarge => error("Workspace write content exceeds the limit"),
            Self::OutcomeUnknown => error("Workspace write outcome is unknown"),
            Self::Unavailable => error("Workspace write is unavailable"),
        }
    }
}

fn error(message: &'static str) -> Value {
    serde_json::json!({ "success": false, "error": message })
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceWriteResponse {
    name: String,
    size: u64,
}

pub(crate) fn map_outcome(
    result: Result<openclaw::workspace::WorkspaceTextReceipt, WorkspaceWriteError>,
) -> WorkspaceWriteDelivery {
    match result {
        Ok(receipt) => WorkspaceWriteDelivery::Ok(WorkspaceWriteResponse {
            name: receipt.name().to_owned(),
            size: receipt.size(),
        }),
        Err(WorkspaceWriteError::InvalidPath) => WorkspaceWriteDelivery::InvalidPath,
        Err(WorkspaceWriteError::NotFile) => WorkspaceWriteDelivery::NotFile,
        Err(WorkspaceWriteError::TooLarge) => WorkspaceWriteDelivery::TooLarge,
        Err(WorkspaceWriteError::OutcomeUnknown) => WorkspaceWriteDelivery::OutcomeUnknown,
        Err(WorkspaceWriteError::AdmissionClosed(_) | WorkspaceWriteError::Unavailable) => {
            WorkspaceWriteDelivery::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(relative_path: &str, content: &str) -> Value {
        json!({
            "id": "workspace.file",
            "operationId": "files.writeText",
            "scope": {
                "kind": "session",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
            },
            "target": { "kind": "workspace-file" },
            "input": {
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
                "relativePath": relative_path,
                "content": content,
            },
        })
    }

    #[test]
    fn accepts_only_the_fixed_bounded_relative_workspace_write_request() {
        assert_eq!(
            WorkspaceWriteRequest::decode_semantics(request("docs/notes.txt", "notes"))
                .unwrap()
                .content(),
            "notes"
        );

        for relative_path in ["", "/private", "C:/private", "../private", "docs//nested"] {
            assert_eq!(
                WorkspaceWriteRequest::decode_semantics(request(relative_path, "notes")),
                Err(RequestError::Invalid)
            );
        }
        assert_eq!(
            WorkspaceWriteRequest::decode_semantics(request(
                "notes.txt",
                &"x".repeat(MAX_CONTENT_BYTES + 1),
            )),
            Err(RequestError::Invalid)
        );
    }

    #[test]
    fn keeps_an_unknown_write_outcome_distinct() {
        let outcome = map_outcome(Err(WorkspaceWriteError::OutcomeUnknown));
        assert_eq!(outcome.status_code(), 422);
        assert_eq!(
            outcome.body(),
            json!({ "success": false, "error": "Workspace write outcome is unknown" })
        );
    }
}
