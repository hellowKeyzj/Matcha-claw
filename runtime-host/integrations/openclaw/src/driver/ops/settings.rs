use super::super::lifecycle::{prepare_openclaw_lifecycle, restart_supervisor};
use super::*;

impl SettingsOps for OpenClawDriver {
    fn apply_settings_projection<'a>(
        &'a self,
        browser_mode: ::settings::BrowserMode,
        proxy_endpoint: Option<String>,
    ) -> ::settings::ports::SettingsFuture<
        'a,
        Result<
            ::settings::ports::SettingsProjectionEffect,
            ::settings::ports::SettingsRuntimeFailure,
        >,
    > {
        let state_dir = self.state_dir.clone();
        let gateway = Arc::clone(&self.gateway);
        let control_lease = self.control_lease();
        let plugins = self.plugins();
        let supervisor = self.supervisor_handle();
        let gateway_port = self.gateway_port;
        let diagnostic_reporter = Arc::clone(&self.diagnostic_reporter);
        Box::pin(async move {
            let browser_mode = crate::settings::browser_mode_projection(browser_mode);
            match supervisor.snapshot().phase() {
                SupervisorPhase::Idle => crate::settings::apply_file_projection(
                    state_dir,
                    browser_mode,
                    proxy_endpoint.as_deref(),
                ),
                SupervisorPhase::Running => {
                    if control_lease.snapshot_control().await != OpenClawControlReadiness::Ready {
                        return Err(::settings::ports::SettingsRuntimeFailure::Unknown);
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
                    Err(::settings::ports::SettingsRuntimeFailure::Unknown)
                }
            }
        })
    }
}

fn prepare_settings_relay_plugin(
    plugins: &crate::projection::plugins::PluginProjection,
    browser_mode: crate::projection::settings::BrowserMode,
) -> Result<bool, ::settings::ports::SettingsRuntimeFailure> {
    if browser_mode != crate::projection::settings::BrowserMode::Relay {
        return Ok(false);
    }
    let selected = ["browser-relay".to_owned()];
    let reconcile = plugins
        .reconcile_enabled_managed_plugins(&selected)
        .map_err(|_| ::settings::ports::SettingsRuntimeFailure::Unknown)?;
    plugins
        .reconcile_installed_records()
        .map_err(|_| ::settings::ports::SettingsRuntimeFailure::Unknown)?;
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
    plugins: crate::projection::plugins::PluginProjection,
    diagnostic_reporter: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
) -> Result<(), ::settings::ports::SettingsRuntimeFailure> {
    if prepare_lifecycle
        && prepare_openclaw_lifecycle(&supervisor, gateway_port, plugins, diagnostic_reporter)
            .await
            .is_err()
    {
        return Err(::settings::ports::SettingsRuntimeFailure::Unknown);
    }
    restart_supervisor(supervisor)
        .await
        .map(|_| ())
        .map_err(|_| ::settings::ports::SettingsRuntimeFailure::Unknown)
}

async fn project_settings_config_outcome(
    outcome: crate::operations::settings_config::SettingsConfigMutationOutcome,
    artifact_changed: bool,
    supervisor: SupervisorHandle,
    gateway_port: u16,
    plugins: crate::projection::plugins::PluginProjection,
    diagnostic_reporter: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
) -> Result<::settings::ports::SettingsProjectionEffect, ::settings::ports::SettingsRuntimeFailure>
{
    let effect = crate::settings::project_config_outcome(outcome, artifact_changed)?;
    if effect == crate::settings::SettingsConfigEffect::RestartRequired {
        restart_after_settings_projection(
            true,
            supervisor,
            gateway_port,
            plugins,
            diagnostic_reporter,
        )
        .await?;
    }
    Ok(effect.projection_effect())
}
