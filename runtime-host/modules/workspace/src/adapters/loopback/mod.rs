use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use tokio::sync::Mutex;

use crate::api::WorkspaceHandle;

pub(crate) mod binary;
pub(crate) mod directory;
pub(crate) mod media;
pub(crate) mod text;
pub(crate) mod write;

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const WORKSPACE_WRITE_REQUEST_BYTES: usize = 2 * 1024 * 1024 + 16 * 1024;
const WORKSPACE_MEDIA_REQUEST_BYTES: usize = 70 * 1024 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Dependencies {
    pub(crate) verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    pub(crate) workspace: WorkspaceHandle,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        workspace: WorkspaceHandle,
    ) -> Self {
        Self {
            verifier,
            workspace,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("workspace"),
        vec![RouteDescriptor::bound(
            "workspace.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    let max_bytes = match path {
        "/api/workspace/files/write-text" => WORKSPACE_WRITE_REQUEST_BYTES,
        "/api/workspace/media" => WORKSPACE_MEDIA_REQUEST_BYTES,
        "/api/workspace/files/read-text"
        | "/api/workspace/files/binary"
        | "/api/workspace/files/list-dir" => DEFAULT_REQUEST_BYTES,
        _ => return None,
    };
    Some(RouteHeadPlan::new(
        body_policy_for_method(head.method.as_str(), max_bytes),
        DEFAULT_DEADLINE,
        timeout_response,
    ))
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        (match pathname(request.path()) {
            "/api/workspace/files/read-text" => text::handler::handle(request, dependencies).await,
            "/api/workspace/files/binary" => binary::handler::handle(request, dependencies).await,
            "/api/workspace/files/list-dir" => {
                directory::handler::handle(request, dependencies).await
            }
            "/api/workspace/files/write-text" => {
                write::handler::handle(request, dependencies).await
            }
            "/api/workspace/media" => media::handler::handle(request, dependencies).await,
            _ => Response::not_found(),
        })
        .into()
    })
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
