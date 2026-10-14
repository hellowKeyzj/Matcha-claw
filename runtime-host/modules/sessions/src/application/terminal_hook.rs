use std::{future::Future, pin::Pin};

use tokio_util::sync::CancellationToken;

use super::state::{RunPhase, SessionSourceBinding};

#[derive(Clone, Debug)]
pub struct SessionRunTerminalSnapshot {
    pub identity: crate::state::SessionIdentity,
    pub source_binding: SessionSourceBinding,
    pub native_run_id: String,
    pub delivery_context: Option<super::state::SessionDeliveryContext>,
    pub phase: RunPhase,
    pub assistant_texts: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionTerminalCloseError {
    Join,
    Unsettled,
}

impl std::fmt::Display for SessionTerminalCloseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Join => "session terminal delivery join failed",
            Self::Unsettled => "session terminal deliveries remain unsettled",
        })
    }
}

impl std::error::Error for SessionTerminalCloseError {}

pub trait SessionTerminalHook: Send + Sync {
    fn run_terminal_async<'a>(
        &'a self,
        snapshot: SessionRunTerminalSnapshot,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<(), SessionRunTerminalSnapshot>> + Send + 'a>>;
}
