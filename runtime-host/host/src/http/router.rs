use std::time::Duration;

use super::{BodyPolicy, Request, RequestHead, Response, RouteOutcome};

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

pub(crate) struct RouterInput {
    pub(crate) routes: Vec<platform::loopback::ModuleDescriptor>,
}

#[derive(Clone)]
pub(crate) struct Router {
    routes: RouteRegistry,
}

impl Router {
    pub(crate) fn new(input: RouterInput) -> Self {
        Self {
            routes: RouteRegistry::new(input.routes),
        }
    }

    pub(crate) fn body_policy(&self, head: &RequestHead) -> BodyPolicy {
        self.routes.head_plan(head).map_or(
            BodyPolicy::Optional {
                max_bytes: DEFAULT_REQUEST_BYTES,
            },
            |plan| plan.body_policy(),
        )
    }

    pub(crate) fn deadline(&self, head: &RequestHead) -> platform::loopback::RouteDeadline {
        self.routes.head_plan(head).map_or(
            platform::loopback::RouteDeadline::Request(DEFAULT_DEADLINE),
            |plan| plan.deadline(),
        )
    }

    pub(crate) fn timeout_response(&self, head: Option<&RequestHead>) -> Response {
        head.and_then(|head| self.routes.head_plan(head))
            .map_or_else(default_timeout_response, |plan| plan.timeout_response())
    }

    pub(crate) async fn route(&self, request: Request) -> RouteOutcome {
        if let Some(outcome) = self.routes.route(request).await {
            return outcome;
        }
        RouteOutcome::Response(Response::not_found())
    }
}

#[derive(Clone)]
struct RouteRegistry {
    routes: Vec<platform::loopback::ModuleDescriptor>,
}

impl RouteRegistry {
    fn new(routes: Vec<platform::loopback::ModuleDescriptor>) -> Self {
        routes.iter().for_each(validate_module_routes);
        Self { routes }
    }

    fn head_plan(&self, head: &RequestHead) -> Option<platform::loopback::RouteHeadPlan> {
        self.routes.iter().find_map(|module| {
            module
                .routes()
                .iter()
                .find_map(|route| route.plan_head(head))
        })
    }

    async fn route(&self, request: Request) -> Option<RouteOutcome> {
        let module = self.routes.iter().find(|module| {
            module
                .routes()
                .iter()
                .any(|route| route.plan_head(&request.head).is_some())
        })?;
        let route = module
            .routes()
            .iter()
            .find(|route| route.plan_head(&request.head).is_some())?;
        Some(route.dispatch(request).await)
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
