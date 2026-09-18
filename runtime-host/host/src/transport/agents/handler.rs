use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    facade::AgentsHandle,
    transport::{
        common::authorization::CapabilityDecisionVerifier, localhost,
        sessions::trace as session_trace,
    },
};

use super::{AgentsRequest, Delivery, map_outcome};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const ROUTE: &str = "/api/subagents/agents";

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: AgentsHandle,
) -> localhost::Response {
    handle_request(method, path, headers, body, verifier, handle)
        .await
        .into()
}

async fn handle_request(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: AgentsHandle,
) -> Response {
    let trace_id = session_trace::trace_id(headers).map(str::to_owned);
    session_trace::log(
        "runtime.agents.request",
        trace_id.as_deref(),
        serde_json::json!({ "method": method, "path": path }),
    );
    if method != "POST" || path != ROUTE {
        session_trace::log(
            "runtime.agents.not-found",
            trace_id.as_deref(),
            serde_json::json!({}),
        );
        return Response::not_found();
    }
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        session_trace::log(
            "runtime.agents.unauthorized",
            trace_id.as_deref(),
            serde_json::json!({}),
        );
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => {
            session_trace::log(
                "runtime.agents.bad-json",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            return Response::bad_request();
        }
    };
    let mut verifier = verifier.lock().await;
    let request = match AgentsRequest::decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(_) => {
            session_trace::log(
                "runtime.agents.decode-invalid",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            return Response::unauthorized();
        }
    };
    session_trace::log(
        "runtime.agents.decode-accepted",
        trace_id.as_deref(),
        serde_json::json!({
            "capability": &request.id,
            "operation": &request.operation_id,
            "adapter": &request.scope.endpoint.runtime_adapter_id,
            "instance": &request.scope.endpoint.runtime_instance_id,
            "scopeAgentId": session_trace::id_shape(Some(&request.scope.agent_id)),
            "targetSubagentId": session_trace::id_shape(request.target.subagent_id.as_deref()),
        }),
    );
    let operation_id = request.operation_id.clone();
    let command = match request.command(trace_id.as_deref()) {
        Ok(command) => command,
        Err(_) => {
            session_trace::log(
                "runtime.agents.command-invalid",
                trace_id.as_deref(),
                serde_json::json!({ "operation": operation_id }),
            );
            return Response::bad_request();
        }
    };
    drop(verifier);
    session_trace::log(
        "runtime.agents.command",
        trace_id.as_deref(),
        serde_json::json!({ "operation": operation_id }),
    );
    let delivery = match handle.agents(command).await {
        Ok(outcome) => map_outcome(outcome),
        Err(_) => {
            session_trace::log(
                "runtime.agents.owner-unavailable",
                trace_id.as_deref(),
                serde_json::json!({ "operation": operation_id }),
            );
            Delivery::Unavailable
        }
    };
    session_trace::log(
        "runtime.agents.outcome",
        trace_id.as_deref(),
        serde_json::json!({
            "operation": operation_id,
            "status": delivery.status_code(),
            "delivery": delivery_trace_kind(&delivery),
        }),
    );
    Response::from_delivery(delivery)
}

struct Response {
    status: u16,
    body: Value,
}

impl From<Response> for localhost::Response {
    fn from(response: Response) -> Self {
        Self::json(response.status, response.body)
    }
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Subagent request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Subagent authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Subagent route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
}

fn delivery_trace_kind(delivery: &Delivery) -> &'static str {
    match delivery {
        Delivery::Agents { .. } => "agents",
        Delivery::Wait(_) => "wait",
        Delivery::Created(_) => "created",
        Delivery::Updated(_) => "updated",
        Delivery::Deleted(_) => "deleted",
        Delivery::Files(_) => "files",
        Delivery::File(_) => "file",
        Delivery::Configuration(_) => "configuration",
        Delivery::ConfigurationApplied => "configurationApplied",
        Delivery::SkillConfiguration(_) => "skillConfiguration",
        Delivery::ToolConfiguration(_) => "toolConfiguration",
        Delivery::PackageExport(_) => "packageExport",
        Delivery::PackageInstall(_) => "packageInstall",
        Delivery::Rejected => "rejected",
        Delivery::OutcomeUnknown => "outcomeUnknown",
        Delivery::WaitUnknown => "waitUnknown",
        Delivery::Unsupported => "unsupported",
        Delivery::Unavailable => "unavailable",
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
