use std::collections::BTreeMap;

use environment::connectors::{Connector, ConnectorConfigValue, McpProgramSource};

use crate::runtime::external_connectors::{ConnectorKind, McpServerProgram, McpTransport};

pub(crate) struct ConnectorRecord {
    pub(super) id: String,
    pub(super) kind: ConnectorKind,
    pub(super) display_name: Option<String>,
    pub(super) description: Option<String>,
    pub(super) enabled: Option<bool>,
    pub(super) workspace_id: Option<String>,
    pub(super) source_id: Option<String>,
    pub(super) mcp_server_program: Option<McpServerProgram>,
    pub(super) tags: Option<Vec<String>>,
    pub(super) command: Option<String>,
    pub(super) args: Option<Vec<String>>,
    pub(super) cwd: Option<String>,
    pub(super) env: Option<BTreeMap<String, String>>,
    pub(super) url: Option<String>,
    pub(super) transport: Option<McpTransport>,
    pub(super) connection_timeout_ms: Option<u64>,
    pub(super) headers: Option<BTreeMap<String, String>>,
    pub(super) base_url: Option<String>,
    pub(super) provider: Option<String>,
    pub(super) package_name: Option<String>,
    pub(super) config: Option<BTreeMap<String, serde_json::Value>>,
    pub(super) secret_env: BTreeMap<String, String>,
    pub(super) secret_headers: BTreeMap<String, String>,
    pub(super) secret_config_refs: BTreeMap<String, String>,
}

fn connector_kind(kind: environment::connectors::ConnectorKind) -> ConnectorKind {
    match kind {
        environment::connectors::ConnectorKind::McpStdio => ConnectorKind::McpStdio,
        environment::connectors::ConnectorKind::McpHttp => ConnectorKind::McpHttp,
        environment::connectors::ConnectorKind::Cli => ConnectorKind::Cli,
        environment::connectors::ConnectorKind::Sdk => ConnectorKind::Sdk,
        environment::connectors::ConnectorKind::Http => ConnectorKind::Http,
    }
}

fn mcp_transport(transport: environment::connectors::McpTransport) -> McpTransport {
    match transport {
        environment::connectors::McpTransport::StreamableHttp => McpTransport::StreamableHttp,
        environment::connectors::McpTransport::Sse => McpTransport::Sse,
    }
}

fn mcp_program_source(
    source: McpProgramSource,
) -> crate::runtime::external_connectors::McpProgramSource {
    match source {
        McpProgramSource::SystemRuntime => {
            crate::runtime::external_connectors::McpProgramSource::SystemRuntime
        }
        McpProgramSource::ExternalCommand => {
            crate::runtime::external_connectors::McpProgramSource::ExternalCommand
        }
        McpProgramSource::ExternalUrl => {
            crate::runtime::external_connectors::McpProgramSource::ExternalUrl
        }
        McpProgramSource::BundledPlugin => {
            crate::runtime::external_connectors::McpProgramSource::BundledPlugin
        }
        McpProgramSource::BundledMcpApp => {
            crate::runtime::external_connectors::McpProgramSource::BundledMcpApp
        }
        McpProgramSource::ManagedLocal => {
            crate::runtime::external_connectors::McpProgramSource::ManagedLocal
        }
    }
}

fn mcp_server_program(program: &environment::connectors::McpServerProgram) -> McpServerProgram {
    McpServerProgram {
        source: mcp_program_source(program.source()),
        program_id: program.program_id().map(str::to_owned),
    }
}

fn config_value_to_json(value: &ConnectorConfigValue) -> serde_json::Value {
    match value {
        ConnectorConfigValue::Null => serde_json::Value::Null,
        ConnectorConfigValue::Bool(b) => serde_json::Value::Bool(*b),
        ConnectorConfigValue::Number(n) => {
            serde_json::from_str(n).unwrap_or(serde_json::Value::String(n.clone()))
        }
        ConnectorConfigValue::String(s) => serde_json::Value::String(s.clone()),
        ConnectorConfigValue::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(config_value_to_json).collect())
        }
        ConnectorConfigValue::Object(obj) => serde_json::Value::Object(
            obj.iter()
                .map(|(k, v)| (k.clone(), config_value_to_json(v)))
                .collect(),
        ),
    }
}

impl ConnectorRecord {
    pub(super) fn from_domain(connector: Connector) -> Self {
        let secret_env = connector
            .secret_env_references()
            .map(|(key, reference)| (key.to_owned(), reference.to_owned()))
            .collect();
        let secret_headers = connector
            .secret_header_references()
            .map(|(key, reference)| (key.to_owned(), reference.to_owned()))
            .collect();
        let secret_config_refs = connector
            .secret_config_references()
            .map(|(key, reference)| (key.to_owned(), reference.to_owned()))
            .collect();
        Self {
            id: connector.id().to_owned(),
            kind: connector_kind(connector.kind()),
            display_name: connector.display_name().map(str::to_owned),
            description: connector.description().map(str::to_owned),
            enabled: connector.enabled_value(),
            workspace_id: connector.workspace_id().map(str::to_owned),
            source_id: connector.source_id().map(str::to_owned),
            mcp_server_program: connector.mcp_server_program().map(mcp_server_program),
            tags: connector.tags().map(<[_]>::to_vec),
            command: connector.command().map(str::to_owned),
            args: connector.args().map(<[_]>::to_vec),
            cwd: connector.cwd().map(str::to_owned),
            env: connector.env().cloned(),
            url: connector.url().map(str::to_owned),
            transport: connector.transport().map(mcp_transport),
            connection_timeout_ms: connector.connection_timeout_ms(),
            headers: connector.headers().cloned(),
            base_url: connector.base_url().map(str::to_owned),
            provider: connector.provider().map(str::to_owned),
            package_name: connector.package_name().map(str::to_owned),
            config: connector.config().map(|c| {
                c.entries()
                    .iter()
                    .map(|(k, v)| (k.clone(), config_value_to_json(v)))
                    .collect()
            }),
            secret_env,
            secret_headers,
            secret_config_refs,
        }
    }
}

