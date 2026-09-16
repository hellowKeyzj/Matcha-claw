use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{
    Connector, ConnectorCatalog, ConnectorConfig, ConnectorConfigValue, ConnectorInput,
    ConnectorKind, McpProgramSource, McpServerProgram, McpTransport, store::ConnectorStoreError,
};

pub(super) const STORE_VERSION: u8 = 3;
pub(super) const LEGACY_STORE_VERSION: u8 = 1;
pub(super) const PREVIOUS_STORE_VERSION: u8 = 2;
pub(super) const MAX_STORE_BYTES: u64 = 1_048_576;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConnectorRevision {
    pub(super) revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) applied_revision: Option<u64>,
    #[serde(default)]
    pub(super) tombstoned: bool,
}

pub(super) fn next_revision(
    current: Option<&ConnectorRevision>,
) -> Result<u64, ConnectorStoreError> {
    current.map_or(Ok(1), |record| {
        record
            .revision
            .checked_add(1)
            .ok_or(ConnectorStoreError::RevisionOverflow)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ConnectorStoreDocument {
    version: u8,
    connectors: Vec<PersistedConnector>,
    #[serde(default)]
    revisions: BTreeMap<String, ConnectorRevision>,
}
impl ConnectorStoreDocument {
    pub(super) fn from_state(
        catalog: &ConnectorCatalog,
        revisions: &BTreeMap<String, ConnectorRevision>,
    ) -> Self {
        Self {
            version: STORE_VERSION,
            connectors: catalog
                .connectors()
                .iter()
                .map(PersistedConnector::from_domain)
                .collect(),
            revisions: revisions.clone(),
        }
    }

    pub(super) fn into_state(
        self,
    ) -> Result<(ConnectorCatalog, BTreeMap<String, ConnectorRevision>), ConnectorStoreError> {
        if self.version != STORE_VERSION
            && self.version != PREVIOUS_STORE_VERSION
            && self.version != LEGACY_STORE_VERSION
        {
            return Err(ConnectorStoreError::Decode);
        }
        if self.version != STORE_VERSION
            && self
                .connectors
                .iter()
                .any(PersistedConnector::has_secret_references)
        {
            return Err(ConnectorStoreError::Decode);
        }
        let connectors = self
            .connectors
            .into_iter()
            .map(PersistedConnector::into_domain)
            .collect::<Result<Vec<_>, _>>()?;
        let catalog = ConnectorCatalog::try_new(connectors).map_err(ConnectorStoreError::from)?;
        let revisions = if self.version == LEGACY_STORE_VERSION {
            catalog
                .connectors()
                .iter()
                .map(|connector| {
                    (
                        connector.id().to_owned(),
                        ConnectorRevision {
                            revision: 1,
                            applied_revision: None,
                            tombstoned: false,
                        },
                    )
                })
                .collect()
        } else {
            validate_revisions(&catalog, self.revisions)?
        };
        Ok((catalog, revisions))
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedConnector {
    id: String,
    kind: PersistedConnectorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mcp_server_program: Option<PersistedMcpServerProgram>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transport: Option<PersistedMcpTransport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_env: Option<BTreeMap<String, PersistedConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_headers: Option<BTreeMap<String, PersistedConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_config_refs: Option<BTreeMap<String, PersistedConnectorSecretReference>>,
}

impl PersistedConnector {
    fn from_domain(connector: &Connector) -> Self {
        Self {
            id: connector.id().to_owned(),
            kind: PersistedConnectorKind::from_domain(connector.kind()),
            display_name: connector.display_name().map(str::to_owned),
            description: connector.description().map(str::to_owned),
            enabled: connector.enabled_value(),
            workspace_id: connector.workspace_id().map(str::to_owned),
            source_id: connector.source_id().map(str::to_owned),
            mcp_server_program: connector
                .mcp_server_program()
                .map(PersistedMcpServerProgram::from_domain),
            tags: connector.tags().map(<[_]>::to_vec),
            command: connector.command().map(str::to_owned),
            args: connector.args().map(<[_]>::to_vec),
            cwd: connector.cwd().map(str::to_owned),
            env: connector.env().cloned(),
            url: connector.url().map(str::to_owned),
            transport: connector
                .transport()
                .map(PersistedMcpTransport::from_domain),
            headers: connector.headers().cloned(),
            connection_timeout_ms: connector.connection_timeout_ms(),
            base_url: connector.base_url().map(str::to_owned),
            provider: connector.provider().map(str::to_owned),
            package_name: connector.package_name().map(str::to_owned),
            config: connector.config().map(persisted_config),
            secret_env: connector
                .secret_env_references()
                .map(|(key, reference)| {
                    (
                        key.to_owned(),
                        PersistedConnectorSecretReference::secret_ref(reference),
                    )
                })
                .collect::<BTreeMap<_, _>>()
                .into_empty_none(),
            secret_headers: connector
                .secret_header_references()
                .map(|(key, reference)| {
                    (
                        key.to_owned(),
                        PersistedConnectorSecretReference::secret_ref(reference),
                    )
                })
                .collect::<BTreeMap<_, _>>()
                .into_empty_none(),
            secret_config_refs: connector
                .secret_config_references()
                .map(|(key, reference)| {
                    (
                        key.to_owned(),
                        PersistedConnectorSecretReference::secret_ref(reference),
                    )
                })
                .collect::<BTreeMap<_, _>>()
                .into_empty_none(),
        }
    }

    fn into_domain(self) -> Result<Connector, ConnectorStoreError> {
        let mut input = ConnectorInput::new(self.id, self.kind.into_domain());
        input.display_name = self.display_name;
        input.description = self.description;
        input.enabled = self.enabled;
        input.workspace_id = self.workspace_id;
        input.source_id = self.source_id;
        input.mcp_server_program = self
            .mcp_server_program
            .map(PersistedMcpServerProgram::into_domain);
        input.tags = self.tags;
        input.command = self.command;
        input.args = self.args;
        input.cwd = self.cwd;
        input.env = self.env;
        input.url = self.url;
        input.transport = self.transport.map(PersistedMcpTransport::into_domain);
        input.headers = self.headers;
        input.connection_timeout_ms = self.connection_timeout_ms;
        input.base_url = self.base_url;
        input.provider = self.provider;
        input.package_name = self.package_name;
        input.config = self.config.map(domain_config).transpose()?;
        Ok(Connector::new(input).with_secret_references(
            secret_reference_map(self.secret_env),
            secret_reference_map(self.secret_headers),
            secret_reference_map(self.secret_config_refs),
        ))
    }

    fn has_secret_references(&self) -> bool {
        self.secret_env.is_some()
            || self.secret_headers.is_some()
            || self.secret_config_refs.is_some()
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PersistedConnectorKind {
    McpStdio,
    McpHttp,
    Cli,
    Sdk,
    Http,
}

impl PersistedConnectorKind {
    fn from_domain(kind: ConnectorKind) -> Self {
        match kind {
            ConnectorKind::McpStdio => Self::McpStdio,
            ConnectorKind::McpHttp => Self::McpHttp,
            ConnectorKind::Cli => Self::Cli,
            ConnectorKind::Sdk => Self::Sdk,
            ConnectorKind::Http => Self::Http,
        }
    }

    fn into_domain(self) -> ConnectorKind {
        match self {
            Self::McpStdio => ConnectorKind::McpStdio,
            Self::McpHttp => ConnectorKind::McpHttp,
            Self::Cli => ConnectorKind::Cli,
            Self::Sdk => ConnectorKind::Sdk,
            Self::Http => ConnectorKind::Http,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PersistedMcpTransport {
    StreamableHttp,
    Sse,
}

impl PersistedMcpTransport {
    fn from_domain(transport: McpTransport) -> Self {
        match transport {
            McpTransport::StreamableHttp => Self::StreamableHttp,
            McpTransport::Sse => Self::Sse,
        }
    }

    fn into_domain(self) -> McpTransport {
        match self {
            Self::StreamableHttp => McpTransport::StreamableHttp,
            Self::Sse => McpTransport::Sse,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PersistedMcpProgramSource {
    SystemRuntime,
    ExternalCommand,
    ExternalUrl,
    BundledPlugin,
    BundledMcpApp,
    ManagedLocal,
}

impl PersistedMcpProgramSource {
    fn from_domain(source: McpProgramSource) -> Self {
        match source {
            McpProgramSource::SystemRuntime => Self::SystemRuntime,
            McpProgramSource::ExternalCommand => Self::ExternalCommand,
            McpProgramSource::ExternalUrl => Self::ExternalUrl,
            McpProgramSource::BundledPlugin => Self::BundledPlugin,
            McpProgramSource::BundledMcpApp => Self::BundledMcpApp,
            McpProgramSource::ManagedLocal => Self::ManagedLocal,
        }
    }

    fn into_domain(self) -> McpProgramSource {
        match self {
            Self::SystemRuntime => McpProgramSource::SystemRuntime,
            Self::ExternalCommand => McpProgramSource::ExternalCommand,
            Self::ExternalUrl => McpProgramSource::ExternalUrl,
            Self::BundledPlugin => McpProgramSource::BundledPlugin,
            Self::BundledMcpApp => McpProgramSource::BundledMcpApp,
            Self::ManagedLocal => McpProgramSource::ManagedLocal,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedMcpServerProgram {
    source: PersistedMcpProgramSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    program_id: Option<String>,
}

impl PersistedMcpServerProgram {
    fn from_domain(program: &McpServerProgram) -> Self {
        Self {
            source: PersistedMcpProgramSource::from_domain(program.source()),
            program_id: program.program_id().map(str::to_owned),
        }
    }

    fn into_domain(self) -> McpServerProgram {
        McpServerProgram::new(self.source.into_domain(), self.program_id)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedConnectorSecretReference {
    kind: PersistedConnectorSecretReferenceKind,
    #[serde(rename = "ref")]
    reference: String,
}

impl PersistedConnectorSecretReference {
    fn secret_ref(reference: &str) -> Self {
        Self {
            kind: PersistedConnectorSecretReferenceKind::SecretRef,
            reference: reference.to_owned(),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PersistedConnectorSecretReferenceKind {
    SecretRef,
}

fn persisted_config(config: &ConnectorConfig) -> serde_json::Map<String, serde_json::Value> {
    config
        .entries()
        .iter()
        .map(|(key, value)| (key.clone(), persisted_config_value(value)))
        .collect()
}

fn persisted_config_value(value: &ConnectorConfigValue) -> serde_json::Value {
    match value {
        ConnectorConfigValue::Null => serde_json::Value::Null,
        ConnectorConfigValue::Bool(value) => serde_json::Value::Bool(*value),
        ConnectorConfigValue::Number(value) => serde_json::Value::Number(
            serde_json::from_str(value).expect("validated connector config number"),
        ),
        ConnectorConfigValue::String(value) => serde_json::Value::String(value.clone()),
        ConnectorConfigValue::Array(values) => {
            serde_json::Value::Array(values.iter().map(persisted_config_value).collect())
        }
        ConnectorConfigValue::Object(values) => serde_json::Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), persisted_config_value(value)))
                .collect(),
        ),
    }
}

fn domain_config(
    config: serde_json::Map<String, serde_json::Value>,
) -> Result<ConnectorConfig, ConnectorStoreError> {
    ConnectorConfig::try_new(
        config
            .into_iter()
            .map(|(key, value)| domain_config_value(value).map(|value| (key, value)))
            .collect::<Option<BTreeMap<_, _>>>()
            .ok_or(ConnectorStoreError::Decode)?,
    )
    .map_err(|_| ConnectorStoreError::Decode)
}

fn domain_config_value(value: serde_json::Value) -> Option<ConnectorConfigValue> {
    match value {
        serde_json::Value::Null => Some(ConnectorConfigValue::Null),
        serde_json::Value::Bool(value) => Some(ConnectorConfigValue::Bool(value)),
        serde_json::Value::Number(value) => Some(ConnectorConfigValue::Number(value.to_string())),
        serde_json::Value::String(value) => Some(ConnectorConfigValue::String(value)),
        serde_json::Value::Array(values) => values
            .into_iter()
            .map(domain_config_value)
            .collect::<Option<Vec<_>>>()
            .map(ConnectorConfigValue::Array),
        serde_json::Value::Object(values) => values
            .into_iter()
            .map(|(key, value)| domain_config_value(value).map(|value| (key, value)))
            .collect::<Option<BTreeMap<_, _>>>()
            .map(ConnectorConfigValue::Object),
    }
}

fn secret_reference_map(
    references: Option<BTreeMap<String, PersistedConnectorSecretReference>>,
) -> Option<BTreeMap<String, String>> {
    references.map(|references| {
        references
            .into_iter()
            .map(|(key, reference)| (key, reference.reference))
            .collect()
    })
}

trait EmptyMapOption {
    fn into_empty_none(self) -> Option<Self>
    where
        Self: Sized;
}

impl<K, V> EmptyMapOption for BTreeMap<K, V> {
    fn into_empty_none(self) -> Option<Self> {
        (!self.is_empty()).then_some(self)
    }
}

fn validate_revisions(
    catalog: &ConnectorCatalog,
    revisions: BTreeMap<String, ConnectorRevision>,
) -> Result<BTreeMap<String, ConnectorRevision>, ConnectorStoreError> {
    for connector in catalog.connectors() {
        let Some(revision) = revisions.get(connector.id()) else {
            return Err(ConnectorStoreError::Decode);
        };
        if revision.revision == 0
            || revision.tombstoned
            || revision.applied_revision > Some(revision.revision)
        {
            return Err(ConnectorStoreError::Decode);
        }
    }
    if revisions.values().any(|record| {
        record.revision == 0
            || (!record.tombstoned && record.applied_revision > Some(record.revision))
    }) {
        return Err(ConnectorStoreError::Decode);
    }
    Ok(revisions)
}
