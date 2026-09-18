use std::sync::Arc;

use platform::endpoint::runtime_address::RuntimeEndpoint;

use crate::runtime::driver::{RuntimeDriver, RuntimeDriverIdentity};

pub(crate) struct RuntimeDriverDirectory {
    open_claw: Option<Arc<dyn RuntimeDriver>>,
    matcha_agent: Option<Arc<dyn RuntimeDriver>>,
}

impl RuntimeDriverDirectory {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self {
            open_claw: None,
            matcha_agent: None,
        }
    }

    pub(crate) fn fixed_peers<T>(open_claw: Arc<T>, matcha_agent: Arc<dyn RuntimeDriver>) -> Self
    where
        T: RuntimeDriver + 'static,
    {
        let open_claw: Arc<dyn RuntimeDriver> = open_claw;
        Self {
            open_claw: Some(open_claw),
            matcha_agent: Some(matcha_agent),
        }
    }

    #[cfg(test)]
    pub(crate) fn register(&mut self, driver: Arc<dyn RuntimeDriver>) {
        self.set_fixed_peer(driver);
    }

    pub(crate) fn lookup(&self, endpoint: &RuntimeEndpoint) -> Option<Arc<dyn RuntimeDriver>> {
        if *endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
            self.open_claw.clone()
        } else if *endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
            self.matcha_agent.clone()
        } else {
            None
        }
    }

    pub(crate) fn lookup_reference(
        &self,
        endpoint: &organization::RuntimeEndpointReference,
    ) -> Option<Arc<dyn RuntimeDriver>> {
        self.all_drivers()
            .find(|driver| driver.identity().runtime_endpoint_reference() == endpoint.as_str())
    }

    pub(crate) fn all_drivers(&self) -> impl Iterator<Item = Arc<dyn RuntimeDriver>> + '_ {
        [self.open_claw.as_ref(), self.matcha_agent.as_ref()]
            .into_iter()
            .flatten()
            .cloned()
    }

    pub(crate) fn connector_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        self.openclaw_driver_with(|driver| driver.connector_ops().is_some())
    }

    pub(crate) fn security_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        self.openclaw_driver_with(|driver| driver.security_ops().is_some())
    }

    pub(crate) fn settings_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        self.openclaw_driver_with(|driver| driver.settings_ops().is_some())
    }

    fn openclaw_driver_with(
        &self,
        supports: impl FnOnce(&dyn RuntimeDriver) -> bool,
    ) -> Option<Arc<dyn RuntimeDriver>> {
        let driver = self.open_claw.as_ref()?.clone();
        supports(driver.as_ref()).then_some(driver)
    }

    #[cfg(test)]
    fn set_fixed_peer(&mut self, driver: Arc<dyn RuntimeDriver>) {
        if driver.identity() == RuntimeDriverIdentity::open_claw() {
            self.open_claw = Some(driver);
        } else if driver.identity() == RuntimeDriverIdentity::matcha_agent() {
            self.matcha_agent = Some(driver);
        }
    }
}
