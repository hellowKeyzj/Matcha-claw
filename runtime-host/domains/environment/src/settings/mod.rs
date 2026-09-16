mod desired;
mod store;

pub use desired::{BrowserMode, Desired, InvalidDesired, Outcome, ProxyDesired, Settlement};
pub use store::{DesiredState, StateFileError};

#[derive(Clone, Debug)]
pub struct PendingDesired {
    pub revision: u64,
    pub desired: Desired,
}

#[derive(Clone, Debug, Default)]
pub struct DesiredSnapshot {
    browser_mode: BrowserMode,
    launch_at_startup: bool,
    gateway_auto_start: bool,
    proxy_enabled: bool,
    proxy_server: String,
    proxy_bypass_rules: String,
}

impl DesiredSnapshot {
    pub(crate) fn new(
        browser_mode: BrowserMode,
        launch_at_startup: bool,
        gateway_auto_start: bool,
        proxy_enabled: bool,
        proxy_server: String,
        proxy_bypass_rules: String,
    ) -> Self {
        Self {
            browser_mode,
            launch_at_startup,
            gateway_auto_start,
            proxy_enabled,
            proxy_server,
            proxy_bypass_rules,
        }
    }

    pub const fn browser_mode(&self) -> BrowserMode {
        self.browser_mode
    }

    pub const fn launch_at_startup(&self) -> bool {
        self.launch_at_startup
    }

    pub const fn gateway_auto_start(&self) -> bool {
        self.gateway_auto_start
    }

    pub const fn proxy_enabled(&self) -> bool {
        self.proxy_enabled
    }

    pub fn proxy_server(&self) -> &str {
        &self.proxy_server
    }

    pub fn proxy_bypass_rules(&self) -> &str {
        &self.proxy_bypass_rules
    }
}

#[derive(Clone, Debug, Default)]
pub struct SettingsSnapshot {
    desired: DesiredSnapshot,
    pending: Option<PendingDesired>,
}

impl SettingsSnapshot {
    pub(crate) fn new(desired: DesiredSnapshot, pending: Option<PendingDesired>) -> Self {
        Self { desired, pending }
    }

    pub fn desired(&self) -> &DesiredSnapshot {
        &self.desired
    }

    pub fn pending(&self) -> Option<&PendingDesired> {
        self.pending.as_ref()
    }

    pub fn gateway_auto_start(&self) -> bool {
        self.desired.gateway_auto_start
    }
}
