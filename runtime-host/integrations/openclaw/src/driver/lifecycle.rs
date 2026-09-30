use std::sync::Arc;

use foundation::process::supervision::{
    CommandReceipt, CompletionError, RestartOutcome, StartOutcome, SupervisorHandle,
    SupervisorPhase, SupervisorSnapshot, TerminationCompletion,
};
use runtime_directory::{
    LifecycleOps, OwnedRuntimeFuture, RuntimeLifecycleFailure, RuntimeStartFailure,
};
use tokio::sync::watch;

use crate::{
    driver::OpenClawDriver,
    lifecycle::logs::{LifecycleDiagnostic, LifecycleDiagnosticCategory, LogStream},
};

impl LifecycleOps for OpenClawDriver {
    fn snapshot(&self) -> SupervisorSnapshot {
        self.owner().snapshot()
    }

    fn subscribe(&self) -> watch::Receiver<SupervisorSnapshot> {
        self.owner().subscribe()
    }

    fn start(&self) -> OwnedRuntimeFuture<Result<StartOutcome, RuntimeStartFailure>> {
        let supervisor = self.supervisor_handle();
        let gateway_port = self.gateway_port;
        let plugins = self.plugins();
        let diagnostic_reporter = Arc::clone(&self.diagnostic_reporter);
        Box::pin(async move {
            let started = std::time::Instant::now();
            eprintln!("[startup-trace] source=openclaw-launch phase=plugin-prepare stage=start");
            let prepared =
                prepare_openclaw_lifecycle(&supervisor, gateway_port, plugins, diagnostic_reporter)
                    .await;
            eprintln!(
                "[startup-trace] source=openclaw-launch phase=plugin-prepare stage=end duration_ms={} success={}",
                started.elapsed().as_millis(),
                prepared.is_ok()
            );
            prepared.map_err(|_| RuntimeStartFailure::CompletionFailed)?;
            eprintln!("[startup-trace] source=openclaw-launch phase=process-start stage=start");
            start_supervisor(supervisor).await
        })
    }

    fn stop(&self) -> OwnedRuntimeFuture<Result<TerminationCompletion, RuntimeLifecycleFailure>> {
        let supervisor = self.supervisor_handle();
        Box::pin(stop_supervisor(supervisor))
    }

    fn restart(&self) -> OwnedRuntimeFuture<Result<RestartOutcome, RuntimeLifecycleFailure>> {
        let supervisor = self.supervisor_handle();
        let gateway_port = self.gateway_port;
        let plugins = self.plugins();
        let diagnostic_reporter = Arc::clone(&self.diagnostic_reporter);
        Box::pin(async move {
            prepare_openclaw_lifecycle(&supervisor, gateway_port, plugins, diagnostic_reporter)
                .await
                .map_err(|_| RuntimeLifecycleFailure::CompletionFailed)?;
            restart_supervisor(supervisor).await
        })
    }
}

impl OpenClawDriver {
    pub fn supervisor_handle(&self) -> SupervisorHandle {
        self.owner
            .lock()
            .expect("OpenClaw supervisor owner lock must not be poisoned")
            .as_ref()
            .expect("OpenClaw supervisor owner must be present")
            .handle()
    }
}

pub async fn prepare_openclaw_lifecycle(
    supervisor: &SupervisorHandle,
    gateway_port: u16,
    plugins: crate::native_config::plugins::PluginProjection,
    diagnostic_reporter: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
) -> Result<(), ()> {
    if supervisor.snapshot().phase() != SupervisorPhase::Running {
        crate::lifecycle::port_guard::ensure_gateway_port_available(gateway_port)
            .await
            .map_err(|_| ())?;
    }
    prepare_openclaw_plugin_readiness(plugins, &diagnostic_reporter);
    Ok(())
}

