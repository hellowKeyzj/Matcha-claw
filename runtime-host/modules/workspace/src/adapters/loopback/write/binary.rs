use base64::{Engine as _, engine::general_purpose::STANDARD};
use platform::{
    endpoint::runtime_address::RuntimeEndpoint,
    loopback::{Request, Response},
};
use serde::Deserialize;

use super::{super::{Dependencies, file::{Endpoint, FileScope as Scope, optional_value}}, map_outcome};
use crate::application::commands::WorkspaceFileSelection;

pub(in crate::adapters::loopback) const AUTHORIZATION_ENDPOINT: &str = "/api/workspace/files/write-binary";
const OPERATION_ID: &str = "files.writeBinary";
const MAX_CONTENT_BYTES: usize = 50 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = MAX_CONTENT_BYTES.div_ceil(3) * 4;

pub(crate) async fn handle(request: Request, dependencies: Dependencies) -> Response {
    if request.method() != "POST" || request.path() != AUTHORIZATION_ENDPOINT {
        return error(404, "Workspace write route is not available");
    }
    let Some(authorization) = request
        .headers()
        .iter()
        .find(|(name, _)| name == "authorization")
        .and_then(|(_, value)| value.strip_prefix("Bearer "))
    else {
        return error(401, "Workspace write authorization is invalid");
    };
    let request: WriteRequest = match serde_json::from_slice(&request.body) {
        Ok(request) => request,
        Err(_) => return error(400, "Workspace write request is invalid"),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    if dependencies
        .verifier
        .lock()
        .await
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            "workspace-files:write",
            OPERATION_ID,
            "workspace-write",
        )
        .is_err()
    {
        return error(401, "Workspace write authorization is invalid");
    }
    let Some((endpoint, selection, relative_path, content)) = request.into_write() else {
        return error(401, "Workspace write authorization is invalid");
    };
    let result = dependencies
        .workspace
        .write_binary(endpoint, selection, relative_path, content)
        .await
        .unwrap_or(Err(crate::WorkspaceWriteFailure::Unavailable));
    let delivery = map_outcome(result);
    Response::json(delivery.status_code(), delivery.body())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteRequest {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl WriteRequest {
    fn into_write(self) -> Option<(RuntimeEndpoint, WorkspaceFileSelection, String, Vec<u8>)> {
        if self.id != "workspace.file"
            || self.operation_id != OPERATION_ID
            || self.target.kind != "workspace-file"
            || !self.scope.matches_input(&self.input.endpoint, self.input.agent_id.as_deref(), self.input.team_id.as_deref(), self.input.run_id.as_deref())
            || !valid_relative_path(&self.input.relative_path)
            || self.input.data.len() > MAX_BASE64_BYTES
        {
            return None;
        }
        let endpoint = self.input.endpoint.runtime_endpoint()?;
        // STANDARD requires canonical padding and zero trailing bits; decode only once.
        let content = STANDARD.decode(&self.input.data).ok()?;
        if content.len() > MAX_CONTENT_BYTES {
            return None;
        }
        Some((
            endpoint,
            self.scope.selection(),
            self.input.relative_path,
            content,
        ))
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    endpoint: Endpoint,
    #[serde(default, deserialize_with = "optional_value")]
    agent_id: Option<String>,
    #[serde(default, deserialize_with = "optional_value")]
    team_id: Option<String>,
    #[serde(default, deserialize_with = "optional_value")]
    run_id: Option<String>,
    relative_path: String,
    data: String,
}

fn error(status: u16, message: &'static str) -> Response {
    Response::json(
        status,
        serde_json::json!({ "success": false, "error": message }),
    )
}
