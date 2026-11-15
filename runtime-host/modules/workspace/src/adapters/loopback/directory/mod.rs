use platform::capability::CapabilityDecisionVerifier;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{WorkspaceDirectoryReceipt, WorkspaceListFailure};
use super::file::{Endpoint, FileScope as Scope, optional_value};

pub(crate) mod handler;

const CAPABILITY_ID: &str = "workspace.file";
const OPERATION_ID: &str = "files.listDir";
const TARGET_KIND: &str = "workspace-file";
pub(super) const AUTHORIZATION_ENDPOINT: &str = "/api/workspace/files/list-dir";
const AUTHORIZATION_SCOPE: &str = "workspace-files:list";
const AUTHORIZATION_SUBJECT: &str = "workspace-directory";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceDirectoryRequest {
    id: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl WorkspaceDirectoryRequest {
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
            && valid_relative_path(&self.input.relative_path))
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    pub(crate) fn endpoint(&self) -> platform::endpoint::runtime_address::RuntimeEndpoint {
        self.input
            .endpoint
            .runtime_endpoint()
            .expect("workspace directory endpoint validated")
    }
    pub(crate) fn selection(&self) -> crate::application::commands::WorkspaceFileSelection {
        self.scope.selection()
    }

    pub(crate) fn relative_path(&self) -> &str {
        &self.input.relative_path
    }

    pub(crate) const fn include_hidden(&self) -> bool {
        self.input.include_hidden
    }
}

fn valid_relative_path(value: &str) -> bool {
    value.is_empty()
        || (value.len() <= 4096
            && !value.as_bytes().contains(&0)
            && !value
                .as_bytes()
                .first()
                .is_some_and(|byte| matches!(byte, b'/' | b'\\'))
            && !value.contains(':')
            && value
                .split(['/', '\\'])
                .all(|component| component != "." && component != ".." && !component.is_empty()))
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
    #[serde(rename = "includeHidden")]
    include_hidden: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceDirectoryDelivery {
    Ok(WorkspaceDirectoryResponse),
    InvalidPath,
    NotDirectory,
    Unavailable,
}

impl WorkspaceDirectoryDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
            Self::InvalidPath | Self::NotDirectory => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Ok(response) => serde_json::to_value(response)
                .expect("Workspace directory public response is serializable"),
            Self::InvalidPath => error("Workspace directory path is invalid"),
            Self::NotDirectory => error("Workspace directory target is not a directory"),
            Self::Unavailable => error("Workspace directory is unavailable"),
        }
    }
}

fn error(message: &'static str) -> Value {
    serde_json::json!({ "success": false, "error": message })
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDirectoryResponse {
    entries: Vec<WorkspaceDirectoryEntry>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDirectoryEntry {
    relative_path: String,
    display: String,
    is_directory: bool,
    size: u64,
}

pub(crate) fn map_outcome(
    result: Result<WorkspaceDirectoryReceipt, WorkspaceListFailure>,
) -> WorkspaceDirectoryDelivery {
    match result {
        Ok(receipt) => WorkspaceDirectoryDelivery::Ok(WorkspaceDirectoryResponse {
            entries: receipt
                .entries()
                .iter()
                .map(|entry| WorkspaceDirectoryEntry {
                    relative_path: entry.relative_path().to_owned(),
                    display: entry.display().to_owned(),
                    is_directory: entry.is_directory(),
                    size: entry.size(),
                })
                .collect(),
        }),
        Err(WorkspaceListFailure::InvalidPath) => WorkspaceDirectoryDelivery::InvalidPath,
        Err(WorkspaceListFailure::NotDirectory) => WorkspaceDirectoryDelivery::NotDirectory,
        Err(WorkspaceListFailure::Unavailable) => WorkspaceDirectoryDelivery::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(relative_path: &str) -> Value {
        json!({
            "id": "workspace.file",
            "operationId": "files.listDir",
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
                "includeHidden": false,
            },
        })
    }

    #[test]
    fn accepts_only_the_fixed_relative_workspace_directory_request() {
        assert!(
            !WorkspaceDirectoryRequest::decode_semantics(request("docs"))
                .unwrap()
                .include_hidden()
        );
        assert_eq!(
            WorkspaceDirectoryRequest::decode_semantics(request("docs"))
                .unwrap()
                .relative_path(),
            "docs"
        );
        assert_eq!(
            WorkspaceDirectoryRequest::decode_semantics(request(""))
                .unwrap()
                .relative_path(),
            ""
        );

        for relative_path in ["/private", "C:/private", "../private", "docs//nested"] {
            assert_eq!(
                WorkspaceDirectoryRequest::decode_semantics(request(relative_path)),
                Err(RequestError::Invalid)
            );
        }
    }

    #[test]
    fn preserves_directory_entries_beyond_legacy_page_size() {
        let delivery = WorkspaceDirectoryDelivery::Ok(WorkspaceDirectoryResponse {
            entries: (0..257)
                .map(|index| WorkspaceDirectoryEntry {
                    relative_path: format!("entry-{index}"),
                    display: format!("entry-{index}"),
                    is_directory: false,
                    size: index,
                })
                .collect(),
        });

        assert_eq!(delivery.body()["entries"].as_array().unwrap().len(), 257);
    }

    #[test]
    fn redacts_workspace_failures() {
        let unavailable = map_outcome(Err(WorkspaceListFailure::Unavailable));
        assert_eq!(unavailable.status_code(), 503);
        assert_eq!(
            unavailable.body(),
            json!({ "success": false, "error": "Workspace directory is unavailable" })
        );
    }
}
