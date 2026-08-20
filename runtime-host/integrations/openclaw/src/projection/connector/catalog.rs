use std::fmt;

use environment::{ConnectorCatalog, ConnectorKind, McpProgramSource, McpTransport};
use serde::Serialize;

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpProgram {
    pub id: String,
    pub source: McpProgramSource,
    pub display_name: String,
    pub connector_kinds: Vec<ConnectorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransport>,
}

impl fmt::Debug for ExternalMcpProgram {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ExternalMcpProgram([REDACTED])")
    }
}

/// Derives the selectable MCP program read model solely from persisted connector
/// desired facts. It does not inspect arbitrary roots, manifests, or entrypoints.
pub fn discover_external_mcp_programs(catalog: &ConnectorCatalog) -> Vec<ExternalMcpProgram> {
    let mut programs = catalog
        .connectors()
        .iter()
        .filter_map(|connector| match connector.kind {
            ConnectorKind::McpStdio => Some(ExternalMcpProgram {
                id: program_id(connector),
                source: program_source(connector),
                display_name: display_name(connector),
                connector_kinds: vec![ConnectorKind::McpStdio],
                transport: None,
            }),
            ConnectorKind::McpHttp => Some(ExternalMcpProgram {
                id: program_id(connector),
                source: program_source(connector),
                display_name: display_name(connector),
                connector_kinds: vec![ConnectorKind::McpHttp],
                transport: connector.transport.clone(),
            }),
            ConnectorKind::Cli | ConnectorKind::Sdk | ConnectorKind::Http => None,
        })
        .collect::<Vec<_>>();
    programs.sort_by(|left, right| left.id.cmp(&right.id));
    programs.dedup_by(|left, right| left.id == right.id);
    programs
}

fn program_id(connector: &environment::Connector) -> String {
    connector
        .mcp_server_program
        .as_ref()
        .and_then(|program| program.program_id.clone())
        .unwrap_or_else(|| format!("managed-local:{}", connector.id))
}

fn program_source(connector: &environment::Connector) -> McpProgramSource {
    connector
        .mcp_server_program
        .as_ref()
        .map(|program| program.source.clone())
        .unwrap_or(McpProgramSource::ManagedLocal)
}

fn display_name(connector: &environment::Connector) -> String {
    connector
        .display_name
        .clone()
        .unwrap_or_else(|| connector.id.clone())
}

#[cfg(test)]
mod tests {
    use environment::Connector;

    use super::*;

    #[test]
    fn discovery_projects_only_non_secret_mcp_read_model_fields() {
        let catalog = ConnectorCatalog::try_new(vec![
            serde_json::from_value::<Connector>(serde_json::json!({
                "id": "github",
                "kind": "mcp-http",
                "displayName": "GitHub",
                "mcpServerProgram": {
                    "source": "bundled-plugin",
                    "programId": "bundled-plugin:github"
                },
                "url": "https://github.example.test/mcp",
                "transport": "sse",
                "headers": { "X-Client": "matcha" }
            }))
            .expect("connector fixture"),
        ])
        .expect("valid catalog");

        let encoded = serde_json::to_string(&discover_external_mcp_programs(&catalog)).unwrap();

        assert!(encoded.contains("bundled-plugin:github"));
        for private_field in [
            "X-Client",
            "matcha",
            "url",
            "command",
            "args",
            "envKeys",
            "headerKeys",
            "rootPath",
            "manifestPath",
            "entrypointPath",
        ] {
            assert!(!encoded.contains(private_field));
        }
    }
}
