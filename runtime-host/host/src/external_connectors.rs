use environment::Connector;
use openclaw::projection::connector::{
    catalog::ExternalMcpProgram,
    external::{ConnectorObservation, ConnectorProjectionEffect},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ListOutcome {
    Available(Vec<Connector>),
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GetOutcome {
    Found(Box<Connector>),
    Missing,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    Stored {
        connector: Box<Connector>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) launch_summary: Option<String>,
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

fn valid_session_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0') && value.len() <= 512
}
