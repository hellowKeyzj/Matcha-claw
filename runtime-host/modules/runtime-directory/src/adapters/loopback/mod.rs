use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use tokio::sync::Mutex;

use crate::{RuntimeEndpointDirectorySource, projection::Delivery};

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);
const RUNTIME_DIRECTORY_ENDPOINT: &str = "/api/runtime-endpoints/list";
const RUNTIME_DIRECTORY_SCOPE: &str = "runtime:endpoints:read";
const RUNTIME_DIRECTORY_CAPABILITY: &str = "runtime.endpoints.directory";
const RUNTIME_DIRECTORY_SUBJECT: &str = "runtime-endpoint-directory";

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    directory: Arc<dyn RuntimeEndpointDirectorySource>,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        directory: Arc<dyn RuntimeEndpointDirectorySource>,
    ) -> Self {
        Self {
            verifier,
            directory,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("runtime-directory"),
        vec![RouteDescriptor::bound(
            "runtime-directory.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    (pathname(&head.path) == RUNTIME_DIRECTORY_ENDPOINT).then(|| {
        RouteHeadPlan::new(
            body_policy_for_get_route(head.method.as_str()),
            DEFAULT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        if request.method() != "GET" || pathname(request.path()) != RUNTIME_DIRECTORY_ENDPOINT {
            return Response::not_found().into();
        }
        handle_runtime_endpoints(&request, dependencies)
            .await
            .into()
    })
}

async fn handle_runtime_endpoints(request: &Request, dependencies: Dependencies) -> Response {
    let Some(authorization) = request.bearer_authorization() else {
        return runtime_endpoints_unauthorized();
    };
    let mut verifier = dependencies.verifier.lock().await;
    if verifier
        .verify(
            authorization,
            now_millis(),
            RUNTIME_DIRECTORY_ENDPOINT,
            RUNTIME_DIRECTORY_SCOPE,
            RUNTIME_DIRECTORY_CAPABILITY,
            RUNTIME_DIRECTORY_SUBJECT,
        )
        .is_err()
    {
        return runtime_endpoints_unauthorized();
    }
    drop(verifier);

    let directory = match dependencies.directory.runtime_endpoint_directory().await {
        Ok(directory) => directory,
        Err(_) => return runtime_endpoints_unavailable(),
    };
    Response::json(200, Delivery::Ok(directory).body())
}

fn body_policy_for_get_route(method: &str) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
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

fn runtime_endpoints_unauthorized() -> Response {
    Response::error(401, "Runtime endpoint directory authorization is invalid")
}

fn runtime_endpoints_unavailable() -> Response {
    Response::error(503, "Runtime endpoint directory is unavailable")
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
