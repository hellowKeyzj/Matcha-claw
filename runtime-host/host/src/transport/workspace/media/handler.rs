use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    facade::WorkspaceHandle,
    runtime::driver::WorkspaceMediaPath,
    transport::{common::authorization::CapabilityDecisionVerifier, localhost},
};

use super::{
    WorkspaceMediaDelivery, WorkspaceMediaRequest, map_prepare, map_resolve, map_stage_buffer,
    map_stage_paths, map_thumbnail, map_thumbnails,
};

const MAX_STAGE_BUFFER_REQUEST_BYTES: usize = 70 * 1024 * 1024;
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    workspace: WorkspaceHandle,
) -> localhost::Response {
    let response = if body.len() > MAX_STAGE_BUFFER_REQUEST_BYTES {
        Response::bad_request()
    } else {
        handle_request(
            Request {
                method: method.to_owned(),
                path: path.to_owned(),
                headers: headers.to_vec(),
                body: body.to_vec(),
            },
            verifier,
            workspace,
        )
        .await
    };
    response.into_localhost()
}

async fn handle_request(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    workspace: WorkspaceHandle,
) -> Response {
    if request.method != "POST" || request.path != "/api/workspace/media" {
        return Response::not_found();
    }
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request =
        match WorkspaceMediaRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(_) => return Response::unauthorized(),
        };
    drop(verifier);
    let delivery = if request.is_prepare() {
        let result = workspace
            .prepare_media(
                request.session_key(),
                request.relative_path(),
                request.mime_type(),
            )
            .map_err(crate::WorkspaceMediaError::from);
        map_prepare(result)
    } else if request.is_resolve() {
        let result = workspace
            .resolve_media(request.session_key(), request.reference())
            .map_err(crate::WorkspaceMediaError::from);
        map_resolve(result)
    } else if request.is_thumbnail() {
        let result = if request.gateway_url().is_empty() {
            workspace
                .thumbnail_media(
                    request.session_key(),
                    request.relative_path(),
                    request.mime_type(),
                )
                .map_err(crate::WorkspaceMediaError::from)
        } else {
            workspace
                .thumbnail_media_gateway(
                    request.session_key(),
                    request.gateway_url(),
                    request.mime_type(),
                    request.agent_id(),
                )
                .map_err(crate::WorkspaceMediaError::from)
        };
        map_thumbnail(result)
    } else if request.is_thumbnails() {
        let paths = request
            .paths()
            .iter()
            .map(|path| {
                if path.is_gateway() {
                    WorkspaceMediaPath::gateway(
                        path.key().to_owned(),
                        path.gateway_url().to_owned(),
                        path.mime_type().to_owned(),
                        path.agent_id().to_owned(),
                    )
                } else {
                    WorkspaceMediaPath::relative(
                        path.key().to_owned(),
                        path.relative_path().to_owned(),
                        path.mime_type().to_owned(),
                    )
                }
            })
            .collect::<Vec<_>>();
        map_thumbnails(
            workspace
                .thumbnails_media(request.session_key(), &paths)
                .map_err(crate::WorkspaceMediaError::from),
        )
    } else if request.is_stage_paths() {
        let paths = request
            .paths()
            .iter()
            .map(|path| {
                WorkspaceMediaPath::relative(
                    path.key().to_owned(),
                    path.relative_path().to_owned(),
                    path.mime_type().to_owned(),
                )
            })
            .collect::<Vec<_>>();
        map_stage_paths(
            workspace
                .stage_paths_media(request.session_key(), &paths)
                .map_err(crate::WorkspaceMediaError::from),
        )
    } else if request.is_stage_buffer() {
        map_stage_buffer(
            workspace
                .stage_buffer_media(
                    request.session_key(),
                    request.base64(),
                    request.file_name(),
                    request.mime_type(),
                )
                .map_err(crate::WorkspaceMediaError::from),
        )
    } else {
        WorkspaceMediaDelivery::Unavailable
    };
    Response::from_delivery(delivery)
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Workspace media request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Workspace media authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Workspace media route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: WorkspaceMediaDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn into_localhost(self) -> localhost::Response {
        localhost::Response::json(self.status, self.body)
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
