mod authority;
mod crypto;
mod legacy;
mod owner;
mod store;

pub use authority::{LicenseClientContext, LicenseConfig, LicensePolicyMode};
pub use owner::{
    LicenseGateProjection, LicenseGateState, LicenseOwner, LicenseOwnerError, LicenseRenewalAlert,
    LicenseStoredKeySummary, LicenseValidationResult,
};

use std::fmt;

use serde::Serialize;
use zeroize::Zeroize;

const MAX_LICENSE_KEY_BYTES: usize = 1024;
const MAX_DEVICE_ID_BYTES: usize = 512;

/// A raw license key scoped to the private license owner.
///
/// The value is never serializable and its debug representation is redacted.
/// Callers should pass ownership to the private store as soon as possible.
#[derive(Eq, PartialEq)]
pub(crate) struct LicenseKey(Vec<u8>);

impl LicenseKey {
    pub(crate) fn try_new(value: impl AsRef<str>) -> Result<Self, LicensePrivateError> {
        let value = value.as_ref().trim();
        if value.is_empty() || value.len() > MAX_LICENSE_KEY_BYTES {
            return Err(LicensePrivateError::InvalidInput);
        }
        Ok(Self(value.as_bytes().to_vec()))
    }

    pub(super) fn from_plaintext(mut bytes: Vec<u8>) -> Result<Self, LicensePrivateError> {
        let result = std::str::from_utf8(&bytes)
            .map_err(|_| LicensePrivateError::CorruptState)
            .and_then(|value| {
                let value = value.trim();
                if value.is_empty() || value.len() > MAX_LICENSE_KEY_BYTES {
                    return Err(LicensePrivateError::CorruptState);
                }
                Ok(Self(value.as_bytes().to_vec()))
            });
        bytes.zeroize();
        result
    }

    pub(super) fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub(super) fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("LicenseKey is validated UTF-8")
    }
}

impl fmt::Debug for LicenseKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LicenseKey(<redacted>)")
    }
}

impl Drop for LicenseKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// The device identity is retained only as a private digest by the store.
#[derive(Eq, PartialEq)]
pub(crate) struct LicenseDeviceIdentity(String);

impl LicenseDeviceIdentity {
    pub(crate) fn try_new(value: impl AsRef<str>) -> Result<Self, LicensePrivateError> {
        let value = value.as_ref().trim();
        if value.is_empty() || value.len() > MAX_DEVICE_ID_BYTES {
            return Err(LicensePrivateError::InvalidInput);
        }
        Ok(Self(value.to_owned()))
    }

    pub(super) fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }

    pub(super) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for LicenseDeviceIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LicenseDeviceIdentity(<redacted>)")
    }
}

impl Drop for LicenseDeviceIdentity {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Metadata supplied by an external validation authority.
///
/// This type carries only cache timing facts. The environment leaf does not
/// contact a license service and does not turn this metadata into an online
/// validation result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct LicenseCacheMetadata {
    last_validated_at_ms: u64,
    offline_grace_until_ms: u64,
    expires_at_ms: Option<u64>,
    revalidate_after_ms: Option<u64>,
}

impl LicenseCacheMetadata {
    pub(crate) fn try_new(
        last_validated_at_ms: u64,
        offline_grace_until_ms: u64,
        expires_at_ms: Option<u64>,
        revalidate_after_ms: Option<u64>,
    ) -> Result<Self, LicensePrivateError> {
        let metadata = Self {
            last_validated_at_ms,
            offline_grace_until_ms,
            expires_at_ms,
            revalidate_after_ms,
        };
        metadata.validate().map(|()| metadata)
    }

    pub(super) fn validate(&self) -> Result<(), LicensePrivateError> {
        if self.offline_grace_until_ms < self.last_validated_at_ms
            || self
                .expires_at_ms
                .is_some_and(|expires_at| expires_at < self.last_validated_at_ms)
            || self
                .revalidate_after_ms
                .is_some_and(|revalidate_after| revalidate_after < self.last_validated_at_ms)
        {
            return Err(LicensePrivateError::InvalidInput);
        }
        Ok(())
    }

