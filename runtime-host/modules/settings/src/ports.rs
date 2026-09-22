use std::{future::Future, pin::Pin};

use crate::{application::receipts::Outcome, domain::BrowserMode};

pub type SettingsFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait SettingsRuntimeDirectory: Send + Sync {
    fn settings_ops(&self) -> Option<&dyn SettingsOps>;
}

pub trait SettingsOps: Send + Sync {
    fn apply_settings_projection<'a>(
        &'a self,
        browser_mode: BrowserMode,
        proxy_endpoint: Option<String>,
    ) -> SettingsFuture<'a, Result<SettingsProjectionEffect, SettingsRuntimeFailure>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsProjectionEffect {
    Changed,
    Unchanged,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsRuntimeFailure {
    Unsupported,
    Unavailable,
    TargetRejected,
    Unknown,
}

impl From<SettingsRuntimeFailure> for Outcome {
    fn from(value: SettingsRuntimeFailure) -> Self {
        match value {
            SettingsRuntimeFailure::TargetRejected => Self::Rejected,
            SettingsRuntimeFailure::Unsupported
            | SettingsRuntimeFailure::Unavailable
            | SettingsRuntimeFailure::Unknown => Self::Unknown,
        }
    }
}
