use std::fmt;

use super::{
    BrowserMode, ChannelOperationalDesired, EnvironmentId, EnvironmentRevision, SecurityPreset,
    canonicalize_operational_channels,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesiredDefinition {
    environment_id: EnvironmentId,
    revision: EnvironmentRevision,
    provider: ProviderReference,
    configuration: DesiredConfiguration,
}

impl DesiredDefinition {
    pub fn new(
        environment_id: EnvironmentId,
        revision: EnvironmentRevision,
        provider: ProviderReference,
        configuration: DesiredConfiguration,
    ) -> Self {
        Self {
            environment_id,
            revision,
            provider,
            configuration,
        }
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub fn revision(&self) -> EnvironmentRevision {
        self.revision
    }

    pub fn provider(&self) -> &ProviderReference {
        &self.provider
    }

    pub fn configuration(&self) -> &DesiredConfiguration {
        &self.configuration
    }

    pub fn connectors(&self) -> &[ConnectorReference] {
        self.configuration.connectors()
    }

    pub fn extensions(&self) -> &[ExtensionReference] {
        self.configuration.extensions()
    }

    pub fn channels(&self) -> &[ChannelReference] {
        self.configuration.channels()
    }

    pub fn credential_references(&self) -> &[CredentialReference] {
        self.configuration.credential_references()
    }

    pub fn policies(&self) -> &[PolicyReference] {
        self.configuration.policies()
    }

    pub fn toolchains(&self) -> &[ToolchainReference] {
        self.configuration.toolchains()
    }

    pub const fn security_preset(&self) -> SecurityPreset {
        self.configuration.security_preset()
    }

    pub const fn browser_mode(&self) -> BrowserMode {
        self.configuration.browser_mode()
    }

    pub fn operational_channels(&self) -> &[ChannelOperationalDesired] {
        self.configuration.operational_channels()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesiredConfiguration {
    connectors: Vec<ConnectorReference>,
    extensions: Vec<ExtensionReference>,
    channels: Vec<ChannelReference>,
    credential_references: Vec<CredentialReference>,
    policies: Vec<PolicyReference>,
    toolchains: Vec<ToolchainReference>,
    security_preset: SecurityPreset,
    browser_mode: BrowserMode,
    operational_channels: Vec<ChannelOperationalDesired>,
}

impl DesiredConfiguration {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        connectors: Vec<ConnectorReference>,
        extensions: Vec<ExtensionReference>,
        channels: Vec<ChannelReference>,
        credential_references: Vec<CredentialReference>,
        policies: Vec<PolicyReference>,
        toolchains: Vec<ToolchainReference>,
        security_preset: SecurityPreset,
        browser_mode: BrowserMode,
        operational_channels: Vec<ChannelOperationalDesired>,
    ) -> Result<Self, InvalidDesiredConfiguration> {
        if has_duplicate(&connectors) {
            return Err(InvalidDesiredConfiguration::DuplicateConnectorReference);
        }
        if has_duplicate(&extensions) {
            return Err(InvalidDesiredConfiguration::DuplicateExtensionReference);
        }
        if has_duplicate(&channels) {
            return Err(InvalidDesiredConfiguration::DuplicateChannelReference);
        }
        if has_duplicate(&credential_references) {
            return Err(InvalidDesiredConfiguration::DuplicateCredentialReference);
        }
        let mut credential_references = credential_references;
        credential_references.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        if has_duplicate(&policies) {
            return Err(InvalidDesiredConfiguration::DuplicatePolicyReference);
        }
        if has_duplicate(&toolchains) {
            return Err(InvalidDesiredConfiguration::DuplicateToolchainReference);
        }
        if operational_channels
            .iter()
            .enumerate()
            .any(|(index, channel)| {
                operational_channels[..index].iter().any(|prior| {
                    prior.channel() == channel.channel() && prior.account() == channel.account()
                })
            })
        {
            return Err(InvalidDesiredConfiguration::DuplicateOperationalChannel);
        }
        let mut operational_channels = operational_channels;
        canonicalize_operational_channels(&mut operational_channels);

        Ok(Self {
            connectors,
            extensions,
            channels,
            credential_references,
            policies,
            toolchains,
            security_preset,
            browser_mode,
            operational_channels,
        })
    }

    pub fn connectors(&self) -> &[ConnectorReference] {
        &self.connectors
    }

    pub fn extensions(&self) -> &[ExtensionReference] {
        &self.extensions
    }

    pub fn channels(&self) -> &[ChannelReference] {
        &self.channels
    }

    pub fn credential_references(&self) -> &[CredentialReference] {
        &self.credential_references
    }

    pub fn policies(&self) -> &[PolicyReference] {
        &self.policies
    }

    pub fn toolchains(&self) -> &[ToolchainReference] {
        &self.toolchains
    }

    pub const fn security_preset(&self) -> SecurityPreset {
        self.security_preset
    }

    pub const fn browser_mode(&self) -> BrowserMode {
        self.browser_mode
    }

    pub fn operational_channels(&self) -> &[ChannelOperationalDesired] {
        &self.operational_channels
    }
}

macro_rules! define_reference {
    ($name:ident, $invalid_name:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, PartialEq)]
        pub struct $name(String);

        impl $name {
            /// Creates a non-secret Environment definition reference.
            ///
            /// # Errors
            ///
            /// Returns [`$invalid_name`] when `value` is empty or contains only
            /// whitespace.
            pub fn try_new(value: impl Into<String>) -> Result<Self, $invalid_name> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err($invalid_name);
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct $invalid_name;

        impl fmt::Display for $invalid_name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(concat!($label, " reference must not be empty"))
            }
        }

        impl std::error::Error for $invalid_name {}
    };
}

