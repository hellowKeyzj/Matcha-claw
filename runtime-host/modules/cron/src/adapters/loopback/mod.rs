use std::sync::Arc;

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor, RouteFuture,
        RouteHeadPlan, RoutePath,
    },
};
use tokio::sync::Mutex;

use crate::api::CronHandle;

pub mod handler;
pub mod wire;

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    cron: CronHandle,
}

impl Dependencies {
    pub fn new(verifier: Arc<Mutex<CapabilityDecisionVerifier>>, cron: CronHandle) -> Self {
        Self { verifier, cron }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("cron"),
        vec![RouteDescriptor::bound(
            "cron.loopback",
            &[
                RoutePath::ExactWithQuery(wire::LIST_PATH),
                RoutePath::ExactWithQuery(wire::CREATE_PATH),
                RoutePath::ExactWithQuery(wire::UPDATE_PATH),
                RoutePath::ExactWithQuery(wire::DELETE_PATH),
                RoutePath::ExactWithQuery(wire::TOGGLE_PATH),
                RoutePath::ExactWithQuery(wire::TRIGGER_PATH),
                RoutePath::ExactWithQuery(wire::SESSION_HISTORY_PATH),
                RoutePath::ExactWithQuery(wire::RESULT_PATH),
            ],
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    handler::loopback_body_policy(head).map(|body_policy| {
        RouteHeadPlan::new(
            body_policy,
            handler::loopback_deadline(),
            handler::loopback_timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        handler::handle_loopback(request, dependencies.verifier, dependencies.cron)
            .await
            .unwrap_or_else(Response::not_found)
            .into()
    })
}
