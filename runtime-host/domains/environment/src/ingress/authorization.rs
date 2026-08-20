use std::{fmt, time::SystemTime};

use crate::EnvironmentCommand;

const MAX_IDENTIFIER_BYTES: usize = 128;

/// An opaque authenticated actor identity supplied by the external product authority.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EnvironmentPrincipal(String);

impl EnvironmentPrincipal {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidEnvironmentPrincipal> {
        let value = value.into();
        valid_identifier(&value)
            .then_some(Self(value))
            .ok_or(InvalidEnvironmentPrincipal)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidEnvironmentPrincipal;

impl fmt::Display for InvalidEnvironmentPrincipal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment actor identity is invalid")
    }
}

impl std::error::Error for InvalidEnvironmentPrincipal {}

/// A unique nonce in a command envelope. Its exact replay persistence belongs to the authorization
/// authority, so it cannot become a second Environment store.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EnvironmentNonce(String);

impl EnvironmentNonce {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidEnvironmentNonce> {
        let value = value.into();
        valid_identifier(&value)
            .then_some(Self(value))
            .ok_or(InvalidEnvironmentNonce)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidEnvironmentNonce;

impl fmt::Display for InvalidEnvironmentNonce {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment command nonce is invalid")
    }
}

impl std::error::Error for InvalidEnvironmentNonce {}

/// An audit-safe correlation supplied by the external producer. It deliberately contains no actor
/// credential, grant material, or desired configuration.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EnvironmentProvenance(String);

impl EnvironmentProvenance {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidEnvironmentProvenance> {
        let value = value.into();
        valid_identifier(&value)
            .then_some(Self(value))
            .ok_or(InvalidEnvironmentProvenance)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidEnvironmentProvenance;

impl fmt::Display for InvalidEnvironmentProvenance {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment command provenance is invalid")
    }
}

impl std::error::Error for InvalidEnvironmentProvenance {}

/// The opaque external authorization decision. The Domain receives no signing key or product
/// identity database and cannot manufacture a grant.
#[derive(Clone, Eq, PartialEq)]
pub struct EnvironmentAuthorization {
    grant_id: String,
    proof: String,
    expires_at: SystemTime,
}

impl EnvironmentAuthorization {
    pub fn try_new(
        grant_id: impl Into<String>,
        proof: impl Into<String>,
        expires_at: SystemTime,
    ) -> Result<Self, InvalidEnvironmentAuthorization> {
        let grant_id = grant_id.into();
        let proof = proof.into();
        if !valid_identifier(&grant_id) || !valid_identifier(&proof) {
            return Err(InvalidEnvironmentAuthorization);
        }
        Ok(Self {
            grant_id,
            proof,
            expires_at,
        })
    }

    pub fn grant_id(&self) -> &str {
        &self.grant_id
    }

    /// Returns the opaque, non-secret proof only to an external authorization verifier.
    /// It must never be placed in a public receipt, error, log, or diagnostic projection.
    pub fn proof(&self) -> &str {
        &self.proof
    }

    pub fn expires_at(&self) -> SystemTime {
        self.expires_at
    }
}

impl fmt::Debug for EnvironmentAuthorization {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EnvironmentAuthorization(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidEnvironmentAuthorization;

impl fmt::Display for InvalidEnvironmentAuthorization {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment authorization is invalid")
    }
}

impl std::error::Error for InvalidEnvironmentAuthorization {}

/// The external authorization root owns signature/proof validation, actor/grant binding, expiry,
/// revocation, and atomic nonce consumption. It is intentionally a narrow port rather than a
/// Host controller or an Environment shadow store.
pub trait EnvironmentAuthorizationPort {
    type Error;

    fn authorize(
        &mut self,
        principal: &EnvironmentPrincipal,
        authorization: &EnvironmentAuthorization,
        provenance: &EnvironmentProvenance,
        nonce: &EnvironmentNonce,
        command: &EnvironmentCommand,
        now: SystemTime,
    ) -> Result<(), EnvironmentAuthorizationRejection<Self::Error>>;
}

#[derive(Eq, PartialEq)]
pub enum EnvironmentAuthorizationRejection<E> {
    Denied,
    Expired,
    Revoked,
    Replay,
    Unavailable(E),
}

impl<E: fmt::Debug> fmt::Debug for EnvironmentAuthorizationRejection<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Denied => formatter.write_str("Denied"),
            Self::Expired => formatter.write_str("Expired"),
            Self::Revoked => formatter.write_str("Revoked"),
            Self::Replay => formatter.write_str("Replay"),
            Self::Unavailable(_) => formatter.write_str("Unavailable(<redacted>)"),
        }
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}
