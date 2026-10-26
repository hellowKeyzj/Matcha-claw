use platform::state_dir::CanonicalStateDir;
use std::collections::BTreeSet;

use ::provider as provider_module;

use crate::{
    bootstrap::{ConfigWriteEffect, PrivateProjectionEffect, RestartPreparation},
    native_config::{plugins::PluginProjection, provider_models::native_provider_plugin},
    port::{
        AppliedStatus, ObservedStatus, OpenClawGateway, ProviderNativeConfigurationDiagnostic,
        ProviderNativeConfigurationEvidence,
    },
};

pub use crate::native_config::provider_models::{
    ProviderModelProjectionError, ProviderModelRuntimeIdentity, public_provider_model_identities,
    public_provider_model_identity, public_provider_model_ref,
};

pub struct NativeProviderConfigurationContext<'a> {
    pub runtime_running: bool,
    pub gateway: &'a OpenClawGateway,
    pub state_dir: CanonicalStateDir,
    pub plugins: PluginProjection,
}

pub struct NativeProviderConfigurationCommand<'a> {
    pub accounts: &'a [provider_module::ProviderAccount],
    pub account_failures: &'a [provider_module::ProviderAccountExecution],
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
            account_failures: command.account_failures,
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
    gateway: &OpenClawGateway,
    identity: &provider_module::ProviderRuntimeIdentity,
) -> provider_module::ProviderModelDiscoveryPortOutcome {
    if !runtime_running {
        return provider_module::ProviderModelDiscoveryPortOutcome::Unavailable;
    }
    match gateway
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
    account_failures: &mut Vec<provider_module::ProviderAccountExecution>,
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
    if platform::trace::enabled() {
        eprintln!(
            "[startup-trace] source=openclaw-driver phase=provider-config detail=start accounts={} retired={} plugin_ids={} required_auth={} auth_refresh={}",
            command.accounts.len(),
            command.retired.len(),
            plugin_ids.join(","),
            command.required_auth_accounts.len(),
            command.auth_state_refresh_required
        );
    }
    let plugins = context.plugins;
    if plugins
        .reconcile_enabled_managed_plugins(&plugin_ids)
        .is_err()
    {
        if platform::trace::enabled() {
            eprintln!(
                "[startup-trace] source=openclaw-driver phase=provider-config detail=managed-plugin-reconcile-failed"
            );
        }
        return provider_unavailable_evidence();
    }
    if plugins.reconcile_installed_records().is_err() {
        if platform::trace::enabled() {
            eprintln!(
                "[startup-trace] source=openclaw-driver phase=provider-config detail=installed-plugin-reconcile-failed"
            );
        }
        return provider_unavailable_evidence();
    }
    if context.runtime_running {
        if platform::trace::enabled() {
            eprintln!(
                "[startup-trace] source=openclaw-driver phase=provider-config detail=gateway-reconcile-start"
            );
        }
        return context
            .gateway
            .reconcile_provider_native_configuration(
                command.accounts,
                command.models,
                command.routing,
                command.retired,
                command.required_auth_accounts,
                account_failures,
                command.auth_state_refresh_required,
                command.now_millis,
            )
            .await;
    }

    if platform::trace::enabled() {
        eprintln!(
            "[startup-trace] source=openclaw-driver phase=provider-config detail=private-reconcile-start"
        );
    }
    private_provider_native_configuration_evidence(context.state_dir, command, account_failures)
}

pub async fn reconcile_provider_native_configuration(
    context: NativeProviderConfigurationContext<'_>,
    command: NativeProviderConfigurationCommand<'_>,
) -> provider_module::ProviderNativeConfigurationEffect {
    let accounts = command.accounts;
    let required = command.required_auth_accounts;
    let runtime_running = context.runtime_running;
    let state_dir = context.state_dir.clone();
    let mut account_failures = command.account_failures.to_vec();
    let evidence =
        reconcile_native_configuration_evidence(context, command, &mut account_failures).await;
    configuration_effect(
        evidence,
        accounts,
        required,
        account_failures,
        runtime_running,
        &state_dir,
    )
}

