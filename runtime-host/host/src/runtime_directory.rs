use std::collections::HashMap;
use std::sync::Arc;

use platform::endpoint::runtime_address::RuntimeEndpoint;

use crate::runtime_driver::RuntimeDriver;

pub(crate) struct RuntimeDriverDirectory {
    drivers: HashMap<String, Arc<dyn RuntimeDriver>>,
    openclaw_driver: Option<Arc<crate::composition::OpenClawInstance>>,
}

impl RuntimeDriverDirectory {
    pub(crate) fn new() -> Self {
        Self {
            drivers: HashMap::new(),
            openclaw_driver: None,
        }
    }

    pub(crate) fn register(&mut self, driver: Arc<dyn RuntimeDriver>) {
        let endpoint = driver.endpoint();
        let key = Self::endpoint_key(&endpoint);
        self.drivers.insert(key, driver);
    }

    pub(crate) fn register_openclaw(
        &mut self,
        instance: Arc<crate::composition::OpenClawInstance>,
    ) {
        let endpoint = instance.endpoint();
        let key = Self::endpoint_key(&endpoint);
        let driver: Arc<dyn RuntimeDriver> = instance.clone();
        self.drivers.insert(key, driver);
        self.openclaw_driver = Some(instance);
    }

    pub(crate) fn lookup(&self, endpoint: &RuntimeEndpoint) -> Option<Arc<dyn RuntimeDriver>> {
        let key = Self::endpoint_key(endpoint);
        self.drivers.get(&key).cloned()
    }

    pub(crate) fn all_drivers(&self) -> impl Iterator<Item = Arc<dyn RuntimeDriver>> + '_ {
        self.drivers.values().cloned()
    }

    pub(crate) fn connector_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        self.openclaw_driver
            .as_ref()
            .filter(|driver| driver.connector_ops().is_some())
            .map(|driver| {
                let driver: Arc<dyn RuntimeDriver> = driver.clone();
                driver
            })
    }

    pub(crate) fn security_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        self.openclaw_driver
            .as_ref()
            .filter(|driver| driver.security_ops().is_some())
            .map(|driver| {
                let driver: Arc<dyn RuntimeDriver> = driver.clone();
                driver
            })
    }

    pub(crate) fn settings_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        self.openclaw_driver
            .as_ref()
            .filter(|driver| driver.settings_ops().is_some())
            .map(|driver| {
                let driver: Arc<dyn RuntimeDriver> = driver.clone();
                driver
            })
    }

    fn endpoint_key(endpoint: &RuntimeEndpoint) -> String {
        format!(
            "{}-{}",
            endpoint.runtime_adapter_id(),
            endpoint.runtime_instance_id()
        )
    }
}
