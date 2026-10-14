use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteHeadPlan, RoutePath,
    },
    mcp::ToolCallError,
};
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::sync::Mutex;

use super::{Family, MAX_BYTES, now_millis, revision};

const TEAM_PATHS: &[RoutePath] = &[RoutePath::Exact(Family::Team.path())];
const WIKI_PATHS: &[RoutePath] = &[RoutePath::Exact(Family::Wiki.path())];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolRequest {
    name: String,
    arguments: Map<String, Value>,
}

pub(crate) fn descriptor(
    org: organization::OrganizationHandle,
    verifier: CapabilityDecisionVerifier,
    resolver: Arc<dyn organization::RoleSessionIdentityResolver>,
    wiki: wiki::WikiHandle,
) -> ModuleDescriptor {
    let verifier = Arc::new(Mutex::new(verifier));
    let team_verifier = Arc::clone(&verifier);
    ModuleDescriptor::new(
        ModuleId::new("host.mcp"),
        vec![
            RouteDescriptor::bound(
                "host.mcp.team.call",
                TEAM_PATHS,
                team_head_plan,
                move |request| {
                    let org = org.clone();
                    let verifier = Arc::clone(&team_verifier);
                    let resolver = Arc::clone(&resolver);
                    Box::pin(
                        async move { handle_team(org, verifier, resolver, request).await.into() },
                    )
                },
            ),
            RouteDescriptor::bound(
                "host.mcp.wiki.call",
                WIKI_PATHS,
                wiki_head_plan,
                move |request| {
                    let wiki = wiki.clone();
                    let verifier = Arc::clone(&verifier);
                    Box::pin(async move { handle_wiki(wiki, verifier, request).await.into() })
                },
            ),
        ],
    )
}

fn team_head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    (head.path == Family::Team.path()).then(|| {
        RouteHeadPlan::new(
            BodyPolicy::Required {
                max_bytes: MAX_BYTES,
            },
            Duration::from_secs(30),
            team_unavailable,
        )
    })
}

fn wiki_head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    (head.path == Family::Wiki.path()).then(|| {
        RouteHeadPlan::body_deadline(
            BodyPolicy::Required {
                max_bytes: usize::MAX,
            },
            Duration::from_secs(30),
            wiki_unavailable,
        )
    })
}

async fn handle_team(
    org: organization::OrganizationHandle,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    resolver: Arc<dyn organization::RoleSessionIdentityResolver>,
    request: Request,
) -> Response {
    let tool = match authorize(&request, &verifier, Family::Team).await {
        Ok(tool) => tool,
        Err(response) => return response,
    };
    match org
        .execute_team_mcp(tool.name, Value::Object(tool.arguments), resolver)
        .await
    {
        Ok(result) => Response::json(200, result),
        Err(_) => team_unavailable(),
    }
}

async fn handle_wiki(
    wiki: wiki::WikiHandle,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    request: Request,
) -> Response {
    let tool = match authorize(&request, &verifier, Family::Wiki).await {
        Ok(tool) => tool,
        Err(response) => return response,
    };
    match wiki.execute_mcp(&tool.name, &tool.arguments).await {
        Ok(result) => Response::json(200, result),
        Err(ToolCallError::InvalidParams) => Response::bad_request(),
        Err(ToolCallError::Internal | ToolCallError::Execution(_)) => wiki_unavailable(),
    }
}

async fn authorize(
    request: &Request,
    verifier: &Mutex<CapabilityDecisionVerifier>,
    family: Family,
) -> Result<ToolRequest, Response> {
    if request.method() != "POST" {
        return Err(Response::not_found());
    }
    let Some(authorization) = request.bearer_authorization() else {
        return Err(unauthorized(family));
    };
    let tool = serde_json::from_slice::<ToolRequest>(&request.body)
        .map_err(|_| Response::bad_request())?;
    let allowed = match family {
        Family::Team => organization::is_team_tool(&tool.name),
        Family::Wiki => wiki::is_wiki_tool(&tool.name),
    };
    if !allowed {
        return Err(Response::bad_request());
    }
    let now = now_millis().map_err(|_| match family {
        Family::Team => team_unavailable(),
        Family::Wiki => wiki_unavailable(),
    })?;
    let decision = verifier.lock().await.verify(
        authorization,
        now,
        family.path(),
        family.scope(),
        family.scope(),
        &tool.name,
    );
    match decision {
        Ok(decision)
            if decision.principal() == family.principal()
                && decision.revision() == revision(&request.body) =>
        {
            Ok(tool)
        }
        _ => Err(unauthorized(family)),
    }
}

fn unauthorized(family: Family) -> Response {
    Response::error(
        401,
        match family {
            Family::Team => "Team MCP authorization is invalid",
            Family::Wiki => "Wiki MCP authorization is invalid",
        },
    )
}

fn team_unavailable() -> Response {
    Response::error(503, "Team MCP owner is unavailable")
}

fn wiki_unavailable() -> Response {
    Response::error(503, "Wiki MCP owner is unavailable")
}
