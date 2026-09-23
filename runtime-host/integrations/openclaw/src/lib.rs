mod surfaces;

pub mod bootstrap;
pub(crate) use surfaces::cron;
pub mod diagnostics;
pub mod driver;
pub mod gateway;
pub mod lifecycle;
mod native_config;
mod package_status;
pub mod platform_runtime;
pub mod port;
pub mod session;
pub use session::window as session_window;

pub use surfaces::tooling::tool_permission;
pub use surfaces::{
    agents, channels as channel, connectors as connector, plugins, providers as provider, security,
    settings, skills as skill, tasks as task_manager, team, tooling as toolchain, usage, workspace,
};
