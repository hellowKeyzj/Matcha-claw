use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConnectorKind {
    McpStdio,
    McpHttp,
    Cli,
    Sdk,
    Http,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum McpTransport {
    StreamableHttp,
    Sse,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum McpProgramSource {
    SystemRuntime,
    ExternalCommand,
    ExternalUrl,
    BundledPlugin,
    BundledMcpApp,
    ManagedLocal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpServerProgram {
    pub(crate) source: McpProgramSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) program_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectorSecretReference {
    pub(crate) kind: ConnectorSecretReferenceKind,
    #[serde(rename = "ref")]
    pub(crate) reference: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConnectorSecretReferenceKind {
    SecretRef,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorReadModel {
    pub(crate) id: String,
    pub(crate) kind: ConnectorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) mcp_server_program: Option<McpServerProgram>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) transport: Option<McpTransport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) connection_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) config: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) secret_env: Option<BTreeMap<String, ConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) secret_headers: Option<BTreeMap<String, ConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) secret_config_refs: Option<BTreeMap<String, ConnectorSecretReference>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalMcpProgram {
    pub(crate) id: String,
    pub(crate) source: McpProgramSource,
    pub(crate) display_name: String,
    pub(crate) connector_kinds: Vec<ConnectorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) transport: Option<McpTransport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) env_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) header_keys: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectorProjectionEffect {
    Written { changed: bool },
    Unknown,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectorObservation {
    Connected,
    Disconnected,
    Disabled,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ListOutcome {
    Available(Vec<ConnectorReadModel>),
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum GetOutcome {
    Found(Box<ConnectorReadModel>),
    Missing,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MutationOutcome {
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
pub(crate) enum ProbeOutcome {
    Observed(ConnectorObservation),
    Missing,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum StatusOutcome {
    Available(Vec<(String, ConnectorObservation)>),
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CatalogOutcome {
    Available(Vec<ExternalMcpProgram>),
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum McpServerKind {
    McpStdio,
    McpHttp,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum OpenClawMcpServerSource {
    Preset,
    External,
    Openclaw,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenClawMcpServerSummary {
    pub(crate) server_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) connector_id: Option<String>,
    pub(crate) display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    pub(crate) kind: McpServerKind,
    pub(crate) source: OpenClawMcpServerSource,
    pub(crate) enabled: bool,
    pub(crate) managed: bool,
    pub(crate) editable: bool,
    pub(crate) removable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OpenClawMcpServersOutcome {
    Available(Vec<OpenClawMcpServerSummary>),
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum SessionEndpoint {
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
pub(crate) struct SessionIdentity {
    pub(crate) endpoint: SessionEndpoint,
    pub(crate) agent_id: String,
    pub(crate) session_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionStatusTarget {
    pub(crate) session_identity: SessionIdentity,
}

impl SessionIdentity {
    pub(crate) fn is_valid(&self) -> bool {
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
    pub(crate) fn is_valid(&self) -> bool {
        self.session_identity.is_valid()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SessionConnectorResultType {
    Connected,
    Disconnected,
    Pending,
    Unsupported,
    Disabled,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionConnectorStatusDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server_id: Option<String>,
    #[serde(skip_serializing)]
    pub(crate) session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) launch_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) enabled_next_run: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) enabled_configurable: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionConnectorStatus {
    pub(crate) connector_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) display_name: Option<String>,
    pub(crate) adapter_id: String,
    pub(crate) target_kind: &'static str,
    pub(crate) result_type: SessionConnectorResultType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) details: Option<SessionConnectorStatusDetails>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionStatusOutcome {
    Available(Vec<SessionConnectorStatus>),
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionMcpServerEnabledTarget {
    pub(crate) session_identity: SessionIdentity,
    pub(crate) server_id: String,
    pub(crate) enabled: bool,
}

impl SessionMcpServerEnabledTarget {
    pub(crate) fn is_valid(&self) -> bool {
        self.session_identity.is_valid() && valid_session_text(&self.server_id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionMcpServerEnabledOutcome {
    Applied,
    Unavailable,
}

fn valid_session_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0') && value.len() <= 512
}
