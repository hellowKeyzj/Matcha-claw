use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    endpoint::runtime_address::RuntimeEndpoint,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use tokio::sync::Mutex;

use crate::api::ChannelHandle;

pub mod catalog;
#[allow(dead_code)]
pub mod config_read;
pub mod control;
pub mod credentials;
pub mod delete;
pub mod login;
pub mod pairing;
pub mod status;

const TINY_REQUEST_BYTES: usize = 256;
const CONTROL_REQUEST_BYTES: usize = 20 * 1024;
const CATALOG_REQUEST_BYTES: usize = 64 * 1024;
const CREDENTIALS_REQUEST_BYTES: usize = 320 * 1024;
const SHORT_DEADLINE: Duration = Duration::from_secs(5);
const LOGIN_DEADLINE: Duration = Duration::from_secs(305);
const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    channel: ChannelHandle,
    endpoint: RuntimeEndpoint,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        channel: ChannelHandle,
        endpoint: RuntimeEndpoint,
    ) -> Self {
        Self {
            verifier,
            channel,
            endpoint,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("channel"),
        vec![RouteDescriptor::bound(
            "channel.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

pub fn request_body_within_limit(
    headers: &[(String, String)],
    body: &[u8],
    max_bytes: usize,
) -> bool {
    body_length(headers).is_some_and(|length| length == body.len() && length <= max_bytes)
}

pub fn required_request_body_within_limit(
    headers: &[(String, String)],
    body: &[u8],
    max_bytes: usize,
) -> bool {
    body_length(headers)
        .is_some_and(|length| length > 0 && length == body.len() && length <= max_bytes)
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    is_route(path).then(|| {
        let plan = if head.method == "POST" && path == "/api/channels/configure" {
            RouteHeadPlan::body_deadline
        } else {
            RouteHeadPlan::new
        };
        plan(
            body_policy_for_method(head.method.as_str(), body_limit(path)),
            deadline(path),
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        let response = match pathname(request.path()) {
            "/api/channels/status" => {
                status::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&dependencies.verifier),
                    dependencies.channel,
                    dependencies.endpoint,
                )
                .await
            }
            "/api/channels/pairing" => {
                pairing::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&dependencies.verifier),
                    dependencies.channel,
                    dependencies.endpoint,
                )
                .await
            }
            "/api/channels/catalog"
            | "/api/channels/configure"
            | "/api/channels/config/read"
            | "/api/channels/credentials/validate" => {
                catalog::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&dependencies.verifier),
                    dependencies.channel,
                    dependencies.endpoint,
                )
                .await
            }
            "/api/channels/control" | "/api/channels/login" | "/api/channels/delete-config" => {
                control::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&dependencies.verifier),
                    dependencies.channel,
                    dependencies.endpoint,
                )
                .await
            }
            _ => Response::not_found(),
        };
        response.into()
    })
}

fn body_length(headers: &[(String, String)]) -> Option<usize> {
    headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
}

fn body_policy_for_method(method: &str, max_bytes: usize) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else if method == "POST" {
        BodyPolicy::Required { max_bytes }
    } else {
        BodyPolicy::Optional {
            max_bytes: DEFAULT_REQUEST_BYTES,
        }
    }
}

fn timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}

fn is_route(path: &str) -> bool {
    matches!(
        path,
        "/api/channels/status"
            | "/api/channels/pairing"
            | "/api/channels/catalog"
            | "/api/channels/configure"
            | "/api/channels/config/read"
            | "/api/channels/credentials/validate"
            | "/api/channels/control"
            | "/api/channels/login"
            | "/api/channels/delete-config"
    )
}

fn body_limit(path: &str) -> usize {
    match path {
        "/api/channels/status" | "/api/channels/pairing" => TINY_REQUEST_BYTES,
        "/api/channels/control" | "/api/channels/login" | "/api/channels/delete-config" => {
            CONTROL_REQUEST_BYTES
        }
        "/api/channels/credentials/validate" => CREDENTIALS_REQUEST_BYTES,
        _ => CATALOG_REQUEST_BYTES,
    }
}

fn deadline(path: &str) -> Duration {
    if path == "/api/channels/login" {
        LOGIN_DEADLINE
    } else {
        SHORT_DEADLINE
    }
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}
