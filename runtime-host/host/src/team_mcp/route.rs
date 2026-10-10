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
    authority: super::ExecutionAuthority,
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
                let authority = authority.clone();
                Box::pin(async move {
                    handle(owner, verifier, resolver, authority, request)
                        .await
                        .into()
                })
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
    authority: super::ExecutionAuthority,
    request: Request,
) -> Response {
    if request.method() != "POST" {
        return Response::not_found();
    }
    let Some(authorization) = request.bearer_authorization() else {
        return unauthorized();
    };
    let Ok(mut tool) = serde_json::from_slice::<ToolRequest>(&request.body) else {
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
    let arguments = tool
        .arguments
        .as_object_mut()
        .expect("validated tool arguments");
    let scope = match arguments.remove("executionAuthority") {
        None => None,
        Some(token) => {
            if !matches!(
                tool.name.as_str(),
                "team_graph_context" | "team_graph_patch"
            ) || arguments.contains_key("designEpoch")
                || arguments.contains_key("promptGeneration")
            {
                return Response::json(
                    400,
                    serde_json::json!({
                        "success": false, "errorCode": "invalid_params",
                        "error": "Execution and design authorization cannot be combined."
                    }),
                );
            }
            let verified = token
                .as_str()
                .ok_or(())
                .and_then(|token| authority.verify(token));
            match verified {
                Ok(scope) => Some(scope),
                Err(()) => {
                    return Response::json(
                        200,
                        serde_json::json!({
                            "success": false, "errorCode": "execution_authority_invalid",
                            "error": "Execution authorization is invalid; stop graph access and use only the authorization supplied with the current node task."
                        }),
                    );
                }
            }
        }
    };
    match owner
        .execute_team_mcp(tool.name, tool.arguments, resolver, scope)
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
