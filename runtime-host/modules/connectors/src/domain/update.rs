use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer};

use super::model::{
    Connector, ConnectorError, ConnectorKind, ConnectorSecretReference, ConnectorSecretReferences,
    McpTransport, connector_config,
};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectorPatch {
    #[serde(default, deserialize_with = "deserialize_field")]
    display_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_enabled")]
    enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_field")]
    command: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    args: Option<Option<Vec<String>>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    cwd: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    env: Option<Option<BTreeMap<String, String>>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    secret_env: Option<Option<BTreeMap<String, ConnectorSecretReference>>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    url: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    transport: Option<Option<McpTransport>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    headers: Option<Option<BTreeMap<String, String>>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    secret_headers: Option<Option<BTreeMap<String, ConnectorSecretReference>>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    connection_timeout_ms: Option<Option<u64>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    base_url: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    provider: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    package_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    config: Option<Option<serde_json::Map<String, serde_json::Value>>>,
    #[serde(default, deserialize_with = "deserialize_field")]
    secret_config_refs: Option<Option<BTreeMap<String, ConnectorSecretReference>>>,
}

fn deserialize_field<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn deserialize_enabled<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    bool::deserialize(deserializer).map(Some)
}

impl ConnectorPatch {
    pub(crate) fn apply(self, connector: &mut Connector) -> Result<(), ConnectorError> {
        let process = self.command.is_some()
            || self.args.is_some()
            || self.cwd.is_some()
            || self.env.is_some()
            || self.secret_env.is_some();
        let http = self.headers.is_some() || self.secret_headers.is_some();
        let mcp_http =
            self.url.is_some() || self.transport.is_some() || self.connection_timeout_ms.is_some();
        let sdk = self.provider.is_some()
            || self.package_name.is_some()
            || self.config.is_some()
            || self.secret_config_refs.is_some();
        let valid_fields = match connector.kind {
            ConnectorKind::McpStdio | ConnectorKind::Cli => {
                !http && !mcp_http && !sdk && self.base_url.is_none()
            }
            ConnectorKind::McpHttp => !process && !sdk && self.base_url.is_none(),
            ConnectorKind::Http => !process && !mcp_http && !sdk,
            ConnectorKind::Sdk => !process && !http && !mcp_http && self.base_url.is_none(),
        };
        if !valid_fields
            || self.command == Some(None)
            || self.url == Some(None)
            || self.base_url == Some(None)
            || self.provider == Some(None)
        {
            return Err(ConnectorError::Invalid);
        }
        if let Some(value) = self.display_name {
            connector.display_name = value;
        }
        if let Some(value) = self.description {
            connector.description = value;
        }
        if let Some(value) = self.enabled {
            connector.enabled = Some(value);
        }
        if let Some(value) = self.command {
            connector.command = value;
        }
        if let Some(value) = self.args {
            connector.args = value;
        }
        if let Some(value) = self.cwd {
            connector.cwd = value;
        }
        if let Some(value) = self.env {
            connector.env = value;
        }
        if let Some(value) = self.url {
            connector.url = value;
        }
        if let Some(value) = self.transport {
            connector.transport = value;
        }
        if let Some(value) = self.headers {
            connector.headers = value;
        }
        if let Some(value) = self.connection_timeout_ms {
            connector.connection_timeout_ms = value;
        }
        if let Some(value) = self.base_url {
            connector.base_url = value;
        }
        if let Some(value) = self.provider {
            connector.provider = value;
        }
        if let Some(value) = self.package_name {
            connector.package_name = value;
        }
        if let Some(value) = self.config {
            connector.config = value.map(connector_config).transpose()?;
        }
        let mut references = connector.secret_references.take().unwrap_or_default();
        if let Some(value) = self.secret_env {
            references.secret_env = value;
        }
        if let Some(value) = self.secret_headers {
            references.secret_headers = value;
        }
        if let Some(value) = self.secret_config_refs {
            references.secret_config_refs = value;
        }
        connector.secret_references =
            Some(references).filter(ConnectorSecretReferences::has_values);
        connector.validate()
    }
}
