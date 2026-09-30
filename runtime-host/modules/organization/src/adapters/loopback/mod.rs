use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use tokio::sync::Mutex;

pub(crate) mod approvals;
pub(crate) mod decision;
pub(crate) mod graph;
pub(crate) mod lifecycle;
pub(crate) mod manual;
pub(crate) mod public;
pub(crate) mod role_sessions;
pub(crate) mod skill;
pub(crate) mod task_board;
pub(crate) mod team_runtime;
pub mod trigger;

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const TEAM_SMALL_REQUEST_BYTES: usize = 8 * 1024;
const TEAM_GRAPH_REQUEST_BYTES: usize = 256 * 1024;
const TEAM_MANUAL_REQUEST_BYTES: usize = 16 * 1024;
const TEAM_RUNTIME_REQUEST_BYTES: usize = 1024 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    organization: crate::OrganizationHandle,
    webhook_token: trigger::WebhookToken,
    role_session_identity: Arc<dyn crate::RoleSessionIdentityResolver>,
    call_workflows: Option<Arc<crate::call::CallWorkflows>>,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        organization: crate::OrganizationHandle,
        webhook_token: trigger::WebhookToken,
        role_session_identity: Arc<dyn crate::RoleSessionIdentityResolver>,
    ) -> Self {
        Self {
            verifier,
            organization,
            webhook_token,
            role_session_identity,
            call_workflows: None,
        }
    }

    pub(crate) fn with_call_workflows(mut self, workflows: Option<Arc<crate::call::CallWorkflows>>) -> Self {
        self.call_workflows = workflows;
        self
    }

    pub(crate) fn with_call(mut self, call: crate::call::CallScope) -> Self {
        self.organization = self.organization.with_call(call);
        self
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("organization"),
        vec![
            RouteDescriptor::bound("organization.loopback.team", head_plan, {
                let dependencies = dependencies.clone();
                move |request| route(dependencies.clone(), request)
            }),
            RouteDescriptor::bound(
                "organization.loopback.team-runtime",
                team_runtime_head_plan,
                move |request| team_runtime_route(dependencies.clone(), request),
            ),
        ],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    is_team_route(path).then(|| {
        RouteHeadPlan::new(
            body_policy_for_method(head.method.as_str(), team_body_limit(path)),
            DEFAULT_DEADLINE,
            timeout_response,
        )
    })
}

fn team_runtime_head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    (pathname(&head.path) == team_runtime::ROUTE).then(|| {
        RouteHeadPlan::new(
            body_policy_for_method(head.method.as_str(), TEAM_RUNTIME_REQUEST_BYTES),
            DEFAULT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(mut dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        match dependencies.call_workflows.take() {
            Some(workflows) => workflows.execute(dependencies, request, false).await.into(),
            None => dispatch_team(dependencies, request).await.into(),
        }
    })
}

pub(crate) async fn dispatch_team(dependencies: Dependencies, request: Request) -> Response {
        let method = request.method().to_owned();
        let path = request.path().to_owned();
        let pathname = pathname(request.path()).to_owned();
        let headers = request.headers().to_vec();
        let body = request.body;
        let response = match pathname.as_str() {
            "/api/team/public" => {
                public::handler::handle_loopback(
                    method,
                    path,
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.organization,
                )
                .await
            }
            "/api/team/role-sessions" => {
                role_sessions::handler::handle_loopback(
                    method,
                    path,
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.organization,
                    dependencies.role_session_identity,
                )
                .await
            }
            "/api/team/approvals" => {
                approvals::handler::handle_loopback(
                    method,
                    path,
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.organization,
                )
                .await
            }
            "/api/team/task-board" => {
                task_board::handler::handle_loopback(
                    method,
                    path,
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.organization,
                )
                .await
            }
            "/api/team/decision" => {
                decision::handler::handle_loopback(
                    method,
                    path,
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.organization,
                )
                .await
            }
            "/api/team/lifecycle" => {
                lifecycle::handler::handle_loopback(
                    method,
                    path,
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.organization,
                )
                .await
            }
            "/api/team/graph" => {
                graph::handler::handle_loopback(
                    method,
                    path,
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.organization,
                )
                .await
            }
            "/api/team/skill" => {
                skill::handler::handle_loopback(
                    method,
                    path,
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.organization,
                )
                .await
            }
            "/api/team/manual-materialize-and-create" => {
                manual::handler::handle_loopback(
                    method,
                    path,
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.organization,
                )
                .await
            }
            path if is_trigger_route(path) => {
                trigger::handler::handle_loopback(
                    method,
                    path.to_owned(),
                    headers,
                    body,
                    dependencies.verifier,
                    dependencies.webhook_token,
                    dependencies.organization,
                )
                .await
            }
            _ => Response::not_found(),
        };
        response
}

fn team_runtime_route(mut dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        match dependencies.call_workflows.take() {
            Some(workflows) => workflows.execute(dependencies, request, true).await.into(),
            None => dispatch_team_runtime(dependencies, request).await.into(),
        }
    })
}

pub(crate) async fn dispatch_team_runtime(dependencies: Dependencies, request: Request) -> Response {
        team_runtime::handle_loopback(
            request.method().to_owned(),
            pathname(request.path()).to_owned(),
            request.bearer_authorization().map(str::to_owned),
            request.body,
            dependencies.verifier,
            dependencies.organization,
            dependencies.role_session_identity,
        )
        .await
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

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn is_team_route(path: &str) -> bool {
    matches!(
        path,
        "/api/team/public"
            | "/api/team/role-sessions"
            | "/api/team/approvals"
            | "/api/team/task-board"
            | "/api/team/decision"
            | "/api/team/lifecycle"
            | "/api/team/graph"
            | "/api/team/skill"
            | "/api/team/manual-materialize-and-create"
    ) || is_trigger_route(path)
}

fn team_body_limit(path: &str) -> usize {
    if is_trigger_route(path) {
        trigger::handler::max_body_bytes(path)
    } else {
        match path {
            "/api/team/graph" => TEAM_GRAPH_REQUEST_BYTES,
            "/api/team/manual-materialize-and-create" => TEAM_MANUAL_REQUEST_BYTES,
            _ => TEAM_SMALL_REQUEST_BYTES,
        }
    }
}

fn is_trigger_route(path: &str) -> bool {
    matches!(path, "/api/team/trigger" | "/api/team/webhook-auth")
        || trigger::handler::is_webhook_route(path)
}

pub use role_sessions::role_session_json;
