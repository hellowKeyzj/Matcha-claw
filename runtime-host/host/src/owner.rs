mod actor;
#[cfg(test)]
mod tests;

use std::{
    fmt,
    sync::{Arc, RwLock},
};

use tokio::{
    sync::{mpsc, oneshot},
    task::JoinError,
};

use crate::{
    Host, HostShutdownError, HostState, ShutdownReport,
    composition::{HostEvent, HostEvents},
};
use foundation::execution::OwnedTask;

const EVENT_CAPACITY: usize = 256;
const SHUTDOWN_CAPACITY: usize = 1;

type ActorExit = Result<(), HostShutdownError>;
pub(super) type ShutdownRequest = oneshot::Sender<ShutdownAttempt>;

pub(crate) struct Owner {
    handle: Option<Handle>,
    task: OwnedTask<ActorExit>,
    events: Option<mpsc::Receiver<HostEvent>>,
}

#[derive(Clone)]
pub(crate) struct HostReadHandle {
    state: Arc<RwLock<HostState>>,
}

#[derive(Clone)]
pub(crate) struct HostStatePublisher {
    state: Arc<RwLock<HostState>>,
}

#[derive(Clone)]
pub(crate) struct Handle {
    shutdown: mpsc::Sender<ShutdownRequest>,
    #[cfg_attr(test, allow(dead_code))]
    state: Option<HostReadHandle>,
}

pub(crate) struct ShutdownAttempt {
    pub(crate) result: Result<ShutdownReport, HostShutdownError>,
    pub(crate) terminal: bool,
}

impl Owner {
    pub(crate) fn spawn(host: Host, events: HostEvents) -> Self {
        let (shutdown, shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
        let (output, output_receiver) = mpsc::channel(EVENT_CAPACITY);
        let (state, publisher) = HostReadHandle::new(host.state());
        let handle = Handle {
            shutdown,
            state: Some(state),
        };
        let (task, _) =
            OwnedTask::spawn(|_| actor::run(host, events, shutdown_receiver, output, publisher));
        Self {
            handle: Some(handle),
            task,
            events: Some(output_receiver),
        }
    }

    pub(crate) fn take_events(&mut self) -> Option<mpsc::Receiver<HostEvent>> {
        self.events.take()
    }

    pub(crate) fn handle(&self) -> Handle {
        self.handle
            .as_ref()
            .expect("Host owner handle must remain until terminal shutdown")
            .clone()
    }

    pub(crate) async fn join(&mut self) -> Result<ActorExit, Error> {
        self.handle.take();
        (&mut self.task).await.map_err(Error::Join)
    }
}

impl HostReadHandle {
    fn new(state: HostState) -> (Self, HostStatePublisher) {
        let state = Arc::new(RwLock::new(state));
        (
            Self {
                state: Arc::clone(&state),
            },
            HostStatePublisher { state },
        )
    }

    pub(crate) fn state(&self) -> HostState {
        *self
            .state
            .read()
            .expect("host lifecycle read state lock poisoned")
    }
}

impl HostStatePublisher {
    fn publish(&self, state: HostState) {
        *self
            .state
            .write()
            .expect("host lifecycle read state lock poisoned") = state;
    }
}

impl Handle {
    pub(crate) fn state(&self) -> HostState {
        self.state
            .as_ref()
            .expect("Host read state must be present on spawned owner handles")
            .state()
    }

    pub(crate) async fn shutdown(&self) -> Result<ShutdownAttempt, Error> {
        let (reply, response) = oneshot::channel();
        self.shutdown
            .send(reply)
            .await
            .map_err(|_| Error::CommandChannelClosed)?;
        response.await.map_err(|_| Error::ResponseChannelClosed)
    }
}

pub(crate) enum Error {
    CommandChannelClosed,
    ResponseChannelClosed,
    Join(JoinError),
}

impl fmt::Debug for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CommandChannelClosed => {
                formatter.write_str("Host owner is not accepting lifecycle requests")
            }
            Self::ResponseChannelClosed => {
                formatter.write_str("Host owner stopped before returning a lifecycle response")
            }
            Self::Join(error) => write!(formatter, "Host owner task failed: {error}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Join(error) => Some(error),
            Self::CommandChannelClosed | Self::ResponseChannelClosed => None,
        }
    }
}
