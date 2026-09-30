use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use serde_json::json;
use tokio::sync::Mutex;

use crate::{ToolchainModule, control::ToolchainControlOutcome};

const STATUS_ENDPOINT: &str = "/api/toolchain/status";
const PREPARE_ENDPOINT: &str = "/api/toolchain/prepare";
const STATUS_SCOPE: &str = "toolchain:read";
const STATUS_CAPABILITY: &str = "toolchain.status";
const STATUS_SUBJECT: &str = "toolchain-status";
const PREPARE_SCOPE: &str = "toolchain:write";
const PREPARE_CAPABILITY: &str = "toolchain.prepare";
const PREPARE_SUBJECT: &str = "toolchain-prepare";
const DEFAULT_DEADLINE: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    toolchain: ToolchainModule,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        toolchain: ToolchainModule,
    ) -> Self {
        Self {
            verifier,
            toolchain,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("toolchain"),
        vec![RouteDescriptor::bound(
            "toolchain.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    matches!(pathname(&head.path), STATUS_ENDPOINT | PREPARE_ENDPOINT)
        .then(|| RouteHeadPlan::new(BodyPolicy::Empty, DEFAULT_DEADLINE, timeout_response))
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        match (request.method(), pathname(request.path())) {
            ("GET", STATUS_ENDPOINT) => status(request, dependencies).await,
            ("POST", PREPARE_ENDPOINT) => prepare(request, dependencies).await,
            _ => Response::not_found(),
        }
        .into()
    })
}

async fn status(request: Request, dependencies: Dependencies) -> Response {
    if !authorized(
        &request,
        dependencies.verifier,
        STATUS_ENDPOINT,
        STATUS_SCOPE,
        STATUS_CAPABILITY,
        STATUS_SUBJECT,
    )
    .await
    {
        return unauthorized();
    }

    let status = match dependencies.toolchain.status().await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) | Err(_) => return unavailable(),
    };
    match crate::control::project_status(status) {
        ToolchainControlOutcome::Status(status) => Response::json(200, json!(status)),
        ToolchainControlOutcome::Prepare(_) | ToolchainControlOutcome::Unavailable => unavailable(),
    }
}

async fn prepare(request: Request, dependencies: Dependencies) -> Response {
    if !authorized(
        &request,
        dependencies.verifier,
        PREPARE_ENDPOINT,
        PREPARE_SCOPE,
        PREPARE_CAPABILITY,
        PREPARE_SUBJECT,
    )
    .await
    {
        return unauthorized();
    }

    match dependencies.toolchain.admit_prepare().await {
        Ok(receipt) => Response::json(202, json!(receipt)),
        Err(()) => unavailable(),
    }
}

async fn authorized(
    request: &Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    endpoint: &'static str,
    scope: &'static str,
    capability: &'static str,
    subject: &'static str,
) -> bool {
    let Some(authorization) = request.bearer_authorization() else {
        return false;
    };
    verifier
        .lock()
        .await
        .verify(
            authorization,
            now_millis(),
            endpoint,
            scope,
            capability,
            subject,
        )
        .is_ok()
}

fn timeout_response() -> Response {
    Response::error(503, "Runtime Host request deadline exceeded")
}

fn unauthorized() -> Response {
    Response::error(401, "Toolchain authorization is invalid")
}

fn unavailable() -> Response {
    Response::error(503, "Toolchain is unavailable")
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
