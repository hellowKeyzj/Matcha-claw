use std::collections::BTreeSet;

use ::provider as provider_module;
use tokio::sync::Mutex;

use crate::{
    bootstrap::{ConfigWriteEffect, PrivateProjectionEffect, RestartPreparation},
    lifecycle::state_dir::CanonicalStateDir,
    port::{
        AppliedStatus, ObservedStatus, OpenClawGateway, ProviderNativeConfigurationDiagnostic,
        ProviderNativeConfigurationEvidence,
    },
    projection::{plugins::PluginProjection, provider_models::native_provider_plugin},
};

pub struct NativeProviderConfigurationContext<'a> {
    pub runtime_running: bool,
    pub gateway: &'a Mutex<OpenClawGateway>,
    pub state_dir: CanonicalStateDir,
    pub plugins: PluginProjection,
}

pub struct NativeProviderConfigurationCommand<'a> {
    pub accounts: &'a [provider_module::ProviderAccount],
    pub models: &'a provider_module::ProviderModelCatalog,
    pub routing: Option<&'a provider_module::ProviderRouting>,
    pub retired: &'a [provider_module::ProviderAccount],
    pub required_auth_accounts: &'a BTreeSet<provider_module::ProviderAccountId>,
    pub auth_state_refresh_required: bool,
    pub now_millis: u64,
}

impl<'a> From<provider_module::ProviderNativeConfigurationCommand<'a>>
    for NativeProviderConfigurationCommand<'a>
{
    fn from(command: provider_module::ProviderNativeConfigurationCommand<'a>) -> Self {
        Self {
            accounts: command.accounts,
            models: command.models,
            routing: command.routing,
            retired: command.retired,
            required_auth_accounts: command.required_auth_accounts,
            auth_state_refresh_required: command.auth_state_refresh_required,
            now_millis: command.now_millis,
        }
    }
}

pub async fn discover_provider_models(
    runtime_running: bool,
    gateway: &Mutex<OpenClawGateway>,
    identity: &provider_module::ProviderRuntimeIdentity,
) -> provider_module::ProviderModelDiscoveryPortOutcome {
    if !runtime_running {
        return provider_module::ProviderModelDiscoveryPortOutcome::Unavailable;
    }
    match gateway
        .lock()
        .await
        .discover_provider_models(identity.provider_key())
        .await
    {
        Ok(models) => provider_module::ProviderModelDiscoveryPortOutcome::Discovered(
            models
                .into_iter()
                .map(|model| provider_module::DiscoveredProviderModel {
                    id: model.id,
                    input: model.input,
                    context_window: model.context_window,
                })
                .collect(),
        ),
        Err(()) => provider_module::ProviderModelDiscoveryPortOutcome::Unavailable,
    }
}

pub async fn reconcile_native_configuration_evidence(
    context: NativeProviderConfigurationContext<'_>,
    command: NativeProviderConfigurationCommand<'_>,
) -> ProviderNativeConfigurationEvidence {
    let plugin_ids = command
        .accounts
        .iter()
        .filter(|account| account.configuration().enabled())
        .filter_map(|account| native_provider_plugin(account.provider().as_str()))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    eprintln!(
        "[startup-trace] source=openclaw-driver phase=provider-config detail=start accounts={} retired={} plugin_ids={} required_auth={} auth_refresh={}",
        command.accounts.len(),
        command.retired.len(),
        plugin_ids.join(","),
        command.required_auth_accounts.len(),
        command.auth_state_refresh_required
    );
    let plugins = context.plugins;
    if plugins
        .reconcile_enabled_managed_plugins(&plugin_ids)
        .is_err()
    {
        eprintln!(
            "[startup-trace] source=openclaw-driver phase=provider-config detail=managed-plugin-reconcile-failed"
        );
        return provider_unavailable_evidence();
    }
    if plugins.reconcile_installed_records().is_err() {
        eprintln!(
            "[startup-trace] source=openclaw-driver phase=provider-config detail=installed-plugin-reconcile-failed"
        );
        return provider_unavailable_evidence();
    }
    if context.runtime_running {
        eprintln!(
            "[startup-trace] source=openclaw-driver phase=provider-config detail=gateway-reconcile-start"
        );
        return context
            .gateway
            .lock()
            .await
            .reconcile_provider_native_configuration(
                command.accounts,
                command.models,
                command.routing,
                command.retired,
                command.required_auth_accounts,
                command.auth_state_refresh_required,
                command.now_millis,
            )
            .await;
    }

    eprintln!(
        "[startup-trace] source=openclaw-driver phase=provider-config detail=private-reconcile-start"
    );
    private_provider_native_configuration_evidence(context.state_dir, command)
}

