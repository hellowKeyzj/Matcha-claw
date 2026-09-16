pub(crate) mod actor;
mod command;
mod handle;
mod projection;
mod query;
mod read_model;

pub(crate) use environment::settings::Outcome as DesiredOutcome;
pub(crate) use handle::SettingsHandle;