fn prepare_openclaw_plugin_readiness(
    plugins: crate::native_config::plugins::PluginProjection,
    diagnostic_reporter: &Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
) {
    let enabled_ids = match plugins.catalog() {
        Ok(catalog) => catalog.execution.enabled_plugin_ids,
        Err(_) => {
            report_openclaw_configuration_rejected(diagnostic_reporter);
            return;
        }
    };
    let configured_channel_ids = match plugins.configured_channel_plugin_ids() {
        Ok(ids) => {
            if plugins.reconcile_configured_channel_plugins(&ids).is_err()
                || plugins
                    .apply_configured_channel_startup_config(&ids)
                    .is_err()
            {
                report_openclaw_configuration_rejected(diagnostic_reporter);
            }
            ids
        }
        Err(_) => {
            report_openclaw_configuration_rejected(diagnostic_reporter);
            Vec::new()
        }
    };
    let mut startup_ids = enabled_ids;
    startup_ids.extend(configured_channel_ids);
    startup_ids.sort();
    startup_ids.dedup();
    if plugins
        .reconcile_enabled_managed_plugins(&startup_ids)
        .is_err()
    {
        report_openclaw_configuration_rejected(diagnostic_reporter);
    }
    if plugins.reconcile_installed_records().is_err() {
        report_openclaw_configuration_rejected(diagnostic_reporter);
    }
    if plugins.reconcile_preinstalled_skills().is_err() {
        report_openclaw_configuration_rejected(diagnostic_reporter);
    }
    if plugins.apply_startup_lifecycle(&startup_ids).is_err() {
        report_openclaw_configuration_rejected(diagnostic_reporter);
    }
}

fn report_openclaw_configuration_rejected(
    diagnostic_reporter: &Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
) {
    diagnostic_reporter(LifecycleDiagnostic::new(
        LogStream::Stderr,
        LifecycleDiagnosticCategory::ConfigurationRejected,
    ));
}

async fn start_supervisor(
    supervisor: SupervisorHandle,
) -> Result<StartOutcome, RuntimeStartFailure> {
    match supervisor.start().await {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
            completion.wait().await.map_err(map_start_completion_error)
        }
        CommandReceipt::AlreadySatisfied => Ok(StartOutcome::Started),
        CommandReceipt::Busy => Err(RuntimeStartFailure::Busy),
        CommandReceipt::Rejected(rejection) => Err(RuntimeStartFailure::Rejected(rejection)),
        CommandReceipt::ShuttingDown => Err(RuntimeStartFailure::ShuttingDown),
    }
}

async fn stop_supervisor(
    supervisor: SupervisorHandle,
) -> Result<TerminationCompletion, RuntimeLifecycleFailure> {
    match supervisor.stop().await {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
            .wait()
            .await
            .map_err(map_lifecycle_completion_error),
        CommandReceipt::AlreadySatisfied => Err(RuntimeLifecycleFailure::AlreadySatisfied),
        CommandReceipt::Busy => Err(RuntimeLifecycleFailure::Busy),
        CommandReceipt::Rejected(rejection) => Err(RuntimeLifecycleFailure::Rejected(rejection)),
        CommandReceipt::ShuttingDown => Err(RuntimeLifecycleFailure::ShuttingDown),
    }
}

pub async fn restart_supervisor(
    supervisor: SupervisorHandle,
) -> Result<RestartOutcome, RuntimeLifecycleFailure> {
    match supervisor.restart().await {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion
            .wait()
            .await
            .map_err(map_lifecycle_completion_error),
        CommandReceipt::AlreadySatisfied => Err(RuntimeLifecycleFailure::AlreadySatisfied),
        CommandReceipt::Busy => Err(RuntimeLifecycleFailure::Busy),
        CommandReceipt::Rejected(rejection) => Err(RuntimeLifecycleFailure::Rejected(rejection)),
        CommandReceipt::ShuttingDown => Err(RuntimeLifecycleFailure::ShuttingDown),
    }
}

fn map_start_completion_error(error: CompletionError) -> RuntimeStartFailure {
    match error {
        CompletionError::Failed(_) => RuntimeStartFailure::CompletionFailed,
        CompletionError::SupervisorStopped => RuntimeStartFailure::SupervisorStopped,
    }
}

fn map_lifecycle_completion_error(error: CompletionError) -> RuntimeLifecycleFailure {
    match error {
        CompletionError::Failed(_) => RuntimeLifecycleFailure::CompletionFailed,
        CompletionError::SupervisorStopped => RuntimeLifecycleFailure::SupervisorStopped,
    }
}
