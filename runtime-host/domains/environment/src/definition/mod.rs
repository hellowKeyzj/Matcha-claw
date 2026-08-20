mod desired;
mod identity;
mod operational;
mod revision;

pub use desired::{
    ChannelReference, ConnectorReference, CredentialReference, DesiredConfiguration,
    DesiredDefinition, ExtensionReference, InvalidChannelReference, InvalidConnectorReference,
    InvalidCredentialReference, InvalidDesiredConfiguration, InvalidExtensionReference,
    InvalidPolicyReference, InvalidProviderReference, InvalidToolchainReference, PolicyReference,
    ProviderReference, ToolchainReference,
};
pub use identity::{EnvironmentId, InvalidEnvironmentId};
pub(crate) use operational::canonicalize_operational_channels;
pub use operational::{
    BrowserMode, ChannelAccountId, ChannelDirectMessagePolicy, ChannelOperationalDesired,
    InvalidChannelAccountId, SecurityPreset,
};
pub use revision::{EnvironmentRevision, EnvironmentRevisionOverflow, InvalidEnvironmentRevision};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definition_oracle_distinguishes_identity_revision_and_desired_shape() {
        let environment_id = EnvironmentId::try_new("environment:primary").unwrap();
        let first = DesiredDefinition::new(
            environment_id.clone(),
            EnvironmentRevision::try_new(1).unwrap(),
            ProviderReference::try_new("anthropic").unwrap(),
            DesiredConfiguration::try_new(
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
            .unwrap(),
        );
        let same_revision_different_provider = DesiredDefinition::new(
            environment_id.clone(),
            EnvironmentRevision::try_new(1).unwrap(),
            ProviderReference::try_new("openai").unwrap(),
            DesiredConfiguration::try_new(
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
            .unwrap(),
        );
        let next_revision_same_shape = DesiredDefinition::new(
            environment_id,
            EnvironmentRevision::try_new(2).unwrap(),
            ProviderReference::try_new("anthropic").unwrap(),
            DesiredConfiguration::try_new(
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
            .unwrap(),
        );

        assert_ne!(first, same_revision_different_provider);
        assert_ne!(first, next_revision_same_shape);
        assert_eq!(
            first.environment_id(),
            next_revision_same_shape.environment_id()
        );
        assert_eq!(first.provider(), next_revision_same_shape.provider());
        assert_ne!(first.revision(), next_revision_same_shape.revision());
    }
}
