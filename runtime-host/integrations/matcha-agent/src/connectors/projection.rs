use std::collections::BTreeMap;

use connectors::{
    Connector, ConnectorCatalog, ConnectorKind, ConnectorSecretRef, ConnectorSecretResolution,
    ConnectorSecretResolverPort, McpTransport, ports::McpPreset,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::ConnectorError;

pub(super) async fn params(
    preset: Option<McpPreset<'_>>,
    catalog: &ConnectorCatalog,
    resolver: &dyn ConnectorSecretResolverPort,
) -> Result<Value, ConnectorError> {
    let mut servers = BTreeMap::new();
    let mut private_sources = BTreeMap::new();
    if let Some(preset) = preset {
        if !preset.runtime_host_mcp_executable().is_absolute()
            || !preset.runtime_host_mcp_state_dir().is_absolute()
        {
            return Err(ConnectorError::UnsupportedConfiguration);
        }
        let command = preset
            .runtime_host_mcp_executable()
            .to_str()
            .ok_or(ConnectorError::UnsupportedConfiguration)?;
        let state = preset
            .runtime_host_mcp_state_dir()
            .to_str()
            .ok_or(ConnectorError::UnsupportedConfiguration)?;
        servers.insert("matcha".to_owned(), json!({"enabled":true,"server":{"type":"stdio","command":command,"args":["mcp","--state-dir",state]}}));
    }
    for connector in catalog.connectors() {
        if !matches!(
            connector.kind(),
            ConnectorKind::McpStdio | ConnectorKind::McpHttp
        ) {
            continue;
        }
        if connector.id() == "matcha" {
            continue;
        }
        // These Host fields have no equivalent in the native per-server MCP schema.
        if connector.cwd().is_some() || connector.connection_timeout_ms().is_some() {
            return Err(ConnectorError::UnsupportedConfiguration);
        }
        let server_name = if connector.id().starts_with("matcha-external.") {
            connector.id().to_owned()
        } else {
            format!("matcha-external.{}", connector.id())
        };
        let server = match connector.kind() {
            ConnectorKind::McpStdio => json!({
                "type":"stdio", "command":connector.command().ok_or(ConnectorError::UnsupportedConfiguration)?,
                "args":connector.args().unwrap_or_default(),
                "env":values(connector, "env", connector.env(), connector.secret_env_references(), resolver, &mut private_sources).await?,
            }),
            ConnectorKind::McpHttp => json!({
                "type":match connector.transport().unwrap_or(McpTransport::StreamableHttp) { McpTransport::StreamableHttp => "http", McpTransport::Sse => "sse" },
                "url":connector.url().ok_or(ConnectorError::UnsupportedConfiguration)?,
                "headers":values(connector, "headers", connector.headers(), connector.secret_header_references(), resolver, &mut private_sources).await?,
            }),
            _ => unreachable!(),
        };
        servers.insert(
            server_name,
            json!({"enabled":connector.enabled(),"server":server}),
        );
    }
    Ok(json!({"servers":servers,"privateSources":private_sources}))
}

async fn values<'a>(
    connector: &Connector,
    section: &str,
    public: Option<&BTreeMap<String, String>>,
    references: impl Iterator<Item = (&'a str, &'a str)>,
    resolver: &dyn ConnectorSecretResolverPort,
    private: &mut BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, ConnectorError> {
    let mut values = public.cloned().unwrap_or_default();
    for (key, reference) in references {
        if !connector.enabled() {
            values.insert(key.into(), String::new());
            continue;
        }
        let reference = ConnectorSecretRef::try_new(reference)
            .map_err(|_| ConnectorError::SecretUnavailable)?;
        let ConnectorSecretResolution::Resolved { value, .. } = resolver
            .resolve(&reference)
            .await
            .map_err(|_| ConnectorError::SecretUnavailable)?
        else {
            return Err(ConnectorError::SecretUnavailable);
        };
        let mut resolved = None;
        value.with_private_bytes(|bytes| {
            resolved = std::str::from_utf8(bytes).ok().map(str::to_owned)
        });
        values.insert(
            key.into(),
            resolved.ok_or(ConnectorError::SecretUnavailable)?,
        );
    }
    let mut projected = BTreeMap::new();
    for (key, value) in values {
        // Length-delimited hashing makes aliases stable without exposing credential references.
        let mut hash = Sha256::new();
        for part in [connector.id(), section, key.as_str()] {
            hash.update((part.len() as u64).to_le_bytes());
            hash.update(part.as_bytes());
        }
        let source = format!("MATCHA_MCP_{:X}", hash.finalize());
        projected.insert(key, format!("${{{source}}}"));
        if connector.enabled() {
            if value.trim().is_empty() || value.contains('\0') {
                return Err(ConnectorError::SecretUnavailable);
            }
            private.insert(source, value);
        }
    }
    Ok(projected)
}
