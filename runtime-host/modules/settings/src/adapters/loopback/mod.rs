use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use tokio::sync::Mutex;

use crate::api::SettingsHandle;

pub mod desired;

const SHORT_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    settings: SettingsHandle,
}

impl Dependencies {
    pub fn new(verifier: Arc<Mutex<CapabilityDecisionVerifier>>, settings: SettingsHandle) -> Self {
        Self { verifier, settings }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("settings"),
        vec![RouteDescriptor::bound(
            "settings.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    let body_policy = match path {
        "/api/settings/current" => body_policy_for_get_route(head.method.as_str()),
        "/api/settings/desired" => body_policy_for_method(head.method.as_str(), 16 * 1024),
        _ => return None,
    };
    Some(RouteHeadPlan::new(
        body_policy,
        SHORT_DEADLINE,
        timeout_response,
    ))
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        desired::handler::handle_route(
            request.method(),
            request.path(),
            request
                .headers()
                .iter()
                .find(|(name, _)| name == "authorization")
                .map(|(_, value)| value.as_str()),
            &request.body,
            Arc::clone(&dependencies.verifier),
            dependencies.settings,
        )
        .await
        .into()
    })
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
