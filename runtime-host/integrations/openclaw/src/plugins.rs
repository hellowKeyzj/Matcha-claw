use std::{future::Future, sync::Arc};

use plugins_module::{
    Catalog, CatalogEntry, ConfigurationOutcome, Execution, Operation, OperationOutcome,
    PluginError, Runtime, RuntimeEntry, ports::PluginsFuture,
};
use runtime_directory::LifecycleOps as _;

use crate::{driver::OpenClawDriver, projection::plugins as openclaw_plugins};

pub trait OpenClawPluginsAdmissionPort: Send + Sync {
    fn admit_openclaw_plugins_request(&self) -> bool;
}

pub trait OpenClawPluginsRestartPort: Send + Sync {
    fn restart_openclaw_runtime<'a>(&'a self) -> PluginsFuture<'a, bool>;
}

#[derive(Clone)]
pub struct OpenClawPluginsPort {
    admission: Arc<dyn OpenClawPluginsAdmissionPort>,
    driver: Arc<OpenClawDriver>,
    restart: Arc<dyn OpenClawPluginsRestartPort>,
}

impl OpenClawPluginsPort {
    pub fn new(
        admission: Arc<dyn OpenClawPluginsAdmissionPort>,
        driver: Arc<OpenClawDriver>,
        restart: Arc<dyn OpenClawPluginsRestartPort>,
    ) -> Self {
        Self {
            admission,
            driver,
            restart,
        }
    }

    fn open_claw_is_running(&self) -> bool {
        self.driver.as_ref().readiness()
    }
}

async fn restart_open_claw_runtime(restart: Arc<dyn OpenClawPluginsRestartPort>) -> bool {
    restart.restart_openclaw_runtime().await
}

impl plugins_module::ports::PluginsPort for OpenClawPluginsPort {
    fn catalog<'a>(&'a self) -> PluginsFuture<'a, Result<Result<Catalog, PluginError>, ()>> {
        Box::pin(async move {
            if !self.admission.admit_openclaw_plugins_request() {
                return Err(());
            }
            Ok(self.driver.plugin_provider().catalog())
        })
    }

    fn runtime<'a>(&'a self) -> PluginsFuture<'a, Result<Result<Runtime, PluginError>, ()>> {
        Box::pin(async move {
            if !self.admission.admit_openclaw_plugins_request() {
                return Err(());
            }
            Ok(self
                .driver
                .plugin_provider()
                .runtime(self.open_claw_is_running()))
        })
    }

    fn set_enabled<'a>(
        &'a self,
        plugin_id: String,
        enabled: bool,
    ) -> PluginsFuture<'a, Result<ConfigurationOutcome, ()>> {
        Box::pin(async move {
            if !self.admission.admit_openclaw_plugins_request() {
                return Ok(ConfigurationOutcome::Unknown);
            }
            let restart = Arc::clone(&self.restart);
            Ok(self
                .driver
                .plugin_provider()
                .set_enabled_with_restart(&plugin_id, enabled, move || {
                    restart_open_claw_runtime(restart)
                })
                .await)
        })
    }

    fn operation<'a>(
        &'a self,
        operation: Operation,
        plugin_id: String,
    ) -> PluginsFuture<'a, Result<OperationOutcome, ()>> {
        Box::pin(async move {
            if !self.admission.admit_openclaw_plugins_request() || !self.open_claw_is_running() {
                return Ok(OperationOutcome::Unknown);
            }
            let restart = Arc::clone(&self.restart);
            Ok(self
                .driver
                .plugin_provider()
                .operation_with_restart(operation, &plugin_id, move || {
                    restart_open_claw_runtime(restart)
                })
                .await)
        })
    }
}

pub struct OpenClawPluginProvider {
    projection: openclaw_plugins::PluginProjection,
}

impl OpenClawPluginProvider {
    pub fn new(projection: openclaw_plugins::PluginProjection) -> Self {
        Self { projection }
    }

    pub fn catalog(&self) -> Result<Catalog, PluginError> {
        self.projection
            .catalog()
            .map(map_catalog)
            .map_err(|_| PluginError::Config)
    }

    pub fn runtime(&self, running: bool) -> Result<Runtime, PluginError> {
        self.projection
            .runtime(running)
            .map(map_runtime)
            .map_err(|_| PluginError::Config)
    }

