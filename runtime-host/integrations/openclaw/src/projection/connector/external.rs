use std::{
    fmt,
    time::{Duration, Instant},
};

use environment::{
    ConnectorCatalog, ConnectorSecretRef, ConnectorSecretResolution, ConnectorSecretResolverPort,
    connectors::{Connector, ConnectorKind, McpTransport},
};
use futures_util::StreamExt;
use reqwest::{Client, header};
use serde_json::{Map, Value};
use tokio::time::timeout;

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    projection::config_store::{
        OpenClawConfigMutation, OpenClawConfigStore, OpenClawConfigStoreError,
    },
};

use super::preset::{PRESET_TEAM_RUN_MCP_SERVER_ID, PresetMcpProjection};

const MANAGED_EXTERNAL_SERVER_PREFIX: &str = "matcha-external.";
const DEFAULT_MCP_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const MCP_PROBE_CLIENT_NAME: &str = "matcha-connector-probe";
const MCP_PROBE_CLIENT_VERSION: &str = "0.0.0";
const MCP_PROBE_REQUEST_ID: &str = "matcha-connector-probe";
const MAX_MCP_PROBE_BODY_BYTES: usize = 1_000_000;

pub fn managed_external_server_id(connector_id: &str) -> String {
    if connector_id.starts_with(MANAGED_EXTERNAL_SERVER_PREFIX) {
        connector_id.to_owned()
    } else {
        format!("{MANAGED_EXTERNAL_SERVER_PREFIX}{connector_id}")
    }
}

pub fn connector_id_for_managed_external_server(server_id: &str) -> Option<&str> {
    server_id.strip_prefix(MANAGED_EXTERNAL_SERVER_PREFIX)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorProjectionEffect {
    Written { changed: bool },
    Unknown,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectorProjectionSkip {
    Disabled,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorProjectionReport {
    pub projected: Vec<String>,
    pub skipped: Vec<(String, ConnectorProjectionSkip)>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorProjectionError {
    InvalidSecretReference,
    MissingHttpUrl,
    SecretUnavailable,
}

impl fmt::Display for ConnectorProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSecretReference => {
                "enabled OpenClaw MCP connector has an invalid secret reference"
            }
            Self::MissingHttpUrl => "enabled OpenClaw MCP HTTP connector is missing its URL",
            Self::SecretUnavailable => {
                "enabled OpenClaw MCP connector secret could not be resolved"
            }
        })
    }
}

impl std::error::Error for ConnectorProjectionError {}

pub fn project_external_connectors(
    state_dir: CanonicalStateDir,
    catalog: &ConnectorCatalog,
    secrets: &dyn ConnectorSecretResolverPort,
) -> Result<(ConnectorProjectionEffect, ConnectorProjectionReport), ConnectorProjectionError> {
    project_runtime_mcp_connectors(state_dir, None, catalog, secrets)
}

