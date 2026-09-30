use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use platform::{
    call::{CallId, CallLogError, CallQuery},
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
    module::{CapabilityKey, EffectKind},
};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::CallLogModule;

const ROUTES: &[&str] = &["call-log.loopback"];
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("call-log.read")];
const EFFECTS: &[EffectKind] = &[
    EffectKind::Route,
    EffectKind::FilesystemWrite,
    EffectKind::OwnerTask,
];

pub(crate) fn descriptor(
    module: CallLogModule,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
) -> platform::module::ModuleDescriptor {
    let loopback = ModuleDescriptor::new(
        ModuleId::new("call-log"),
        vec![RouteDescriptor::bound(
            "call-log.loopback",
            head_plan,
            move |request| route(module.clone(), verifier.clone(), request),
        )],
    );
    platform::module::ModuleDescriptor::new(
        platform::module::ModuleId::new("call-log"),
        PROVIDES,
        &[],
        EFFECTS,
        ROUTES,
        &[],
        Some(loopback),
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    matches!(
        head.path.as_str(),
        "/api/calls/list" | "/api/calls/get" | "/api/calls/history"
    )
    .then(|| {
        RouteHeadPlan::new(
            BodyPolicy::Required { max_bytes: 4096 },
            Duration::from_secs(5),
            unavailable,
        )
    })
}

fn route(
    module: CallLogModule,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    request: Request,
) -> RouteFuture {
    Box::pin(async move {
        if request.method() != "POST" {
            return Response::not_found().into();
        }
        let Some(authorization) = request.bearer_authorization() else {
            return Response::error(401, "Call log authorization is invalid").into();
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        if verifier
            .lock()
            .await
            .verify(
                authorization,
                now,
                request.path(),
                "call-log:read",
                "call-log.read",
                "host-call-log",
            )
            .is_err()
        {
            return Response::error(401, "Call log authorization is invalid").into();
        }
        let result = query(&module, request.path(), &request.body).await;
        match result {
            Ok(body) => Response::json(200, body),
            Err(CallLogError::InvalidInput | CallLogError::InvalidTransition) => {
                Response::bad_request()
            }
            Err(CallLogError::NotFound) => Response::error(404, "Call record was not found"),
            Err(CallLogError::QueueFull) => Response::error(503, "Call log queue is full"),
            Err(CallLogError::Unavailable | CallLogError::PersistFailed) => unavailable(),
        }
        .into()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetRequest {
    call_id: CallId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryRequest {
    call_id: CallId,
    after_revision: Option<u64>,
    limit: u32,
}

async fn query(
    module: &CallLogModule,
    path: &str,
    body: &[u8],
) -> Result<serde_json::Value, CallLogError> {
    match path {
        "/api/calls/list" => {
            let query: CallQuery =
                serde_json::from_slice(body).map_err(|_| CallLogError::InvalidInput)?;
            serde_json::to_value(module.list(query).await?).map_err(|_| CallLogError::Unavailable)
        }
        "/api/calls/get" => {
            let query: GetRequest =
                serde_json::from_slice(body).map_err(|_| CallLogError::InvalidInput)?;
            serde_json::to_value(module.get(query.call_id).await?)
                .map_err(|_| CallLogError::Unavailable)
        }
        "/api/calls/history" => {
            let query: HistoryRequest =
                serde_json::from_slice(body).map_err(|_| CallLogError::InvalidInput)?;
            serde_json::to_value(
                module
                    .history(query.call_id, query.after_revision, query.limit)
                    .await?,
            )
            .map_err(|_| CallLogError::Unavailable)
        }
        _ => Err(CallLogError::InvalidInput),
    }
}

fn unavailable() -> Response {
    Response::error(503, "Call log is unavailable")
}
