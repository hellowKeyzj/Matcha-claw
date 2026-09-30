use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use tokio::sync::Mutex;

use crate::ProviderHandle;

mod accounts;
mod models;
mod routing;

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const SHORT_DEADLINE: Duration = Duration::from_secs(5);
const TIMEOUT_ERROR: &str = "Runtime Host request deadline exceeded";

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
}

impl Dependencies {
    pub fn new(verifier: Arc<Mutex<CapabilityDecisionVerifier>>, provider: ProviderHandle) -> Self {
        Self { verifier, provider }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("provider"),
        vec![RouteDescriptor::bound(
            "provider.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    is_route(path).then(|| {
        let plan = if head.method == "POST" && post_body_required(path) {
            RouteHeadPlan::body_deadline
        } else {
            RouteHeadPlan::new
        };
        plan(
            body_policy_for_method(head.method.as_str(), path),
            SHORT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        match pathname(request.path()) {
            path if path == accounts::ENDPOINT || path.starts_with(accounts::ACCOUNT_PREFIX) => {
                accounts::handle(request, dependencies.verifier, dependencies.provider).await
            }
            models::ENDPOINT | models::SELECTABLE_ENDPOINT | models::DISCOVERY_RESULT_ENDPOINT => {
                models::handle(request, dependencies.verifier, dependencies.provider).await
            }
            routing::ENDPOINT => {
                routing::handle(request, dependencies.verifier, dependencies.provider).await
            }
            _ => Response::not_found(),
        }
        .into()
    })
}

fn body_policy_for_method(method: &str, path: &str) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else if method == "POST" && post_body_required(path) {
        BodyPolicy::Required {
            max_bytes: DEFAULT_REQUEST_BYTES,
        }
    } else {
        BodyPolicy::Optional {
            max_bytes: DEFAULT_REQUEST_BYTES,
        }
    }
}

fn post_body_required(path: &str) -> bool {
    matches!(
        path,
        accounts::ENDPOINT | models::ENDPOINT | routing::ENDPOINT
    )
}

fn timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": TIMEOUT_ERROR }),
    )
}

fn is_route(path: &str) -> bool {
    path == accounts::ENDPOINT
        || path.starts_with(accounts::ACCOUNT_PREFIX)
        || path == models::ENDPOINT
        || path == models::SELECTABLE_ENDPOINT
        || path == models::DISCOVERY_RESULT_ENDPOINT
        || path == routing::ENDPOINT
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