pub(crate) enum ConnectorListReceipt {
    Available(Vec<ConnectorRecord>),
}

pub(crate) enum ConnectorGetReceipt {
    Found(Box<ConnectorRecord>),
    Missing,
}

pub(crate) enum ConnectorProjectionReceipt {
    Written { changed: bool },
    Unknown,
    Unavailable,
}

pub(crate) enum ConnectorMutationReceipt {
    Stored {
        connector: Box<ConnectorRecord>,
        created: bool,
        revision: u64,
        configuration: ConnectorProjectionReceipt,
    },
    Removed {
        revision: u64,
        configuration: ConnectorProjectionReceipt,
    },
    Missing,
    Rejected,
    Unknown,
    Unavailable,
}

pub(crate) enum ConnectorObservationReceipt {
    Connected,
    Disconnected,
    Disabled,
    Unsupported,
    Unknown,
}

pub(crate) enum ConnectorProbeReceipt {
    Observed(ConnectorObservationReceipt),
    Missing,
    Unavailable,
}

pub(crate) enum ConnectorStatusReceipt {
    Available(Vec<(String, ConnectorObservationReceipt)>),
    Unavailable,
}

pub(crate) struct ConnectorCatalogProgram {
    pub(super) id: String,
    pub(super) source: McpProgramSource,
    pub(super) display_name: String,
    pub(super) connector_kinds: Vec<ConnectorKind>,
    pub(super) transport: Option<McpTransport>,
    pub(super) command: Option<String>,
    pub(super) args: Option<Vec<String>>,
    pub(super) url: Option<String>,
    pub(super) root_path: Option<String>,
    pub(super) env_keys: Option<Vec<String>>,
    pub(super) header_keys: Option<Vec<String>>,
}

pub(crate) enum ConnectorCatalogReceipt {
    Available(Vec<ConnectorCatalogProgram>),
}

pub(crate) struct ConnectorSessionTarget {
    pub(super) endpoint: ConnectorSessionEndpoint,
    pub(super) session_key: String,
}

pub(crate) enum ConnectorSessionEndpoint {
    Native {
        runtime_adapter_id: String,
        runtime_instance_id: String,
    },
    ProtocolConnector,
}

pub(crate) struct ConnectorSessionMcpServerEnabledTarget {
    pub(super) session: ConnectorSessionTarget,
    pub(super) server_id: String,
    pub(super) enabled: bool,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum RuntimeMcpServerSource {
    Preset,
    External,
    OpenClaw,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum RuntimeMcpServerKind {
    McpStdio,
    McpHttp,
    Unknown,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RuntimeMcpServerSummary {
    pub(super) server_id: String,
    pub(super) connector_id: Option<String>,
    pub(super) display_name: String,
    pub(super) description: Option<String>,
    pub(super) kind: RuntimeMcpServerKind,
    pub(super) source: RuntimeMcpServerSource,
    pub(super) enabled: bool,
    pub(super) managed: bool,
    pub(super) editable: bool,
    pub(super) removable: bool,
}

pub(crate) enum OpenClawMcpServersReceipt {
    Available(Vec<RuntimeMcpServerSummary>),
    Unavailable,
}

pub(crate) struct ConnectorSessionMcpServerStatusDetails {
    pub(super) server_id: String,
    pub(super) tool_count: Option<u64>,
    pub(super) launch_summary: Option<String>,
    pub(super) enabled_next_run: bool,
    pub(super) enabled_configurable: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum ConnectorSessionMcpServerState {
    DisabledByConfiguration,
    MissingFromNativeStatus,
    NativeStatusUnavailable,
    NativeDisabled,
    NativeNotConnected,
    NativeListingTools,
    NativeStaleConfig,
    NativeConnected,
    NativeDisconnected,
    NativeError,
    NativeEnabledFalse,
    NativeAvailable,
    NativePending,
}

pub(crate) struct ConnectorSessionMcpServerStatus {
    pub(super) server: RuntimeMcpServerSummary,
    pub(super) state: ConnectorSessionMcpServerState,
    pub(super) details: ConnectorSessionMcpServerStatusDetails,
}

pub(crate) enum ConnectorSessionStatusReceipt {
    Available(Vec<ConnectorSessionMcpServerStatus>),
}

pub(crate) enum ConnectorSessionMcpServerEnabledReceipt {
    Applied,
    Unavailable,
}
