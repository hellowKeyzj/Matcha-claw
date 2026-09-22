use crate::{adapters::store::DesiredSnapshot, domain::BrowserMode};

#[derive(Clone, Debug, Default)]
pub(crate) struct DesiredReadModel {
    desired: DesiredSnapshot,
}

impl DesiredReadModel {
    pub(crate) fn new(desired: DesiredSnapshot) -> Self {
        Self { desired }
    }

    pub(crate) fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "browserMode": browser_mode(self.desired.browser_mode()),
            "launchAtStartup": self.desired.launch_at_startup(),
            "gatewayAutoStart": self.desired.gateway_auto_start(),
            "proxyEnabled": self.desired.proxy_enabled(),
            "proxyServer": self.desired.proxy_server(),
            "proxyBypassRules": self.desired.proxy_bypass_rules(),
        })
    }
}

fn browser_mode(mode: BrowserMode) -> &'static str {
    match mode {
        BrowserMode::Native => "native",
        BrowserMode::Relay => "relay",
        BrowserMode::Off => "off",
    }
}
