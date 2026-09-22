use std::{future::Future, pin::Pin, sync::Arc};

use tokio::sync::mpsc;

pub type ProviderCommand = crate::application::terminal::ProviderCommand;
pub type ProviderError = crate::application::terminal::ProviderError;
pub type ProviderEvent = crate::application::terminal::ProviderEvent;
pub type ProviderOpen = crate::application::terminal::TerminalProviderOpen;
pub type ProviderStream = crate::application::terminal::TerminalStream;
pub type TerminalContext = crate::application::terminal::TerminalContext;

pub type ProviderFuture = Pin<Box<dyn Future<Output = Result<ProviderOpen, ProviderError>> + Send>>;

pub trait TerminalProvider: Send + Sync + 'static {
    fn open(&self, context: TerminalContext) -> ProviderFuture;
}

pub type ProviderOpenFuture = Pin<Box<dyn Future<Output = Result<ProviderOpen, ()>> + Send>>;

pub trait FleetTerminalProviderPort: Send + Sync + 'static {
    fn open_terminal_provider(&self, context: TerminalContext) -> ProviderOpenFuture;
}

/// Fleet owner adapter for terminal provider effects. Target configuration and
/// trust material are captured by the owner; credentials are resolved only while
/// opening.
///
/// This adapter never accepts public target configuration and never exposes raw
/// provider stderr/native state across the terminal stream.
pub struct NativeProvider<P> {
    port: Arc<P>,
}

impl<P> NativeProvider<P> {
    pub fn new(port: Arc<P>) -> Self {
        Self { port }
    }
}

impl<P> TerminalProvider for NativeProvider<P>
where
    P: FleetTerminalProviderPort,
{
    fn open(&self, context: TerminalContext) -> ProviderFuture {
        let port = Arc::clone(&self.port);
        Box::pin(async move {
            port.open_terminal_provider(context)
                .await
                .map_err(|_| ProviderError::message("fleet terminal provider unavailable"))
        })
    }
}

impl FleetTerminalProviderPort for crate::owner::handle::FleetHandle {
    fn open_terminal_provider(&self, context: TerminalContext) -> ProviderOpenFuture {
        let owner = self.clone();
        Box::pin(async move { owner.terminal_provider_open(context).await })
    }
}

pub struct TerminalProviderHandle {
    commands: Option<mpsc::Sender<ProviderCommand>>,
}

impl TerminalProviderHandle {
    pub fn new(commands: mpsc::Sender<ProviderCommand>) -> Self {
        Self {
            commands: Some(commands),
        }
    }

    pub async fn send(&self, command: ProviderCommand) -> Result<(), ProviderError> {
        self.commands
            .as_ref()
            .ok_or_else(|| ProviderError::message("provider handle is closed"))?
            .send(command)
            .await
            .map_err(|_| ProviderError::message("provider command channel is closed"))
    }

    pub async fn close(&mut self) {
        let _ = self.commands.take();
    }
}

impl Drop for TerminalProviderHandle {
    fn drop(&mut self) {
        let _ = self.commands.take();
    }
}
