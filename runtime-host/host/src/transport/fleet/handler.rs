use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::{sync::Mutex, time::timeout};

use super::{DecodeError, Delivery, Request, read};
use crate::fleet::handle::FleetHandle;
use crate::transport::common::authorization::CapabilityDecisionVerifier;
use crate::transport::fleet::terminal_stream::ServerDependencies as TerminalServerDependencies;
use crate::transport::localhost;

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const REQUEST_READ_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) fn localhost_body_policy(
    head: &localhost::RequestHead,
) -> Option<localhost::BodyPolicy> {
    if is_terminal_route(&head.method, &head.path) {
        return Some(localhost::BodyPolicy::Empty);
    }
    if is_fleet_route(&head.method, &head.path)
        || head.path == "/api/remote-fleet/runtime-agent/ingress"
    {
        return Some(localhost::BodyPolicy::Required {
            max_bytes: MAX_REQUEST_BYTES,
        });
    }
    None
}

pub(crate) const fn localhost_deadline() -> Duration {
    REQUEST_READ_DEADLINE
}

pub(crate) fn localhost_timeout_response() -> localhost::Response {
    into_localhost_response(Response::bad_request())
}

pub(crate) async fn handle_localhost(
    request: localhost::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: FleetHandle,
    terminal: TerminalServerDependencies,
) -> Option<localhost::RouteOutcome> {
    if is_terminal_route(request.method(), request.path()) {
        let Some(key) = request
            .head
            .websocket_key
            .as_deref()
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
        else {
            return Some(localhost::RouteOutcome::Response(
                localhost::Response::json(
                    400,
                    serde_json::json!({"error":"invalid terminal websocket upgrade"}),
                ),
            ));
        };
        if !request.head.websocket || !request.body.is_empty() {
            return Some(localhost::RouteOutcome::Response(
                localhost::Response::json(
                    400,
                    serde_json::json!({"error":"invalid terminal websocket upgrade"}),
                ),
            ));
        }
        return Some(localhost::RouteOutcome::Upgrade(
            localhost::Upgrade::FleetTerminal {
                path: request.head.path,
                key,
                websocket: true,
                terminal,
            },
        ));
    }
    if !is_fleet_route(request.method(), request.path())
        && request.path() != "/api/remote-fleet/runtime-agent/ingress"
    {
        return None;
    }
    if request.body.len() > MAX_REQUEST_BYTES {
        return Some(localhost::RouteOutcome::Response(into_localhost_response(
            Response::bad_request(),
        )));
    }
    let response = match timeout(
        REQUEST_READ_DEADLINE,
        handle(
            HttpRequest {
                method: request.head.method,
                path: request.head.path,
                headers: request.head.headers,
                body: request.body,
            },
            verifier,
            owner,
        ),
    )
    .await
    {
        Ok(response) => response,
        Err(_) => Response::bad_request(),
    };
    Some(localhost::RouteOutcome::Response(into_localhost_response(
        response,
    )))
}

fn into_localhost_response(response: Response) -> localhost::Response {
    localhost::Response::json(response.status, response.body)
}

async fn handle(
    request: HttpRequest,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: FleetHandle,
) -> Response {
    if request.path == "/api/remote-fleet/runtime-agent/ingress" {
        return match super::runtime_agent_ingress::handle(
            &request.method,
            &request.path,
            &request.headers,
            &request.body,
            &owner,
        )
        .await
        {
            Some((status, body)) => Response { status, body },
            None => Response::not_found(),
        };
    }
    if !is_fleet_route(&request.method, &request.path) {
        return Response::not_found();
    }
    let Some(authorization) = bearer_authorization(&request.headers) else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let request = match Request::decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    Response::from_delivery(read(&owner, request).await)
}

struct HttpRequest {
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
        Self::fixed(400, "Fleet request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Fleet authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Fleet route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
}

fn is_fleet_route(method: &str, path: &str) -> bool {
    method == "POST" && path == "/api/fleet"
}

pub(super) fn is_terminal_route(method: &str, path: &str) -> bool {
    method == "GET"
        && (path == crate::transport::fleet::terminal_stream::TERMINAL_WEBSOCKET_PATH
            || path == crate::transport::fleet::terminal_stream::PRIVATE_TERMINAL_WEBSOCKET_PATH)
}

fn bearer_authorization(headers: &[(String, String)]) -> Option<&str> {
    headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
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
    fn route_and_authorization_are_exact() {
        assert!(is_fleet_route("POST", "/api/fleet"));
        assert!(!is_fleet_route("GET", "/api/fleet"));
        assert!(!is_fleet_route("POST", "/api/remote-fleet"));
        let headers = vec![("authorization".to_owned(), "Bearer decision".to_owned())];
        assert_eq!(bearer_authorization(&headers), Some("decision"));
        assert!(
            bearer_authorization(&[("authorization".to_owned(), "Basic x".to_owned())]).is_none()
        );
    }
}
