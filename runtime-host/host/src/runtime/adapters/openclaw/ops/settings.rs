use super::super::owner::lifecycle::{prepare_openclaw_lifecycle, restart_supervisor};
use super::*;

impl SettingsOps for OpenClawInstance {
    fn apply_settings_projection(
        &self,
        browser_mode: openclaw::projection::settings::BrowserMode,
        proxy_endpoint: Option<String>,
    ) -> OwnedRuntimeFuture<
        Result<SettingsProjectionEffect, crate::runtime::driver::RuntimeOperationFailure>,
    > {
        let state_dir = self.state_dir.clone();
        let gateway = Arc::clone(&self.gateway);
        let control_lease = self.control_lease();
        let plugins = self.plugins();
        let supervisor = self.supervisor_handle();
        let gateway_port = self.gateway_port;
        let diagnostic_reporter = Arc::clone(&self.diagnostic_reporter);
        Box::pin(async move {
            match supervisor.snapshot().phase() {
                SupervisorPhase::Idle => apply_settings_file_projection(
                    state_dir,
                    browser_mode,
                    proxy_endpoint.as_deref(),
                ),
                SupervisorPhase::Running => {
                    if control_lease.snapshot_control().await != OpenClawControlReadiness::Ready {
                        return Err(crate::runtime::driver::RuntimeOperationFailure::Unknown);
                    }
                    let artifact_changed = prepare_settings_relay_plugin(&plugins, browser_mode)?;
                    let outcome = gateway
                        .lock()
                        .await
                        .apply_settings_config_projection(browser_mode, proxy_endpoint)
                        .await;
                    project_settings_config_outcome(
                        outcome,
                        artifact_changed,
                        supervisor,
                        gateway_port,
                        plugins,
                        diagnostic_reporter,
                    )
                    .await
                }
                SupervisorPhase::Starting
                | SupervisorPhase::Stopping
                | SupervisorPhase::WaitingToRestart
                | SupervisorPhase::OperationFailed
                | SupervisorPhase::ShutDown => {
                    Err(crate::runtime::driver::RuntimeOperationFailure::Unknown)
                }
            }
        })
    }
}

fn apply_settings_file_projection(
    state_dir: CanonicalStateDir,
    browser_mode: openclaw::projection::settings::BrowserMode,
    proxy_endpoint: Option<&str>,
) -> Result<SettingsProjectionEffect, crate::runtime::driver::RuntimeOperationFailure> {
    openclaw::projection::settings::apply(state_dir, browser_mode, proxy_endpoint)
        .map(|changed| {
            if changed {
                SettingsProjectionEffect::Changed
            } else {
                SettingsProjectionEffect::Unchanged
            }
        })
        .map_err(map_settings_projection_error)
}

fn map_settings_projection_error(
    error: openclaw::projection::settings::SettingsProjectionError,
) -> crate::runtime::driver::RuntimeOperationFailure {
    match error {
        openclaw::projection::settings::SettingsProjectionError::InvalidProxy => {
            crate::runtime::driver::RuntimeOperationFailure::TargetRejected
        }
        openclaw::projection::settings::SettingsProjectionError::ConfigStore => {
            crate::runtime::driver::RuntimeOperationFailure::Unknown
        }
    }
}

fn prepare_settings_relay_plugin(
    plugins: &openclaw::projection::plugins::PluginProjection,
    browser_mode: openclaw::projection::settings::BrowserMode,
) -> Result<bool, crate::runtime::driver::RuntimeOperationFailure> {
    if browser_mode != openclaw::projection::settings::BrowserMode::Relay {
        return Ok(false);
    }
    let selected = ["browser-relay".to_owned()];
    let reconcile = plugins
        .reconcile_enabled_managed_plugins(&selected)
        .map_err(|_| crate::runtime::driver::RuntimeOperationFailure::Unknown)?;
    plugins
        .reconcile_installed_records()
        .map_err(|_| crate::runtime::driver::RuntimeOperationFailure::Unknown)?;
    Ok(reconcile
        .installed_ids
        .iter()
        .any(|id| id == "browser-relay")
        || reconcile.updated_ids.iter().any(|id| id == "browser-relay")
        || !reconcile.removed_ids.is_empty())
}

async fn restart_after_settings_projection(
    prepare_lifecycle: bool,
    supervisor: SupervisorHandle,
    gateway_port: u16,
    plugins: openclaw::projection::plugins::PluginProjection,
    diagnostic_reporter: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
) -> Result<(), crate::runtime::driver::RuntimeOperationFailure> {
    if prepare_lifecycle
        && prepare_openclaw_lifecycle(&supervisor, gateway_port, plugins, diagnostic_reporter)
            .await
            .is_err()
    {
        return Err(crate::runtime::driver::RuntimeOperationFailure::Unknown);
    }
    restart_supervisor(supervisor)
        .await
        .map(|_| ())
        .map_err(|_| crate::runtime::driver::RuntimeOperationFailure::Unknown)
}

async fn project_settings_config_outcome(
    outcome: openclaw::operations::settings_config::SettingsConfigMutationOutcome,
    artifact_changed: bool,
    supervisor: SupervisorHandle,
    gateway_port: u16,
    plugins: openclaw::projection::plugins::PluginProjection,
    diagnostic_reporter: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
) -> Result<SettingsProjectionEffect, crate::runtime::driver::RuntimeOperationFailure> {
    match outcome {
        openclaw::operations::settings_config::SettingsConfigMutationOutcome::Confirmed => {
            Ok(SettingsProjectionEffect::Changed)
        }
        openclaw::operations::settings_config::SettingsConfigMutationOutcome::RestartRequired => {
            restart_after_settings_projection(
                artifact_changed,
                supervisor,
                gateway_port,
                plugins,
                diagnostic_reporter,
            )
            .await?;
            Ok(SettingsProjectionEffect::Changed)
        }
        openclaw::operations::settings_config::SettingsConfigMutationOutcome::Noop => {
            if artifact_changed {
                restart_after_settings_projection(
                    true,
                    supervisor,
                    gateway_port,
                    plugins,
                    diagnostic_reporter,
                )
                .await?;
                return Ok(SettingsProjectionEffect::Changed);
            }
            Ok(SettingsProjectionEffect::Unchanged)
        }
        openclaw::operations::settings_config::SettingsConfigMutationOutcome::Rejected => {
            Err(crate::runtime::driver::RuntimeOperationFailure::TargetRejected)
        }
        openclaw::operations::settings_config::SettingsConfigMutationOutcome::Unknown => {
            Err(crate::runtime::driver::RuntimeOperationFailure::Unknown)
        }
    }
}
