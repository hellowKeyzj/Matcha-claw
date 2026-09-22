use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use tokio::sync::Mutex;

use crate::{PlatformToolsModule, delivery::Delivery};

const AUTHORIZATION_ENDPOINT: &str = "/api/platform/tools";
const AUTHORIZATION_SCOPE: &str = "platform:tools:read";
const CAPABILITY_ID: &str = "platform.tools.list";
const AUTHORIZATION_SUBJECT: &str = "platform-tools";
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    tools: PlatformToolsModule,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        tools: PlatformToolsModule,
    ) -> Self {
        Self { verifier, tools }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("platform-tools"),
        vec![RouteDescriptor::bound(
            "platform-tools.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    (head.method == "GET" && pathname(&head.path) == AUTHORIZATION_ENDPOINT)
        .then(|| RouteHeadPlan::new(BodyPolicy::Empty, DEFAULT_DEADLINE, timeout_response))
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        if request.method() != "GET" || pathname(request.path()) != AUTHORIZATION_ENDPOINT {
            return Response::not_found().into();
        }
        handle(dependencies, request).await.into()
    })
}

async fn handle(dependencies: Dependencies, request: Request) -> Response {
    let Some(authorization) = request.bearer_authorization() else {
        return unauthorized();
    };
    let mut verifier = dependencies.verifier.lock().await;
    if verifier
        .verify(
            authorization,
            now_millis(),
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            CAPABILITY_ID,
            AUTHORIZATION_SUBJECT,
        )
        .is_err()
    {
        return unauthorized();
    }
    drop(verifier);

    let delivery = Delivery::from(dependencies.tools.platform_tools().await);
    Response::json(delivery.status_code(), delivery.body())
}

fn unauthorized() -> Response {
    Response::error(401, "Platform tools authorization is invalid")
}

fn timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
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
