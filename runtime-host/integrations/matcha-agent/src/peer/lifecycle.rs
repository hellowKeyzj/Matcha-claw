use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use foundation::process::{
    ShutdownOutcome,
    supervision::{
        CommandReceipt, RestartOutcome, StartOutcome, Supervisor, SupervisorHandle,
        SupervisorSnapshot, TerminationCompletion,
    },
};

use super::{JoinError, LifecycleError, ShutdownError};
use crate::client::Client;

pub struct MatchaPeer {
    handle: SupervisorHandle,
    supervisor: Supervisor,
    native: Client,
    search: crate::search::OfflineControl,
    source_epoch: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct MatchaPeerLifecycleHandle {
    handle: SupervisorHandle,
    source_epoch: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct MatchaPeerSessionHandle {
    native: Client,
    source_epoch: Arc<AtomicU64>,
}

impl MatchaPeer {
    pub(super) fn new(
        handle: SupervisorHandle,
        supervisor: Supervisor,
        _working_directory: PathBuf,
        native: Client,
        search: crate::search::OfflineControl,
    ) -> Self {
        Self {
            handle,
            supervisor,
            native,
            search,
            source_epoch: Arc::new(AtomicU64::new(1)),
        }
    }

    pub(crate) fn search_control(&self) -> crate::search::OfflineControl {
        self.search.clone()
    }

    pub fn native_client(&self) -> Client {
        self.native.clone()
    }

    pub fn session_handle(&self) -> MatchaPeerSessionHandle {
        MatchaPeerSessionHandle {
            native: self.native_client(),
            source_epoch: Arc::clone(&self.source_epoch),
        }
    }

    pub fn lifecycle_handle(&self) -> MatchaPeerLifecycleHandle {
        MatchaPeerLifecycleHandle {
            handle: self.handle.clone(),
            source_epoch: Arc::clone(&self.source_epoch),
        }
    }

    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.handle.snapshot()
    }
    pub fn advance_source_epoch(&self) -> u64 {
        self.lifecycle_handle().advance_source_epoch()
    }
    pub async fn request_start(&self) -> Result<(), LifecycleError> {
        self.lifecycle_handle().request_start().await
    }
    pub async fn start(&self) -> Result<StartOutcome, LifecycleError> {
        self.lifecycle_handle().start().await
    }
    pub async fn stop(&self) -> Result<TerminationCompletion, LifecycleError> {
        self.lifecycle_handle().stop().await
    }
    pub async fn restart(&self) -> Result<RestartOutcome, LifecycleError> {
        self.lifecycle_handle().restart().await
    }

    pub async fn confirm_shutdown(&self) -> Result<ShutdownOutcome, ShutdownError> {
        let outcome = match self.handle.shutdown().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.map_err(ShutdownError::from)
            }
            CommandReceipt::AlreadySatisfied => match self.handle.snapshot().last_outcome() {
                Some(foundation::process::supervision::SupervisorOutcome::ShutDown(outcome)) => {
                    Ok(outcome.clone())
                }
                _ => Err(ShutdownError::MissingOutcome),
            },
            CommandReceipt::Busy => Err(ShutdownError::Busy),
            CommandReceipt::Rejected(rejection) => Err(ShutdownError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(ShutdownError::ShuttingDown),
        };
        let cleanup = self.native.shutdown().await;
        if cleanup.is_err() {
            platform::trace::runtime_trace(
                "matcha.peer.shutdown.cleanup_failed",
                || serde_json::json!({"supervisorFailed":outcome.is_err(),"transportFailed":true}),
            );
        }
        let outcome = outcome?;
        cleanup.map_err(|_| ShutdownError::CompletionFailed)?;
        Ok(outcome)
    }

    pub async fn join(mut self) -> Result<(), JoinError> {
        let result = self.supervisor.join().await.map_err(JoinError::from);
        let cleanup = self.native.shutdown().await;
        if cleanup.is_err() {
            platform::trace::runtime_trace(
                "matcha.peer.join.cleanup_failed",
                || serde_json::json!({"supervisorFailed":result.is_err(),"transportFailed":true}),
            );
        }
        result?;
        cleanup.map_err(|_| JoinError::TransportCleanup)
    }
}

impl MatchaPeerSessionHandle {
    pub fn native_client(&self) -> Client {
        self.native.clone()
    }
    pub(crate) fn observer_source_epoch(&self) -> u64 {
        self.source_epoch.fetch_add(1, Ordering::Relaxed) + 1
    }
}

impl MatchaPeerLifecycleHandle {
    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.handle.snapshot()
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.handle.subscribe()
    }
    pub fn advance_source_epoch(&self) -> u64 {
        self.source_epoch.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn request_start(&self) -> Result<(), LifecycleError> {
        match self.handle.start().await {
            CommandReceipt::Accepted(_)
            | CommandReceipt::Shared(_)
            | CommandReceipt::AlreadySatisfied => Ok(()),
            CommandReceipt::Busy => Err(LifecycleError::Busy),
            CommandReceipt::Rejected(rejection) => Err(LifecycleError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(LifecycleError::ShuttingDown),
        }
    }

    pub async fn start(&self) -> Result<StartOutcome, LifecycleError> {
        match self.handle.start().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.map_err(LifecycleError::from)
            }
            CommandReceipt::AlreadySatisfied => Ok(StartOutcome::Started),
            CommandReceipt::Busy => Err(LifecycleError::Busy),
            CommandReceipt::Rejected(rejection) => Err(LifecycleError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(LifecycleError::ShuttingDown),
        }
    }

    pub async fn stop(&self) -> Result<TerminationCompletion, LifecycleError> {
        match self.handle.stop().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.map_err(LifecycleError::from)
            }
            CommandReceipt::AlreadySatisfied => Err(LifecycleError::AlreadySatisfied),
            CommandReceipt::Busy => Err(LifecycleError::Busy),
            CommandReceipt::Rejected(rejection) => Err(LifecycleError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(LifecycleError::ShuttingDown),
        }
    }

    pub async fn restart(&self) -> Result<RestartOutcome, LifecycleError> {
        match self.handle.restart().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.map_err(LifecycleError::from)
            }
            CommandReceipt::AlreadySatisfied => Err(LifecycleError::AlreadySatisfied),
            CommandReceipt::Busy => Err(LifecycleError::Busy),
            CommandReceipt::Rejected(rejection) => Err(LifecycleError::Rejected(rejection)),
            CommandReceipt::ShuttingDown => Err(LifecycleError::ShuttingDown),
        }
    }
}
