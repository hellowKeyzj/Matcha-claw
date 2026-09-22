mod adapters;
pub mod capability;
pub mod control;
mod domain;
pub mod ports;
pub mod projection;

use std::sync::Arc;

use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

pub use domain::{
    Catalog, CatalogEntry, ConfigurationOutcome, Execution, Operation, OperationOutcome,
    PluginError, Runtime, RuntimeEntry,
};

const MODULE_ID: ModuleId = ModuleId::new("plugins");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("plugins")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.plugins")];
const ROUTES: &[&str] = &["plugins.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::Route, EffectKind::RuntimeOperation];

#[derive(Clone)]
pub struct PluginsModule {
    plugins: Arc<dyn ports::PluginsPort>,
}

impl PluginsModule {
    pub fn new(plugins: Arc<dyn ports::PluginsPort>) -> Self {
        Self { plugins }
    }

    pub async fn catalog(&self) -> Result<Result<Catalog, PluginError>, ()> {
        self.plugins.catalog().await
    }

    pub async fn runtime(&self) -> Result<Result<Runtime, PluginError>, ()> {
        self.plugins.runtime().await
    }

    pub async fn set_enabled(
        &self,
        plugin_id: String,
        enabled: bool,
    ) -> Result<ConfigurationOutcome, ()> {
        self.plugins.set_enabled(plugin_id, enabled).await
    }

    pub async fn operation(
        &self,
        operation: Operation,
        plugin_id: String,
    ) -> Result<OperationOutcome, ()> {
        self.plugins.operation(operation, plugin_id).await
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(adapters::loopback::descriptor(
                adapters::loopback::Dependencies::new(verifier, self.clone()),
            )),
            Some(CapabilityDescriptorProvider::new(
                capability::listed,
                capability::describe,
            )),
        )
    }
}
