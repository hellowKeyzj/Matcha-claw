use std::time::{SystemTime, UNIX_EPOCH};

use platform::loopback::{Request, Response};
use serde_json::{Map, Value};

use crate::projection::public::{Delivery, map_outcome};

use super::AgentsRequest;

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const TRACE_HEADER: &str = "x-matchaclaw-session-trace";

pub(crate) async fn handle(request: Request, dependencies: super::Dependencies) -> Response {
    handle_request(request, dependencies).await.into_response()
}

async fn handle_request(request: Request, dependencies: super::Dependencies) -> ResponseBody {
    let path = super::pathname(request.path());
    let trace_id = trace_id(request.headers()).map(str::to_owned);
    log(
        "runtime.agents.request",
        trace_id.as_deref(),
        serde_json::json!({ "method": request.method(), "path": request.path() }),
    );
    if request.method() != "POST" || path != super::AUTHORIZATION_ENDPOINT {
        log(
            "runtime.agents.not-found",
            trace_id.as_deref(),
            serde_json::json!({}),
        );
        return ResponseBody::not_found();
    }
    let Some(authorization) = request
        .headers()
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        log(
            "runtime.agents.unauthorized",
            trace_id.as_deref(),
            serde_json::json!({}),
        );
        return ResponseBody::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            log(
                "runtime.agents.bad-json",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            return ResponseBody::bad_request();
        }
    };
    let mut verifier = dependencies.verifier.lock().await;
    let request = match AgentsRequest::decode(value, authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(_) => {
            log(
                "runtime.agents.decode-invalid",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            return ResponseBody::unauthorized();
        }
    };
    log(
        "runtime.agents.decode-accepted",
        trace_id.as_deref(),
        serde_json::json!({
            "capability": &request.id,
            "operation": &request.operation_id,
            "adapter": &request.scope.endpoint.runtime_adapter_id,
            "instance": &request.scope.endpoint.runtime_instance_id,
            "scopeAgentId": id_shape(Some(&request.scope.agent_id)),
            "targetSubagentId": id_shape(request.target.subagent_id.as_deref()),
        }),
    );
    let operation_id = request.operation_id.clone();
    let command = match request.command(trace_id.as_deref()) {
        Ok(command) => command,
        Err(_) => {
            log(
                "runtime.agents.command-invalid",
                trace_id.as_deref(),
                serde_json::json!({ "operation": operation_id }),
            );
            return ResponseBody::bad_request();
        }
    };
    drop(verifier);
    log(
        "runtime.agents.command",
        trace_id.as_deref(),
        serde_json::json!({ "operation": operation_id }),
    );
    let delivery = match dependencies.subagents.subagents(command).await {
        Ok(outcome) => map_outcome(outcome),
        Err(_) => {
            log(
                "runtime.agents.owner-unavailable",
                trace_id.as_deref(),
                serde_json::json!({ "operation": operation_id }),
            );
            Delivery::Unavailable
        }
    };
    log(
        "runtime.agents.outcome",
        trace_id.as_deref(),
        serde_json::json!({
            "operation": operation_id,
            "status": delivery.status_code(),
            "delivery": delivery_trace_kind(&delivery),
        }),
    );
    ResponseBody::from_delivery(delivery)
}

struct ResponseBody {
    status: u16,
    body: Value,
}

impl ResponseBody {
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

    fn into_response(self) -> Response {
        Response::json(self.status, self.body)
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

fn trace_id(headers: &[(String, String)]) -> Option<&str> {
    headers
        .iter()
        .find(|(name, _)| name == TRACE_HEADER)
        .map(|(_, value)| value.as_str())
        .filter(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        })
}

fn log(stage: &str, trace_id: Option<&str>, payload: Value) {
    if trace_id.is_none() || !enabled() {
        return;
    }
    emit(stage, trace_id, payload);
}

fn enabled() -> bool {
    std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() == Ok("1")
}

fn emit(stage: &str, trace_id: Option<&str>, payload: Value) {
    let mut event = Map::new();
    event.insert("prefix".into(), Value::String("session-trace".into()));
    event.insert("source".into(), Value::String("runtime-host".into()));
    if let Some(trace_id) = trace_id {
        event.insert("traceId".into(), Value::String(trace_id.into()));
    }
    event.insert("stage".into(), Value::String(stage.into()));
    event.insert("at".into(), Value::Number(now_millis().into()));
    if let Value::Object(fields) = payload {
        event.extend(fields);
    }
    eprintln!("{}", Value::Object(event));
}

fn id_shape(value: Option<&str>) -> Value {
    match value {
        Some(value) => serde_json::json!({ "present": true, "length": value.len() }),
        None => serde_json::json!({ "present": false, "length": 0 }),
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
