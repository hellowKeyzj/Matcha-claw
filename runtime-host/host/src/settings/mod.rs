pub(crate) mod actor;
mod command;
pub(crate) mod desired;
mod handle;

mod query;

pub(crate) use command::SettingsCommand;
pub use desired::{Desired, Outcome as DesiredOutcome};
pub(crate) use handle::SettingsHandle;
pub(crate) use query::SettingsQuery;