pub fn prepare_private_projection(
    state_dir: CanonicalStateDir,
    command: provider_module::ProviderPrivateProjectionCommand<'_>,
) -> provider_module::ProviderPrivateProjectionEffect {
    let required = command
        .routing
        .map(|routing| {
            routing
                .routes()
                .iter()
                .flat_map(|(_, route)| std::iter::once(route.primary()).chain(route.fallbacks()))
                .map(|reference| reference.account_id().clone())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let mut failures = command.account_failures.to_vec();
    let effect = PrivateProjectionEffect::apply_required_auth(
        state_dir.clone(),
        command.accounts,
        command.models,
        command.routing,
        &[],
        &required,
        &mut failures,
        command.now_millis,
    );
    let evidence = config_write_evidence(&state_dir, &effect.providers);
    let report = configuration_effect(
        evidence,
        command.accounts,
        &required,
        failures,
        false,
        &state_dir,
    );
    let mut projected = provider_private_projection_effect(effect);
    projected.reports = report.reports().to_vec();
    projected
}

fn configuration_effect(
    mut evidence: ProviderNativeConfigurationEvidence,
    accounts: &[provider_module::ProviderAccount],
    required: &BTreeSet<provider_module::ProviderAccountId>,
    failures: Vec<provider_module::ProviderAccountExecution>,
    runtime_running: bool,
    state_dir: &CanonicalStateDir,
) -> provider_module::ProviderNativeConfigurationEffect {
    let partial = !failures.is_empty();
    let executions = account_executions(accounts, required, failures, &evidence, runtime_running);
    if evidence.applied() == AppliedStatus::Confirmed
        && evidence.observed() == ObservedStatus::Matches
        && (partial || !runtime_running)
    {
        evidence = if partial {
            ProviderNativeConfigurationEvidence::with_diagnostic(
                evidence.changed(),
                AppliedStatus::Unknown,
                if runtime_running {
                    ObservedStatus::Mismatch
                } else {
                    ObservedStatus::Unavailable
                },
                ProviderNativeConfigurationDiagnostic::new(
                    "provider-config",
                    "provider-projection-partial",
                    state_dir
                        .as_path()
                        .join("openclaw.json")
                        .display()
                        .to_string(),
                    None,
                    Some("models.providers"),
                    None,
                ),
            )
        } else {
            ProviderNativeConfigurationEvidence::new(
                evidence.changed(),
                AppliedStatus::Unknown,
                ObservedStatus::Unavailable,
            )
        };
    }
    provider_native_configuration_effect(evidence).with_report(
        provider_module::ProviderSessionEndpoint::OpenClawLocal,
        executions,
    )
}

fn account_executions(
    accounts: &[provider_module::ProviderAccount],
    required: &BTreeSet<provider_module::ProviderAccountId>,
    mut failures: Vec<provider_module::ProviderAccountExecution>,
    evidence: &ProviderNativeConfigurationEvidence,
    runtime_running: bool,
) -> Vec<provider_module::ProviderAccountExecution> {
    use provider_module::{
        ProviderAccountAuthMode, ProviderAccountExecutionStatus as Status,
        ProviderCallDiagnosticReason as Reason,
    };
    let confirmed = evidence.applied() == AppliedStatus::Confirmed
        && evidence.observed() == ObservedStatus::Matches;
    for account in accounts
        .iter()
        .filter(|account| account.configuration().enabled())
    {
        if failures
            .iter()
            .any(|failure| failure.account_id == account.id().as_str())
        {
            continue;
        }
        let auth_known = required.contains(account.id())
            || matches!(
                account.configuration().auth_mode(),
                ProviderAccountAuthMode::Local | ProviderAccountAuthMode::CliReuse
            );
        if !auth_known {
            continue;
        }
        let (execution, reason) = if !confirmed {
            (
                Status::Unknown,
                Some(Reason::ProviderProjectionOutcomeUnknown),
            )
        } else if !runtime_running {
            (Status::Unknown, None)
        } else {
            (Status::Ready, None)
        };
        failures.push(provider_module::ProviderAccountExecution {
            account_id: account.id().as_str().to_owned(),
            account_revision: account.revision().get(),
            execution,
            diagnostic: reason.map(|reason| provider_module::ProviderCallDiagnostic {
                reason: Some(reason),
                private_resolver_code: None,
            }),
        });
    }
    failures
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
    account_failures: &mut Vec<provider_module::ProviderAccountExecution>,
) -> ProviderNativeConfigurationEvidence {
    let effect = PrivateProjectionEffect::apply_required_auth(
        state_dir.clone(),
        command.accounts,
        command.models,
        command.routing,
        command.retired,
        command.required_auth_accounts,
        account_failures,
        command.now_millis,
    );
    config_write_evidence(&state_dir, &effect.providers)
}

fn config_write_evidence(
    state_dir: &CanonicalStateDir,
    effect: &ConfigWriteEffect,
) -> ProviderNativeConfigurationEvidence {
    match effect {
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
        reports: Vec::new(),
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
