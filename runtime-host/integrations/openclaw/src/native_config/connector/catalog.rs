use std::fmt;

use connectors::{
    Connector, ConnectorCatalog, ConnectorKind, McpProgramSource, McpServerProgram, McpTransport,
};
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
        .filter_map(|connector| match connector.kind() {
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
                transport: connector.transport(),
            }),
            ConnectorKind::Cli | ConnectorKind::Sdk | ConnectorKind::Http => None,
        })
        .collect::<Vec<_>>();
    programs.sort_by(|left, right| left.id.cmp(&right.id));
    programs.dedup_by(|left, right| left.id == right.id);
    programs
}

fn program_id(connector: &Connector) -> String {
    connector
        .mcp_server_program()
        .and_then(|program| program.program_id().map(str::to_owned))
        .unwrap_or_else(|| format!("managed-local:{}", connector.id()))
}

fn program_source(connector: &Connector) -> McpProgramSource {
    connector
        .mcp_server_program()
        .map(McpServerProgram::source)
        .unwrap_or(McpProgramSource::ManagedLocal)
}

fn display_name(connector: &Connector) -> String {
    connector
        .display_name()
        .map(str::to_owned)
        .unwrap_or_else(|| connector.id().to_owned())
}

#[cfg(test)]
mod tests {
    use connectors::{Connector, ConnectorInput, McpServerProgram};

    use super::*;

    #[test]
    fn discovery_projects_only_non_secret_mcp_read_model_fields() {
        let mut input = ConnectorInput::new("github".into(), ConnectorKind::McpHttp);
        input.display_name = Some("GitHub".into());
        input.mcp_server_program = Some(McpServerProgram::new(
            McpProgramSource::BundledPlugin,
            Some("bundled-plugin:github".into()),
        ));
        input.url = Some("https://github.example.test/mcp".into());
        input.transport = Some(McpTransport::Sse);
        input.headers = Some(std::collections::BTreeMap::from([(
            "X-Client".into(),
            "matcha".into(),
        )]));
        let catalog =
            ConnectorCatalog::try_new(vec![Connector::new(input)]).expect("valid catalog");

        let encoded = serde_json::to_value(discover_external_mcp_programs(&catalog)).unwrap();

        assert_eq!(
            encoded,
            serde_json::json!([{
                "id": "bundled-plugin:github",
                "source": "bundled-plugin",
                "displayName": "GitHub",
                "connectorKinds": ["mcp-http"],
                "transport": "sse"
            }])
        );
        let encoded = encoded.to_string();
        for private_field in [
            "X-Client",
            "matcha",
            "https://github.example.test/mcp",
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