pub fn project_runtime_mcp_connectors(
    state_dir: CanonicalStateDir,
    preset: Option<PresetMcpProjection<'_>>,
    catalog: &ConnectorCatalog,
    secrets: &dyn ConnectorSecretResolverPort,
) -> Result<(ConnectorProjectionEffect, ConnectorProjectionReport), ConnectorProjectionError> {
    let mut report = ConnectorProjectionReport {
        projected: Vec::new(),
        skipped: Vec::new(),
    };
    let mut servers = Map::new();
    if let Some(preset) = preset {
        let Some(server) = preset.team_run_server() else {
            return Ok((ConnectorProjectionEffect::Unavailable, report));
        };
        report.projected.push(PRESET_TEAM_RUN_MCP_SERVER_ID.into());
        servers.insert(PRESET_TEAM_RUN_MCP_SERVER_ID.into(), server);
    }
    for connector in catalog.connectors() {
        if !connector.enabled() {
            report
                .skipped
                .push((connector.id().to_owned(), ConnectorProjectionSkip::Disabled));
            continue;
        }
        match server_for(connector, secrets) {
            Ok(Some(server)) => {
                let server_id = managed_external_server_id(connector.id());
                report.projected.push(server_id.clone());
                servers.insert(server_id, server);
            }
            Ok(None) if !connector.enabled() => report
                .skipped
                .push((connector.id().to_owned(), ConnectorProjectionSkip::Disabled)),
            Ok(None) => report.skipped.push((
                connector.id().to_owned(),
                ConnectorProjectionSkip::Unsupported,
            )),
            Err(
                ConnectorProjectionError::InvalidSecretReference
                | ConnectorProjectionError::SecretUnavailable,
            ) => {
                report.skipped.push((
                    connector.id().to_owned(),
                    ConnectorProjectionSkip::Unsupported,
                ));
                return Ok((ConnectorProjectionEffect::Unavailable, report));
            }
            Err(error) => return Err(error),
        }
    }
    let store = OpenClawConfigStore::new(state_dir);
    let effect = match store.update(|document| {
        let mut mcp = document
            .get("mcp")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut current_servers = mcp
            .get("servers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut changed = false;
        current_servers.retain(|id, _| {
            let stale = is_stale_managed_server_id(id, &servers);
            changed |= stale;
            !stale
        });
        for (id, server) in &servers {
            if current_servers.get(id) != Some(server) {
                current_servers.insert(id.clone(), server.clone());
                changed = true;
            }
        }
        if !changed {
            return OpenClawConfigMutation::unchanged();
        }
        mcp.insert("servers".into(), Value::Object(current_servers));
        let mut commands = document
            .get("commands")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        commands.insert("restart".into(), Value::Bool(true));
        document.insert("commands".into(), Value::Object(commands));
        document.insert("mcp".into(), Value::Object(mcp));
        OpenClawConfigMutation::changed()
    }) {
        Ok(update) if projection_readback_matches(&store, &servers) => {
            ConnectorProjectionEffect::Written {
                changed: update.changed,
            }
        }
        Ok(_) => ConnectorProjectionEffect::Unavailable,
        Err(error) => projection_effect(error),
    };
    Ok((effect, report))
}

fn projection_readback_matches(store: &OpenClawConfigStore, expected: &Map<String, Value>) -> bool {
    let Ok(document) = store.read() else {
        return false;
    };
    let actual = document
        .get("mcp")
        .and_then(Value::as_object)
        .and_then(|mcp| mcp.get("servers"))
        .and_then(Value::as_object);
    expected
        .iter()
        .all(|(id, server)| actual.and_then(|servers| servers.get(id)) == Some(server))
        && actual.is_none_or(|servers| {
            servers
                .keys()
                .all(|id| !is_stale_managed_server_id(id, expected))
        })
}

fn is_stale_managed_server_id(id: &str, projected: &Map<String, Value>) -> bool {
    !projected.contains_key(id) && id.starts_with(MANAGED_EXTERNAL_SERVER_PREFIX)
}

pub(crate) fn projection_effect(error: OpenClawConfigStoreError) -> ConnectorProjectionEffect {
    match error {
        OpenClawConfigStoreError::TemporaryCreateFailed
        | OpenClawConfigStoreError::TemporaryWriteFailed
        | OpenClawConfigStoreError::TemporarySyncFailed
        | OpenClawConfigStoreError::ReplaceFailed
        | OpenClawConfigStoreError::CleanupFailed
        | OpenClawConfigStoreError::CommittedButNotDurable => ConnectorProjectionEffect::Unknown,
        OpenClawConfigStoreError::StateDirectoryRejected
        | OpenClawConfigStoreError::ReentrantUpdate
        | OpenClawConfigStoreError::ReadFailed
        | OpenClawConfigStoreError::InvalidDocument
        | OpenClawConfigStoreError::DocumentTooLarge => ConnectorProjectionEffect::Unavailable,
    }
}

fn server_for(
    connector: &Connector,
    secrets: &dyn ConnectorSecretResolverPort,
) -> Result<Option<Value>, ConnectorProjectionError> {
    if !connector.enabled() {
        return Ok(None);
    }
    match connector.kind() {
        ConnectorKind::McpStdio => {
            let Some(command) = connector.command() else {
                return Ok(None);
            };
            let mut server = Map::new();
            server.insert("command".into(), Value::String(command.to_owned()));
            optional_strings(&mut server, "args", connector.args());
            let env =
                merge_secret_values(connector.env(), connector.secret_env_references(), secrets)?;
            if !env.is_empty() {
                server.insert("env".into(), Value::Object(env));
            }
            optional_text(&mut server, "cwd", connector.cwd());
            Ok(Some(Value::Object(server)))
        }
        ConnectorKind::McpHttp => {
            let Some(url) = connector.url() else {
                return Err(ConnectorProjectionError::MissingHttpUrl);
            };
            let mut server = Map::new();
            server.insert("url".into(), Value::String(url.to_owned()));
            server.insert(
                "transport".into(),
                Value::String(
                    match connector
                        .transport()
                        .unwrap_or(McpTransport::StreamableHttp)
                    {
                        McpTransport::StreamableHttp => "streamable-http",
                        McpTransport::Sse => "sse",
                    }
                    .into(),
                ),
            );
            let headers = merge_secret_values(
                connector.headers(),
                connector.secret_header_references(),
                secrets,
            )?;
            if !headers.is_empty() {
                server.insert("headers".into(), Value::Object(headers));
            }
            if let Some(timeout) = connector.connection_timeout_ms() {
                server.insert("connectionTimeoutMs".into(), Value::Number(timeout.into()));
            }
            Ok(Some(Value::Object(server)))
        }
        ConnectorKind::Cli | ConnectorKind::Sdk | ConnectorKind::Http => Ok(None),
    }
}

fn merge_secret_values<'a>(
    public: Option<&'a std::collections::BTreeMap<String, String>>,
    secret_refs: impl Iterator<Item = (&'a str, &'a str)>,
    secrets: &dyn ConnectorSecretResolverPort,
) -> Result<Map<String, Value>, ConnectorProjectionError> {
    let mut values = public
        .into_iter()
        .flat_map(|values| values.iter())
        .map(|(key, value)| (key.clone(), Value::String(value.clone())))
        .collect::<Map<_, _>>();
    for (key, reference) in secret_refs {
        let reference = ConnectorSecretRef::try_new(reference)
            .map_err(|_| ConnectorProjectionError::InvalidSecretReference)?;
        let resolution = secrets
            .resolve(&reference)
            .map_err(|_| ConnectorProjectionError::SecretUnavailable)?;
        let ConnectorSecretResolution::Resolved { value, .. } = resolution else {
            return Err(ConnectorProjectionError::SecretUnavailable);
        };
        let mut resolved = String::new();
        value.with_private_bytes(|bytes| resolved = String::from_utf8_lossy(bytes).into_owned());
        values.insert(key.into(), Value::String(resolved));
    }
    Ok(values)
}

