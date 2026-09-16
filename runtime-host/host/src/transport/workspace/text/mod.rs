use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    WorkspaceReadError, runtime::driver::WorkspaceTextReceipt,
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const CAPABILITY_ID: &str = "workspace.file";
const OPERATION_ID: &str = "files.readText";
const RUNTIME_KIND: &str = "native-runtime";
const RUNTIME_ADAPTER_ID: &str = "openclaw";
const RUNTIME_INSTANCE_ID: &str = "local";
const SCOPE_KIND: &str = "session";
const TARGET_KIND: &str = "workspace-file";
const AUTHORIZATION_ENDPOINT: &str = "/api/workspace/files/read-text";
const AUTHORIZATION_SCOPE: &str = "workspace-files:read";
const AUTHORIZATION_SUBJECT: &str = "workspace-text";
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Unauthorized,
    Invalid,
    InvalidPath,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceTextRequest {
    id: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl WorkspaceTextRequest {
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
            .map_err(|_| RequestError::Unauthorized)?;
        Self::decode_semantics(value)
    }

    fn decode_semantics(value: Value) -> Result<Self, RequestError> {
        let request: Self = serde_json::from_value(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), RequestError> {
        if !(self.id == CAPABILITY_ID
            && self.operation_id == OPERATION_ID
            && self.scope.kind == SCOPE_KIND
            && self.target.kind == TARGET_KIND
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.is_openclaw_local()
            && valid_session_key(&self.scope.session_key)
            && self.scope.session_key == self.input.session_key)
        {
            return Err(RequestError::Invalid);
        }
        if !valid_relative_path(&self.input.relative_path) {
            return Err(RequestError::InvalidPath);
        }
        Ok(())
    }

    pub(crate) fn session_key(&self) -> &str {
        &self.input.session_key
    }

    pub(crate) fn relative_path(&self) -> &str {
        &self.input.relative_path
    }

    pub(crate) fn max_bytes(&self) -> usize {
        self.input
            .max_bytes
            .map(|limit| limit.clamp(1, MAX_TEXT_BYTES))
            .unwrap_or(MAX_TEXT_BYTES)
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
    #[serde(rename = "maxBytes")]
    max_bytes: Option<usize>,
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
pub(crate) enum WorkspaceTextDelivery {
    Ok(WorkspaceTextResponse),
    InvalidPath,
    NotFile,
    TooLarge,
    Binary,
    Unavailable,
}

impl WorkspaceTextDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
            Self::InvalidPath | Self::NotFile | Self::TooLarge | Self::Binary => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Ok(response) => serde_json::to_value(response)
                .expect("Workspace text public response is serializable"),
            Self::InvalidPath => error("Workspace text path is invalid"),
            Self::NotFile => error("Workspace text target is not a file"),
            Self::TooLarge => error("Workspace text target exceeds the limit"),
            Self::Binary => error("Workspace text target is binary"),
            Self::Unavailable => error("Workspace text is unavailable"),
        }
    }
}

fn error(message: &'static str) -> Value {
    serde_json::json!({ "success": false, "error": message })
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceTextResponse {
    name: String,
    content: String,
    size: u64,
}

pub(crate) fn map_outcome(
    result: Result<WorkspaceTextReceipt, WorkspaceReadError>,
) -> WorkspaceTextDelivery {
    match result {
        Ok(receipt) => WorkspaceTextDelivery::Ok(WorkspaceTextResponse {
            name: receipt.name().to_owned(),
            content: receipt.content().to_owned(),
            size: receipt.size(),
        }),
        Err(WorkspaceReadError::InvalidPath) => WorkspaceTextDelivery::InvalidPath,
        Err(WorkspaceReadError::NotFile) => WorkspaceTextDelivery::NotFile,
        Err(WorkspaceReadError::TooLarge) => WorkspaceTextDelivery::TooLarge,
        Err(WorkspaceReadError::Binary) => WorkspaceTextDelivery::Binary,
        Err(WorkspaceReadError::AdmissionClosed(_) | WorkspaceReadError::Unavailable) => {
            WorkspaceTextDelivery::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request() -> Value {
        json!({
            "id": "workspace.file",
            "operationId": "files.readText",
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
                "relativePath": "docs/notes.txt",
            },
        })
    }

    #[test]
    fn accepts_only_the_fixed_relative_workspace_text_request() {
        assert_eq!(
            WorkspaceTextRequest::decode_semantics(request())
                .unwrap()
                .relative_path(),
            "docs/notes.txt"
        );

        for (value, error) in [
            (json!({}), RequestError::Invalid),
            (
                {
                    let mut value = request();
                    value["input"]["path"] = json!("C:/private/root/notes.txt");
                    value
                },
                RequestError::Invalid,
            ),
            (
                {
                    let mut value = request();
                    value["input"]["relativePath"] = json!("");
                    value
                },
                RequestError::InvalidPath,
            ),
            (
                {
                    let mut value = request();
                    value["input"]["relativePath"] = json!("/private");
                    value
                },
                RequestError::InvalidPath,
            ),
            (
                {
                    let mut value = request();
                    value["input"]["relativePath"] = json!("C:/private");
                    value
                },
                RequestError::InvalidPath,
            ),
            (
                {
                    let mut value = request();
                    value["input"]["relativePath"] = json!("../private");
                    value
                },
                RequestError::InvalidPath,
            ),
            (
                {
                    let mut value = request();
                    value["input"]["relativePath"] = json!("docs//nested");
                    value
                },
                RequestError::InvalidPath,
            ),
            (
                {
                    let mut value = request();
                    value["scope"]["sessionKey"] = json!("other");
                    value
                },
                RequestError::Invalid,
            ),
            (
                {
                    let mut value = request();
                    value["input"]["endpoint"]["runtimeInstanceId"] = json!("remote");
                    value
                },
                RequestError::Invalid,
            ),
            (
                {
                    let mut value = request();
                    value["peerSensitiveField"] = json!("private-peer-value");
                    value
                },
                RequestError::Invalid,
            ),
        ] {
            assert_eq!(WorkspaceTextRequest::decode_semantics(value), Err(error));
        }
    }

    #[test]
    fn clamps_optional_max_bytes_to_text_bounds() {
        let decoded = WorkspaceTextRequest::decode_semantics(request()).unwrap();
        assert_eq!(decoded.max_bytes(), MAX_TEXT_BYTES);

        let mut payload = request();
        payload["input"]["maxBytes"] = json!(0);
        assert_eq!(
            WorkspaceTextRequest::decode_semantics(payload)
                .unwrap()
                .max_bytes(),
            1
        );

        let mut payload = request();
        payload["input"]["maxBytes"] = json!(MAX_TEXT_BYTES + 1);
        assert_eq!(
            WorkspaceTextRequest::decode_semantics(payload)
                .unwrap()
                .max_bytes(),
            MAX_TEXT_BYTES
        );
    }

    #[test]
    fn redacts_workspace_failures() {
        let unavailable = map_outcome(Err(WorkspaceReadError::Unavailable));
        assert_eq!(unavailable.status_code(), 503);
        assert_eq!(
            unavailable.body(),
            json!({ "success": false, "error": "Workspace text is unavailable" })
        );
        let rendered = unavailable.body().to_string();
        assert!(!rendered.contains("workspace-root"));
        assert!(!rendered.contains("private native failure"));
    }
}