    pub(super) fn last_validated_at_ms(self) -> u64 {
        self.last_validated_at_ms
    }

    pub(super) fn offline_grace_until_ms(self) -> u64 {
        self.offline_grace_until_ms
    }

    pub(super) fn expires_at_ms(self) -> Option<u64> {
        self.expires_at_ms
    }

    pub(super) fn revalidate_after_ms(self) -> Option<u64> {
        self.revalidate_after_ms
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LicensePrivateError {
    InvalidInput,
    NoStoredKey,
    NoCachedValidation,
    StorageUnavailable,
    CorruptState,
    CryptoUnavailable,
    IdentityMismatch,
    KeyHashMismatch,
    Expired,
}

impl fmt::Display for LicensePrivateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "License private input is invalid",
            Self::NoStoredKey => "No private license key is stored",
            Self::NoCachedValidation => "No cached license validation is available",
            Self::StorageUnavailable => "License private storage is unavailable",
            Self::CorruptState => "License private state is corrupt",
            Self::CryptoUnavailable => "License private cryptography is unavailable",
            Self::IdentityMismatch => "License device identity does not match",
            Self::KeyHashMismatch => "License key hash does not match private state",
            Self::Expired => "License cache is expired",
        })
    }
}

impl std::error::Error for LicensePrivateError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LicenseProjectionState {
    Unknown,
    Unavailable,
    CacheBacked,
    Expired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LicenseProjectionReason {
    NoStoredKey,
    NoCachedValidation,
    CacheGraceValid,
    RevalidationDue,
    Expired,
    IdentityMismatch,
    KeyHashMismatch,
    CorruptState,
    StorageUnavailable,
    CryptoUnavailable,
}

/// A safe projection for delivery layers. It contains no key, path, token, or
/// native validation detail.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct LicenseProjection {
    pub state: LicenseProjectionState,
    pub reason: LicenseProjectionReason,
    pub has_stored_key: bool,
    pub has_usable_cache: bool,
    pub last_validated_at_ms: Option<u64>,
    pub expires_at_ms: Option<u64>,
    pub offline_grace_until_ms: Option<u64>,
    pub revalidate_after_ms: Option<u64>,
    pub revalidation_due: bool,
}

impl LicensePrivateError {
    pub(super) fn projection(self) -> LicenseProjection {
        let (state, reason, has_stored_key) = match self {
            Self::InvalidInput | Self::NoStoredKey => (
                LicenseProjectionState::Unknown,
                LicenseProjectionReason::NoStoredKey,
                false,
            ),
            Self::NoCachedValidation => (
                LicenseProjectionState::Unavailable,
                LicenseProjectionReason::NoCachedValidation,
                true,
            ),
            Self::StorageUnavailable => (
                LicenseProjectionState::Unavailable,
                LicenseProjectionReason::StorageUnavailable,
                false,
            ),
            Self::CryptoUnavailable => (
                LicenseProjectionState::Unavailable,
                LicenseProjectionReason::CryptoUnavailable,
                true,
            ),
            Self::CorruptState => (
                LicenseProjectionState::Unknown,
                LicenseProjectionReason::CorruptState,
                true,
            ),
            Self::IdentityMismatch => (
                LicenseProjectionState::Unknown,
                LicenseProjectionReason::IdentityMismatch,
                true,
            ),
            Self::KeyHashMismatch => (
                LicenseProjectionState::Unknown,
                LicenseProjectionReason::KeyHashMismatch,
                true,
            ),
            Self::Expired => (
                LicenseProjectionState::Expired,
                LicenseProjectionReason::Expired,
                true,
            ),
        };
        LicenseProjection {
            state,
            reason,
            has_stored_key,
            has_usable_cache: false,
            last_validated_at_ms: None,
            expires_at_ms: None,
            offline_grace_until_ms: None,
            revalidate_after_ms: None,
            revalidation_due: false,
        }
    }
}