fn optional_text(object: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        object.insert(key.into(), Value::String(value.to_owned()));
    }
}
fn optional_strings<T: serde::Serialize + ?Sized>(
    object: &mut Map<String, Value>,
    key: &str,
    value: Option<&T>,
) {
    if let Some(value) = value {
        object.insert(
            key.into(),
            serde_json::to_value(value).expect("non-secret connector value is serializable"),
        );
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorObservation {
    Connected,
    Disconnected,
    Disabled,
    Unsupported,
    Unknown,
}

pub fn observe_external_connector(connector: &Connector) -> ConnectorObservation {
    if !connector.enabled() {
        return ConnectorObservation::Disabled;
    }
    if connector.has_secret_references() {
        return ConnectorObservation::Unsupported;
    }

    match connector.kind() {
        ConnectorKind::McpHttp => ConnectorObservation::Unknown,
        ConnectorKind::McpStdio | ConnectorKind::Cli | ConnectorKind::Sdk | ConnectorKind::Http => {
            ConnectorObservation::Unsupported
        }
    }
}

pub async fn probe_external_connector(connector: &Connector) -> ConnectorObservation {
    if !connector.enabled() {
        return ConnectorObservation::Disabled;
    }
    if connector.has_secret_references() {
        return ConnectorObservation::Unsupported;
    }

    let ConnectorKind::McpHttp = connector.kind() else {
        return ConnectorObservation::Unsupported;
    };
    let Some(url) = connector.url() else {
        return ConnectorObservation::Unknown;
    };

    let timeout_duration = Duration::from_millis(
        connector
            .connection_timeout_ms()
            .unwrap_or(DEFAULT_MCP_PROBE_TIMEOUT.as_millis() as u64),
    );
    let client = match Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => return ConnectorObservation::Unknown,
    };
    let started_at = Instant::now();
    let request = match connector
        .transport()
        .unwrap_or(McpTransport::StreamableHttp)
    {
        McpTransport::Sse => client
            .get(url)
            .header(header::ACCEPT, "text/event-stream")
            .headers(public_headers(connector)),
        McpTransport::StreamableHttp => client
            .post(url)
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header(header::CONTENT_TYPE, "application/json")
            .headers(public_headers(connector))
            .json(&initialize_request()),
    };
    let response = match timeout(timeout_duration, request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) | Err(_) => return ConnectorObservation::Disconnected,
    };
    if !response.status().is_success() {
        return ConnectorObservation::Disconnected;
    }
    if matches!(
        connector
            .transport()
            .unwrap_or(McpTransport::StreamableHttp),
        McpTransport::Sse
    ) {
        return ConnectorObservation::Connected;
    }
    let mut body_stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let chunk = match timeout(
            timeout_duration.saturating_sub(started_at.elapsed()),
            body_stream.next(),
        )
        .await
        {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(Some(Err(_))) | Err(_) => return ConnectorObservation::Disconnected,
            Ok(None) => break,
        };
        if chunk.len() > MAX_MCP_PROBE_BODY_BYTES.saturating_sub(body.len()) {
            return ConnectorObservation::Disconnected;
        }
        body.extend_from_slice(&chunk);
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(value) if valid_initialize_response(&value) => ConnectorObservation::Connected,
        _ => ConnectorObservation::Disconnected,
    }
}

