use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::EnvironmentIngressFailure;
use crate::{
    BrowserMode, ChannelAccountId, ChannelDirectMessagePolicy, ChannelOperationalDesired,
    ChannelReference, ConnectorReference, CredentialReference, DesiredConfiguration,
    DesiredDefinition, EnvironmentCommand, EnvironmentId, EnvironmentRevision, ExtensionReference,
    PolicyReference, ProviderReference, SecurityPreset, ToolchainReference,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WireEnvelope {
    pub(super) version: u8,
    pub(super) actor: String,
    pub(super) authorization: WireAuthorization,
    pub(super) provenance: String,
    pub(super) nonce: String,
    pub(super) command: WireCommand,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WireAuthorization {
    pub(super) grant_id: String,
    pub(super) proof: String,
    pub(super) expires_at: u64,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum WireCommand {
    Create {
        definition: WireDefinition,
    },
    Replace {
        environment_id: String,
        expected_revision: u64,
        definition: WireDefinition,
    },
    Delete {
        environment_id: String,
        expected_revision: u64,
    },
}

impl WireCommand {
    pub(super) fn into_command(self) -> Result<EnvironmentCommand, EnvironmentIngressFailure> {
        match self {
            Self::Create { definition } => {
                EnvironmentCommand::create(definition.into_definition()?)
                    .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)
            }
            Self::Replace {
                environment_id,
                expected_revision,
                definition,
            } => EnvironmentCommand::replace(
                parse_environment_id(environment_id)?,
                revision(expected_revision)?,
                definition.into_definition()?,
            )
            .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope),
            Self::Delete {
                environment_id,
                expected_revision,
            } => Ok(EnvironmentCommand::delete(
                parse_environment_id(environment_id)?,
                revision(expected_revision)?,
            )),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WireDefinition {
    environment_id: String,
    revision: u64,
    provider: String,
    configuration: WireConfiguration,
}

impl WireDefinition {
    fn into_definition(self) -> Result<DesiredDefinition, EnvironmentIngressFailure> {
        Ok(DesiredDefinition::new(
            parse_environment_id(self.environment_id)?,
            revision(self.revision)?,
            ProviderReference::try_new(self.provider)
                .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)?,
            self.configuration.into_configuration()?,
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireConfiguration {
    connectors: Vec<String>,
    extensions: Vec<String>,
    channels: Vec<String>,
    credential_references: Vec<String>,
    policies: Vec<String>,
    toolchains: Vec<String>,
    security_preset: WireSecurityPreset,
    browser_mode: WireBrowserMode,
    operational_channels: Vec<WireOperationalChannel>,
}

impl WireConfiguration {
    fn into_configuration(self) -> Result<DesiredConfiguration, EnvironmentIngressFailure> {
        DesiredConfiguration::try_new(
            references(self.connectors, ConnectorReference::try_new)?,
            references(self.extensions, ExtensionReference::try_new)?,
            references(self.channels, ChannelReference::try_new)?,
            references(self.credential_references, CredentialReference::try_new)?,
            references(self.policies, PolicyReference::try_new)?,
            references(self.toolchains, ToolchainReference::try_new)?,
            self.security_preset.into_domain(),
            self.browser_mode.into_domain(),
            self.operational_channels
                .into_iter()
                .map(WireOperationalChannel::into_domain)
                .collect::<Result<Vec<_>, _>>()?,
        )
        .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum WireSecurityPreset {
    Strict,
    Balanced,
    Relaxed,
}

impl WireSecurityPreset {
    const fn into_domain(self) -> SecurityPreset {
        match self {
            Self::Strict => SecurityPreset::Strict,
            Self::Balanced => SecurityPreset::Balanced,
            Self::Relaxed => SecurityPreset::Relaxed,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum WireBrowserMode {
    Native,
    Relay,
    Off,
}

impl WireBrowserMode {
    const fn into_domain(self) -> BrowserMode {
        match self {
            Self::Native => BrowserMode::Native,
            Self::Relay => BrowserMode::Relay,
            Self::Off => BrowserMode::Off,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireOperationalChannel {
    channel: String,
    account: String,
    enabled: bool,
    direct_message_policy: WireDirectMessagePolicy,
}

impl WireOperationalChannel {
    fn into_domain(self) -> Result<ChannelOperationalDesired, EnvironmentIngressFailure> {
        Ok(ChannelOperationalDesired::new(
            ChannelReference::try_new(self.channel)
                .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)?,
            ChannelAccountId::try_new(self.account)
                .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)?,
            self.enabled,
            self.direct_message_policy.into_domain(),
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum WireDirectMessagePolicy {
    Pairing,
    Allowlist,
    Open,
    Disabled,
}

impl WireDirectMessagePolicy {
    const fn into_domain(self) -> ChannelDirectMessagePolicy {
        match self {
            Self::Pairing => ChannelDirectMessagePolicy::Pairing,
            Self::Allowlist => ChannelDirectMessagePolicy::Allowlist,
            Self::Open => ChannelDirectMessagePolicy::Open,
            Self::Disabled => ChannelDirectMessagePolicy::Disabled,
        }
    }
}

fn parse_environment_id(value: String) -> Result<EnvironmentId, EnvironmentIngressFailure> {
    EnvironmentId::try_new(value).map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)
}

fn revision(value: u64) -> Result<EnvironmentRevision, EnvironmentIngressFailure> {
    EnvironmentRevision::try_new(value).map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)
}

pub(super) fn timestamp(value: u64) -> Result<SystemTime, EnvironmentIngressFailure> {
    UNIX_EPOCH
        .checked_add(Duration::from_secs(value))
        .ok_or(EnvironmentIngressFailure::InvalidEnvelope)
}

fn references<T, E>(
    values: Vec<String>,
    create: impl FnMut(String) -> Result<T, E>,
) -> Result<Vec<T>, EnvironmentIngressFailure> {
    values
        .into_iter()
        .map(create)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| EnvironmentIngressFailure::InvalidEnvelope)
}
