use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    endpoint::runtime_address::RuntimeEndpoint,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan, RoutePath,
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

const TINY_REQUEST_BYTES: usize = 1024;
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
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        channel: ChannelHandle,
    ) -> Self {
        Self {
            verifier,
            channel,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("channel"),
        vec![RouteDescriptor::bound(
            "channel.loopback",
            &[
                RoutePath::ExactWithQuery(status::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(pairing::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(catalog::CATALOG_ENDPOINT),
                RoutePath::ExactWithQuery(catalog::CONFIG_ENDPOINT),
                RoutePath::ExactWithQuery(config_read::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(credentials::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(control::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(login::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(delete::AUTHORIZATION_ENDPOINT),
            ],
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
        let plan = if head.method == "POST"
            && matches!(path, catalog::CONFIG_ENDPOINT | delete::AUTHORIZATION_ENDPOINT)
        {
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
        if !request_body_within_limit(
            request.headers(),
            &request.body,
            body_limit(pathname(request.path())),
        ) {
            return Response::json(
                400,
                serde_json::json!({"success":false,"error":"Channel request is invalid"}),
            ).into();
        }
        let mut body = match serde_json::from_slice::<serde_json::Value>(&request.body) {
            Ok(body) => body,
            Err(_) => return Response::json(
                400,
                serde_json::json!({"success":false,"error":"Channel request is invalid"}),
            ).into(),
        };
        let endpoint = match take_endpoint(&mut body) {
            Ok(endpoint) => endpoint,
            Err(()) => return Response::json(
                400,
                serde_json::json!({"success":false,"error":"Channel runtime scope is invalid"}),
            ).into(),
        };
        let body = serde_json::to_vec(&body).expect("JSON value serializes");
        let mut headers = request.headers().to_vec();
        headers.retain(|(name, _)| name != "content-length");
        headers.push(("content-length".into(), body.len().to_string()));
        let dependencies = Dependencies {
            channel: dependencies.channel.with_endpoint(endpoint.clone()),
            verifier: dependencies.verifier,
        };
        let response = match pathname(request.path()) {
            status::AUTHORIZATION_ENDPOINT => {
                status::handler::handle(
                    request.method(),
                    request.path(),
                    &headers,
                    &body,
                    Arc::clone(&dependencies.verifier),
                    dependencies.channel,
                    endpoint.clone(),
                )
                .await
            }
            pairing::AUTHORIZATION_ENDPOINT => {
                pairing::handler::handle(
                    request.method(),
                    request.path(),
                    &headers,
                    &body,
                    Arc::clone(&dependencies.verifier),
                    dependencies.channel,
                    endpoint.clone(),
                )
                .await
            }
            catalog::CATALOG_ENDPOINT
            | catalog::CONFIG_ENDPOINT
            | config_read::AUTHORIZATION_ENDPOINT
            | credentials::AUTHORIZATION_ENDPOINT => {
                catalog::handler::handle(
                    request.method(),
                    request.path(),
                    &headers,
                    &body,
                    Arc::clone(&dependencies.verifier),
                    dependencies.channel,
                    endpoint.clone(),
                )
                .await
            }
            control::AUTHORIZATION_ENDPOINT | login::AUTHORIZATION_ENDPOINT | delete::AUTHORIZATION_ENDPOINT => {
                control::handler::handle(
                    request.method(),
                    request.path(),
                    &headers,
                    &body,
                    Arc::clone(&dependencies.verifier),
                    dependencies.channel,
                    endpoint.clone(),
                )
                .await
            }
            _ => Response::not_found(),
        };
        response.into()
    })
}

fn take_endpoint(body: &mut serde_json::Value) -> Result<RuntimeEndpoint, ()> {
    let body = body.as_object_mut().ok_or(())?;
    let Some(scope) = body.remove("scope") else {
        // This unscoped API is the existing OpenClaw route, never implicit peer selection.
        return RuntimeEndpoint::try_new("openclaw", "local").map_err(|_| ());
    };
    let scope = scope.as_object().ok_or(())?;
    if scope.len() != 2
        || scope.get("kind").and_then(serde_json::Value::as_str) != Some("runtime-instance")
    {
        return Err(());
    }
    let endpoint = scope
        .get("endpoint")
        .and_then(serde_json::Value::as_object)
        .ok_or(())?;
    if endpoint.len() != 3
        || endpoint.get("kind").and_then(serde_json::Value::as_str) != Some("native-runtime")
    {
        return Err(());
    }
    let adapter = endpoint.get("runtimeAdapterId").and_then(serde_json::Value::as_str).ok_or(())?;
    let instance = endpoint.get("runtimeInstanceId").and_then(serde_json::Value::as_str).ok_or(())?;
    RuntimeEndpoint::try_new(adapter, instance).map_err(|_| ())
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
        status::AUTHORIZATION_ENDPOINT
            | pairing::AUTHORIZATION_ENDPOINT
            | catalog::CATALOG_ENDPOINT
            | catalog::CONFIG_ENDPOINT
            | config_read::AUTHORIZATION_ENDPOINT
            | credentials::AUTHORIZATION_ENDPOINT
            | control::AUTHORIZATION_ENDPOINT
            | login::AUTHORIZATION_ENDPOINT
            | delete::AUTHORIZATION_ENDPOINT
    )
}

fn body_limit(path: &str) -> usize {
    match path {
        status::AUTHORIZATION_ENDPOINT | pairing::AUTHORIZATION_ENDPOINT => TINY_REQUEST_BYTES,
        control::AUTHORIZATION_ENDPOINT | login::AUTHORIZATION_ENDPOINT | delete::AUTHORIZATION_ENDPOINT => {
            CONTROL_REQUEST_BYTES
        }
        credentials::AUTHORIZATION_ENDPOINT => CREDENTIALS_REQUEST_BYTES,
        _ => CATALOG_REQUEST_BYTES,
    }
}

fn deadline(path: &str) -> Duration {
    if path == login::AUTHORIZATION_ENDPOINT {
        LOGIN_DEADLINE
    } else {
        SHORT_DEADLINE
    }
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}
