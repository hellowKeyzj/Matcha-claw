use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Serialize};

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

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectorSecretReferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) secret_env: Option<BTreeMap<String, ConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) secret_headers: Option<BTreeMap<String, ConnectorSecretReference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) secret_config_refs: Option<BTreeMap<String, ConnectorSecretReference>>,
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

impl ConnectorSecretReferences {
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

#[derive(Clone, Debug, Deserialize)]
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
    pub fn into_connector(self) -> Connector {
        Connector {
            id: self.id,
            kind: self.kind,
            display_name: self.display_name,
            description: self.description,
            enabled: self.enabled,
            workspace_id: self.workspace_id,
            source_id: self.source_id,
            mcp_server_program: self.mcp_server_program,
            tags: self.tags,
            command: self.command,
            args: self.args,
            cwd: self.cwd,
            env: self.env,
            url: self.url,
            transport: self.transport,
            headers: self.headers,
            connection_timeout_ms: self.connection_timeout_ms,
            base_url: self.base_url,
            provider: self.provider,
            package_name: self.package_name,
            config: self.config,
            secret_references: self.secret_references,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connector {
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
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(flatten)]
    #[serde(skip_serializing_if = "Option::is_none")]
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
            mcp_server_program: Some(McpServerProgram {
                source: McpProgramSource::SystemRuntime,
                program_id: Some("system-runtime:matcha".into()),
            }),
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
                    || self.config.as_ref().is_some_and(contains_secret_key)
                {
                    return Err(ConnectorError::Invalid);
                }
            }
        }
        Ok(())
    }

    pub fn enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }

    pub(crate) fn with_secret_references(mut self, references: ConnectorSecretReferences) -> Self {
        self.secret_references = Some(references);
        self
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

    pub fn public_json(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).expect("connector is serializable");
        let object = value.as_object_mut().expect("connector JSON is an object");
        for field in ["command", "args", "cwd", "env", "headers", "config"] {
            object.remove(field);
        }
        value
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
        self.connectors.iter().find(|connector| connector.id == id)
    }
    pub fn upsert(&mut self, connector: Connector) -> Result<bool, ConnectorError> {
        if connector.id == "matcha" {
            return Err(ConnectorError::SystemManaged);
        }
        connector.validate()?;
        let created = self.get(&connector.id).is_none();
        self.connectors.retain(|current| current.id != connector.id);
        self.connectors.push(connector);
        self.connectors
            .sort_by(|left, right| left.id.cmp(&right.id));
        Ok(created)
    }
    pub fn remove(&mut self, id: &str) -> Result<bool, ConnectorError> {
        if id == "matcha" {
            return Err(ConnectorError::SystemManaged);
        }
        let count = self.connectors.len();
        self.connectors.retain(|connector| connector.id != id);
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

fn valid_secret_reference(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 512
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        && value.split(':').all(|part| !part.is_empty())
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

fn contains_secret_key(value: &serde_json::Map<String, serde_json::Value>) -> bool {
    value
        .iter()
        .any(|(key, item)| secret_key(key) || item.as_object().is_some_and(contains_secret_key))
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_connector_view_never_serializes_private_execution_fields() {
        let mut connector = Connector::system_runtime();
        connector.id = "remote".into();
        connector.kind = ConnectorKind::McpHttp;
        connector.url = Some("https://example.test/mcp".into());
        connector.command = Some("private-command".into());
        connector.args = Some(vec!["private-argument".into()]);
        connector.cwd = Some("C:/private/runtime".into());
        connector.env = Some(BTreeMap::from([(
            "PRIVATE_ENV".into(),
            "private-value".into(),
        )]));
        connector.headers = Some(BTreeMap::from([(
            "X-Private".into(),
            "private-value".into(),
        )]));
        connector.config = Some(serde_json::Map::from_iter([(
            "privateConfig".into(),
            serde_json::Value::String("private-value".into()),
        )]));
        let encoded = connector.public_json().to_string();
        for private_field in [
            "private-command",
            "private-argument",
            "C:/private/runtime",
            "PRIVATE_ENV",
            "X-Private",
            "privateConfig",
            "command",
            "args",
            "cwd",
            "env",
            "headers",
            "config",
        ] {
            assert!(!encoded.contains(private_field));
        }
        assert!(connector.validate().is_ok());
    }

    #[test]
    fn opaque_secret_references_round_trip_in_public_json_without_resolved_values() {
        let value = serde_json::json!({
            "id": "remote",
            "kind": "mcp-http",
            "url": "https://example.test/mcp",
            "secretHeaders": {
                "Authorization": { "kind": "secret-ref", "ref": "credential:v1:opaque" }
            }
        });
        let connector = serde_json::from_value::<ConnectorPublicInput>(value)
            .expect("secret refs decode")
            .into_connector();
        assert!(connector.validate().is_ok());
        let public = connector.public_json();
        assert_eq!(
            public["secretHeaders"]["Authorization"],
            serde_json::json!({ "kind": "secret-ref", "ref": "credential:v1:opaque" })
        );
        assert!(!public.to_string().contains("resolved-secret-value"));
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
            let value = serde_json::json!({
                "id": "remote",
                "kind": "mcp-http",
                "url": "https://example.test/mcp",
                "secretHeaders": {
                    key: { "kind": "secret-ref", "ref": reference }
                }
            });
            let connector: Connector = serde_json::from_value(value).expect("secret refs decode");
            assert_eq!(connector.validate(), Err(ConnectorError::Invalid));
        }

        let invalid_environment = serde_json::json!({
            "id": "remote",
            "kind": "mcp-stdio",
            "command": "managed-mcp",
            "secretEnv": {
                "lowercase": { "kind": "secret-ref", "ref": "credential:v1:opaque" }
            }
        });
        let connector: Connector = serde_json::from_value(invalid_environment).unwrap();
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
