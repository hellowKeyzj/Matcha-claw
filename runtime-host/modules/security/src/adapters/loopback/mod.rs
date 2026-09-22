use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use tokio::sync::Mutex;

use crate::api::SecurityHandle;

pub mod emergency;
pub mod policy;

const SHORT_DEADLINE: Duration = Duration::from_secs(5);
const SECURITY_POLICY_REQUEST_BYTES: usize = 72 * 1024;

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    security: SecurityHandle,
}

impl Dependencies {
    pub fn new(verifier: Arc<Mutex<CapabilityDecisionVerifier>>, security: SecurityHandle) -> Self {
        Self { verifier, security }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("security"),
        vec![RouteDescriptor::bound(
            "security.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    if path == "/api/security/emergency" {
        return Some(RouteHeadPlan::new(
            body_policy_for_method(head.method.as_str(), 2),
            SHORT_DEADLINE,
            timeout_response,
        ));
    }
    if is_security_policy_post_route(path) {
        return Some(RouteHeadPlan::new(
            body_policy_for_method(head.method.as_str(), SECURITY_POLICY_REQUEST_BYTES),
            SHORT_DEADLINE,
            timeout_response,
        ));
    }
    is_security_policy_route("GET", path).then(|| {
        RouteHeadPlan::new(
            body_policy_for_get_route(head.method.as_str()),
            SHORT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        let path = pathname(request.path());
        if request.method() == "POST" && path == "/api/security/emergency" {
            return emergency::handler::handle(
                request.method(),
                request.path(),
                request.headers(),
                &request.body,
                Arc::clone(&dependencies.verifier),
                dependencies.security,
            )
            .await
            .into();
        }
        let response = match policy::handler::handle_route(
            request.method(),
            request.path(),
            request
                .headers()
                .iter()
                .find(|(name, _)| name == "authorization")
                .map(|(_, value)| value.as_str()),
            request
                .headers()
                .iter()
                .find(|(name, _)| name == "x-matchaclaw-trace-id")
                .map(|(_, value)| value.as_str()),
            &request.body,
            Arc::clone(&dependencies.verifier),
            dependencies.security,
        )
        .await
        {
            Ok(response) => response,
            Err(_) => Response::error(503, "Security policy is unavailable"),
        };
        response.into()
    })
}

fn is_security_policy_route(method: &str, path: &str) -> bool {
    let path = pathname(path);
    matches!(
        (method, path),
        ("GET", "/api/security/policy/current")
            | ("GET", "/api/security/audit/current")
            | ("GET", "/api/security/audit")
            | ("GET", "/api/security/destructive-rule-catalog/current")
            | ("POST", "/api/security/operation")
            | ("POST", "/api/security/policy")
    )
}

fn is_security_policy_post_route(path: &str) -> bool {
    matches!(path, "/api/security/operation" | "/api/security/policy")
}

fn body_policy_for_method(method: &str, max_bytes: usize) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else {
        BodyPolicy::Required { max_bytes }
    }
}

fn body_policy_for_get_route(method: &str) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else {
        BodyPolicy::Optional { max_bytes: 0 }
    }
}

fn timeout_response() -> Response {
    Response::error(503, "Runtime Host request deadline exceeded")
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(pathname, _)| pathname)
}
