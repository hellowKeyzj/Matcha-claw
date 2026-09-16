use environment::settings::{self, Outcome};

use crate::runtime::{
    directory::RuntimeDriverDirectory,
    driver::{RuntimeOperationFailure, SettingsProjectionEffect},
};

pub(crate) async fn apply_saved_desired(
    runtime_directory: &RuntimeDriverDirectory,
    desired: settings::Desired,
) -> Outcome {
    let Some(driver) = runtime_directory.settings_driver() else {
        return Outcome::Unknown;
    };
    let Some(settings) = driver.settings_ops() else {
        return Outcome::Unknown;
    };

    match settings
        .apply_settings_projection(
            browser_mode_projection(desired.browser_mode()),
            desired.proxy_endpoint().map(ToOwned::to_owned),
        )
        .await
    {
        Ok(SettingsProjectionEffect::Unchanged | SettingsProjectionEffect::Changed) => {
            Outcome::Confirmed
        }
        Err(RuntimeOperationFailure::TargetRejected) => Outcome::Rejected,
        Err(_) => Outcome::Unknown,
    }
}

fn browser_mode_projection(
    browser_mode: settings::BrowserMode,
) -> openclaw::projection::settings::BrowserMode {
    match browser_mode {
        settings::BrowserMode::Native => openclaw::projection::settings::BrowserMode::Native,
        settings::BrowserMode::Relay => openclaw::projection::settings::BrowserMode::Relay,
        settings::BrowserMode::Off => openclaw::projection::settings::BrowserMode::Off,
    }
}
