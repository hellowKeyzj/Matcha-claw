use std::{fmt, future::Future, path::Path, pin::Pin};

use platform::endpoint::runtime_address::RuntimeEndpoint;
use zeroize::Zeroizing;

use crate::domain::{Connector, ConnectorCatalog};

pub const PRESET_MCP_SERVER_ID: &str = "matcha";

const CONNECTOR_SECRET_REFERENCE_PREFIX: &str = "credential:v1:";
const MAX_CONNECTOR_SECRET_REFERENCE_BYTES: usize = 512;
const MAX_CONNECTOR_SECRET_VALUE_BYTES: usize = 256 * 1024;

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct ConnectorSecretRef(String);

impl ConnectorSecretRef {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidConnectorSecretRef> {
        let value = value.into();
        if valid_reference(&value) {
            Ok(Self(value))
        } else {
            Err(InvalidConnectorSecretRef)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ConnectorSecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConnectorSecretRef([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidConnectorSecretRef;

impl fmt::Display for InvalidConnectorSecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("connector secret reference is invalid")
    }
}

impl std::error::Error for InvalidConnectorSecretRef {}

pub struct ConnectorSecretValue(Zeroizing<Vec<u8>>);

impl ConnectorSecretValue {
    pub fn from_secret(value: impl Into<String>) -> Result<Self, InvalidConnectorSecretValue> {
        let value = value.into();
        if value.trim().is_empty() || value.len() > MAX_CONNECTOR_SECRET_VALUE_BYTES {
            return Err(InvalidConnectorSecretValue);
        }
        Ok(Self(Zeroizing::new(value.into_bytes())))
    }

    pub fn with_private_bytes(&self, project: impl FnOnce(&[u8])) {
        project(&self.0);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidConnectorSecretValue;

impl fmt::Display for InvalidConnectorSecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("connector secret value is invalid")
    }
}

impl std::error::Error for InvalidConnectorSecretValue {}

pub trait ConnectorSecretFactSource: Send + Sync {
    fn lookup(
        &self,
        reference: &ConnectorSecretRef,
    ) -> Result<ConnectorSecretFact, ConnectorSecretFactSourceError>;
}

pub enum ConnectorSecretFact {
    Resolved(ConnectorSecretValue),
    NotFound,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorSecretFactSourceError {
    Unavailable,
    Failed,
}

impl fmt::Display for ConnectorSecretFactSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "connector secret fact source is unavailable",
            Self::Failed => "connector secret fact source failed",
        })
    }
}

impl std::error::Error for ConnectorSecretFactSourceError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConnectorSecretResolutionMetadata {
    pub source: ConnectorSecretSourceStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorSecretSourceStatus {
    Resolved,
    NotFound,
    Unavailable,
}

pub enum ConnectorSecretResolution {
    Resolved {
        value: ConnectorSecretValue,
        metadata: ConnectorSecretResolutionMetadata,
    },
    NotFound {
        metadata: ConnectorSecretResolutionMetadata,
    },
    Unavailable {
        metadata: ConnectorSecretResolutionMetadata,
    },
}

pub trait ConnectorSecretResolverPort: Send + Sync {
    fn resolve(
        &self,
        reference: &ConnectorSecretRef,
    ) -> Result<ConnectorSecretResolution, ConnectorSecretAuthorityPortError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorSecretAuthorityPortError {
    SourceUnavailable,
    SourceFailed,
}

impl fmt::Display for ConnectorSecretAuthorityPortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::SourceUnavailable => "connector secret authority source is unavailable",
            Self::SourceFailed => "connector secret authority source failed",
        })
    }
}

impl std::error::Error for ConnectorSecretAuthorityPortError {}

pub struct ConnectorSecretAuthority<S> {
    source: S,
}

impl<S> ConnectorSecretAuthority<S> {
    pub fn new(source: S) -> Self {
        Self { source }
    }
}

