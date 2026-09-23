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

impl provider_module::ProviderPrivateProjectionOps for OpenClawDriver {
    fn prepare_private_projection(
        &self,
        command: provider_module::ProviderPrivateProjectionCommand<'_>,
    ) -> provider_module::ProviderPrivateProjectionEffect {
        crate::surfaces::providers::prepare_private_projection(self.state_dir.clone(), command)
    }
}
