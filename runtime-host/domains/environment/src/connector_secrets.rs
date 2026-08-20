use std::fmt;

use zeroize::Zeroizing;

use crate::ports::{
    ConnectorSecretAuthorityPortError, ConnectorSecretFact, ConnectorSecretFactSource,
    ConnectorSecretFactSourceError, ConnectorSecretResolution, ConnectorSecretResolutionMetadata,
    ConnectorSecretResolverPort, ConnectorSecretSourceStatus,
};

const CONNECTOR_SECRET_REFERENCE_PREFIX: &str = "credential:v1:";
const MAX_CONNECTOR_SECRET_REFERENCE_BYTES: usize = 512;
const MAX_CONNECTOR_SECRET_VALUE_BYTES: usize = 256 * 1024;

/// An opaque connector credential reference.
///
/// This identity is safe to retain in connector metadata, but it is distinct
/// from provider-account and Fleet secret reference types.
#[derive(Clone, Eq, Hash, PartialEq)]
pub struct ConnectorSecretRef(String);

impl ConnectorSecretRef {
    /// Creates a connector-only `credential:v1:<opaque>` reference.
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

/// Private execution material. This type deliberately has no `Debug`,
/// `Serialize`, `Display`, `Clone`, or readback implementation.
pub struct ConnectorSecretValue(Zeroizing<Vec<u8>>);

impl ConnectorSecretValue {
    pub fn from_secret(value: impl Into<String>) -> Result<Self, InvalidConnectorSecretValue> {
        let value = value.into();
        if value.trim().is_empty() || value.len() > MAX_CONNECTOR_SECRET_VALUE_BYTES {
            return Err(InvalidConnectorSecretValue);
        }
        Ok(Self(Zeroizing::new(value.into_bytes())))
    }

    /// Runs private execution code while the plaintext remains inside the
    /// caller's private projection. The callback cannot return the bytes for
    /// public readback; it must consume them only for the private effect.
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

/// Adapter from an injected Environment fact source to the connector secret
/// resolver port. It owns no fallback map or durable secret state.
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

/// Explicit adapter used until a real private injection/persistence producer
/// is wired. It never claims that connector secret resolution is available.
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
