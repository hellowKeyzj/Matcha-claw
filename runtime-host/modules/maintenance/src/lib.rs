use std::sync::Arc;

use platform::call::CallId;
use platform::mcp::arguments::{require_exact_keys, required_string};
use platform::mcp::{ToolCallError, ToolCallFuture, ToolCallOutcome, ToolProvider};
use serde_json::{Map, Value, json};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MaintenanceAction {
    Status { call_id: Option<CallId> },
    Logs { cursor: Option<u64> },
    Inspect,
    Start,
    Restart,
    Repair,
}

pub trait MaintenancePort: Send + Sync {
    fn execute(&self, action: MaintenanceAction) -> ToolCallFuture<'_>;
}

pub struct Maintenance {
    port: Arc<dyn MaintenancePort>,
}

impl Maintenance {
    pub fn new(port: Arc<dyn MaintenancePort>) -> Self {
        Self { port }
    }

    pub async fn execute_mcp(&self, name: &str, arguments: &Map<String, Value>) -> ToolCallOutcome {
        if !is_maintenance_tool(name) {
            return Err(ToolCallError::InvalidParams);
        }
        self.port.execute(parse_action(arguments)?).await
    }
}

pub struct MaintenanceMcpFacade {
    call: Box<dyn for<'a> Fn(&'a str, &'a Map<String, Value>) -> ToolCallFuture<'a> + Send + Sync>,
}

impl MaintenanceMcpFacade {
    pub fn new(
        call: impl for<'a> Fn(&'a str, &'a Map<String, Value>) -> ToolCallFuture<'a>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            call: Box::new(call),
        }
    }
}

pub fn is_maintenance_tool(name: &str) -> bool {
    name == "maintenance"
}

impl ToolProvider for MaintenanceMcpFacade {
    fn tools(&self) -> Vec<Value> {
        vec![maintenance_tool()]
    }

    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> Option<ToolCallFuture<'a>> {
        is_maintenance_tool(name).then(|| (self.call)(name, arguments))
    }
}

fn parse_action(arguments: &Map<String, Value>) -> Result<MaintenanceAction, ToolCallError> {
    let action =
        match required_string(arguments, "action").map_err(|_| ToolCallError::InvalidParams)? {
            "status" => MaintenanceAction::Status {
                call_id: arguments
                    .get("callId")
                    .map(|value| {
                        let value = value.as_str().ok_or(ToolCallError::InvalidParams)?;
                        CallId::parse(value).map_err(|_| ToolCallError::InvalidParams)
                    })
                    .transpose()?,
            },
            "logs" => MaintenanceAction::Logs {
                cursor: arguments
                    .get("cursor")
                    .map(|value| value.as_u64().ok_or(ToolCallError::InvalidParams))
                    .transpose()?,
            },
            "inspect" => MaintenanceAction::Inspect,
            "start" => MaintenanceAction::Start,
            "restart" => MaintenanceAction::Restart,
            "repair" => MaintenanceAction::Repair,
            _ => return Err(ToolCallError::InvalidParams),
        };
    let allowed: &[&str] = match &action {
        MaintenanceAction::Status { .. } => &["action", "callId"],
        MaintenanceAction::Logs { .. } => &["action", "cursor"],
        _ => &["action"],
    };
    require_exact_keys(arguments, allowed).map_err(|_| ToolCallError::InvalidParams)?;
    Ok(action)
}

fn maintenance_tool() -> Value {
    json!({
        "name": "maintenance",
        "description": concat!(
            "Maintain only this application's local OpenClaw runtime. Select exactly one action. ",
            "status: read application lifecycle, repair snapshot and control readiness separately; ",
            "running does not mean the control connection is ready. Optional callId reads the ",
            "existing audit result of an OpenClaw lifecycle.start, lifecycle.restart or lifecycle.repair ",
            "operation, not arbitrary audit records. ",
            "logs: read structured sanitized driver logs with entries, source, cursor, reset, ",
            "truncated and lifecycleTailEvicted; optional cursor continues a previous read. ",
            "inspect: read bounded installation/state paths, package version/schemaVersions, ",
            "configuration parsing and safe summaries, and shared/configured-agent database ",
            "metadata and shape, with coverage and unchecked areas. It never returns credentials, ",
            "conversation bodies or raw configuration, creates missing databases, migrates data, ",
            "loads extensions, checkpoints or runs VACUUM; it is not full native schema validation. ",
            "start/restart/repair: request the existing application lifecycle or repair operation; ",
            "preserve its receipt, admitted, busy and unknown outcomes. These actions change runtime ",
            "state and require user authorization for the specific operation through native MCP ",
            "approval; no input flag grants authorization. Accepted does not mean recovered: ",
            "follow up with status (and callId when returned), logs and the original in-app function. ",
            "cursor is allowed only for logs; callId only for status. No executable, state path, port, ",
            "token, SQL, shell, arbitrary file path or alternate runtime can be supplied."
        ),
        "annotations": {
            "readOnlyHint": false
        },
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "logs", "inspect", "start", "restart", "repair"],
                    "description": "status/logs/inspect are read-only observations; start/restart/repair request authorized lifecycle changes."
                },
                "cursor": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Optional log cursor, only for action=logs; omit for the current bounded log snapshot. Null is not allowed."
                },
                "callId": {
                    "type": "string",
                    "pattern": "^[0-9a-fA-F]{32}$",
                    "minLength": 32,
                    "maxLength": 32,
                    "description": "Optional existing OpenClaw start/restart/repair receipt callId, only for action=status. Null is not allowed."
                }
            },
            "required": ["action"],
            "allOf": [
                {
                    "if": { "required": ["cursor"] },
                    "then": { "properties": { "action": { "const": "logs" } } }
                },
                {
                    "if": { "required": ["callId"] },
                    "then": { "properties": { "action": { "const": "status" } } }
                }
            ]
        }
    })
}
