use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    facade::TaskManagerHandle, transport::common::authorization::CapabilityDecisionVerifier,
};

use super::{
    CREATE_PATH, DecodeError, Delivery, GET_PATH, LIST_PATH, TODOS_GET_PATH, TODOS_WRITE_PATH,
    TaskRequest, UPDATE_PATH,
};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle_localhost(
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    task_manager_handle: TaskManagerHandle,
) -> crate::transport::localhost::Response {
    self::handle(
        Request {
            method,
            path,
            headers,
            body,
        },
        verifier,
        task_manager_handle,
    )
    .await
    .into_localhost()
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: TaskManagerHandle,
) -> Response {
    if !accepts_route(&request.method, &request.path) {
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
    let request = match TaskRequest::decode(
        &request.path,
        value,
        authorization,
        &mut verifier,
        now_millis(),
    ) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    match handle.task_manager(request.into_command()).await {
        Ok(outcome) => Response::from_delivery(Delivery::from_outcome(outcome)),
        Err(_) => Response::from_delivery(Delivery::unavailable()),
    }
}

pub(crate) fn accepts_route(method: &str, path: &str) -> bool {
    method == "POST"
        && matches!(
            path,
            LIST_PATH | GET_PATH | CREATE_PATH | UPDATE_PATH | TODOS_GET_PATH | TODOS_WRITE_PATH
        )
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
        Self::fixed(400, "Task manager request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Task manager authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Task manager route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status(),
            body: delivery.body().clone(),
        }
    }

    fn into_localhost(self) -> crate::transport::localhost::Response {
        crate::transport::localhost::Response::json(self.status, self.body)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_fixed_post_routes() {
        for path in [
            LIST_PATH,
            GET_PATH,
            CREATE_PATH,
            UPDATE_PATH,
            TODOS_GET_PATH,
            TODOS_WRITE_PATH,
        ] {
            assert!(accepts_route("POST", path));
        }
        assert!(!accepts_route("GET", LIST_PATH));
        assert!(!accepts_route("POST", "/api/tasks/unknown"));
    }

    #[test]
    fn response_errors_are_closed() {
        assert_eq!(Response::bad_request().status, 400);
        assert_eq!(Response::unauthorized().status, 401);
        assert_eq!(Response::not_found().status, 404);
    }
}
