use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use platform::loopback::{ModuleId, RouteDescriptor, RouteHeadPlan, RoutePath};
use tokio::sync::RwLock;

use super::{BodyPolicy, Request, RequestHead, Response, RouteOutcome};

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(crate) struct Router {
    routes: Arc<RwLock<RouteIndex>>,
}

#[derive(Default)]
struct RouteIndex {
    exact: HashMap<&'static str, Vec<Arc<RouteSlot>>>,
    exact_with_query: HashMap<&'static str, Vec<Arc<RouteSlot>>>,
    prefixes: Vec<(&'static str, Arc<RouteSlot>)>,
}

struct RouteSlot {
    ordinal: usize,
    module_id: ModuleId,
    descriptor: RouteDescriptor,
    active: AtomicBool,
}

pub(super) struct PreparedRoute {
    plan: RouteHeadPlan,
    selected: Option<Arc<RouteSlot>>,
}

impl PreparedRoute {
    pub(super) fn plan(&self) -> RouteHeadPlan {
        self.plan
    }

    pub(super) async fn dispatch(self, request: Request) -> RouteOutcome {
        match self.selected {
            // The single body-complete admission check does not revoke a started handler.
            Some(route) if route.active.load(Ordering::Acquire) => {
                route.descriptor.dispatch(request).await
            }
            _ => RouteOutcome::Response(Response::not_found()),
        }
    }
}

impl Router {
    pub(crate) fn new(routes: Vec<platform::loopback::ModuleDescriptor>) -> Self {
        routes.iter().for_each(validate_module_routes);
        let mut index = RouteIndex::default();
        for (ordinal, (module_id, route)) in routes
            .iter()
            .flat_map(|module| {
                module
                    .routes()
                    .iter()
                    .map(move |route| (module.id(), route))
            })
            .enumerate()
        {
            let slot = Arc::new(RouteSlot {
                ordinal,
                module_id,
                descriptor: route.clone(),
                active: AtomicBool::new(true),
            });
            for &path in route.paths() {
                match path {
                    RoutePath::Exact(path) => {
                        index.exact.entry(path).or_default().push(Arc::clone(&slot));
                    }
                    RoutePath::ExactWithQuery(path) => {
                        index
                            .exact_with_query
                            .entry(path)
                            .or_default()
                            .push(Arc::clone(&slot));
                    }
                    RoutePath::Prefix(prefix) => index.prefixes.push((prefix, Arc::clone(&slot))),
                }
            }
        }
        Self {
            routes: Arc::new(RwLock::new(index)),
        }
    }

    pub(crate) async fn unregister_route(&self, module_id: ModuleId, route_id: &'static str) {
        let mut index = self.routes.write().await;
        let retain_route = |route: &Arc<RouteSlot>| {
            if route.module_id == module_id && route.descriptor.id() == route_id {
                route.active.store(false, Ordering::Release);
                false
            } else {
                true
            }
        };
        let RouteIndex {
            exact,
            exact_with_query,
            prefixes,
        } = &mut *index;
        for paths in [exact, exact_with_query] {
            paths.retain(|_, routes| {
                routes.retain(&retain_route);
                !routes.is_empty()
            });
        }
        prefixes.retain(|(_, route)| retain_route(route));
    }

    pub(super) async fn resolve(&self, head: &RequestHead) -> PreparedRoute {
        let index = self.routes.read().await;
        let target = head.path.as_str();
        let pathname = target.split_once('?').map_or(target, |(path, _)| path);
        let selected = index
            .exact
            .get(target)
            .into_iter()
            .flatten()
            .chain(index.exact_with_query.get(pathname).into_iter().flatten())
            .chain(
                index
                    .prefixes
                    .iter()
                    .filter_map(|(prefix, route)| pathname.starts_with(*prefix).then_some(route)),
            )
            .filter_map(|route| route.descriptor.plan_head(head).map(|plan| (route, plan)))
            .min_by_key(|(route, _)| route.ordinal);
        match selected {
            Some((route, plan)) => PreparedRoute {
                plan,
                selected: Some(Arc::clone(route)),
            },
            None => PreparedRoute {
                plan: RouteHeadPlan::new(
                    BodyPolicy::Optional {
                        max_bytes: DEFAULT_REQUEST_BYTES,
                    },
                    DEFAULT_DEADLINE,
                    default_timeout_response,
                ),
                selected: None,
            },
        }
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
