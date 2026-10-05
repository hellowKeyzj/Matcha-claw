use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteHeadPlan,
    },
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

use super::{CAPABILITY, MAX_BYTES, PRINCIPAL, ROUTE, SCOPE, is_tool, now_millis, revision};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolRequest {
    name: String,
    arguments: Value,
}

pub(super) fn descriptor(
    owner: organization::OrganizationHandle,
    verifier: CapabilityDecisionVerifier,
    resolver: Arc<dyn organization::RoleSessionIdentityResolver>,
) -> ModuleDescriptor {
    let verifier = Arc::new(Mutex::new(verifier));
    ModuleDescriptor::new(
        ModuleId::new("host.team-mcp"),
        vec![RouteDescriptor::bound(
            "host.team-mcp.call",
            head_plan,
            move |request| {
                let owner = owner.clone();
                let verifier = verifier.clone();
                let resolver = resolver.clone();
                Box::pin(async move { handle(owner, verifier, resolver, request).await.into() })
            },
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    (head.path == ROUTE).then(|| {
        RouteHeadPlan::new(
            BodyPolicy::Required {
                max_bytes: MAX_BYTES,
            },
            Duration::from_secs(30),
            unavailable,
        )
    })
}

async fn handle(
    owner: organization::OrganizationHandle,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    resolver: Arc<dyn organization::RoleSessionIdentityResolver>,
    request: Request,
) -> Response {
    if request.method() != "POST" {
        return Response::not_found();
    }
    let Some(authorization) = request.bearer_authorization() else {
        return unauthorized();
    };
    let Ok(tool) = serde_json::from_slice::<ToolRequest>(&request.body) else {
        return Response::bad_request();
    };
    if !is_tool(&tool.name) || !tool.arguments.is_object() {
        return Response::bad_request();
    }
    let Ok(now) = now_millis() else {
        return unavailable();
    };
    let decision =
        verifier
            .lock()
            .await
            .verify(authorization, now, ROUTE, SCOPE, CAPABILITY, &tool.name);
    match decision {
        Ok(decision)
            if decision.principal() == PRINCIPAL
                && decision.revision() == revision(&request.body) => {}
        _ => return unauthorized(),
    }
    match owner
        .execute_team_mcp(tool.name, tool.arguments, resolver)
        .await
    {
        Ok(result) if result.get("errorCode").and_then(Value::as_str) == Some("invalid_params") => {
            Response::json(400, result)
        }
        Ok(result) => Response::json(200, result),
        Err(_) => unavailable(),
    }
}

fn unauthorized() -> Response {
    Response::error(401, "Team MCP authorization is invalid")
}
fn unavailable() -> Response {
    Response::error(503, "Team MCP owner is unavailable")
}
