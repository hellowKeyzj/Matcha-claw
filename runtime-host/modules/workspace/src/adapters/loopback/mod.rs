use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan, RoutePath,
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
            &[
                RoutePath::ExactWithQuery(text::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(binary::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(directory::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(write::AUTHORIZATION_ENDPOINT),
                RoutePath::ExactWithQuery(media::AUTHORIZATION_ENDPOINT),
            ],
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    let max_bytes = match path {
        write::AUTHORIZATION_ENDPOINT => WORKSPACE_WRITE_REQUEST_BYTES,
        media::AUTHORIZATION_ENDPOINT => WORKSPACE_MEDIA_REQUEST_BYTES,
        text::AUTHORIZATION_ENDPOINT
        | binary::AUTHORIZATION_ENDPOINT
        | directory::AUTHORIZATION_ENDPOINT => DEFAULT_REQUEST_BYTES,
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
            text::AUTHORIZATION_ENDPOINT => text::handler::handle(request, dependencies).await,
            binary::AUTHORIZATION_ENDPOINT => binary::handler::handle(request, dependencies).await,
            directory::AUTHORIZATION_ENDPOINT => {
                directory::handler::handle(request, dependencies).await
            }
            write::AUTHORIZATION_ENDPOINT => {
                write::handler::handle(request, dependencies).await
            }
            media::AUTHORIZATION_ENDPOINT => media::handler::handle(request, dependencies).await,
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
