use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteHeadPlan, RoutePath,
    },
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::{SearchConfig, SearchError, SearchModule, SearchVerifyRequest};

const PATHS: &[RoutePath] = &[
    RoutePath::Exact("/api/search"),
    RoutePath::Exact("/api/search/config"),
    RoutePath::Exact("/api/search/prepare"),
    RoutePath::Exact("/api/search/restart"),
    RoutePath::Exact("/api/search/verify"),
    RoutePath::Exact("/api/search/stop"),
    RoutePath::Exact("/api/search/logs"),
];

pub(crate) fn descriptor(
    search: SearchModule,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("search"),
        vec![RouteDescriptor::bound(
            "search.loopback",
            PATHS,
            head_plan,
            move |request| {
                let search = search.clone();
                let verifier = Arc::clone(&verifier);
                Box::pin(async move { route(search, verifier, request).await.into() })
            },
        )],
    )
}

fn operation(method: &str, path: &str) -> Option<&'static str> {
    match (method, path) {
        ("GET", "/api/search") => Some("read"),
        ("PUT", "/api/search/config") => Some("configure"),
        ("POST", "/api/search/prepare") => Some("prepare"),
        ("POST", "/api/search/restart") => Some("restart"),
        ("POST", "/api/search/verify") => Some("verify"),
        ("POST", "/api/search/stop") => Some("stop"),
        ("GET", "/api/search/logs") => Some("logs"),
        _ => None,
    }
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let operation = operation(&head.method, &head.path)?;
    let body = match operation {
        "read" | "logs" => BodyPolicy::Empty,
        "configure" | "verify" => BodyPolicy::Required {
            max_bytes: 1024 * 1024,
        },
        _ => BodyPolicy::Optional { max_bytes: 2 },
    };
    // Admitted commands continue in the owner if the caller disconnects; only an actual settled response is a success.
    Some(RouteHeadPlan::body_deadline(
        body,
        Duration::from_secs(10),
        timeout_response,
    ))
}

async fn route(
    search: SearchModule,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    request: Request,
) -> Response {
    let Some(operation) = operation(request.method(), request.path()) else {
        return Response::not_found();
    };
    let Some(token) = request.bearer_authorization() else {
        return unauthorized();
    };
    let capability = format!("search.{operation}");
    let is_read = matches!(operation, "read" | "logs");
    let decision = verifier.lock().await.verify(
        token,
        now_millis(),
        request.path(),
        if is_read {
            "search:read"
        } else {
            "search:write"
        },
        &capability,
        "network-search",
    );
    let Ok(decision) = decision else {
        return unauthorized();
    };
    if !is_read && decision.revision() != format!("{:x}", Sha256::digest(&request.body)) {
        return unauthorized();
    }
    match operation {
        "verify" => {
            let request = match serde_json::from_slice::<SearchVerifyRequest>(&request.body) {
                Ok(request) => request,
                Err(_) => return error(SearchError::invalid()),
            };
            respond(search.verify(request).await)
        }
        "logs" => match search.logs().await {
            Ok(lines) => Response::json(200, serde_json::json!({ "lines": lines })),
            Err(failure) => error(failure),
        },
        "configure" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Configure {
                expected_revision: u64,
                config: SearchConfig,
            }
            let input = match serde_json::from_slice::<Configure>(&request.body) {
                Ok(input) => input,
                Err(_) => return error(SearchError::invalid()),
            };
            respond(
                search
                    .replace_config(input.expected_revision, input.config)
                    .await,
            )
        }
        "read" => respond(search.snapshot().await),
        _ => {
            if !request.body.is_empty() && request.body != b"{}" {
                return error(SearchError::invalid());
            }
            let result = match operation {
                "prepare" => search.prepare().await,
                "restart" => search.restart().await,
                "stop" => search.stop().await,
                _ => return Response::not_found(),
            };
            respond(result)
        }
    }
}

fn respond<T: serde::Serialize>(result: Result<T, SearchError>) -> Response {
    match result {
        Ok(value) => Response::json(200, serde_json::json!(value)),
        Err(failure) => error(failure),
    }
}
fn error(failure: SearchError) -> Response {
    Response::error(failure.status(), failure.message())
}
fn unauthorized() -> Response {
    Response::error(401, "Network search authorization is invalid")
}
fn timeout_response() -> Response {
    error(SearchError::unavailable())
}
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
