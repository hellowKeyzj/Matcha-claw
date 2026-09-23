use std::{sync::Arc, time::Duration};

use tokio::sync::RwLock;

use super::{BodyPolicy, Request, RequestHead, Response, RouteOutcome};

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(crate) struct Router {
    routes: Arc<RwLock<Vec<platform::loopback::ModuleDescriptor>>>,
}

impl Router {
    pub(crate) fn new(routes: Vec<platform::loopback::ModuleDescriptor>) -> Self {
        routes.iter().for_each(validate_module_routes);
        Self {
            routes: Arc::new(RwLock::new(routes)),
        }
    }

    pub(crate) async fn unregister_route(
        &self,
        module_id: platform::loopback::ModuleId,
        route_id: &'static str,
    ) {
        let mut routes = self.routes.write().await;
        routes.iter_mut().for_each(|module| {
            if module.id() == module_id {
                module.unregister_route(route_id);
            }
        });
        routes.retain(|module| !module.routes().is_empty());
    }

    pub(crate) async fn body_policy(&self, head: &RequestHead) -> BodyPolicy {
        self.head_plan(head).await.map_or(
            BodyPolicy::Optional {
                max_bytes: DEFAULT_REQUEST_BYTES,
            },
            |plan| plan.body_policy(),
        )
    }

    pub(crate) async fn deadline(&self, head: &RequestHead) -> platform::loopback::RouteDeadline {
        self.head_plan(head).await.map_or(
            platform::loopback::RouteDeadline::Request(DEFAULT_DEADLINE),
            |plan| plan.deadline(),
        )
    }

    pub(crate) async fn timeout_response(&self, head: Option<&RequestHead>) -> Response {
        match head {
            Some(head) => self
                .head_plan(head)
                .await
                .map_or_else(default_timeout_response, |plan| plan.timeout_response()),
            None => default_timeout_response(),
        }
    }

    pub(crate) async fn route(&self, request: Request) -> RouteOutcome {
        let route = {
            let routes = self.routes.read().await;
            routes.iter().find_map(|module| {
                module
                    .routes()
                    .iter()
                    .find(|route| route.plan_head(&request.head).is_some())
                    .cloned()
            })
        };
        match route {
            Some(route) => route.dispatch(request).await,
            None => RouteOutcome::Response(Response::not_found()),
        }
    }

    async fn head_plan(&self, head: &RequestHead) -> Option<platform::loopback::RouteHeadPlan> {
        self.routes.read().await.iter().find_map(|module| {
            module
                .routes()
                .iter()
                .find_map(|route| route.plan_head(head))
        })
    }
}

fn validate_module_routes(module: &platform::loopback::ModuleDescriptor) {
    debug_assert!(!module.id().as_str().is_empty());
    debug_assert!(module.routes().iter().all(|route| !route.id().is_empty()));
}

fn default_timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}
