use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorKind {
    McpStdio,
    McpHttp,
    Cli,
    Sdk,
    Http,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpTransport {
    StreamableHttp,
    Sse,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpProgramSource {
    SystemRuntime,
    ExternalCommand,
    ExternalUrl,
    BundledPlugin,
    BundledMcpApp,
    ManagedLocal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerProgram {
    pub source: McpProgramSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorSecretReference {
    pub kind: ConnectorSecretReferenceKind,
    #[serde(rename = "ref")]
    pub reference: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorSecretReferenceKind {
    SecretRef,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorReadModel {
    pub id: String,
    pub kind: ConnectorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_server_program: Option<McpServerProgram>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_env: Option<BTreeMap<String, ConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_headers: Option<BTreeMap<String, ConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_config_refs: Option<BTreeMap<String, ConnectorSecretReference>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpProgram {
    pub id: String,
    pub source: McpProgramSource,
    pub display_name: String,
    pub connector_kinds: Vec<ConnectorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_keys: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorProjectionEffect {
    Written { changed: bool },
    Unknown,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorObservation {
    Connected,
    Disconnected,
    Disabled,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ListOutcome {
    Available(Vec<ConnectorReadModel>),
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GetOutcome {
    Found(Box<ConnectorReadModel>),
    Missing,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    Stored {
        connector: Box<ConnectorReadModel>,
        created: bool,
        revision: u64,
        configuration: ConnectorProjectionEffect,
    },
    Removed {
        revision: u64,
        configuration: ConnectorProjectionEffect,
    },
    Missing,
    Rejected,
    Unknown,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProbeOutcome {
    Observed(ConnectorObservation),
    Missing,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StatusOutcome {
    Available(Vec<(String, ConnectorObservation)>),
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogOutcome {
    Available(Vec<ExternalMcpProgram>),
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpServerKind {
    McpStdio,
    McpHttp,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenClawMcpServerSource {
    Preset,
    External,
    Openclaw,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawMcpServerSummary {
    pub server_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector_id: Option<String>,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: McpServerKind,
    pub source: OpenClawMcpServerSource,
    pub enabled: bool,
    pub managed: bool,
    pub editable: bool,
    pub removable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OpenClawMcpServersOutcome {
    Available(Vec<OpenClawMcpServerSummary>),
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SessionEndpoint {
    #[serde(rename = "native-runtime")]
    Native {
        #[serde(rename = "runtimeAdapterId")]
        runtime_adapter_id: String,
        #[serde(rename = "runtimeInstanceId")]
        runtime_instance_id: String,
    },
    #[serde(rename = "protocol-connector")]
    ProtocolConnector {
        #[serde(rename = "protocolId")]
        protocol_id: String,
        #[serde(rename = "connectorId")]
        connector_id: String,
        #[serde(rename = "endpointId")]
        endpoint_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionIdentity {
    pub endpoint: SessionEndpoint,
    pub agent_id: String,
    pub session_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStatusTarget {
    pub session_identity: SessionIdentity,
}

impl SessionIdentity {
    pub fn is_valid(&self) -> bool {
        valid_session_text(&self.agent_id)
            && valid_session_text(&self.session_key)
            && match &self.endpoint {
                SessionEndpoint::Native {
                    runtime_adapter_id,
                    runtime_instance_id,
                } => {
                    valid_session_text(runtime_adapter_id)
                        && valid_session_text(runtime_instance_id)
                }
                SessionEndpoint::ProtocolConnector {
                    protocol_id,
                    connector_id,
                    endpoint_id,
                } => {
                    valid_session_text(protocol_id)
                        && valid_session_text(connector_id)
                        && valid_session_text(endpoint_id)
                }
            }
    }
}

impl SessionStatusTarget {
    pub fn is_valid(&self) -> bool {
        self.session_identity.is_valid()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionConnectorResultType {
    Connected,
    Disconnected,
    Pending,
    Unsupported,
    Disabled,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConnectorStatusDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(skip_serializing)]
    pub session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_next_run: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_configurable: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConnectorStatus {
    pub connector_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub adapter_id: String,
    pub target_kind: &'static str,
    pub result_type: SessionConnectorResultType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<SessionConnectorStatusDetails>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionStatusOutcome {
    Available(Vec<SessionConnectorStatus>),
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMcpServerEnabledTarget {
    pub session_identity: SessionIdentity,
    pub server_id: String,
    pub enabled: bool,
}

impl SessionMcpServerEnabledTarget {
    pub fn is_valid(&self) -> bool {
        self.session_identity.is_valid() && valid_session_text(&self.server_id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionMcpServerEnabledOutcome {
    Applied,
    Unavailable,
}

fn valid_session_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0') && value.len() <= 512
}
