use std::sync::Arc;

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{Request, Response},
};
use serde_json::json;
use tokio::sync::Mutex;

use crate::ProviderRecoveryStore;

pub(super) const ENDPOINT: &str = "/api/providers/recovery";
pub(super) const ACKNOWLEDGE_ENDPOINT: &str = "/api/providers/recovery/acknowledge";

pub(super) async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    recovery: Option<Arc<Mutex<ProviderRecoveryStore>>>,
) -> Response {
    let operation = match (request.method(), request.path()) {
        ("GET", ENDPOINT) => "providerRecovery.get",
        ("POST", ACKNOWLEDGE_ENDPOINT) => "providerRecovery.acknowledge",
        _ => return Response::not_found(),
    };
    if !request.body.is_empty() {
        return Response::bad_request();
    }
    let Some(authorization) = request.bearer_authorization() else {
        return Response::error(401, "Runtime Host request is unauthorized");
    };
    if verifier
        .lock()
        .await
        .verify(
            authorization,
            super::now_millis(),
            request.path(),
            "providers:accounts",
            operation,
            "provider-recovery",
        )
        .is_err()
    {
        return Response::error(401, "Runtime Host request is unauthorized");
    }
    let Some(recovery) = recovery else {
        return Response::error(503, "Provider configuration recovery is unavailable");
    };
    let result = tokio::task::spawn_blocking(move || {
        let recovery = recovery.blocking_lock();
        if operation == "providerRecovery.get" {
            recovery
                .pending()
                .map(|notice| json!({ "recovery": notice }))
        } else {
            recovery.acknowledge().map(|()| json!({ "success": true }))
        }
    })
    .await;
    match result {
        Ok(Ok(body)) => Response::json(200, body),
        _ => Response::error(
            503,
            "Provider configuration recovery could not be read or acknowledged",
        ),
    }
}
