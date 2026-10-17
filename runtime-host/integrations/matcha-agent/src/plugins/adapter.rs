use plugins_module::{
    AgentCatalog, AgentCatalogEntry, ConfigurationOutcome, Operation, OperationOutcome, PluginError,
    ports::{AgentPluginsPort, PluginsFuture},
};
use tokio_util::sync::CancellationToken;

use super::{Failure, Plugins};

impl AgentPluginsPort for Plugins {
    fn catalog<'a>(&'a self, agent_id: &'a str) -> PluginsFuture<'a, Result<AgentCatalog, PluginError>> {
        Box::pin(async move {
            let catalog = self.list(agent_id).await.map_err(|_| PluginError::Config)?;
            Ok(AgentCatalog {
                agent_id: catalog.agent_id,
                plugins: catalog.plugins.into_iter().map(|plugin| AgentCatalogEntry {
                    id: plugin.id, version: plugin.version, scope: plugin.scope,
                    enabled: plugin.enabled, error_count: plugin.error_count,
                }).collect(),
            })
        })
    }

    fn set_enabled<'a>(&'a self, agent_id: &'a str, plugin_id: &'a str, enabled: bool) -> PluginsFuture<'a, ConfigurationOutcome> {
        Box::pin(async move {
            let operation = if enabled { super::Operation::Enable } else { super::Operation::Disable };
            // Native auto-scope resolves merged settings; it does not reload existing sessions.
            match self.mutate(agent_id, operation, plugin_id, None, &CancellationToken::new()).await {
                Ok(_) => ConfigurationOutcome::Configured,
                Err(Failure::Rejected) => ConfigurationOutcome::Rejected,
                Err(_) => ConfigurationOutcome::Unknown,
            }
        })
    }

    fn operation<'a>(&'a self, agent_id: &'a str, operation: Operation, plugin_id: &'a str) -> PluginsFuture<'a, OperationOutcome> {
        Box::pin(async move {
            let operation = match operation {
                Operation::Install => super::Operation::Install,
                Operation::Update => super::Operation::Update,
                Operation::Uninstall => super::Operation::Uninstall,
            };
            // These existing product actions retain the native CLI's default user scope.
            match self.mutate(agent_id, operation, plugin_id, None, &CancellationToken::new()).await {
                Ok(_) => OperationOutcome::Configured,
                Err(Failure::Rejected) => OperationOutcome::Rejected,
                Err(_) => OperationOutcome::Unknown,
            }
        })
    }
}