define_reference!(ProviderReference, InvalidProviderReference, "provider");
define_reference!(ConnectorReference, InvalidConnectorReference, "connector");
define_reference!(ExtensionReference, InvalidExtensionReference, "extension");
define_reference!(ChannelReference, InvalidChannelReference, "channel");
define_reference!(PolicyReference, InvalidPolicyReference, "policy");
define_reference!(ToolchainReference, InvalidToolchainReference, "toolchain");

const CREDENTIAL_REFERENCE_PREFIX: &str = "credential:v1:";
const MAX_CREDENTIAL_REFERENCE_BYTES: usize = 128;

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct CredentialReference(String);

impl CredentialReference {
    /// Creates a version-bound opaque reference to privately held credential material.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidCredentialReference`] unless `value` is a v1 credential
    /// reference with a bounded opaque identifier.
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidDesiredConfiguration {
    DuplicateConnectorReference,
    DuplicateExtensionReference,
    DuplicateChannelReference,
    DuplicateCredentialReference,
    DuplicatePolicyReference,
    DuplicateToolchainReference,
    DuplicateOperationalChannel,
}

impl fmt::Display for InvalidDesiredConfiguration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::DuplicateConnectorReference => "connector references must be distinct",
            Self::DuplicateExtensionReference => "extension references must be distinct",
            Self::DuplicateChannelReference => "channel references must be distinct",
            Self::DuplicateCredentialReference => "credential references must be distinct",
            Self::DuplicatePolicyReference => "policy references must be distinct",
            Self::DuplicateToolchainReference => "toolchain references must be distinct",
            Self::DuplicateOperationalChannel => {
                "operational channel and account pairs must be distinct"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for InvalidDesiredConfiguration {}

fn has_duplicate<T: Eq>(references: &[T]) -> bool {
    references
        .iter()
        .enumerate()
        .any(|(index, reference)| references[..index].contains(reference))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::definition::{ChannelAccountId, ChannelDirectMessagePolicy};

    fn configuration() -> DesiredConfiguration {
        DesiredConfiguration::try_new(
            vec![ConnectorReference::try_new("slack").unwrap()],
            vec![ExtensionReference::try_new("browser-relay").unwrap()],
            vec![ChannelReference::try_new("discord").unwrap()],
            vec![CredentialReference::try_new("credential:v1:anthropic").unwrap()],
            vec![PolicyReference::try_new("security:balanced").unwrap()],
            vec![ToolchainReference::try_new("bun:1").unwrap()],
            SecurityPreset::Balanced,
            BrowserMode::Relay,
            vec![ChannelOperationalDesired::new(
                ChannelReference::try_new("discord").unwrap(),
                ChannelAccountId::try_new("default").unwrap(),
                true,
                ChannelDirectMessagePolicy::Pairing,
            )],
        )
        .unwrap()
    }

    fn definition() -> DesiredDefinition {
        DesiredDefinition::new(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(7).unwrap(),
            ProviderReference::try_new("anthropic").unwrap(),
            configuration(),
        )
    }

    #[test]
    fn desired_definition_preserves_each_domain_owned_configuration_plane() {
        let definition = definition();

        assert_eq!(definition.environment_id().as_str(), "environment:primary");
        assert_eq!(definition.revision().get(), 7);
        assert_eq!(definition.provider().as_str(), "anthropic");
        assert_eq!(definition.connectors()[0].as_str(), "slack");
        assert_eq!(definition.extensions()[0].as_str(), "browser-relay");
        assert_eq!(definition.channels()[0].as_str(), "discord");
        assert_eq!(
            definition.credential_references()[0].as_str(),
            "credential:v1:anthropic"
        );
        assert_eq!(definition.policies()[0].as_str(), "security:balanced");
        assert_eq!(definition.toolchains()[0].as_str(), "bun:1");
        assert_eq!(definition.security_preset(), SecurityPreset::Balanced);
        assert_eq!(definition.browser_mode(), BrowserMode::Relay);
        assert_eq!(
            definition.operational_channels()[0].account().as_str(),
            "default"
        );
    }

    #[test]
    fn configuration_rejects_duplicate_references_in_every_plane() {
        let connector = ConnectorReference::try_new("connector:calendar").unwrap();
        assert_eq!(
            DesiredConfiguration::try_new(
                vec![connector.clone(), connector],
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap_err(),
            InvalidDesiredConfiguration::DuplicateConnectorReference
        );

        let extension = ExtensionReference::try_new("extension:browser").unwrap();
        assert_eq!(
            DesiredConfiguration::try_new(
                Vec::new(),
                vec![extension.clone(), extension],
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap_err(),
            InvalidDesiredConfiguration::DuplicateExtensionReference
        );

        let channel = ChannelReference::try_new("channel:discord").unwrap();
        assert_eq!(
            DesiredConfiguration::try_new(
                Vec::new(),
                Vec::new(),
                vec![channel.clone(), channel],
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap_err(),
            InvalidDesiredConfiguration::DuplicateChannelReference
        );

        let credential = CredentialReference::try_new("credential:v1:anthropic").unwrap();
        assert_eq!(
            DesiredConfiguration::try_new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                vec![credential.clone(), credential],
                Vec::new(),
                Vec::new(),
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap_err(),
            InvalidDesiredConfiguration::DuplicateCredentialReference
        );

        let policy = PolicyReference::try_new("policy:balanced").unwrap();
        assert_eq!(
            DesiredConfiguration::try_new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                vec![policy.clone(), policy],
                Vec::new(),
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap_err(),
            InvalidDesiredConfiguration::DuplicatePolicyReference
        );

        let toolchain = ToolchainReference::try_new("toolchain:bun").unwrap();
        assert_eq!(
            DesiredConfiguration::try_new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                vec![toolchain.clone(), toolchain],
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap_err(),
            InvalidDesiredConfiguration::DuplicateToolchainReference
        );

        let operational = ChannelOperationalDesired::new(
            ChannelReference::try_new("channel:discord").unwrap(),
            ChannelAccountId::try_new("default").unwrap(),
            true,
            ChannelDirectMessagePolicy::Pairing,
        );
        assert_eq!(
            DesiredConfiguration::try_new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                vec![operational.clone(), operational],
            )
            .unwrap_err(),
            InvalidDesiredConfiguration::DuplicateOperationalChannel
        );
    }

    #[test]
    fn operational_channels_are_canonicalized_by_channel_and_account() {
        let configuration = DesiredConfiguration::try_new(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            SecurityPreset::Relaxed,
            BrowserMode::Relay,
            vec![
                ChannelOperationalDesired::new(
                    ChannelReference::try_new("whatsapp").unwrap(),
                    ChannelAccountId::try_new("work").unwrap(),
                    true,
                    ChannelDirectMessagePolicy::Open,
                ),
                ChannelOperationalDesired::new(
                    ChannelReference::try_new("discord").unwrap(),
                    ChannelAccountId::try_new("zeta").unwrap(),
                    true,
                    ChannelDirectMessagePolicy::Pairing,
                ),
                ChannelOperationalDesired::new(
                    ChannelReference::try_new("discord").unwrap(),
                    ChannelAccountId::try_new("alpha").unwrap(),
                    false,
                    ChannelDirectMessagePolicy::Disabled,
                ),
            ],
        )
        .unwrap();

        assert_eq!(
            configuration
                .operational_channels()
                .iter()
                .map(|desired| (desired.channel().as_str(), desired.account().as_str()))
                .collect::<Vec<_>>(),
            [
                ("discord", "alpha"),
                ("discord", "zeta"),
                ("whatsapp", "work")
            ]
        );
    }

    #[test]
    fn credential_references_require_the_current_opaque_material_grammar() {
        let reference = CredentialReference::try_new("credential:v1:anthropic:primary").unwrap();

        assert_eq!(reference.as_str(), "credential:v1:anthropic:primary");
        assert_eq!(
            CredentialReference::try_new("credential:anthropic"),
            Err(InvalidCredentialReference)
        );
        assert_eq!(
            CredentialReference::try_new("credential:v2:anthropic"),
            Err(InvalidCredentialReference)
        );
        assert_eq!(
            CredentialReference::try_new("credential:v1:../anthropic"),
            Err(InvalidCredentialReference)
        );
        assert_eq!(
            CredentialReference::try_new("credential:v1:anthropic/key"),
            Err(InvalidCredentialReference)
        );
    }

    #[test]
    fn credential_reference_debug_and_errors_do_not_expose_opaque_material_identity() {
        let reference = CredentialReference::try_new("credential:v1:private-canary").unwrap();
        let error = CredentialReference::try_new("credential:v1:private-canary/value").unwrap_err();

        assert_eq!(format!("{reference:?}"), "CredentialReference([REDACTED])");
        assert_eq!(error, InvalidCredentialReference);
        assert_eq!(error.to_string(), "credential reference is invalid");
        assert!(!format!("{reference:?} {error:?} {error}").contains("private-canary"));
    }

    #[test]
    fn credential_accounts_are_canonicalized_before_private_projection() {
        let configuration = DesiredConfiguration::try_new(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec![
                CredentialReference::try_new("credential:v1:openai:secondary").unwrap(),
                CredentialReference::try_new("credential:v1:openai:primary").unwrap(),
            ],
            Vec::new(),
            Vec::new(),
            SecurityPreset::Relaxed,
            BrowserMode::Relay,
            Vec::new(),
        )
        .unwrap();

        assert_eq!(
            configuration
                .credential_references()
                .iter()
                .map(CredentialReference::as_str)
                .collect::<Vec<_>>(),
            [
                "credential:v1:openai:primary",
                "credential:v1:openai:secondary"
            ]
        );
    }
}
