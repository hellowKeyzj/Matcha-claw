use serde::Deserialize;
use serde_json::{Value, json};

use crate::runtime::external_connectors::{
    McpServerKind, OpenClawMcpServerSource, OpenClawMcpServerSummary, OpenClawMcpServersOutcome,
};
use crate::transport::common::authorization::CapabilityDecisionVerifier;

pub(crate) const ENDPOINT: &str = "/api/openclaw/mcp-servers";
const CAPABILITY_ID: &str = "openclaw.mcpServers";
const SCOPE: &str = "openclaw:mcp-servers";
const SUBJECT: &str = "openclaw-mcp-servers";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    id: String,
    operation_id: String,
    scope: Kind,
    target: Kind,
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Kind {
    kind: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Input {
    List {},
}

pub(crate) enum Command {
    List,
}

impl Request {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, RequestError> {
        let operation = value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|operation| operation_name(operation).is_some())
            .ok_or(RequestError::Invalid)?;
        verifier
            .verify(authorization, now, ENDPOINT, SCOPE, operation, SUBJECT)
            .map_err(|_| RequestError::Unauthorized)?;
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        request
            .valid()
            .then_some(request)
            .ok_or(RequestError::Invalid)
    }

    fn valid(&self) -> bool {
        self.id == CAPABILITY_ID
            && self.scope.kind == "openclaw-mcp-servers"
            && self.target.kind == "openclaw-mcp-servers"
            && operation_name(&self.operation_id).is_some_and(|kind| match (&self.input, kind) {
                (Input::List {}, "list") => true,
                _ => false,
            })
    }

    pub(crate) fn into_command(self) -> Command {
        match self.input {
            Input::List {} => Command::List,
        }
    }
}

fn operation_name(operation: &str) -> Option<&'static str> {
    match operation {
        "openClawMcpServers.list" => Some("list"),
        _ => None,
    }
}

pub(crate) enum Delivery {
    List(OpenClawMcpServersOutcome),
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::List(OpenClawMcpServersOutcome::Available(_)) => 200,
            Self::List(OpenClawMcpServersOutcome::Unavailable) | Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::List(OpenClawMcpServersOutcome::Available(servers)) => json!({
                "servers": servers.iter().map(project_server).collect::<Vec<_>>(),
            }),
            Self::List(OpenClawMcpServersOutcome::Unavailable) | Self::Unavailable => {
                json!({ "success": false, "error": "OpenClaw MCP servers are unavailable" })
            }
        }
    }
}

fn project_server(server: &OpenClawMcpServerSummary) -> Value {
    let mut value = json!({
        "serverId": server.server_id,
        "displayName": server.display_name,
        "kind": project_kind(server.kind),
        "source": project_source(&server.source),
        "enabled": server.enabled,
        "managed": server.managed,
        "editable": server.editable,
        "removable": server.removable,
    });
    if let Some(connector_id) = &server.connector_id {
        value["connectorId"] = json!(connector_id);
    }
    if let Some(description) = &server.description {
        value["description"] = json!(description);
    }
    value
}

fn project_kind(kind: McpServerKind) -> &'static str {
    match kind {
        McpServerKind::McpStdio => "mcp-stdio",
        McpServerKind::McpHttp => "mcp-http",
        McpServerKind::Unknown => "unknown",
    }
}

fn project_source(source: &OpenClawMcpServerSource) -> &'static str {
    match source {
        OpenClawMcpServerSource::Preset => "preset",
        OpenClawMcpServerSource::External => "external",
        OpenClawMcpServerSource::Openclaw => "openclaw",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_accepts_only_list_operation_envelope() {
        let value = request("openClawMcpServers.list", json!({ "kind": "list" }));

        let decoded = serde_json::from_value::<Request>(value).expect("request decodes");
        assert!(decoded.valid());

        let direct = serde_json::from_value::<Request>(json!({ "kind": "list" }));
        assert!(direct.is_err());

        let unsupported = serde_json::from_value::<Request>(request(
            "openClawMcpServers.sessionStatus",
            json!({ "kind": "sessionStatus" }),
        ));
        assert!(unsupported.is_err());
    }

    #[test]
    fn unit_variant_rejects_unknown_fields() {
        let accepted = serde_json::from_value::<Request>(request(
            "openClawMcpServers.list",
            json!({ "kind": "list" }),
        ))
        .expect("list request decodes");
        assert!(accepted.valid());

        let rejected = serde_json::from_value::<Request>(request(
            "openClawMcpServers.list",
            json!({ "kind": "list", "bogus": 1 }),
        ));
        assert!(rejected.is_err());
    }

    fn request(operation_id: &str, input: Value) -> Value {
        json!({
            "id": CAPABILITY_ID,
            "operationId": operation_id,
            "scope": { "kind": "openclaw-mcp-servers" },
            "target": { "kind": "openclaw-mcp-servers" },
            "input": input,
        })
    }
}
