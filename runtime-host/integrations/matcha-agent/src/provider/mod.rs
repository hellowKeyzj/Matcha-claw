mod configuration;
mod projection;

pub use projection::{
    ProjectionFailure, ProjectionFailureKind, ProjectionRemoteKind, project_session_runtime,
};

use crate::driver::MatchaRuntimeDriver;
use provider_module::{
    ProviderAccount, ProviderAccountKind, ProviderConfigOps, ProviderFuture,
    ProviderNativeConfigurationCommand, ProviderNativeConfigurationEffect,
    ProviderPrivateProjectionCommand, ProviderPrivateProjectionEffect,
    ProviderPrivateProjectionOps, ProviderRuntimeIdentity, ProviderRuntimeIdentityOps,
};

/// Server provider IDs are account identities, not OpenClaw provider/plugin keys.
pub fn account_provider_id(account_id: &str) -> String {
    use std::fmt::Write;
    let mut id = String::from("host-account-");
    for byte in account_id.bytes() {
        let _ = write!(id, "{byte:02x}");
    }
    id
}

impl ProviderConfigOps for MatchaRuntimeDriver {
    fn reconcile_provider_native_configuration<'a>(
        &'a self,
        command: ProviderNativeConfigurationCommand<'a>,
    ) -> ProviderFuture<'a, ProviderNativeConfigurationEffect> {
        Box::pin(async move { configuration::reconcile(&self.native_client(), command).await })
    }
}

impl ProviderPrivateProjectionOps for MatchaRuntimeDriver {
    fn prepare_private_projection<'a>(
        &'a self,
        command: ProviderPrivateProjectionCommand<'a>,
    ) -> ProviderFuture<'a, ProviderPrivateProjectionEffect> {
        Box::pin(async move { configuration::prepare(&self.native_client(), command).await })
    }
}

impl ProviderRuntimeIdentityOps for MatchaRuntimeDriver {
    fn runtime_identities(
        &self,
        accounts: &[ProviderAccount],
    ) -> Result<Vec<ProviderRuntimeIdentity>, ()> {
        accounts
            .iter()
            .filter(|account| account.configuration().enabled())
            .map(|account| self.runtime_identity(account))
            .collect()
    }

    fn runtime_identity(&self, account: &ProviderAccount) -> Result<ProviderRuntimeIdentity, ()> {
        Ok(ProviderRuntimeIdentity::new(
            account.id().as_str(),
            account_provider_id(account.id().as_str()),
        ))
    }

    fn runtime_model_ref(
        &self,
        _identity: &ProviderRuntimeIdentity,
        _kind: ProviderAccountKind,
        model_id: &str,
    ) -> String {
        // CLI model values are native identifiers. Account selection stays in the Host binding.
        model_id.to_owned()
    }
}
