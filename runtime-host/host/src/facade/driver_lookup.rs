use std::sync::Arc;

use platform::endpoint::runtime_address::RuntimeEndpoint;

use crate::runtime::{
    directory::RuntimeDriverDirectory,
    driver::{RuntimeDriver, RuntimeDriverIdentity},
};

#[derive(Clone)]
pub(super) struct RuntimeDrivers {
    directory: Arc<RuntimeDriverDirectory>,
}

impl RuntimeDrivers {
    pub(super) fn new(directory: Arc<RuntimeDriverDirectory>) -> Self {
        Self { directory }
    }

    pub(super) fn driver(&self, endpoint: &RuntimeEndpoint) -> Option<Arc<dyn RuntimeDriver>> {
        self.directory.lookup(endpoint)
    }

    pub(super) fn openclaw_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        self.driver(&RuntimeDriverIdentity::open_claw().endpoint())
    }

    pub(super) fn ready_openclaw_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        let driver = self.openclaw_driver()?;
        Self::is_ready(driver.as_ref()).then_some(driver)
    }

    pub(super) fn is_ready(driver: &dyn RuntimeDriver) -> bool {
        driver.lifecycle_ops().is_some_and(|ops| ops.readiness())
    }
}
