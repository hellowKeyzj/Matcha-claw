use platform::capability::CapabilityDecisionVerifier;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    WorkspaceBinaryFailure, WorkspaceBinaryReceipt, WorkspaceStatFailure, WorkspaceStatReceipt,
};

pub(crate) mod handler;

const CAPABILITY_ID: &str = "workspace.file";
const READ_OPERATION_ID: &str = "files.readBinary";
const STAT_OPERATION_ID: &str = "files.stat";
const RUNTIME_KIND: &str = "native-runtime";
const SCOPE_KIND: &str = "session";
const TARGET_KIND: &str = "workspace-file";
const AUTHORIZATION_ENDPOINT: &str = "/api/workspace/files/binary";
const AUTHORIZATION_SCOPE: &str = "workspace-files:binary";
const AUTHORIZATION_SUBJECT: &str = "workspace-binary";
const MAX_BINARY_BYTES: usize = 50 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceBinaryRequest {
    id: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl WorkspaceBinaryRequest {
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
                value
                    .get("operationId")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
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
            && matches!(
                self.operation_id.as_str(),
                READ_OPERATION_ID | STAT_OPERATION_ID
            )
            && self.scope.kind == SCOPE_KIND
            && self.target.kind == TARGET_KIND
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.runtime_endpoint().is_some()
            && valid_session_key(&self.scope.session_key)
            && self.scope.session_key == self.input.session_key
            && valid_relative_path(&self.input.relative_path)
            && (self.operation_id != STAT_OPERATION_ID || self.input.max_bytes.is_none()))
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    pub(crate) fn endpoint(&self) -> platform::endpoint::runtime_address::RuntimeEndpoint {
        self.input
            .endpoint
            .runtime_endpoint()
            .expect("workspace binary endpoint validated")
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
            .map(|limit| limit.clamp(1, MAX_BINARY_BYTES))
            .unwrap_or(MAX_BINARY_BYTES)
    }

    pub(crate) fn is_stat(&self) -> bool {
        self.operation_id == STAT_OPERATION_ID
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
    fn runtime_endpoint(&self) -> Option<platform::endpoint::runtime_address::RuntimeEndpoint> {
        (self.kind == RUNTIME_KIND)
            .then(|| {
                platform::endpoint::runtime_address::RuntimeEndpoint::try_new(
                    &self.runtime_adapter_id,
                    &self.runtime_instance_id,
                )
                .ok()
            })
            .flatten()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceBinaryDelivery {
    Binary(WorkspaceBinaryResponse),
    Stat(WorkspaceStatResponse),
    InvalidPath,
    NotFile,
    TooLarge,
    Unavailable,
}

impl WorkspaceBinaryDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Binary(_) | Self::Stat(_) => 200,
            Self::InvalidPath | Self::NotFile | Self::TooLarge => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Binary(response) => serde_json::to_value(response)
                .expect("Workspace binary public response is serializable"),
            Self::Stat(response) => serde_json::to_value(response)
                .expect("Workspace stat public response is serializable"),
            Self::InvalidPath => error("Workspace binary path is invalid"),
            Self::NotFile => error("Workspace binary target is not a file"),
            Self::TooLarge => error("Workspace binary target exceeds the limit"),
            Self::Unavailable => error("Workspace binary is unavailable"),
        }
    }
}

fn error(message: &'static str) -> Value {
    serde_json::json!({ "success": false, "error": message })
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceBinaryResponse {
    name: String,
    data: String,
    size: u64,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceStatResponse {
    name: String,
    is_directory: bool,
    size: u64,
    mtime_ms: u64,
}

pub(crate) fn map_binary_outcome(
    result: Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure>,
) -> WorkspaceBinaryDelivery {
    match result {
        Ok(receipt) => WorkspaceBinaryDelivery::Binary(WorkspaceBinaryResponse {
            name: receipt.name().to_owned(),
            data: STANDARD.encode(receipt.content()),
            size: receipt.size(),
        }),
        Err(WorkspaceBinaryFailure::InvalidPath) => WorkspaceBinaryDelivery::InvalidPath,
        Err(WorkspaceBinaryFailure::NotFile) => WorkspaceBinaryDelivery::NotFile,
        Err(WorkspaceBinaryFailure::TooLarge) => WorkspaceBinaryDelivery::TooLarge,
        Err(WorkspaceBinaryFailure::Unavailable) => WorkspaceBinaryDelivery::Unavailable,
    }
}

pub(crate) fn map_stat_outcome(
    result: Result<WorkspaceStatReceipt, WorkspaceStatFailure>,
) -> WorkspaceBinaryDelivery {
    match result {
        Ok(receipt) => WorkspaceBinaryDelivery::Stat(WorkspaceStatResponse {
            name: receipt.name().to_owned(),
            is_directory: receipt.is_directory(),
            size: receipt.size(),
            mtime_ms: receipt.mtime_ms(),
        }),
        Err(WorkspaceStatFailure::InvalidPath) => WorkspaceBinaryDelivery::InvalidPath,
        Err(WorkspaceStatFailure::Unavailable) => WorkspaceBinaryDelivery::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(operation_id: &str) -> Value {
        json!({
            "id": "workspace.file",
            "operationId": operation_id,
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
                "relativePath": "docs/asset.bin",
            },
        })
    }

    #[test]
    fn accepts_only_fixed_binary_and_stat_relative_requests() {
        assert!(
            !WorkspaceBinaryRequest::decode_semantics(request(READ_OPERATION_ID))
                .unwrap()
                .is_stat()
        );
        assert!(
            WorkspaceBinaryRequest::decode_semantics(request(STAT_OPERATION_ID))
                .unwrap()
                .is_stat()
        );
        for relative_path in ["", "/private", "C:/private", "../private", "docs//nested"] {
            let mut value = request(READ_OPERATION_ID);
            value["input"]["relativePath"] = json!(relative_path);
            assert_eq!(
                WorkspaceBinaryRequest::decode_semantics(value),
                Err(RequestError::Invalid)
            );
        }
    }

    #[test]
    fn clamps_optional_max_bytes_to_binary_bounds() {
        let decoded = WorkspaceBinaryRequest::decode_semantics(request(READ_OPERATION_ID)).unwrap();
        assert_eq!(decoded.max_bytes(), MAX_BINARY_BYTES);

        let mut payload = request(READ_OPERATION_ID);
        payload["input"]["maxBytes"] = json!(0);
        assert_eq!(
            WorkspaceBinaryRequest::decode_semantics(payload)
                .unwrap()
                .max_bytes(),
            1
        );

        let mut payload = request(READ_OPERATION_ID);
        payload["input"]["maxBytes"] = json!(MAX_BINARY_BYTES + 1);
        assert_eq!(
            WorkspaceBinaryRequest::decode_semantics(payload)
                .unwrap()
                .max_bytes(),
            MAX_BINARY_BYTES
        );
    }

    #[test]
    fn redacts_binary_and_stat_failures() {
        for delivery in [
            map_binary_outcome(Err(WorkspaceBinaryFailure::Unavailable)),
            map_stat_outcome(Err(WorkspaceStatFailure::Unavailable)),
        ] {
            let rendered = delivery.body().to_string();
            assert_eq!(delivery.status_code(), 503);
            assert!(!rendered.contains("workspace-root"));
            assert!(!rendered.contains("private native failure"));
        }
    }
}
