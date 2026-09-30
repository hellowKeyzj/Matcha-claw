use std::sync::Arc;

use platform::{
    call::CallId,
    capability::CapabilityDecisionVerifier,
    loopback::{Request, Response},
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::SkillsModule;

pub(super) const ENDPOINT: &str = "/api/skills/operations/result";
pub(super) const PRIVATE_ENDPOINT: &str = "/api/sealed-skills/export-cloud/result";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultRequest {
    call_id: String,
}

pub(super) async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
) -> Response {
    let Ok(body) = serde_json::from_slice::<ResultRequest>(&request.body) else {
        return Response::json(400, json!({ "outcome": "rejected" }));
    };
    let Ok(call_id) = CallId::parse(&body.call_id) else {
        return Response::json(400, json!({ "outcome": "rejected" }));
    };
    let private = request.path() == PRIVATE_ENDPOINT;
    let results = skills.operations.lock().await.results.clone();
    let Some(access) = results.access(&call_id, private).await else {
        return not_found();
    };
    let Some(token) = request
        .head
        .headers
        .iter()
        .find(|(name, _)| name == "authorization")
        .and_then(|(_, value)| value.strip_prefix("Bearer "))
    else {
        return Response::json(401, json!({ "outcome": "rejected" }));
    };
    let verified = verifier.lock().await.verify(
        token,
        super::now_millis(),
        request.path(),
        &access.scope,
        &access.capability,
        &access.subject,
    );
    if !verified.is_ok_and(|decision| {
        decision.principal() == access.principal
            && (!private || decision.principal() == "electron-main-local")
    }) {
        return Response::json(401, json!({ "outcome": "rejected" }));
    }
    match results.read(&call_id).await {
        Some(body) => Response::json(200, body),
        None => not_found(),
    }
}

fn not_found() -> Response {
    Response::json(404, json!({ "outcome": "notFound" }))
}
