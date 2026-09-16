use std::fmt;

use crate::connectors::{ConnectorSecretRef, ConnectorSecretValue};

/// The private fact source injected by composition or a native secret adapter.
///
/// Implementations must return only the requested private execution value and
/// must not expose it through durable public facts, telemetry, logs, or DTOs.
pub trait ConnectorSecretFactSource: Send + Sync {
    fn lookup(
        &self,
        reference: &ConnectorSecretRef,
    ) -> Result<ConnectorSecretFact, ConnectorSecretFactSourceError>;
}

/// Fact-source result. `Unavailable` is distinct from `NotFound`: the former
/// means no trusted source is currently wired, while the latter means an
/// available source has no value for this reference.
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

/// The only resolution metadata allowed outside the private execution value.
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

/// Private resolution result. The resolved value has no `Debug`, `Serialize`,
/// `Display`, or public readback implementation.
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

/// Environment's generic connector SecretRef authority seam.
///
/// The implementation is injected at composition time. No resolver may infer
/// a value from connector configuration or own a second secret store.
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
