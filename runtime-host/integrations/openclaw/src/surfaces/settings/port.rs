use crate::port::OpenClawGateway;
use crate::surfaces::settings::gateway::config::{
    SettingsConfigMutationOutcome, SettingsConfigOperation,
};

impl OpenClawGateway {
    pub async fn apply_settings_config_projection(
        &self,
        browser_mode: crate::native_config::settings::BrowserMode,
        proxy_endpoint: Option<String>,
    ) -> SettingsConfigMutationOutcome {
        let projection = match crate::native_config::settings::SettingsProjection::try_new(
            browser_mode,
            proxy_endpoint.as_deref(),
        ) {
            Ok(projection) => projection,
            Err(_) => return SettingsConfigMutationOutcome::Rejected,
        };
        SettingsConfigOperation::new(self.client())
            .apply(&projection)
            .await
    }
}
