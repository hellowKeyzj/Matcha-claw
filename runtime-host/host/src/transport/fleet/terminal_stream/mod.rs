#[allow(dead_code)]
mod protocol;
pub mod provider;
#[allow(dead_code)]
mod server;

pub(crate) use server::{HostTicketPort, ServerDependencies};
pub(crate) use server::{
    PRIVATE_TERMINAL_WEBSOCKET_PATH, TERMINAL_WEBSOCKET_PATH, serve_upgrade, write_http_error,
};

pub use provider::NativeProvider;
