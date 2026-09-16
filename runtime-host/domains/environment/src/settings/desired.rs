use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Confirmed,
    Rejected,
    Unknown,
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Unknown => "outcome_unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub revision: u64,
    pub outcome: Outcome,
}

impl Settlement {
    pub const fn unknown(revision: u64) -> Self {
        Self {
            revision,
            outcome: Outcome::Unknown,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Desired {
    pub(super) browser_mode: BrowserMode,
    pub(super) proxy: Proxy,
    pub(super) launch_at_startup: bool,
    pub(super) gateway_auto_start: bool,
}

impl Desired {
    pub fn try_new(
        browser_mode: BrowserMode,
        proxy: ProxyDesired,
        launch_at_startup: bool,
        gateway_auto_start: bool,
    ) -> Result<Self, InvalidDesired> {
        if !valid_text(&proxy.server, 2048) || !valid_text(&proxy.bypass_rules, 4096) {
            return Err(InvalidDesired);
        }
        if proxy.enabled && proxy.server.is_empty() {
            return Err(InvalidDesired);
        }
        if proxy.server.contains('@') {
            return Err(InvalidDesired);
        }
        Ok(Self {
            browser_mode,
            proxy: Proxy {
                enabled: proxy.enabled,
                server: proxy.server,
                bypass_rules: proxy.bypass_rules,
            },
            launch_at_startup,
            gateway_auto_start,
        })
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
        self.proxy.enabled
    }

    pub fn proxy_server(&self) -> &str {
        &self.proxy.server
    }

    pub fn proxy_bypass_rules(&self) -> &str {
        &self.proxy.bypass_rules
    }

    pub fn proxy_endpoint(&self) -> Option<&str> {
        self.proxy.enabled.then_some(self.proxy.server.as_str())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProxyDesired {
    pub enabled: bool,
    pub server: String,
    pub bypass_rules: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidDesired;

impl fmt::Display for InvalidDesired {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("settings desired state is invalid")
    }
}

impl std::error::Error for InvalidDesired {}

fn valid_text(value: &str, maximum: usize) -> bool {
    value.len() <= maximum && !value.contains('\0') && !value.contains(['\r', '\n'])
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum BrowserMode {
    #[default]
    Native,
    Relay,
    Off,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Proxy {
    pub(super) enabled: bool,
    pub(super) server: String,
    pub(super) bypass_rules: String,
}