    pub fn set_enabled(&self, plugin_id: &str, enabled: bool) -> ConfigurationOutcome {
        map_configuration_outcome(self.projection.set_enabled(plugin_id, enabled))
    }

    pub async fn set_enabled_with_restart<R, Restart>(
        &self,
        plugin_id: &str,
        enabled: bool,
        restart: R,
    ) -> ConfigurationOutcome
    where
        R: FnOnce() -> Restart,
        Restart: Future<Output = bool>,
    {
        let outcome = self.set_enabled(plugin_id, enabled);
        if outcome != ConfigurationOutcome::Configured {
            return outcome;
        }
        if restart().await {
            outcome
        } else {
            ConfigurationOutcome::Unknown
        }
    }

    pub fn operation(&self, operation: Operation, plugin_id: &str) -> OperationOutcome {
        map_operation_outcome(self.projection.operation(
            match operation {
                Operation::Install => openclaw_plugins::PluginOperation::Install,
                Operation::Update => openclaw_plugins::PluginOperation::Update,
                Operation::Uninstall => openclaw_plugins::PluginOperation::Uninstall,
            },
            plugin_id,
        ))
    }

    pub fn finalize_uninstall(&self, plugin_id: &str) -> OperationOutcome {
        map_operation_outcome(self.projection.finalize_uninstall(plugin_id))
    }

    pub async fn operation_with_restart<R, Restart>(
        &self,
        operation: Operation,
        plugin_id: &str,
        restart: R,
    ) -> OperationOutcome
    where
        R: FnOnce() -> Restart,
        Restart: Future<Output = bool>,
    {
        let outcome = self.operation(operation, plugin_id);
        if outcome != OperationOutcome::Configured {
            return outcome;
        }
        if !restart().await {
            return OperationOutcome::Unknown;
        }
        if operation == Operation::Uninstall {
            self.finalize_uninstall(plugin_id)
        } else {
            OperationOutcome::Configured
        }
    }
}

fn map_catalog(catalog: openclaw_plugins::Catalog) -> Catalog {
    Catalog {
        success: catalog.success,
        execution: Execution {
            enabled_plugin_ids: catalog.execution.enabled_plugin_ids,
        },
        plugins: catalog.plugins.into_iter().map(map_catalog_entry).collect(),
    }
}

fn map_catalog_entry(entry: openclaw_plugins::CatalogEntry) -> CatalogEntry {
    CatalogEntry {
        runtime: entry.runtime,
        id: entry.id,
        name: entry.name,
        version: entry.version,
        kind: entry.kind,
        platform: entry.platform,
        description: entry.description,
        companion_skill_slugs: entry.companion_skill_slugs,
        enabled: entry.enabled,
        installed: entry.installed,
        update_available: entry.update_available,
        companion_skill_ready: entry.companion_skill_ready,
    }
}

fn map_runtime(runtime: openclaw_plugins::Runtime) -> Runtime {
    Runtime {
        success: runtime.success,
        lifecycle: runtime.lifecycle,
        state: runtime.state,
        health: runtime.health,
        execution: Execution {
            enabled_plugin_ids: runtime.execution.enabled_plugin_ids,
        },
        plugins: runtime
            .plugins
            .into_iter()
            .map(|entry| RuntimeEntry {
                id: entry.id,
                status: entry.status,
            })
            .collect(),
    }
}

fn map_configuration_outcome(outcome: openclaw_plugins::SetEnabledOutcome) -> ConfigurationOutcome {
    match outcome {
        openclaw_plugins::SetEnabledOutcome::Configured => ConfigurationOutcome::Configured,
        openclaw_plugins::SetEnabledOutcome::Rejected => ConfigurationOutcome::Rejected,
        openclaw_plugins::SetEnabledOutcome::Unknown => ConfigurationOutcome::Unknown,
    }
}

fn map_operation_outcome(outcome: openclaw_plugins::PluginOperationOutcome) -> OperationOutcome {
    match outcome {
        openclaw_plugins::PluginOperationOutcome::Configured => OperationOutcome::Configured,
        openclaw_plugins::PluginOperationOutcome::Rejected => OperationOutcome::Rejected,
        openclaw_plugins::PluginOperationOutcome::Unknown => OperationOutcome::Unknown,
    }
}
