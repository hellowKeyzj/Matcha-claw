use std::fmt;

const CREDENTIAL_REFERENCE_PREFIX: &str = "credential:v1:";
const MAX_CREDENTIAL_REFERENCE_BYTES: usize = 128;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderReference(String);

impl ProviderReference {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidProviderReference> {
        let value = value.into();
        (!value.trim().is_empty())
            .then_some(Self(value))
            .ok_or(InvalidProviderReference)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidProviderReference;

impl fmt::Display for InvalidProviderReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider reference must not be empty")
    }
}

impl std::error::Error for InvalidProviderReference {}

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct CredentialReference(String);

impl CredentialReference {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidCredentialReference> {
        let value = value.into();
        valid_credential_reference(&value)
            .then_some(Self(value))
            .ok_or(InvalidCredentialReference)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CredentialReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialReference([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCredentialReference;

impl fmt::Display for InvalidCredentialReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("credential reference is invalid")
    }
}

impl std::error::Error for InvalidCredentialReference {}

fn valid_credential_reference(value: &str) -> bool {
    value.len() <= MAX_CREDENTIAL_REFERENCE_BYTES
        && value
            .strip_prefix(CREDENTIAL_REFERENCE_PREFIX)
            .is_some_and(valid_credential_profile_id)
}

fn valid_credential_profile_id(value: &str) -> bool {
    !value.is_empty()
        && !value.contains("..")
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}
