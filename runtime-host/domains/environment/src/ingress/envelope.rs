use std::{fmt, time::SystemTime};

use super::{
    authorization::{
        EnvironmentAuthorization, EnvironmentAuthorizationPort, EnvironmentAuthorizationRejection,
        EnvironmentNonce, EnvironmentPrincipal, EnvironmentProvenance,
    },
    wire::WireEnvelope,
};
use crate::EnvironmentCommand;

const ENVELOPE_VERSION: u8 = 1;
const MAX_ENVELOPE_BYTES: usize = 64 * 1024;

/// A validated, versioned, non-secret command envelope. It cannot be constructed from loopback,
/// cwd, Gateway operator permissions, or private Host control frames.
#[derive(Clone, Eq, PartialEq)]
pub struct EnvironmentCommandEnvelope {
    principal: EnvironmentPrincipal,
    authorization: EnvironmentAuthorization,
    provenance: EnvironmentProvenance,
    nonce: EnvironmentNonce,
    command: EnvironmentCommand,
}

impl EnvironmentCommandEnvelope {
    pub fn decode(input: &[u8]) -> Result<Self, EnvironmentIngressFailure> {
        if input.len() > MAX_ENVELOPE_BYTES {
            return Err(EnvironmentIngressFailure::InvalidEnvelope);
        }
        let wire = serde_json::from_slice::<WireEnvelope>(input)
            .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)?;
        if wire.version != ENVELOPE_VERSION {
            return Err(EnvironmentIngressFailure::UnsupportedVersion);
        }
        Self::from_wire(wire)
    }

    pub fn command(&self) -> &EnvironmentCommand {
        &self.command
    }

    pub fn principal(&self) -> &EnvironmentPrincipal {
        &self.principal
    }

    pub fn provenance(&self) -> &EnvironmentProvenance {
        &self.provenance
    }

    fn from_wire(wire: WireEnvelope) -> Result<Self, EnvironmentIngressFailure> {
        let principal = EnvironmentPrincipal::try_new(wire.actor)
            .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)?;
        let authorization = EnvironmentAuthorization::try_new(
            wire.authorization.grant_id,
            wire.authorization.proof,
            super::wire::timestamp(wire.authorization.expires_at)?,
        )
        .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)?;
        let provenance = EnvironmentProvenance::try_new(wire.provenance)
            .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)?;
        let nonce = EnvironmentNonce::try_new(wire.nonce)
            .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)?;
        let command = wire.command.into_command()?;
        Ok(Self {
            principal,
            authorization,
            provenance,
            nonce,
            command,
        })
    }
}

impl fmt::Debug for EnvironmentCommandEnvelope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EnvironmentCommandEnvelope(<redacted>)")
    }
}

pub struct EnvironmentIngress<A> {
    authorization: A,
}

impl<A> EnvironmentIngress<A> {
    pub fn new(authorization: A) -> Self {
        Self { authorization }
    }

    pub fn authorization(&self) -> &A {
        &self.authorization
    }
}

impl<A: EnvironmentAuthorizationPort> EnvironmentIngress<A> {
    /// Validates an envelope and consumes its replay fence through the external authorization
    /// authority. A successful return is the only point at which a Host consumer may persist the
    /// returned Domain command.
    pub fn accept(
        &mut self,
        input: &[u8],
        now: SystemTime,
    ) -> Result<EnvironmentCommand, EnvironmentIngressFailure> {
        let envelope = EnvironmentCommandEnvelope::decode(input)?;
        if envelope.authorization.expires_at() <= now {
            return Err(EnvironmentIngressFailure::AuthorizationExpired);
        }
        self.authorization
            .authorize(
                &envelope.principal,
                &envelope.authorization,
                &envelope.provenance,
                &envelope.nonce,
                &envelope.command,
                now,
            )
            .map_err(EnvironmentIngressFailure::from_authorization)?;
        Ok(envelope.command)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentIngressFailure {
    InvalidEnvelope,
    UnsupportedVersion,
    AuthorizationDenied,
    AuthorizationExpired,
    AuthorizationRevoked,
    ReplayRejected,
    AuthorizationUnavailable,
}

impl EnvironmentIngressFailure {
    fn from_authorization<E>(rejection: EnvironmentAuthorizationRejection<E>) -> Self {
        match rejection {
            EnvironmentAuthorizationRejection::Denied => Self::AuthorizationDenied,
            EnvironmentAuthorizationRejection::Expired => Self::AuthorizationExpired,
            EnvironmentAuthorizationRejection::Revoked => Self::AuthorizationRevoked,
            EnvironmentAuthorizationRejection::Replay => Self::ReplayRejected,
            EnvironmentAuthorizationRejection::Unavailable(_) => Self::AuthorizationUnavailable,
        }
    }
}

impl fmt::Display for EnvironmentIngressFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidEnvelope => "environment command envelope is invalid",
            Self::UnsupportedVersion => "environment command envelope version is unsupported",
            Self::AuthorizationDenied => "environment command authorization was denied",
            Self::AuthorizationExpired => "environment command authorization has expired",
            Self::AuthorizationRevoked => "environment command authorization was revoked",
            Self::ReplayRejected => "environment command nonce was already used",
            Self::AuthorizationUnavailable => {
                "environment command authorization could not be verified"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for EnvironmentIngressFailure {}
