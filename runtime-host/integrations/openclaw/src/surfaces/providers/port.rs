use crate::port::OpenClawGateway;
use crate::surfaces::providers::gateway::native_config::{
    ProviderNativeConfigurationEvidence, ProviderNativeConfigurationOperation,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderNativeConfigurationEffect {
    Evidence(ProviderNativeConfigurationEvidence),
    Unavailable,
}

impl ProviderNativeConfigurationEffect {
    pub fn evidence(self) -> Option<ProviderNativeConfigurationEvidence> {
        match self {
            Self::Evidence(evidence) => Some(evidence),
            Self::Unavailable => None,
        }
    }

    pub fn merge(self, other: Self) -> Self {
        match (self, other) {
            (Self::Evidence(a), Self::Evidence(b)) => Self::Evidence(a.merge(b)),
            (Self::Evidence(e), Self::Unavailable) | (Self::Unavailable, Self::Evidence(e)) => {
                Self::Evidence(e)
            }
            (Self::Unavailable, Self::Unavailable) => Self::Unavailable,
        }
    }
}

impl OpenClawGateway {
    pub async fn discover_provider_models(
        &self,
        provider: &str,
    ) -> Result<Vec<crate::surfaces::providers::gateway::models::Model>, ()> {
        crate::surfaces::providers::gateway::models::ProviderModelCatalog::new(self.client())
            .discover(provider)
            .await
    }

    pub async fn reconcile_provider_native_configuration(
        &self,
        accounts: &[::provider::ProviderAccount],
        models: &::provider::ProviderModelCatalog,
        routing: Option<&::provider::ProviderRouting>,
        retired: &[::provider::ProviderAccount],
        required_auth_accounts: &std::collections::BTreeSet<::provider::ProviderAccountId>,
        auth_state_refresh_required: bool,
        now_millis: u64,
    ) -> ProviderNativeConfigurationEvidence {
        ProviderNativeConfigurationOperation::new(
            self.client(),
            self.team_state_dir()
                .expect("OpenClaw provider native config requires a state directory"),
        )
        .reconcile(
            accounts,
            models,
            routing,
            retired,
            required_auth_accounts,
            auth_state_refresh_required,
            now_millis,
        )
        .await
    }
}
