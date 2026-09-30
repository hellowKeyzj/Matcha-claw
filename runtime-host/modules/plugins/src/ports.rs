use std::{future::Future, pin::Pin};

use crate::{Catalog, ConfigurationOutcome, Operation, OperationOutcome, PluginError, Runtime};

pub type PluginsFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait PluginsPort: Send + Sync {
    fn admit_mutation(&self) -> Result<(), ()>;

    fn set_enabled_admitted<'a>(
        &'a self,
        plugin_id: String,
        enabled: bool,
    ) -> PluginsFuture<'a, Result<ConfigurationOutcome, ()>>;

    fn operation_admitted<'a>(
        &'a self,
        operation: Operation,
        plugin_id: String,
    ) -> PluginsFuture<'a, Result<OperationOutcome, ()>>;

    fn catalog<'a>(&'a self) -> PluginsFuture<'a, Result<Result<Catalog, PluginError>, ()>>;

    fn runtime<'a>(&'a self) -> PluginsFuture<'a, Result<Result<Runtime, PluginError>, ()>>;

    fn set_enabled<'a>(
        &'a self,
        plugin_id: String,
        enabled: bool,
    ) -> PluginsFuture<'a, Result<ConfigurationOutcome, ()>>;

    fn operation<'a>(
        &'a self,
        operation: Operation,
        plugin_id: String,
    ) -> PluginsFuture<'a, Result<OperationOutcome, ()>>;
}
