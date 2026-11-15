use platform::capability::CapabilityDecisionVerifier;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{WorkspaceWriteFailure, WorkspaceWriteReceipt};
use super::file::{Endpoint, FileScope as Scope, optional_value};

pub(crate) mod binary;
pub(crate) mod handler;

const CAPABILITY_ID: &str = "workspace.file";
const OPERATION_ID: &str = "files.writeText";
const TARGET_KIND: &str = "workspace-file";
pub(super) const AUTHORIZATION_ENDPOINT: &str = "/api/workspace/files/write-text";
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
            && self.target.kind == TARGET_KIND
            && self.scope.matches_input(&self.input.endpoint, self.input.agent_id.as_deref(), self.input.team_id.as_deref(), self.input.run_id.as_deref())
            && valid_relative_path(&self.input.relative_path)
            && self.input.content.len() <= MAX_CONTENT_BYTES)
            .then_some(())
            .ok_or(RequestError::Invalid)
    }

    pub(crate) fn endpoint(&self) -> platform::endpoint::runtime_address::RuntimeEndpoint {
        self.input
            .endpoint
            .runtime_endpoint()
            .expect("workspace write endpoint validated")
    }
    pub(crate) fn selection(&self) -> crate::application::commands::WorkspaceFileSelection {
        self.scope.selection()
    }

    pub(crate) fn relative_path(&self) -> &str {
        &self.input.relative_path
    }

    pub(crate) fn content(&self) -> &str {
        &self.input.content
    }
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
struct Target {
    kind: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Input {
    endpoint: Endpoint,
    #[serde(rename = "agentId", default, deserialize_with = "optional_value")]
    agent_id: Option<String>,
    #[serde(rename = "teamId", default, deserialize_with = "optional_value")]
    team_id: Option<String>,
    #[serde(rename = "runId", default, deserialize_with = "optional_value")]
    run_id: Option<String>,
    #[serde(rename = "relativePath")]
    relative_path: String,
    content: String,
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
    result: Result<WorkspaceWriteReceipt, WorkspaceWriteFailure>,
) -> WorkspaceWriteDelivery {
    match result {
        Ok(receipt) => WorkspaceWriteDelivery::Ok(WorkspaceWriteResponse {
            name: receipt.name().to_owned(),
            size: receipt.size(),
        }),
        Err(WorkspaceWriteFailure::InvalidPath) => WorkspaceWriteDelivery::InvalidPath,
        Err(WorkspaceWriteFailure::NotFile) => WorkspaceWriteDelivery::NotFile,
        Err(WorkspaceWriteFailure::TooLarge) => WorkspaceWriteDelivery::TooLarge,
        Err(WorkspaceWriteFailure::OutcomeUnknown) => WorkspaceWriteDelivery::OutcomeUnknown,
        Err(WorkspaceWriteFailure::Unavailable) => WorkspaceWriteDelivery::Unavailable,
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
        let outcome = map_outcome(Err(WorkspaceWriteFailure::OutcomeUnknown));
        assert_eq!(outcome.status_code(), 422);
        assert_eq!(
            outcome.body(),
            json!({ "success": false, "error": "Workspace write outcome is unknown" })
        );
    }
}
