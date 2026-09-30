use std::collections::BTreeMap;

use crate::domain::{Connector, ConnectorConfigValue, McpProgramSource as DomainMcpProgramSource};

use crate::delivery::{ConnectorKind, McpProgramSource, McpServerProgram, McpTransport};

pub(crate) struct ConnectorRecord {
    pub(crate) id: String,
    pub(crate) kind: ConnectorKind,
    pub(crate) display_name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) enabled: Option<bool>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) source_id: Option<String>,
    pub(crate) mcp_server_program: Option<McpServerProgram>,
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) command: Option<String>,
    pub(crate) args: Option<Vec<String>>,
    pub(crate) cwd: Option<String>,
    pub(crate) env: Option<BTreeMap<String, String>>,
    pub(crate) url: Option<String>,
    pub(crate) transport: Option<McpTransport>,
    pub(crate) connection_timeout_ms: Option<u64>,
    pub(crate) headers: Option<BTreeMap<String, String>>,
    pub(crate) base_url: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) package_name: Option<String>,
    pub(crate) config: Option<BTreeMap<String, serde_json::Value>>,
    pub(crate) secret_env: BTreeMap<String, String>,
    pub(crate) secret_headers: BTreeMap<String, String>,
    pub(crate) secret_config_refs: BTreeMap<String, String>,
}

fn connector_kind(kind: crate::domain::ConnectorKind) -> ConnectorKind {
    match kind {
        crate::domain::ConnectorKind::McpStdio => ConnectorKind::McpStdio,
        crate::domain::ConnectorKind::McpHttp => ConnectorKind::McpHttp,
        crate::domain::ConnectorKind::Cli => ConnectorKind::Cli,
        crate::domain::ConnectorKind::Sdk => ConnectorKind::Sdk,
        crate::domain::ConnectorKind::Http => ConnectorKind::Http,
    }
}

fn mcp_transport(transport: crate::domain::McpTransport) -> McpTransport {
    match transport {
        crate::domain::McpTransport::StreamableHttp => McpTransport::StreamableHttp,
        crate::domain::McpTransport::Sse => McpTransport::Sse,
    }
}

fn mcp_program_source(source: DomainMcpProgramSource) -> McpProgramSource {
    match source {
        DomainMcpProgramSource::SystemRuntime => McpProgramSource::SystemRuntime,
        DomainMcpProgramSource::ExternalCommand => McpProgramSource::ExternalCommand,
        DomainMcpProgramSource::ExternalUrl => McpProgramSource::ExternalUrl,
        DomainMcpProgramSource::BundledPlugin => McpProgramSource::BundledPlugin,
        DomainMcpProgramSource::BundledMcpApp => McpProgramSource::BundledMcpApp,
        DomainMcpProgramSource::ManagedLocal => McpProgramSource::ManagedLocal,
    }
}

fn mcp_server_program(program: &crate::domain::McpServerProgram) -> McpServerProgram {
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
    pub(crate) fn from_domain(connector: Connector) -> Self {
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

#[derive(Clone)]
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
    pub(crate) id: String,
    pub(crate) source: McpProgramSource,
    pub(crate) display_name: String,
    pub(crate) connector_kinds: Vec<ConnectorKind>,
    pub(crate) transport: Option<McpTransport>,
    pub(crate) command: Option<String>,
    pub(crate) args: Option<Vec<String>>,
    pub(crate) url: Option<String>,
    pub(crate) root_path: Option<String>,
    pub(crate) env_keys: Option<Vec<String>>,
    pub(crate) header_keys: Option<Vec<String>>,
}

pub(crate) enum ConnectorCatalogReceipt {
    Available(Vec<ConnectorCatalogProgram>),
}

pub(crate) struct ConnectorSessionTarget {
    pub(crate) endpoint: ConnectorSessionEndpoint,
    pub(crate) session_key: String,
}

pub(crate) enum ConnectorSessionEndpoint {
    Native {
        runtime_adapter_id: String,
        runtime_instance_id: String,
    },
    ProtocolConnector,
}

pub(crate) struct ConnectorSessionMcpServerEnabledTarget {
    pub(crate) session: ConnectorSessionTarget,
    pub(crate) server_id: String,
    pub(crate) enabled: bool,
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
    pub(crate) server_id: String,
    pub(crate) connector_id: Option<String>,
    pub(crate) display_name: String,
    pub(crate) description: Option<String>,
    pub(crate) kind: RuntimeMcpServerKind,
    pub(crate) source: RuntimeMcpServerSource,
    pub(crate) enabled: bool,
    pub(crate) managed: bool,
    pub(crate) editable: bool,
    pub(crate) removable: bool,
}

pub(crate) enum OpenClawMcpServersReceipt {
    Available(Vec<RuntimeMcpServerSummary>),
    Unavailable,
}

pub(crate) struct ConnectorSessionMcpServerStatusDetails {
    pub(crate) server_id: String,
    pub(crate) tool_count: Option<u64>,
    pub(crate) launch_summary: Option<String>,
    pub(crate) enabled_next_run: bool,
    pub(crate) enabled_configurable: bool,
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
    pub(crate) server: RuntimeMcpServerSummary,
    pub(crate) state: ConnectorSessionMcpServerState,
    pub(crate) details: ConnectorSessionMcpServerStatusDetails,
}

pub(crate) enum ConnectorSessionStatusReceipt {
    Available(Vec<ConnectorSessionMcpServerStatus>),
}

pub(crate) enum ConnectorSessionMcpServerEnabledReceipt {
    Applied,
    Unavailable,
}
