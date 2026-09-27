use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::{SealedPackageAuthorizationKey, SealedResourceError, SealedResourceModule};

const AUTHORIZE_PACKAGE_ENDPOINT: &str = "/api/sealed-resource/authorize-package";
const AUTHORIZATION_SCOPE: &str = "sealed-resource:package";
const CAPABILITY_ID: &str = "sealedResource.authorizePackage";
const AUTHORIZATION_SUBJECT: &str = "sealed-resource-keyring";
const DEFAULT_REQUEST_BYTES: usize = 2 * 1024;
const SHORT_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(crate) struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    sealed_resource: SealedResourceModule,
}

impl Dependencies {
    pub(crate) fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        sealed_resource: SealedResourceModule,
    ) -> Self {
        Self {
            verifier,
            sealed_resource,
        }
    }
}

pub(crate) fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("sealed-resource"),
        vec![RouteDescriptor::bound(
            "sealed-resource.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    (head.method == "POST" && pathname(&head.path) == AUTHORIZE_PACKAGE_ENDPOINT).then(|| {
        RouteHeadPlan::new(
            BodyPolicy::Required {
                max_bytes: DEFAULT_REQUEST_BYTES,
            },
            SHORT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        if request.method() != "POST" || pathname(request.path()) != AUTHORIZE_PACKAGE_ENDPOINT {
            return Response::not_found().into();
        }
        handle(dependencies, request).await.into()
    })
}

async fn handle(dependencies: Dependencies, request: Request) -> Response {
    let Some(authorization) = request.bearer_authorization() else {
        return unauthorized();
    };
    if dependencies
        .verifier
        .lock()
        .await
        .verify(
            authorization,
            now_millis(),
            AUTHORIZE_PACKAGE_ENDPOINT,
            AUTHORIZATION_SCOPE,
            CAPABILITY_ID,
            AUTHORIZATION_SUBJECT,
        )
        .is_err()
    {
        return unauthorized();
    }

    let request = match serde_json::from_slice::<AuthorizePackageRequest>(&request.body) {
        Ok(request) => request,
        Err(_) => return rejected(),
    };
    match authorize_package(dependencies.sealed_resource, request) {
        Ok(()) => Response::json(200, json!({ "outcome": "accepted" })),
        Err(SealedResourceError::Unknown) => Response::json(503, json!({ "outcome": "unknown" })),
        Err(_) => rejected(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizePackageRequest {
    package_sha256: String,
    authorization_key: String,
    lease_expires_at: String,
}

fn authorize_package(
    sealed_resource: SealedResourceModule,
    request: AuthorizePackageRequest,
) -> Result<(), SealedResourceError> {
    let authorization_key = SealedPackageAuthorizationKey::from_base64(&request.authorization_key)?;
    let lease_expires_at_ms = lease_expires_at_ms(&request.lease_expires_at)?;
    sealed_resource.register_authorization_key(
        request.package_sha256,
        authorization_key,
        lease_expires_at_ms,
    )
}

fn lease_expires_at_ms(value: &str) -> Result<u64, SealedResourceError> {
    let value = chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| SealedResourceError::Rejected)?
        .timestamp_millis();
    value.try_into().map_err(|_| SealedResourceError::Rejected)
}

fn unauthorized() -> Response {
    Response::error(401, "Sealed resource authorization is invalid")
}

fn rejected() -> Response {
    Response::json(400, json!({ "outcome": "rejected" }))
}

fn timeout_response() -> Response {
    Response::json(
        503,
        json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
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
