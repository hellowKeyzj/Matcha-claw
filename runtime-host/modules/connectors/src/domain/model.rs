use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Serialize};

use crate::ports::ConnectorSecretRef;

const MAX_CONNECTOR_ID_BYTES: usize = 128;
const MAX_CONNECTORS: usize = 256;
const BLOCKED_ENVIRONMENT_KEYS: &[&str] = &[
    "NODE_OPTIONS",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PERL5OPT",
    "PS4",
    "RUBYOPT",
    "SHELLOPTS",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorKind {
    McpStdio,
    McpHttp,
    Cli,
    Sdk,
    Http,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpTransport {
    StreamableHttp,
    Sse,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
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

impl McpServerProgram {
    pub fn new(source: McpProgramSource, program_id: Option<String>) -> Self {
        Self { source, program_id }
    }

    pub const fn source(&self) -> McpProgramSource {
        self.source
    }

    pub fn program_id(&self) -> Option<&str> {
        self.program_id.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorConfig {
    entries: BTreeMap<String, ConnectorConfigValue>,
}

impl ConnectorConfig {
    pub fn try_new(
        entries: BTreeMap<String, ConnectorConfigValue>,
    ) -> Result<Self, InvalidConnectorConfig> {
        if entries.values().all(valid_config_value) {
            Ok(Self { entries })
        } else {
            Err(InvalidConnectorConfig)
        }
    }

    pub fn entries(&self) -> &BTreeMap<String, ConnectorConfigValue> {
        &self.entries
    }

    fn contains_secret_key(&self) -> bool {
        contains_secret_config_key(&self.entries)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectorConfigValue {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<ConnectorConfigValue>),
    Object(BTreeMap<String, ConnectorConfigValue>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidConnectorConfig;

impl fmt::Display for InvalidConnectorConfig {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("connector config is invalid")
    }
}

impl std::error::Error for InvalidConnectorConfig {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorPublicInput {
    id: String,
    kind: ConnectorKind,
    display_name: Option<String>,
    description: Option<String>,
    enabled: Option<bool>,
    workspace_id: Option<String>,
    source_id: Option<String>,
    mcp_server_program: Option<McpServerProgram>,
    tags: Option<Vec<String>>,
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<BTreeMap<String, String>>,
    url: Option<String>,
    transport: Option<McpTransport>,
    headers: Option<BTreeMap<String, String>>,
    connection_timeout_ms: Option<u64>,
    base_url: Option<String>,
    provider: Option<String>,
    package_name: Option<String>,
    config: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(flatten)]
    secret_references: Option<ConnectorSecretReferences>,
}

impl ConnectorPublicInput {
    pub fn into_connector(self) -> Result<Connector, ConnectorError> {
        let mut input = ConnectorInput::new(self.id, self.kind);
        input.display_name = self.display_name;
        input.description = self.description;
        input.enabled = self.enabled;
        input.workspace_id = self.workspace_id;
        input.source_id = self.source_id;
        input.mcp_server_program = self.mcp_server_program;
        input.tags = self.tags;
        input.command = self.command;
        input.args = self.args;
        input.cwd = self.cwd;
        input.env = self.env;
        input.url = self.url;
        input.transport = self.transport;
        input.headers = self.headers;
        input.connection_timeout_ms = self.connection_timeout_ms;
        input.base_url = self.base_url;
        input.provider = self.provider;
        input.package_name = self.package_name;
        input.config = self.config.map(connector_config).transpose()?;
        let (secret_env, secret_headers, secret_config_refs) = self
            .secret_references
            .map(ConnectorSecretReferences::into_reference_maps)
            .unwrap_or_default();
        Ok(Connector::new(input).with_secret_references(
            secret_env,
            secret_headers,
            secret_config_refs,
        ))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorInput {
    pub id: String,
    pub kind: ConnectorKind,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub enabled: Option<bool>,
    pub workspace_id: Option<String>,
    pub source_id: Option<String>,
    pub mcp_server_program: Option<McpServerProgram>,
    pub tags: Option<Vec<String>>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub url: Option<String>,
    pub transport: Option<McpTransport>,
    pub headers: Option<BTreeMap<String, String>>,
    pub connection_timeout_ms: Option<u64>,
    pub base_url: Option<String>,
    pub provider: Option<String>,
    pub package_name: Option<String>,
    pub config: Option<ConnectorConfig>,
}

impl ConnectorInput {
    pub fn new(id: String, kind: ConnectorKind) -> Self {
        Self {
            id,
            kind,
            display_name: None,
            description: None,
            enabled: None,
            workspace_id: None,
            source_id: None,
            mcp_server_program: None,
            tags: None,
            command: None,
            args: None,
            cwd: None,
            env: None,
            url: None,
            transport: None,
            headers: None,
            connection_timeout_ms: None,
            base_url: None,
            provider: None,
            package_name: None,
            config: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectorSecretReferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) secret_env: Option<BTreeMap<String, ConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) secret_headers: Option<BTreeMap<String, ConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) secret_config_refs: Option<BTreeMap<String, ConnectorSecretReference>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectorSecretReference {
    pub(crate) kind: ConnectorSecretReferenceKind,
    #[serde(rename = "ref")]
    pub(crate) reference: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConnectorSecretReferenceKind {
    SecretRef,
}

impl ConnectorSecretReferences {
    fn into_reference_maps(
        self,
    ) -> (
        Option<BTreeMap<String, String>>,
        Option<BTreeMap<String, String>>,
        Option<BTreeMap<String, String>>,
    ) {
        (
            secret_reference_map(self.secret_env),
            secret_reference_map(self.secret_headers),
            secret_reference_map(self.secret_config_refs),
        )
    }

    fn has_values(&self) -> bool {
        self.secret_env
            .as_ref()
            .is_some_and(|values| !values.is_empty())
            || self
                .secret_headers
                .as_ref()
                .is_some_and(|values| !values.is_empty())
            || self
                .secret_config_refs
                .as_ref()
                .is_some_and(|values| !values.is_empty())
    }

    pub(crate) fn validate(&self, connector_kind: &ConnectorKind) -> Result<(), ConnectorError> {
        let valid_fields = match connector_kind {
            ConnectorKind::McpStdio | ConnectorKind::Cli => {
                self.secret_headers.is_none() && self.secret_config_refs.is_none()
            }
            ConnectorKind::McpHttp | ConnectorKind::Http => {
                self.secret_env.is_none() && self.secret_config_refs.is_none()
            }
            ConnectorKind::Sdk => self.secret_env.is_none() && self.secret_headers.is_none(),
        };
        if !valid_fields
            || !valid_secret_reference_map(self.secret_env.as_ref(), true)
            || !valid_secret_reference_map(self.secret_headers.as_ref(), false)
            || !valid_secret_reference_map(self.secret_config_refs.as_ref(), false)
        {
            return Err(ConnectorError::Invalid);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Connector {
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
    pub(crate) headers: Option<BTreeMap<String, String>>,
    pub(crate) connection_timeout_ms: Option<u64>,
    pub(crate) base_url: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) package_name: Option<String>,
    pub(crate) config: Option<ConnectorConfig>,
    pub(crate) secret_references: Option<ConnectorSecretReferences>,
}

impl Connector {
    pub fn system_runtime() -> Self {
        Self {
            id: "matcha".into(),
            kind: ConnectorKind::McpStdio,
            display_name: Some("Matcha system runtime".into()),
            description: Some("Managed by Matcha".into()),
            enabled: Some(true),
            workspace_id: None,
            source_id: None,
            mcp_server_program: Some(McpServerProgram::new(
                McpProgramSource::SystemRuntime,
                Some("system-runtime:matcha".into()),
            )),
            tags: None,
            command: None,
            args: None,
            cwd: None,
            env: None,
            url: None,
            transport: None,
            headers: None,
            connection_timeout_ms: None,
            base_url: None,
            provider: None,
            package_name: None,
            config: None,
            secret_references: None,
        }
    }

    pub fn new(input: ConnectorInput) -> Self {
        Self {
            id: input.id,
            kind: input.kind,
            display_name: input.display_name,
            description: input.description,
            enabled: input.enabled,
            workspace_id: input.workspace_id,
            source_id: input.source_id,
            mcp_server_program: input.mcp_server_program,
            tags: input.tags,
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env: input.env,
            url: input.url,
            transport: input.transport,
            headers: input.headers,
            connection_timeout_ms: input.connection_timeout_ms,
            base_url: input.base_url,
            provider: input.provider,
            package_name: input.package_name,
            config: input.config,
            secret_references: None,
        }
    }

    pub fn with_secret_references(
        mut self,
        secret_env: Option<BTreeMap<String, String>>,
        secret_headers: Option<BTreeMap<String, String>>,
        secret_config_refs: Option<BTreeMap<String, String>>,
    ) -> Self {
        self.secret_references = Some(ConnectorSecretReferences {
            secret_env: map_secret_references(secret_env),
            secret_headers: map_secret_references(secret_headers),
            secret_config_refs: map_secret_references(secret_config_refs),
        })
        .filter(ConnectorSecretReferences::has_values);
        self
    }

    pub fn validate(&self) -> Result<(), ConnectorError> {
        if !valid_id(&self.id) {
            return Err(ConnectorError::Invalid);
        }
        if self.mcp_server_program.is_some()
            && !matches!(self.kind, ConnectorKind::McpStdio | ConnectorKind::McpHttp)
        {
            return Err(ConnectorError::Invalid);
        }
        if self
            .secret_references
            .as_ref()
            .is_some_and(|references| references.validate(&self.kind).is_err())
        {
            return Err(ConnectorError::Invalid);
        }
        match self.kind {
            ConnectorKind::McpStdio | ConnectorKind::Cli => {
                if !nonempty(&self.command) || !valid_string_map(self.env.as_ref(), true) {
                    return Err(ConnectorError::Invalid);
                }
            }
            ConnectorKind::McpHttp => {
                if !valid_url(self.url.as_deref())
                    || !valid_string_map(self.headers.as_ref(), false)
                    || self.connection_timeout_ms == Some(0)
                {
                    return Err(ConnectorError::Invalid);
                }
            }
            ConnectorKind::Http => {
                if !valid_url(self.base_url.as_deref())
                    || !valid_string_map(self.headers.as_ref(), false)
                {
                    return Err(ConnectorError::Invalid);
                }
            }
            ConnectorKind::Sdk => {
                if !nonempty(&self.provider)
                    || self
                        .config
                        .as_ref()
                        .is_some_and(ConnectorConfig::contains_secret_key)
                {
                    return Err(ConnectorError::Invalid);
                }
            }
        }
        Ok(())
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub const fn kind(&self) -> ConnectorKind {
        self.kind
    }

    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub const fn enabled_value(&self) -> Option<bool> {
        self.enabled
    }

    pub fn workspace_id(&self) -> Option<&str> {
        self.workspace_id.as_deref()
    }

    pub fn source_id(&self) -> Option<&str> {
        self.source_id.as_deref()
    }

    pub fn mcp_server_program(&self) -> Option<&McpServerProgram> {
        self.mcp_server_program.as_ref()
    }

    pub fn tags(&self) -> Option<&[String]> {
        self.tags.as_deref()
    }

    pub fn command(&self) -> Option<&str> {
        self.command.as_deref()
    }

    pub fn args(&self) -> Option<&[String]> {
        self.args.as_deref()
    }

    pub fn cwd(&self) -> Option<&str> {
        self.cwd.as_deref()
    }

    pub fn env(&self) -> Option<&BTreeMap<String, String>> {
        self.env.as_ref()
    }

    pub fn url(&self) -> Option<&str> {
        self.url.as_deref()
    }

    pub const fn transport(&self) -> Option<McpTransport> {
        self.transport
    }

    pub fn headers(&self) -> Option<&BTreeMap<String, String>> {
        self.headers.as_ref()
    }

    pub const fn connection_timeout_ms(&self) -> Option<u64> {
        self.connection_timeout_ms
    }

    pub fn base_url(&self) -> Option<&str> {
        self.base_url.as_deref()
    }

    pub fn provider(&self) -> Option<&str> {
        self.provider.as_deref()
    }

    pub fn package_name(&self) -> Option<&str> {
        self.package_name.as_deref()
    }

    pub fn config(&self) -> Option<&ConnectorConfig> {
        self.config.as_ref()
    }

    pub fn enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }

    pub fn has_secret_references(&self) -> bool {
        self.secret_references
            .as_ref()
            .is_some_and(ConnectorSecretReferences::has_values)
    }

    pub fn secret_env_references(&self) -> impl Iterator<Item = (&str, &str)> {
        self.secret_references
            .as_ref()
            .and_then(|references| references.secret_env.as_ref())
            .into_iter()
            .flat_map(|references| references.iter())
            .map(|(key, reference)| (key.as_str(), reference.reference.as_str()))
    }

    pub fn secret_header_references(&self) -> impl Iterator<Item = (&str, &str)> {
        self.secret_references
            .as_ref()
            .and_then(|references| references.secret_headers.as_ref())
            .into_iter()
            .flat_map(|references| references.iter())
            .map(|(key, reference)| (key.as_str(), reference.reference.as_str()))
    }

    pub fn secret_config_references(&self) -> impl Iterator<Item = (&str, &str)> {
        self.secret_references
            .as_ref()
            .and_then(|references| references.secret_config_refs.as_ref())
            .into_iter()
            .flat_map(|references| references.iter())
            .map(|(key, reference)| (key.as_str(), reference.reference.as_str()))
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConnectorCatalog {
    connectors: Vec<Connector>,
}

impl ConnectorCatalog {
    pub fn try_new(connectors: Vec<Connector>) -> Result<Self, ConnectorError> {
        if connectors.len() > MAX_CONNECTORS {
            return Err(ConnectorError::Invalid);
        }
        let mut connectors = connectors;
        for connector in &connectors {
            connector.validate()?;
        }
        connectors.sort_by(|left, right| left.id.cmp(&right.id));
        if connectors.windows(2).any(|pair| pair[0].id == pair[1].id) {
            return Err(ConnectorError::Duplicate);
        }
        Ok(Self { connectors })
    }

    pub fn connectors(&self) -> &[Connector] {
        &self.connectors
    }
    pub fn get(&self, id: &str) -> Option<&Connector> {
        self.connectors
            .iter()
            .find(|connector| connector.id() == id)
    }
    pub fn upsert(&mut self, connector: Connector) -> Result<bool, ConnectorError> {
        if connector.id() == "matcha" {
            return Err(ConnectorError::SystemManaged);
        }
        connector.validate()?;
        let created = self.get(connector.id()).is_none();
        self.connectors
            .retain(|current| current.id() != connector.id());
        self.connectors.push(connector);
        self.connectors
            .sort_by(|left, right| left.id().cmp(right.id()));
        Ok(created)
    }
    pub fn remove(&mut self, id: &str) -> Result<bool, ConnectorError> {
        if id == "matcha" {
            return Err(ConnectorError::SystemManaged);
        }
        let count = self.connectors.len();
        self.connectors.retain(|connector| connector.id() != id);
        Ok(count != self.connectors.len())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorError {
    Invalid,
    Duplicate,
    SystemManaged,
}
impl fmt::Display for ConnectorError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::Invalid => "External connector is invalid",
            Self::Duplicate => "External connector identifiers must be unique",
            Self::SystemManaged => {
                "Matcha system runtime connector is managed by the External Connector Platform"
            }
        })
    }
}
impl std::error::Error for ConnectorError {}

fn valid_id(value: &str) -> bool {
    value.len() <= MAX_CONNECTOR_ID_BYTES
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}
fn nonempty(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
}
fn valid_url(value: Option<&str>) -> bool {
    value
        .and_then(|value| url_scheme(value).then_some(value))
        .is_some_and(|value| {
            value.len() <= 2_048
                && !value
                    .chars()
                    .any(|character| character.is_control() || character.is_whitespace())
        })
}
fn url_scheme(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}
fn valid_string_map(value: Option<&BTreeMap<String, String>>, process_environment: bool) -> bool {
    value.is_none_or(|value| {
        value.iter().all(|(key, _)| {
            !key.trim().is_empty()
                && !secret_key(key)
                && (!process_environment || !BLOCKED_ENVIRONMENT_KEYS.contains(&key.as_str()))
        })
    })
}
fn valid_secret_reference_map(
    value: Option<&BTreeMap<String, ConnectorSecretReference>>,
    process_environment: bool,
) -> bool {
    value.is_none_or(|value| {
        value.iter().all(|(key, reference)| {
            let valid_key = if process_environment {
                valid_environment_key(key)
            } else {
                valid_reference_key(key)
            };
            valid_key
                && (!process_environment || !BLOCKED_ENVIRONMENT_KEYS.contains(&key.as_str()))
                && matches!(reference.kind, ConnectorSecretReferenceKind::SecretRef)
                && valid_secret_reference(&reference.reference)
        })
    })
}

fn connector_config(
    config: serde_json::Map<String, serde_json::Value>,
) -> Result<ConnectorConfig, ConnectorError> {
    ConnectorConfig::try_new(
        config
            .into_iter()
            .map(|(key, value)| connector_config_value(value).map(|value| (key, value)))
            .collect::<Option<BTreeMap<_, _>>>()
            .ok_or(ConnectorError::Invalid)?,
    )
    .map_err(|_| ConnectorError::Invalid)
}

fn connector_config_value(value: serde_json::Value) -> Option<ConnectorConfigValue> {
    match value {
        serde_json::Value::Null => Some(ConnectorConfigValue::Null),
        serde_json::Value::Bool(value) => Some(ConnectorConfigValue::Bool(value)),
        serde_json::Value::Number(value) => Some(ConnectorConfigValue::Number(value.to_string())),
        serde_json::Value::String(value) => Some(ConnectorConfigValue::String(value)),
        serde_json::Value::Array(values) => values
            .into_iter()
            .map(connector_config_value)
            .collect::<Option<Vec<_>>>()
            .map(ConnectorConfigValue::Array),
        serde_json::Value::Object(values) => values
            .into_iter()
            .map(|(key, value)| connector_config_value(value).map(|value| (key, value)))
            .collect::<Option<BTreeMap<_, _>>>()
            .map(ConnectorConfigValue::Object),
    }
}

fn secret_reference_map(
    references: Option<BTreeMap<String, ConnectorSecretReference>>,
) -> Option<BTreeMap<String, String>> {
    references.map(|references| {
        references
            .into_iter()
            .map(|(key, reference)| (key, reference.reference))
            .collect()
    })
}

fn map_secret_references(
    references: Option<BTreeMap<String, String>>,
) -> Option<BTreeMap<String, ConnectorSecretReference>> {
    references.map(|references| {
        references
            .into_iter()
            .map(|(key, reference)| {
                (
                    key,
                    ConnectorSecretReference {
                        kind: ConnectorSecretReferenceKind::SecretRef,
                        reference,
                    },
                )
            })
            .collect()
    })
}

fn valid_secret_reference(value: &str) -> bool {
    ConnectorSecretRef::try_new(value).is_ok()
}

fn valid_environment_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_' && index > 0
        })
}

fn valid_reference_key(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/'))
}

fn valid_config_value(value: &ConnectorConfigValue) -> bool {
    match value {
        ConnectorConfigValue::Null
        | ConnectorConfigValue::Bool(_)
        | ConnectorConfigValue::String(_) => true,
        ConnectorConfigValue::Number(value) => {
            serde_json::from_str::<serde_json::Number>(value).is_ok()
        }
        ConnectorConfigValue::Array(items) => items.iter().all(valid_config_value),
        ConnectorConfigValue::Object(items) => items.values().all(valid_config_value),
    }
}

fn contains_secret_config_key(value: &BTreeMap<String, ConnectorConfigValue>) -> bool {
    value.iter().any(|(key, item)| {
        secret_key(key)
            || matches!(item, ConnectorConfigValue::Object(items) if contains_secret_config_key(items))
    })
}

fn secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "token",
        "secret",
        "password",
        "passwd",
        "api-key",
        "api_key",
        "private-key",
        "private_key",
        "credential",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

const SYSTEM_RUNTIME_CONNECTOR_ID: &str = "matcha";

pub(crate) fn connector_list(catalog: &ConnectorCatalog) -> Vec<Connector> {
    let mut connectors = user_connectors(catalog);
    connectors.push(system_runtime_connector());
    connectors.sort_by(|left, right| left.id().cmp(right.id()));
    connectors
}

pub(crate) fn user_connectors(catalog: &ConnectorCatalog) -> Vec<Connector> {
    catalog
        .connectors()
        .iter()
        .filter(|connector| {
            connector.id() != SYSTEM_RUNTIME_CONNECTOR_ID && !is_system_runtime_connector(connector)
        })
        .cloned()
        .collect()
}

pub(crate) fn connector(catalog: &ConnectorCatalog, id: &str) -> Option<Connector> {
    if id == SYSTEM_RUNTIME_CONNECTOR_ID {
        return Some(system_runtime_connector());
    }
    user_connectors(catalog)
        .into_iter()
        .find(|connector| connector.id() == id)
}

pub(crate) fn is_system_runtime_connector(connector: &Connector) -> bool {
    connector
        .mcp_server_program()
        .is_some_and(|program| matches!(program.source(), McpProgramSource::SystemRuntime))
}

pub(crate) fn system_runtime_connector() -> Connector {
    Connector::system_runtime()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn valid_secret_references_validate() {
        let mut input = ConnectorInput::new("remote".into(), ConnectorKind::McpHttp);
        input.url = Some("https://example.test/mcp".into());
        let connector = Connector::new(input).with_secret_references(
            None,
            Some(BTreeMap::from([(
                "Authorization".into(),
                "credential:v1:opaque".into(),
            )])),
            None,
        );

        assert!(connector.validate().is_ok());
        assert!(connector.has_secret_references());
        assert_eq!(
            connector.secret_header_references().collect::<Vec<_>>(),
            vec![("Authorization", "credential:v1:opaque")]
        );
    }

    #[test]
    fn secret_reference_maps_reject_invalid_keys_and_values() {
        let invalid = [
            ("", "credential:v1:opaque"),
            ("Authorization", ""),
            ("Authorization", "credential secret"),
            ("Authorization", "credential:v1:opaque\n"),
        ];
        for (key, reference) in invalid {
            let mut input = ConnectorInput::new("remote".into(), ConnectorKind::McpHttp);
            input.url = Some("https://example.test/mcp".into());
            let connector = Connector::new(input).with_secret_references(
                None,
                Some(BTreeMap::from([(key.to_owned(), reference.to_owned())])),
                None,
            );
            assert_eq!(connector.validate(), Err(ConnectorError::Invalid));
        }

        let mut input = ConnectorInput::new("remote".into(), ConnectorKind::McpStdio);
        input.command = Some("managed-mcp".into());
        let connector = Connector::new(input).with_secret_references(
            Some(BTreeMap::from([(
                "lowercase".into(),
                "credential:v1:opaque".into(),
            )])),
            None,
            None,
        );
        assert_eq!(connector.validate(), Err(ConnectorError::Invalid));
    }

    #[test]
    fn system_connector_cannot_mutate_or_delete() {
        let mut catalog = ConnectorCatalog::default();
        assert_eq!(
            catalog.upsert(Connector::system_runtime()),
            Err(ConnectorError::SystemManaged)
        );
        assert_eq!(catalog.remove("matcha"), Err(ConnectorError::SystemManaged));
    }
}