fn public_headers(connector: &Connector) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(values) = connector.headers() {
        for (name, value) in values {
            let Ok(name) = header::HeaderName::try_from(name) else {
                continue;
            };
            let Ok(value) = header::HeaderValue::try_from(value) else {
                continue;
            };
            headers.insert(name, value);
        }
    }
    headers
}

fn initialize_request() -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": MCP_PROBE_REQUEST_ID,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": MCP_PROBE_CLIENT_NAME,
                "version": MCP_PROBE_CLIENT_VERSION,
            },
        },
    })
}

fn valid_initialize_response(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.get("jsonrpc") == Some(&Value::String("2.0".into()))
            && object
                .get("result")
                .is_some_and(|result| result.is_object())
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use environment::connectors::ConnectorInput;

    use super::*;

    #[test]
    fn observation_does_not_infer_runtime_health_from_connector_configuration() {
        let mut input = ConnectorInput::new("remote".into(), ConnectorKind::McpHttp);
        input.url = Some("https://example.test/mcp".into());
        let connector = Connector::new(input);

        assert_eq!(
            observe_external_connector(&connector),
            ConnectorObservation::Unknown
        );
    }

    #[test]
    fn enabled_non_http_connectors_are_unsupported_without_a_probe_producer() {
        let mut input = ConnectorInput::new("stdio".into(), ConnectorKind::McpStdio);
        input.enabled = Some(true);
        input.command = Some("private-command".into());
        input.args = Some(vec!["private-arg".into()]);
        let connector = Connector::new(input);

        assert_eq!(
            observe_external_connector(&connector),
            ConnectorObservation::Unsupported
        );
    }

    #[tokio::test]
    async fn secret_ref_mcp_connectors_are_unsupported_for_observe_and_probe() {
        let mut input = ConnectorInput::new("remote".into(), ConnectorKind::McpHttp);
        input.enabled = Some(true);
        input.url = Some("https://example.test/mcp".into());
        let connector = Connector::new(input).with_secret_references(
            None,
            Some(BTreeMap::from([(
                "Authorization".into(),
                "credential:v1:opaque".into(),
            )])),
            None,
        );

        assert_eq!(
            observe_external_connector(&connector),
            ConnectorObservation::Unsupported
        );
        assert_eq!(
            probe_external_connector(&connector).await,
            ConnectorObservation::Unsupported
        );
    }
}
