pub(crate) mod abort;
pub(crate) mod actor;
pub(crate) mod approval;
#[allow(dead_code)]
pub(crate) mod command;
pub(crate) mod create;
pub(crate) mod delete;
pub(crate) mod endpoint;
pub(crate) mod events;
#[allow(dead_code)]
pub(crate) mod handle;
pub(crate) mod matcha;
#[allow(dead_code)]
pub(crate) mod matcha_history;
#[allow(dead_code)]
pub(crate) mod matcha_session_catalog;
#[allow(dead_code)]
pub(crate) mod model_selection;
pub(crate) mod openclaw;
pub(crate) mod openclaw_direct;
#[allow(dead_code)]
pub(crate) mod query;
pub(crate) mod rename;
pub(crate) mod runtime_error;
#[allow(dead_code)]
pub(crate) mod send;
pub(crate) mod send_hook;
#[allow(dead_code)]
pub(crate) mod session_permission;
#[allow(dead_code)]
pub(crate) mod state;
pub(crate) mod terminal_hook;
#[allow(dead_code)]
pub(crate) mod timeline;

pub(crate) use handle::SessionHandle;
pub use runtime_error::RuntimeSessionError;
pub(crate) use terminal_hook::{SessionRunTerminalSnapshot, SessionTerminalHook};

#[cfg(test)]
mod actor_tests;