impl<S> ConnectorSecretResolverPort for ConnectorSecretAuthority<S>
where
    S: ConnectorSecretFactSource,
{
    fn resolve(
        &self,
        reference: &ConnectorSecretRef,
    ) -> Result<ConnectorSecretResolution, ConnectorSecretAuthorityPortError> {
        match self.source.lookup(reference).map_err(|error| match error {
            ConnectorSecretFactSourceError::Unavailable => {
                ConnectorSecretAuthorityPortError::SourceUnavailable
            }
            ConnectorSecretFactSourceError::Failed => {
                ConnectorSecretAuthorityPortError::SourceFailed
            }
        })? {
            ConnectorSecretFact::Resolved(value) => Ok(ConnectorSecretResolution::Resolved {
                value,
                metadata: ConnectorSecretResolutionMetadata {
                    source: ConnectorSecretSourceStatus::Resolved,
                },
            }),
            ConnectorSecretFact::NotFound => Ok(ConnectorSecretResolution::NotFound {
                metadata: ConnectorSecretResolutionMetadata {
                    source: ConnectorSecretSourceStatus::NotFound,
                },
            }),
            ConnectorSecretFact::Unavailable => Ok(ConnectorSecretResolution::Unavailable {
                metadata: ConnectorSecretResolutionMetadata {
                    source: ConnectorSecretSourceStatus::Unavailable,
                },
            }),
        }
    }
}

#[derive(Clone, Copy, Default)]
pub struct UnavailableConnectorSecretFactSource;

impl ConnectorSecretFactSource for UnavailableConnectorSecretFactSource {
    fn lookup(
        &self,
        _reference: &ConnectorSecretRef,
    ) -> Result<ConnectorSecretFact, ConnectorSecretFactSourceError> {
        Ok(ConnectorSecretFact::Unavailable)
    }
}

pub type UnavailableConnectorSecretAuthority =
    ConnectorSecretAuthority<UnavailableConnectorSecretFactSource>;

pub fn unavailable_connector_secret_authority() -> UnavailableConnectorSecretAuthority {
    ConnectorSecretAuthority::new(UnavailableConnectorSecretFactSource)
}

fn valid_reference(value: &str) -> bool {
    let Some(opaque) = value.strip_prefix(CONNECTOR_SECRET_REFERENCE_PREFIX) else {
        return false;
    };
    value.len() <= MAX_CONNECTOR_SECRET_REFERENCE_BYTES
        && !opaque.is_empty()
        && !opaque.contains("..")
        && opaque
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && opaque
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

pub type ConnectorFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait ConnectorRuntimeDirectory: Send + Sync {
    fn connector_ops(&self) -> Option<&dyn ConnectorOps>;

    fn connector_ops_for_endpoint(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn ConnectorOps>;
}

pub trait ConnectorOps: Send + Sync {
    fn apply_runtime_mcp_projection<'a>(
        &'a self,
        preset: Option<McpPreset<'a>>,
        catalog: ConnectorCatalog,
        secrets: &'a dyn ConnectorSecretResolverPort,
    ) -> ConnectorFuture<'a, ConnectorProjectionEffect>;

    fn probe_external_connector<'a>(
        &'a self,
        connector: Connector,
    ) -> ConnectorFuture<'a, ConnectorObservation>;

    fn list_mcp_servers<'a>(
        &'a self,
    ) -> ConnectorFuture<'a, Result<Vec<McpServerConfig>, ConnectorOperationFailure>>;

    fn observe_mcp_server_status<'a>(
        &'a self,
        session_key: String,
    ) -> ConnectorFuture<'a, Result<McpServerStatusList, ConnectorOperationFailure>>;

    fn set_mcp_session_server_enabled<'a>(
        &'a self,
        session_key: String,
        server_name: String,
        enabled: bool,
    ) -> ConnectorFuture<'a, Result<(), ConnectorOperationFailure>>;
}

#[derive(Clone, Copy)]
pub struct McpPreset<'a> {
    runtime_host_mcp_executable: &'a Path,
    runtime_host_mcp_state_dir: &'a Path,
}

impl<'a> McpPreset<'a> {
    pub fn new(
        runtime_host_mcp_executable: &'a Path,
        runtime_host_mcp_state_dir: &'a Path,
    ) -> Self {
        Self {
            runtime_host_mcp_executable,
            runtime_host_mcp_state_dir,
        }
    }

    pub fn runtime_host_mcp_executable(&self) -> &'a Path {
        self.runtime_host_mcp_executable
    }

    pub fn runtime_host_mcp_state_dir(&self) -> &'a Path {
        self.runtime_host_mcp_state_dir
    }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorOperationFailure {
    Unknown,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpServerConfig {
    pub server_id: String,
    pub kind: McpServerKind,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpServerKind {
    McpStdio,
    McpHttp,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpServerStatusList {
    pub servers: Vec<McpServerStatusEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpServerStatusEntry {
    pub name: String,
    pub launch_summary: Option<String>,
    pub tool_count: Option<u64>,
    pub available: Option<bool>,
    pub enabled: Option<bool>,
    pub state: Option<String>,
}
