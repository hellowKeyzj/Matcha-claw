use crate::{
    application::receipts::Outcome,
    domain::Desired,
    ports::{SettingsProjectionEffect, SettingsRuntimeDirectory},
};

pub(crate) async fn apply_saved_desired(
    runtime_directory: &dyn SettingsRuntimeDirectory,
    desired: Desired,
) -> Outcome {
    let Some(settings) = runtime_directory.settings_ops() else {
        return Outcome::Unknown;
    };

    match settings
        .apply_settings_projection(
            desired.browser_mode(),
            desired.proxy_endpoint().map(ToOwned::to_owned),
        )
        .await
    {
        Ok(SettingsProjectionEffect::Unchanged | SettingsProjectionEffect::Changed) => {
            Outcome::Confirmed
        }
        Err(error) => error.into(),
    }
}
