use std::{error::Error, fmt, future::Future, pin::Pin};

use tokio::sync::mpsc;

use super::server::TerminalContext;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCommand {
    Input(Vec<u8>),
    Resize { rows: u16, cols: u16 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderEvent {
    Output(Vec<u8>),
    Exit { code: Option<i32> },
}

#[derive(Debug)]
pub struct ProviderError(pub Box<dyn Error + Send + Sync>);

impl ProviderError {
    pub fn message(message: &'static str) -> Self {
        Self(message.into())
    }
}
impl fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("fleet terminal provider failed")
    }
}
impl Error for ProviderError {}

pub type TerminalStream = mpsc::Receiver<Result<ProviderEvent, ProviderError>>;
pub type ProviderFuture =
    Pin<Box<dyn Future<Output = Result<TerminalProviderOpen, ProviderError>> + Send>>;

pub struct TerminalProviderOpen {
    pub commands: mpsc::Sender<ProviderCommand>,
    pub events: TerminalStream,
}

pub trait TerminalProvider: Send + Sync + 'static {
    fn open(&self, context: TerminalContext) -> ProviderFuture;
}

/// Native Fleet provider composition. Target configuration and trust material are
/// captured from the Fleet owner; credentials are resolved only while opening.
///
/// This snapshot must be rebuilt by composition after target mutations; a terminal
/// session never falls back to public request configuration.
pub struct NativeProvider {
    owner: crate::fleet::handle::FleetHandle,
}

impl NativeProvider {
    pub fn new(owner: crate::fleet::handle::FleetHandle) -> Self {
        Self { owner }
    }
}

impl TerminalProvider for NativeProvider {
    fn open(&self, context: TerminalContext) -> ProviderFuture {
        let owner = self.owner.clone();
        Box::pin(async move {
            owner
                .terminal_provider_open(context)
                .await
                .map_err(|_| ProviderError::message("fleet terminal provider unavailable"))
        })
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
