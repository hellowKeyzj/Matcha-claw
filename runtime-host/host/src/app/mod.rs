mod runtime;
mod service;
mod shutdown;

pub use service::{AppInput, run_app_service};

#[cfg(test)]
pub(crate) use runtime::run_control_service;

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
