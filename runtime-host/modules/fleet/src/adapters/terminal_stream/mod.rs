#[allow(dead_code)]
mod handler;
#[allow(dead_code)]
mod protocol;
pub mod provider;

pub use handler::{FleetTerminalTicketPort, ServerDependencies};
pub use handler::{
    HostTicketPort, PRIVATE_TERMINAL_WEBSOCKET_PATH, TERMINAL_WEBSOCKET_PATH, TicketError,
    TicketPort, serve_upgrade, write_http_error,
};
pub use provider::{
    FleetTerminalProviderPort, NativeProvider, ProviderError, ProviderEvent, ProviderFuture,
    ProviderOpen, ProviderStream, TerminalContext, TerminalProvider, TerminalProviderHandle,
};
