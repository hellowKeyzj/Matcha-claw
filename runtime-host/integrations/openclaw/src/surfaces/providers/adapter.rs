use foundation::process::supervision::SupervisorPhase;
use provider as provider_module;

use crate::driver::OpenClawDriver;

impl OpenClawDriver {
    fn native_provider_configuration_context(
        &self,
        runtime_running: bool,
    ) -> crate::surfaces::providers::NativeProviderConfigurationContext<'_> {
        crate::surfaces::providers::NativeProviderConfigurationContext {
            runtime_running,
            gateway: self.gateway.as_ref(),
            state_dir: self.state_dir.clone(),
            plugins: self.plugins(),
        }
    }
}

impl provider_module::ProviderConfigOps for OpenClawDriver {
    fn reconcile_provider_native_configuration<'a>(
        &'a self,
        command: provider_module::ProviderNativeConfigurationCommand<'a>,
    ) -> provider_module::ProviderFuture<'a, provider_module::ProviderNativeConfigurationEffect>
    {
        Box::pin(async move {
            let runtime_running = self.owner().snapshot().phase() == SupervisorPhase::Running;
            crate::surfaces::providers::reconcile_provider_native_configuration(
                self.native_provider_configuration_context(runtime_running),
                command.into(),
            )
            .await
        })
    }
}

impl provider_module::ProviderModelDiscoveryOps for OpenClawDriver {
    fn discover_provider_models<'a>(
        &'a self,
        _account: &'a provider_module::ProviderAccount,
        identity: &'a provider_module::ProviderRuntimeIdentity,
    ) -> provider_module::ProviderFuture<'a, provider_module::ProviderModelDiscoveryPortOutcome>
    {
        Box::pin(async move {
            let runtime_running = self.owner().snapshot().phase() == SupervisorPhase::Running;
            crate::surfaces::providers::discover_provider_models(
                runtime_running,
                self.gateway.as_ref(),
                identity,
            )
            .await
        })
    }
}

impl provider_module::ProviderRuntimeIdentityOps for OpenClawDriver {
    fn runtime_identities(
        &self,
        accounts: &[provider_module::ProviderAccount],
    ) -> Result<Vec<provider_module::ProviderRuntimeIdentity>, ()> {
        super::public_provider_model_identities(accounts)
            .map(|identities| {
                identities
                    .into_iter()
                    .map(|(account_id, identity)| {
                        provider_module::ProviderRuntimeIdentity::new(
                            account_id,
                            identity.provider_key(),
                        )
                    })
                    .collect()
            })
            .map_err(|_| ())
    }

    fn runtime_identity(
        &self,
        account: &provider_module::ProviderAccount,
    ) -> Result<provider_module::ProviderRuntimeIdentity, ()> {
        super::public_provider_model_identity(account)
            .map(|identity| {
                provider_module::ProviderRuntimeIdentity::new(
                    account.id().as_str(),
                    identity.provider_key(),
                )
            })
            .map_err(|_| ())
    }

    fn runtime_model_ref(
        &self,
        identity: &provider_module::ProviderRuntimeIdentity,
        kind: provider_module::ProviderAccountKind,
        model_id: &str,
    ) -> String {
        super::public_provider_model_ref(identity.provider_key(), kind, model_id)
    }
}

impl provider_module::ProviderPrivateProjectionOps for OpenClawDriver {
    fn prepare_private_projection(
        &self,
        command: provider_module::ProviderPrivateProjectionCommand<'_>,
    ) -> provider_module::ProviderPrivateProjectionEffect {
        crate::surfaces::providers::prepare_private_projection(self.state_dir.clone(), command)
    }
}
