use ::settings::{
    self as settings_module,
    ports::{SettingsProjectionEffect, SettingsRuntimeFailure},
};

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    operations::settings_config::SettingsConfigMutationOutcome,
    projection::settings::{
        self as settings_projection, BrowserMode as OpenClawBrowserMode, SettingsProjectionError,
    },
};

pub fn browser_mode_projection(browser_mode: settings_module::BrowserMode) -> OpenClawBrowserMode {
    match browser_mode {
        settings_module::BrowserMode::Native => OpenClawBrowserMode::Native,
        settings_module::BrowserMode::Relay => OpenClawBrowserMode::Relay,
        settings_module::BrowserMode::Off => OpenClawBrowserMode::Off,
    }
}

pub fn apply_file_projection(
    state_dir: CanonicalStateDir,
    browser_mode: OpenClawBrowserMode,
    proxy_endpoint: Option<&str>,
) -> Result<SettingsProjectionEffect, SettingsRuntimeFailure> {
    settings_projection::apply(state_dir, browser_mode, proxy_endpoint)
        .map(|changed| {
            if changed {
                SettingsProjectionEffect::Changed
            } else {
                SettingsProjectionEffect::Unchanged
            }
        })
        .map_err(map_projection_error)
}

pub fn project_config_outcome(
    outcome: SettingsConfigMutationOutcome,
    artifact_changed: bool,
) -> Result<SettingsConfigEffect, SettingsRuntimeFailure> {
    match outcome {
        SettingsConfigMutationOutcome::Confirmed => Ok(SettingsConfigEffect::Changed),
        SettingsConfigMutationOutcome::RestartRequired => Ok(SettingsConfigEffect::RestartRequired),
        SettingsConfigMutationOutcome::Noop => {
            if artifact_changed {
                Ok(SettingsConfigEffect::RestartRequired)
            } else {
                Ok(SettingsConfigEffect::Unchanged)
            }
        }
        SettingsConfigMutationOutcome::Rejected => Err(SettingsRuntimeFailure::TargetRejected),
        SettingsConfigMutationOutcome::Unknown => Err(SettingsRuntimeFailure::Unknown),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsConfigEffect {
    Changed,
    Unchanged,
    RestartRequired,
}

impl SettingsConfigEffect {
    pub fn projection_effect(self) -> SettingsProjectionEffect {
        match self {
            Self::Changed | Self::RestartRequired => SettingsProjectionEffect::Changed,
            Self::Unchanged => SettingsProjectionEffect::Unchanged,
        }
    }
}

fn map_projection_error(error: SettingsProjectionError) -> SettingsRuntimeFailure {
    match error {
        SettingsProjectionError::InvalidProxy => SettingsRuntimeFailure::TargetRejected,
        SettingsProjectionError::ConfigStore => SettingsRuntimeFailure::Unknown,
    }
}
