use std::{fmt, future::Future, pin::Pin};

use crate::definition::{
    BrowserMode, ChannelOperationalDesired, ChannelReference, ConnectorReference,
    CredentialReference, DesiredDefinition, EnvironmentId, EnvironmentRevision, ExtensionReference,
    PolicyReference, ProviderReference, SecurityPreset, ToolchainReference,
    canonicalize_operational_channels,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppliedProjection {
    environment_id: EnvironmentId,
    revision: EnvironmentRevision,
    receipt: VerifiedProjectionReceipt,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct VerifiedProjectionReceipt {
    provider: ProviderReference,
    connectors: Vec<ConnectorReference>,
    extensions: Vec<ExtensionReference>,
    channels: Vec<ChannelReference>,
    private_credential_projection: Vec<CredentialReference>,
    policies: Vec<PolicyReference>,
    toolchains: Vec<ToolchainReference>,
    security_preset: SecurityPreset,
    browser_mode: BrowserMode,
    operational_channels: Vec<ChannelOperationalDesired>,
}

impl AppliedProjection {
    #[allow(clippy::too_many_arguments)]
    pub fn from_verified_readback(
        environment_id: EnvironmentId,
        revision: EnvironmentRevision,
        provider: ProviderReference,
        connectors: Vec<ConnectorReference>,
        extensions: Vec<ExtensionReference>,
        channels: Vec<ChannelReference>,
        private_credential_projection: Vec<CredentialReference>,
        policies: Vec<PolicyReference>,
        toolchains: Vec<ToolchainReference>,
        security_preset: SecurityPreset,
        browser_mode: BrowserMode,
        operational_channels: Vec<ChannelOperationalDesired>,
    ) -> Self {
        let mut operational_channels = operational_channels;
        canonicalize_operational_channels(&mut operational_channels);
        Self {
            environment_id,
            revision,
            receipt: VerifiedProjectionReceipt {
                provider,
                connectors,
                extensions,
                channels,
                private_credential_projection,
                policies,
                toolchains,
                security_preset,
                browser_mode,
                operational_channels,
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn new(environment_id: EnvironmentId, revision: EnvironmentRevision) -> Self {
        Self::revision_evidence(environment_id, revision)
    }

    #[cfg(test)]
    pub(crate) fn revision_evidence(
        environment_id: EnvironmentId,
        revision: EnvironmentRevision,
    ) -> Self {
        Self::from_verified_readback(
            environment_id,
            revision,
            ProviderReference::try_new("test:provider").expect("test provider is valid"),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            SecurityPreset::Relaxed,
            BrowserMode::Relay,
            Vec::new(),
        )
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub const fn revision(&self) -> EnvironmentRevision {
        self.revision
    }

    pub(crate) fn covers(&self, desired: &DesiredDefinition) -> bool {
        self.environment_id == *desired.environment_id()
            && self.revision == desired.revision()
            && self.receipt.provider == *desired.provider()
            && self.receipt.connectors == desired.connectors()
            && self.receipt.extensions == desired.extensions()
            && self.receipt.channels == desired.channels()
            && self.receipt.private_credential_projection == desired.credential_references()
            && self.receipt.policies == desired.policies()
            && self.receipt.toolchains == desired.toolchains()
            && self.receipt.security_preset == desired.security_preset()
            && self.receipt.browser_mode == desired.browser_mode()
            && self.receipt.operational_channels == desired.operational_channels()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentProjectionFault {
    Rejected,
    Unavailable,
    OutcomeUnknown,
}

impl fmt::Display for EnvironmentProjectionFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Rejected => "environment projection was rejected",
            Self::Unavailable => "environment projection target is unavailable",
            Self::OutcomeUnknown => "environment projection outcome is unknown",
        })
    }
}

impl std::error::Error for EnvironmentProjectionFault {}

pub trait EnvironmentProjectionPort: Send + Sync {
    fn apply<'a>(
        &'a self,
        desired: &'a DesiredDefinition,
    ) -> Pin<
        Box<dyn Future<Output = Result<AppliedProjection, EnvironmentProjectionFault>> + Send + 'a>,
    >;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desired() -> DesiredDefinition {
        DesiredDefinition::new(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(7).unwrap(),
            ProviderReference::try_new("provider:anthropic").unwrap(),
            crate::definition::DesiredConfiguration::try_new(
                vec![ConnectorReference::try_new("connector:calendar").unwrap()],
                vec![ExtensionReference::try_new("extension:browser").unwrap()],
                vec![ChannelReference::try_new("channel:discord").unwrap()],
                vec![CredentialReference::try_new("credential:v1:anthropic").unwrap()],
                vec![PolicyReference::try_new("policy:balanced").unwrap()],
                vec![ToolchainReference::try_new("toolchain:bun").unwrap()],
                crate::definition::SecurityPreset::Relaxed,
                crate::definition::BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap(),
        )
    }

    #[test]
    fn verified_projection_covers_every_required_plane_at_its_desired_revision() {
        let desired = desired();
        let projection = AppliedProjection::from_verified_readback(
            desired.environment_id().clone(),
            desired.revision(),
            desired.provider().clone(),
            desired.connectors().to_vec(),
            desired.extensions().to_vec(),
            desired.channels().to_vec(),
            desired.credential_references().to_vec(),
            desired.policies().to_vec(),
            desired.toolchains().to_vec(),
            desired.security_preset(),
            desired.browser_mode(),
            desired.operational_channels().to_vec(),
        );

        assert_eq!(projection.environment_id(), desired.environment_id());
        assert_eq!(projection.revision(), desired.revision());
        assert!(projection.covers(&desired));
    }

    #[test]
    fn verified_projection_matches_canonical_operational_channels_regardless_of_readback_order() {
        let desired = DesiredDefinition::new(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(7).unwrap(),
            ProviderReference::try_new("provider:anthropic").unwrap(),
            crate::definition::DesiredConfiguration::try_new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                crate::definition::SecurityPreset::Relaxed,
                crate::definition::BrowserMode::Relay,
                vec![
                    crate::definition::ChannelOperationalDesired::new(
                        ChannelReference::try_new("discord").unwrap(),
                        crate::definition::ChannelAccountId::try_new("primary").unwrap(),
                        true,
                        crate::definition::ChannelDirectMessagePolicy::Pairing,
                    ),
                    crate::definition::ChannelOperationalDesired::new(
                        ChannelReference::try_new("whatsapp").unwrap(),
                        crate::definition::ChannelAccountId::try_new("work").unwrap(),
                        false,
                        crate::definition::ChannelDirectMessagePolicy::Disabled,
                    ),
                ],
            )
            .unwrap(),
        );
        let projection = AppliedProjection::from_verified_readback(
            desired.environment_id().clone(),
            desired.revision(),
            desired.provider().clone(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            desired.security_preset(),
            desired.browser_mode(),
            desired
                .operational_channels()
                .iter()
                .cloned()
                .rev()
                .collect(),
        );

        assert!(projection.covers(&desired));
    }

    #[test]
    fn projection_faults_do_not_carry_target_diagnostics() {
        assert_eq!(
            EnvironmentProjectionFault::Rejected.to_string(),
            "environment projection was rejected"
        );
        assert_eq!(
            EnvironmentProjectionFault::Unavailable.to_string(),
            "environment projection target is unavailable"
        );
        assert_eq!(
            EnvironmentProjectionFault::OutcomeUnknown.to_string(),
            "environment projection outcome is unknown"
        );
    }
}
