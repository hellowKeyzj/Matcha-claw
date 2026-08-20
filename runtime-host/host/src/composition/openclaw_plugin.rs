use crate::plugin::{
    Catalog, CatalogEntry, ConfigurationOutcome, Execution, Operation, OperationOutcome,
    PluginError, Runtime, RuntimeEntry,
};

use openclaw::projection::plugins as openclaw_plugins;

pub(crate) struct OpenClawPluginProvider {
    projection: openclaw::projection::plugins::PluginProjection,
}

impl OpenClawPluginProvider {
    pub(crate) fn new(projection: openclaw::projection::plugins::PluginProjection) -> Self {
        Self { projection }
    }

    pub(crate) fn catalog(&self) -> Result<Catalog, PluginError> {
        self.projection
            .catalog()
            .map(map_catalog)
            .map_err(|_| PluginError::Config)
    }

    pub(crate) fn runtime(&self, running: bool) -> Result<Runtime, PluginError> {
        self.projection
            .runtime(running)
            .map(map_runtime)
            .map_err(|_| PluginError::Config)
    }

    pub(crate) fn set_enabled(&self, plugin_id: &str, enabled: bool) -> ConfigurationOutcome {
        map_configuration_outcome(self.projection.set_enabled(plugin_id, enabled))
    }

    pub(crate) fn operation(&self, operation: Operation, plugin_id: &str) -> OperationOutcome {
        map_operation_outcome(self.projection.operation(
            match operation {
                Operation::Install => openclaw::projection::plugins::PluginOperation::Install,
                Operation::Update => openclaw::projection::plugins::PluginOperation::Update,
                Operation::Uninstall => openclaw::projection::plugins::PluginOperation::Uninstall,
            },
            plugin_id,
        ))
    }

    pub(crate) fn finalize_uninstall(&self, plugin_id: &str) -> OperationOutcome {
        map_operation_outcome(self.projection.finalize_uninstall(plugin_id))
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
