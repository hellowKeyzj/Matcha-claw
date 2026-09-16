use super::*;

impl OpenClawInstance {
    pub(crate) async fn discover_provider_models(
        &self,
        provider: &str,
    ) -> Result<Vec<openclaw::operations::provider_models::Model>, ()> {
        if self.owner().snapshot().phase() != SupervisorPhase::Running {
            return Err(());
        }
        self.gateway
            .lock()
            .await
            .discover_provider_models(provider)
            .await
    }

    pub(crate) async fn reconcile_provider_native_configuration(
        &self,
        accounts: &[environment::ProviderAccount],
        models: &environment::ProviderModelCatalog,
        routing: Option<&environment::ProviderRouting>,
        retired: &[environment::ProviderAccount],
        required_auth_accounts: &std::collections::BTreeSet<environment::ProviderAccountId>,
        auth_state_refresh_required: bool,
        now_millis: u64,
    ) -> openclaw::port::ProviderNativeConfigurationEvidence {
        let plugin_ids = accounts
            .iter()
            .filter(|account| account.configuration().enabled())
            .filter_map(|account| {
                openclaw::projection::provider_models::native_provider_plugin(
                    account.provider().as_str(),
                )
            })
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        eprintln!(
            "[startup-trace] source=openclaw-driver phase=provider-config detail=start accounts={} retired={} plugin_ids={} required_auth={} auth_refresh={}",
            accounts.len(),
            retired.len(),
            plugin_ids.join(","),
            required_auth_accounts.len(),
            auth_state_refresh_required
        );
        let plugins = self.plugins();
        if plugins
            .reconcile_enabled_managed_plugins(&plugin_ids)
            .is_err()
        {
            eprintln!(
                "[startup-trace] source=openclaw-driver phase=provider-config detail=managed-plugin-reconcile-failed"
            );
            return openclaw::port::ProviderNativeConfigurationEvidence::new(
                false,
                openclaw::port::AppliedStatus::Unknown,
                openclaw::port::ObservedStatus::Unavailable,
            );
        }
        if plugins.reconcile_installed_records().is_err() {
            eprintln!(
                "[startup-trace] source=openclaw-driver phase=provider-config detail=installed-plugin-reconcile-failed"
            );
            return openclaw::port::ProviderNativeConfigurationEvidence::new(
                false,
                openclaw::port::AppliedStatus::Unknown,
                openclaw::port::ObservedStatus::Unavailable,
            );
        }
        if self.owner().snapshot().phase() == SupervisorPhase::Running {
            eprintln!(
                "[startup-trace] source=openclaw-driver phase=provider-config detail=gateway-reconcile-start"
            );
            return self
                .gateway
                .lock()
                .await
                .reconcile_provider_native_configuration(
                    accounts,
                    models,
                    routing,
                    retired,
                    required_auth_accounts,
                    auth_state_refresh_required,
                    now_millis,
                )
                .await;
        }

        eprintln!(
            "[startup-trace] source=openclaw-driver phase=provider-config detail=private-reconcile-start"
        );
        private_provider_native_configuration_evidence(
            self.state_dir.clone(),
            accounts,
            models,
            routing,
            retired,
            required_auth_accounts,
            now_millis,
        )
    }
}

fn private_provider_native_configuration_evidence(
    state_dir: CanonicalStateDir,
    accounts: &[environment::ProviderAccount],
    models: &environment::ProviderModelCatalog,
    routing: Option<&environment::ProviderRouting>,
    retired: &[environment::ProviderAccount],
    required_auth_accounts: &std::collections::BTreeSet<environment::ProviderAccountId>,
    now_millis: u64,
) -> ProviderNativeConfigurationEvidence {
    let effect = PrivateProjectionEffect::apply_required_auth(
        state_dir.clone(),
        accounts,
        models,
        routing,
        retired,
        required_auth_accounts,
        now_millis,
    );
    match effect.providers {
        ConfigWriteEffect::Unchanged => ProviderNativeConfigurationEvidence::new(
            false,
            AppliedStatus::Confirmed,
            ObservedStatus::Matches,
        ),
        ConfigWriteEffect::Written => ProviderNativeConfigurationEvidence::new(
            true,
            AppliedStatus::Confirmed,
            ObservedStatus::Matches,
        ),
        ConfigWriteEffect::Unknown(diagnostic) => {
            ProviderNativeConfigurationEvidence::with_diagnostic(
                false,
                AppliedStatus::Unknown,
                ObservedStatus::Unavailable,
                ProviderNativeConfigurationDiagnostic::new(
                    "private-projection",
                    diagnostic.reason(),
                    state_dir
                        .as_path()
                        .join("openclaw.json")
                        .display()
                        .to_string(),
                    None,
                    Some(diagnostic.expected_path()),
                    Some(diagnostic.detail().to_owned()),
                ),
            )
        }
    }
}

impl ProviderConfigOps for OpenClawInstance {
    fn reconcile_provider_native_configuration<'a>(
        &'a self,
        command: ProviderNativeConfigurationCommand<'a>,
    ) -> SessionFuture<'a, openclaw::port::ProviderNativeConfigurationEffect> {
        Box::pin(async move {
            openclaw::port::ProviderNativeConfigurationEffect::Evidence(
                OpenClawInstance::reconcile_provider_native_configuration(
                    self,
                    command.accounts,
                    command.models,
                    command.routing,
                    command.retired,
                    command.required_auth_accounts,
                    command.auth_state_refresh_required,
                    command.now_millis,
                )
                .await,
            )
        })
    }
}
