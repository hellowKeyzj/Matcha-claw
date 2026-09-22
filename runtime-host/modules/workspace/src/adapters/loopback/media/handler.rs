use platform::loopback::{Request, Response as LoopbackResponse};

use serde_json::Value;

use crate::WorkspaceMediaPath;

use super::{
    WorkspaceMediaDelivery, WorkspaceMediaRequest, map_prepare, map_resolve, map_stage_buffer,
    map_stage_paths, map_thumbnail, map_thumbnails,
};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    request: Request,
    dependencies: super::super::Dependencies,
) -> LoopbackResponse {
    handle_request(request, dependencies).await.into_loopback()
}

async fn handle_request(request: Request, dependencies: super::super::Dependencies) -> Response {
    if request.method() != "POST" || request.path() != "/api/workspace/media" {
        return Response::not_found();
    }
    let Some(authorization) = request
        .headers()
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
    let mut verifier = dependencies.verifier.lock().await;
    let request =
        match WorkspaceMediaRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(_) => return Response::unauthorized(),
        };
    drop(verifier);
    let delivery = if request.is_prepare() {
        let result = dependencies
            .workspace
            .prepare_media(
                request.endpoint(),
                request.session_key().to_owned(),
                request.relative_path().to_owned(),
                request.mime_type().to_owned(),
            )
            .await
            .unwrap_or(Err(crate::WorkspaceMediaFailure::Unavailable));
        map_prepare(result)
    } else if request.is_resolve() {
        let result = dependencies
            .workspace
            .resolve_media(
                request.endpoint(),
                request.session_key().to_owned(),
                request.reference().to_owned(),
            )
            .await
            .unwrap_or(Err(crate::WorkspaceMediaFailure::Unavailable));
        map_resolve(result)
    } else if request.is_thumbnail() {
        let result = if request.gateway_url().is_empty() {
            dependencies
                .workspace
                .thumbnail_media(
                    request.endpoint(),
                    request.session_key().to_owned(),
                    request.relative_path().to_owned(),
                    request.mime_type().to_owned(),
                )
                .await
        } else {
            dependencies
                .workspace
                .thumbnail_media_gateway(
                    request.endpoint(),
                    request.session_key().to_owned(),
                    request.gateway_url().to_owned(),
                    request.mime_type().to_owned(),
                    request.agent_id().to_owned(),
                )
                .await
        }
        .unwrap_or(Err(crate::WorkspaceMediaFailure::Unavailable));
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
            dependencies
                .workspace
                .thumbnails_media(request.endpoint(), request.session_key().to_owned(), paths)
                .await
                .unwrap_or(Err(crate::WorkspaceMediaFailure::Unavailable)),
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
            dependencies
                .workspace
                .stage_paths_media(request.endpoint(), request.session_key().to_owned(), paths)
                .await
                .unwrap_or(Err(crate::WorkspaceMediaFailure::Unavailable)),
        )
    } else if request.is_stage_buffer() {
        map_stage_buffer(
            dependencies
                .workspace
                .stage_buffer_media(
                    request.endpoint(),
                    request.session_key().to_owned(),
                    request.base64().to_owned(),
                    request.file_name().to_owned(),
                    request.mime_type().to_owned(),
                )
                .await
                .unwrap_or(Err(crate::WorkspaceMediaFailure::Unavailable)),
        )
    } else {
        WorkspaceMediaDelivery::Unavailable
    };
    Response::from_delivery(delivery)
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

    fn into_loopback(self) -> LoopbackResponse {
        LoopbackResponse::json(self.status, self.body)
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
