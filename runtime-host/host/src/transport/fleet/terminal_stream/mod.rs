#[allow(dead_code)]
mod handler;
#[allow(dead_code)]
mod protocol;
pub mod provider;

pub(crate) use handler::{HostTicketPort, ServerDependencies};
pub(crate) use handler::{
    PRIVATE_TERMINAL_WEBSOCKET_PATH, TERMINAL_WEBSOCKET_PATH, serve_upgrade, write_http_error,
};

pub use provider::NativeProvider;
