use std::fmt;

use crate::definition::{CredentialReference, ProviderReference};

const MAX_ACCOUNT_ID_BYTES: usize = 128;
const MAX_LABEL_BYTES: usize = 256;
const MAX_ENDPOINT_BYTES: usize = 2_048;

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub struct ProviderAccountId(String);

impl ProviderAccountId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidProviderAccountId> {
        let value = value.into();
        valid_identifier(&value, MAX_ACCOUNT_ID_BYTES)
            .then_some(Self(value))
            .ok_or(InvalidProviderAccountId)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderAccountId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProviderAccountId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for ProviderAccountId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidProviderAccountId;

impl fmt::Display for InvalidProviderAccountId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider account identifier is invalid")
    }
}

impl std::error::Error for InvalidProviderAccountId {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAccountAuthMode {
    ApiKey,
    OAuthBrowser,
    OAuthDevice,
    Local,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderApiProtocol {
    AnthropicMessages,
    GoogleGenerativeAi,
    OpenAiCompletions,
    OpenAiResponses,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAccountKind {
    Chat,
    Media,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderMediaApiProtocol {
    Google,
    OpenAi,
    OpenRouter,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProviderEndpoint(String);

impl ProviderEndpoint {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidProviderEndpoint> {
        let value = value.into();
        valid_endpoint(&value)
            .then_some(Self(value))
            .ok_or(InvalidProviderEndpoint)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProviderEndpoint")
            .field(&self.0)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidProviderEndpoint;

impl fmt::Display for InvalidProviderEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider endpoint is invalid")
    }
}

impl std::error::Error for InvalidProviderEndpoint {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderAccountConfiguration {
    label: String,
    enabled: bool,
    kind: ProviderAccountKind,
    endpoint: Option<ProviderEndpoint>,
    protocol: Option<ProviderApiProtocol>,
    media_protocol: Option<ProviderMediaApiProtocol>,
    auth_mode: ProviderAccountAuthMode,
    credential: Option<CredentialReference>,
    created_at: String,
    updated_at: String,
}

/// Owned input for validating and constructing a provider account configuration.
#[derive(Debug)]
pub struct ProviderAccountConfigurationInput {
    pub label: String,
    pub enabled: bool,
    pub kind: ProviderAccountKind,
    pub endpoint: Option<ProviderEndpoint>,
    pub protocol: Option<ProviderApiProtocol>,
    pub media_protocol: Option<ProviderMediaApiProtocol>,
    pub auth_mode: ProviderAccountAuthMode,
    pub credential: Option<CredentialReference>,
    pub created_at: String,
    pub updated_at: String,
}

impl ProviderAccountConfiguration {
    pub fn try_new(
        input: ProviderAccountConfigurationInput,
    ) -> Result<Self, InvalidProviderAccountConfiguration> {
        let ProviderAccountConfigurationInput {
            label,
            enabled,
            kind,
            endpoint,
            protocol,
            media_protocol,
            auth_mode,
            credential,
            created_at,
            updated_at,
        } = input;
        if label.trim().is_empty()
            || label.len() > MAX_LABEL_BYTES
            || label.chars().any(char::is_control)
        {
            return Err(InvalidProviderAccountConfiguration::InvalidLabel);
        }
        if matches!(auth_mode, ProviderAccountAuthMode::Local) && credential.is_some() {
            return Err(InvalidProviderAccountConfiguration::LocalCredential);
        }
        if !matches!(auth_mode, ProviderAccountAuthMode::Local) && credential.is_none() {
            return Err(InvalidProviderAccountConfiguration::CredentialRequired);
        }
        if !valid_timestamp(&created_at) || !valid_timestamp(&updated_at) {
            return Err(InvalidProviderAccountConfiguration::InvalidTimestamp);
        }
        match kind {
            ProviderAccountKind::Chat if media_protocol.is_some() => {
                return Err(InvalidProviderAccountConfiguration::UnexpectedMediaProtocol);
            }
            ProviderAccountKind::Media if protocol.is_some() || media_protocol.is_none() => {
                return Err(InvalidProviderAccountConfiguration::InvalidMediaProtocol);
            }
            _ => {}
        }
        Ok(Self {
            label,
            enabled,
            kind,
            endpoint,
            protocol,
            media_protocol,
            auth_mode,
            credential,
            created_at,
            updated_at,
        })
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub const fn enabled(&self) -> bool {
        self.enabled
    }

    pub const fn kind(&self) -> ProviderAccountKind {
        self.kind
    }

    pub fn endpoint(&self) -> Option<&ProviderEndpoint> {
        self.endpoint.as_ref()
    }

    pub const fn protocol(&self) -> Option<ProviderApiProtocol> {
        self.protocol
    }

    pub const fn media_protocol(&self) -> Option<ProviderMediaApiProtocol> {
        self.media_protocol
    }

    pub const fn auth_mode(&self) -> ProviderAccountAuthMode {
        self.auth_mode
    }

    pub fn credential(&self) -> Option<&CredentialReference> {
        self.credential.as_ref()
    }

    pub fn created_at(&self) -> &str {
        &self.created_at
    }

    pub fn updated_at(&self) -> &str {
        &self.updated_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidProviderAccountConfiguration {
    CredentialRequired,
    InvalidLabel,
    InvalidMediaProtocol,
    InvalidTimestamp,
    LocalCredential,
    UnexpectedMediaProtocol,
}

impl fmt::Display for InvalidProviderAccountConfiguration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::CredentialRequired => {
                "provider account authentication requires a credential reference"
            }
            Self::InvalidLabel => "provider account label is invalid",
            Self::InvalidMediaProtocol => "provider media account protocol is invalid",
            Self::InvalidTimestamp => "provider account timestamp is invalid",
            Self::LocalCredential => "local provider accounts cannot select a credential",
            Self::UnexpectedMediaProtocol => {
                "chat provider accounts cannot select a media protocol"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for InvalidProviderAccountConfiguration {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderAccount {
    id: ProviderAccountId,
    provider: ProviderReference,
    revision: ProviderAccountRevision,
    configuration: ProviderAccountConfiguration,
}

impl ProviderAccount {
    pub fn new(
        id: ProviderAccountId,
        provider: ProviderReference,
        revision: ProviderAccountRevision,
        configuration: ProviderAccountConfiguration,
    ) -> Self {
        Self {
            id,
            provider,
            revision,
            configuration,
        }
    }

    pub fn id(&self) -> &ProviderAccountId {
        &self.id
    }

    pub fn provider(&self) -> &ProviderReference {
        &self.provider
    }

    pub const fn revision(&self) -> ProviderAccountRevision {
        self.revision
    }

    pub fn configuration(&self) -> &ProviderAccountConfiguration {
        &self.configuration
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ProviderAccountRevision(u64);

impl ProviderAccountRevision {
    pub fn try_new(value: u64) -> Result<Self, InvalidProviderAccountRevision> {
        (value > 0)
            .then_some(Self(value))
            .ok_or(InvalidProviderAccountRevision)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidProviderAccountRevision;

impl fmt::Display for InvalidProviderAccountRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider account revision must be non-zero")
    }
}

impl std::error::Error for InvalidProviderAccountRevision {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderAccountSelection {
    provider: ProviderReference,
    account_id: ProviderAccountId,
}

impl ProviderAccountSelection {
    pub fn new(provider: ProviderReference, account_id: ProviderAccountId) -> Self {
        Self {
            provider,
            account_id,
        }
    }

    pub fn select<'a>(&self, accounts: &'a [ProviderAccount]) -> Option<&'a ProviderAccount> {
        accounts.iter().find(|account| {
            account.provider() == &self.provider && account.id() == &self.account_id
        })
    }
}

fn valid_identifier(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

fn valid_endpoint(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_ENDPOINT_BYTES || value.chars().any(char::is_control) {
        return false;
    }
    let Some(remainder) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = remainder.split('/').next().unwrap_or_default();
    !authority.is_empty() && !authority.contains('@') && !authority.chars().any(char::is_whitespace)
}

fn valid_timestamp(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && !value.chars().any(char::is_control)
}

#[cfg(test)]
#[path = "provider_account_tests.rs"]
mod tests;
