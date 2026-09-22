use platform::endpoint::runtime_address::RuntimeEndpoint;

use crate::RuntimeDriverIdentity;

#[derive(Clone)]
pub struct RuntimeDriverDirectory<D> {
    open_claw: Option<D>,
    matcha_agent: Option<D>,
}

impl<D> RuntimeDriverDirectory<D> {
    pub const fn new() -> Self {
        Self {
            open_claw: None,
            matcha_agent: None,
        }
    }

    pub fn fixed_peers(open_claw: D, matcha_agent: D) -> Self {
        Self {
            open_claw: Some(open_claw),
            matcha_agent: Some(matcha_agent),
        }
    }

    pub fn lookup_ref(&self, endpoint: &RuntimeEndpoint) -> Option<&D> {
        if *endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
            self.open_claw.as_ref()
        } else if *endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
            self.matcha_agent.as_ref()
        } else {
            None
        }
    }

    pub fn lookup_reference_ref(&self, endpoint: &str) -> Option<&D> {
        if endpoint == RuntimeDriverIdentity::open_claw().runtime_endpoint_reference() {
            self.open_claw.as_ref()
        } else if endpoint == RuntimeDriverIdentity::matcha_agent().runtime_endpoint_reference() {
            self.matcha_agent.as_ref()
        } else {
            None
        }
    }

    pub fn all_drivers_ref(&self) -> impl Iterator<Item = &D> {
        [self.open_claw.as_ref(), self.matcha_agent.as_ref()]
            .into_iter()
            .flatten()
    }

    pub fn set_fixed_peer(&mut self, identity: RuntimeDriverIdentity, driver: D) {
        if identity == RuntimeDriverIdentity::open_claw() {
            self.open_claw = Some(driver);
        } else if identity == RuntimeDriverIdentity::matcha_agent() {
            self.matcha_agent = Some(driver);
        }
    }
}

impl<D: Clone> RuntimeDriverDirectory<D> {
    pub fn lookup(&self, endpoint: &RuntimeEndpoint) -> Option<D> {
        self.lookup_ref(endpoint).cloned()
    }

    pub fn lookup_reference(&self, endpoint: &str) -> Option<D> {
        self.lookup_reference_ref(endpoint).cloned()
    }

    pub fn all_drivers(&self) -> impl Iterator<Item = D> + '_ {
        self.all_drivers_ref().cloned()
    }
}

impl<D> Default for RuntimeDriverDirectory<D> {
    fn default() -> Self {
        Self::new()
    }
}
