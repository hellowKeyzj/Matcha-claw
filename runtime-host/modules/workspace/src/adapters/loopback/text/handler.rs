use platform::loopback::{Request, Response as LoopbackResponse};

use serde_json::Value;

use super::{RequestError, WorkspaceTextDelivery, WorkspaceTextRequest, map_outcome};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    request: Request,
    dependencies: super::super::Dependencies,
) -> LoopbackResponse {
    handle_request(request, dependencies).await.into_loopback()
}

async fn handle_request(request: Request, dependencies: super::super::Dependencies) -> Response {
    if request.method() != "POST" || request.path() != "/api/workspace/files/read-text" {
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
        match WorkspaceTextRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(RequestError::InvalidPath) => {
                return Response::from_delivery(WorkspaceTextDelivery::InvalidPath);
            }
            Err(RequestError::Unauthorized | RequestError::Invalid) => {
                return Response::unauthorized();
            }
        };
    drop(verifier);
    let result = dependencies
        .workspace
        .read_text(
            request.endpoint(),
            request.session_key().to_owned(),
            request.relative_path().to_owned(),
            request.max_bytes(),
        )
        .await
        .unwrap_or(Err(crate::WorkspaceReadFailure::Unavailable));
    Response::from_delivery(map_outcome(result))
}

struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Workspace text request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Workspace text authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Workspace text route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: WorkspaceTextDelivery) -> Self {
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
