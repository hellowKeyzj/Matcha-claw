use std::{error::Error, fmt};

use tokio::sync::mpsc;

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

pub struct TerminalProviderOpen {
    pub commands: mpsc::Sender<ProviderCommand>,
    pub events: TerminalStream,
}

#[derive(Clone, Debug)]
pub struct TerminalContext {
    pub session: fleet::terminal::SessionId,
    pub target: fleet::terminal::TargetId,
    pub provider: fleet::terminal::ProviderId,
    pub generation: fleet::terminal::Generation,
    pub node: fleet::topology::NodeId,
    pub endpoint: platform::endpoint::EndpointId,
    pub rows: u16,
    pub cols: u16,
}
