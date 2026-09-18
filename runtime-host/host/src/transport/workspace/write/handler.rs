use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    facade::WorkspaceHandle,
    transport::{common::authorization::CapabilityDecisionVerifier, localhost},
};

use super::{WorkspaceWriteDelivery, WorkspaceWriteRequest, map_outcome};

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024 + 16 * 1024;
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
    let response = if body.len() > MAX_REQUEST_BYTES {
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
    if request.method != "POST" || request.path != "/api/workspace/files/write-text" {
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
        match WorkspaceWriteRequest::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request,
            Err(_) => return Response::unauthorized(),
        };
    drop(verifier);
    let result = workspace
        .write_text(
            request.session_key(),
            request.relative_path(),
            request.content(),
        )
        .map_err(crate::WorkspaceWriteError::from);
    Response::from_delivery(map_outcome(result))
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
        Self::fixed(400, "Workspace write request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Workspace write authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Workspace write route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: WorkspaceWriteDelivery) -> Self {
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
