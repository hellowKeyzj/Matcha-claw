mod adapters;
mod call;
pub mod capability;
pub mod control;
mod domain;
mod operations;
pub mod ports;
pub mod projection;

use std::sync::Arc;

use platform::{
    call::{CallContext, CallLogError, CallReceipt, CallRecorder, CallStatus},
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
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route, EffectKind::RuntimeOperation];

#[derive(Clone)]
pub struct PluginsModule {
    plugins: Arc<dyn ports::PluginsPort>,
    recorder: Option<CallRecorder>,
    operations: Arc<std::sync::OnceLock<operations::Operations>>,
}

impl PluginsModule {
    pub fn new(plugins: Arc<dyn ports::PluginsPort>) -> Self {
        Self { plugins, recorder: None, operations: Arc::new(std::sync::OnceLock::new()) }
    }

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    pub async fn catalog(&self) -> Result<Result<Catalog, PluginError>, ()> {
        let mut detail = call::Detail::Catalog {
            plugin_count: None, installed_count: None, enabled_count: None,
        };
        let context = self.begin("plugins.catalog", &detail).await?;
        let result = self.plugins.catalog().await;
        let status = match &result {
            Ok(Ok(catalog)) => {
                detail = call::Detail::Catalog {
                    plugin_count: Some(catalog.plugins.len()),
                    installed_count: Some(catalog.plugins.iter().filter(|plugin| plugin.installed).count()),
                    enabled_count: Some(catalog.execution.enabled_plugin_ids.len()),
                };
                CallStatus::Succeeded
            }
            Ok(Err(_)) => CallStatus::Failed,
            Err(_) => CallStatus::Rejected,
        };
        Self::finish(context, status, &detail).await;
        result
    }

    pub async fn runtime(&self) -> Result<Result<Runtime, PluginError>, ()> {
        let mut detail = call::Detail::Runtime {
            plugin_count: None, enabled_count: None, running_count: None,
        };
        let context = self.begin("plugins.runtime", &detail).await?;
        let result = self.plugins.runtime().await;
        let status = match &result {
            Ok(Ok(runtime)) => {
                detail = call::Detail::Runtime {
                    plugin_count: Some(runtime.plugins.len()),
                    enabled_count: Some(runtime.execution.enabled_plugin_ids.len()),
                    running_count: Some(runtime.plugins.iter().filter(|plugin| plugin.status == "running").count()),
                };
                CallStatus::Succeeded
            }
            Ok(Err(_)) => CallStatus::Failed,
            Err(_) => CallStatus::Rejected,
        };
        Self::finish(context, status, &detail).await;
        result
    }

    pub async fn set_enabled(&self, plugin_id: String, enabled: bool) -> Result<ConfigurationOutcome, ()> {
        let Some(recorder) = self.recorder.as_ref() else {
            return self.plugins.set_enabled(plugin_id, enabled).await;
        };
        let (_, result) = self.operations().submit(recorder, operations::Mutation::Configuration { plugin_id, enabled }).await.map_err(|_| ())?;
        result.await.map(ConfigurationOutcome::from).map_err(|_| ())
    }

    pub async fn operation(&self, operation: Operation, plugin_id: String) -> Result<OperationOutcome, ()> {
        let Some(recorder) = self.recorder.as_ref() else {
            return self.plugins.operation(operation, plugin_id).await;
        };
        let (_, result) = self.operations().submit(recorder, operations::Mutation::Operation { plugin_id, operation }).await.map_err(|_| ())?;
        result.await.map(OperationOutcome::from).map_err(|_| ())
    }

    pub async fn admit_configuration(&self, plugin_id: String, enabled: bool) -> Result<CallReceipt, CallLogError> {
        self.admit(operations::Mutation::Configuration { plugin_id, enabled }).await
    }

    pub async fn admit_operation(&self, operation: Operation, plugin_id: String) -> Result<CallReceipt, CallLogError> {
        self.admit(operations::Mutation::Operation { plugin_id, operation }).await
    }

    async fn admit(&self, mutation: operations::Mutation) -> Result<CallReceipt, CallLogError> {
        let recorder = self.recorder.as_ref().ok_or(CallLogError::Unavailable)?;
        let (receipt, _) = self.operations().submit(recorder, mutation).await?;
        Ok(receipt)
    }

    fn operations(&self) -> &operations::Operations {
        self.operations.get_or_init(|| operations::Operations::spawn(self.plugins.clone()))
    }

    pub async fn stop_operations(&self) {
        // Initializing the task here also seals admission when shutdown precedes the first mutation.
        self.operations().stop().await;
    }

    async fn begin(&self, command: &'static str, detail: &call::Detail) -> Result<Option<CallContext<call::Detail>>, ()> {
        match self.recorder.as_ref() {
            Some(recorder) => recorder.begin(command, detail).await.map(Some).map_err(|_| ()),
            None => Ok(None),
        }
    }

    async fn finish(context: Option<CallContext<call::Detail>>, status: CallStatus, detail: &call::Detail) {
        if let Some(context) = context {
            let _ = context.finish(status, detail).await;
        }
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            MODULE_ID, PROVIDES, REQUIRES, EFFECTS, ROUTES, EVENTS,
            Some(adapters::loopback::descriptor(adapters::loopback::Dependencies::new(verifier, self.clone()))),
            Some(CapabilityDescriptorProvider::new(capability::listed, capability::describe)),
        )
    }
}