pub async fn reconcile_provider_native_configuration(
    context: NativeProviderConfigurationContext<'_>,
    command: NativeProviderConfigurationCommand<'_>,
) -> provider_module::ProviderNativeConfigurationEffect {
    provider_native_configuration_effect(
        reconcile_native_configuration_evidence(context, command).await,
    )
}

pub fn prepare_private_projection(
    state_dir: CanonicalStateDir,
    command: provider_module::ProviderPrivateProjectionCommand<'_>,
) -> provider_module::ProviderPrivateProjectionEffect {
    provider_private_projection_effect(PrivateProjectionEffect::apply(
        state_dir,
        command.accounts,
        command.models,
        command.routing,
        command.now_millis,
    ))
}

fn provider_unavailable_evidence() -> ProviderNativeConfigurationEvidence {
    ProviderNativeConfigurationEvidence::new(
        false,
        AppliedStatus::Unknown,
        ObservedStatus::Unavailable,
    )
}

fn private_provider_native_configuration_evidence(
    state_dir: CanonicalStateDir,
    command: NativeProviderConfigurationCommand<'_>,
) -> ProviderNativeConfigurationEvidence {
    let effect = PrivateProjectionEffect::apply_required_auth(
        state_dir.clone(),
        command.accounts,
        command.models,
        command.routing,
        command.retired,
        command.required_auth_accounts,
        command.now_millis,
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

fn provider_native_configuration_effect(
    evidence: ProviderNativeConfigurationEvidence,
) -> provider_module::ProviderNativeConfigurationEffect {
    let changed = evidence.changed();
    let applied = provider_applied_status(evidence.applied());
    let observed = provider_observed_status(evidence.observed());
    provider_module::ProviderNativeConfigurationEffect::Evidence(
        evidence
            .diagnostic()
            .map(provider_native_configuration_diagnostic)
            .map(|diagnostic| {
                provider_module::ProviderNativeConfigurationEvidence::with_diagnostic(
                    changed, applied, observed, diagnostic,
                )
            })
            .unwrap_or_else(|| {
                provider_module::ProviderNativeConfigurationEvidence::new(
                    changed, applied, observed,
                )
            }),
    )
}

fn provider_applied_status(status: AppliedStatus) -> provider_module::ProviderAppliedStatus {
    match status {
        AppliedStatus::Confirmed => provider_module::ProviderAppliedStatus::Confirmed,
        AppliedStatus::Unknown => provider_module::ProviderAppliedStatus::Unknown,
    }
}

fn provider_observed_status(status: ObservedStatus) -> provider_module::ProviderObservedStatus {
    match status {
        ObservedStatus::Matches => provider_module::ProviderObservedStatus::Matches,
        ObservedStatus::Mismatch => provider_module::ProviderObservedStatus::Mismatch,
        ObservedStatus::Unavailable => provider_module::ProviderObservedStatus::Unavailable,
    }
}

fn provider_native_configuration_diagnostic(
    diagnostic: &ProviderNativeConfigurationDiagnostic,
) -> provider_module::ProviderNativeConfigurationDiagnostic {
    provider_module::ProviderNativeConfigurationDiagnostic::new(
        diagnostic.phase(),
        diagnostic.reason(),
        diagnostic.config_path(),
        diagnostic.method().map(str::to_owned),
        diagnostic.expected_path().map(str::to_owned),
        diagnostic.detail().map(str::to_owned),
    )
}

fn provider_private_projection_effect(
    effect: PrivateProjectionEffect,
) -> provider_module::ProviderPrivateProjectionEffect {
    provider_module::ProviderPrivateProjectionEffect {
        providers: provider_config_write_effect(effect.providers),
        restart: provider_restart_preparation(effect.restart),
    }
}

fn provider_config_write_effect(
    effect: ConfigWriteEffect,
) -> provider_module::ProviderConfigWriteEffect {
    match effect {
        ConfigWriteEffect::Unchanged => provider_module::ProviderConfigWriteEffect::Unchanged,
        ConfigWriteEffect::Written => provider_module::ProviderConfigWriteEffect::Written,
        ConfigWriteEffect::Unknown(diagnostic) => {
            provider_module::ProviderConfigWriteEffect::Unknown(
                provider_module::ProviderProjectionBuildDiagnostic::new(
                    diagnostic.reason(),
                    diagnostic.expected_path(),
                    diagnostic.detail(),
                ),
            )
        }
    }
}

fn provider_restart_preparation(
    restart: RestartPreparation,
) -> provider_module::ProviderRestartPreparation {
    match restart {
        RestartPreparation::NotRequired => provider_module::ProviderRestartPreparation::NotRequired,
        RestartPreparation::Required => provider_module::ProviderRestartPreparation::Required,
        RestartPreparation::Unknown => provider_module::ProviderRestartPreparation::Unknown,
    }
}
