use foundation::{
    execution::{OwnedTask, OwnerRuntimeHandle},
    lifecycle::ModuleScope,
};
use tokio::sync::oneshot;

use crate::{
    SearchConfig, SearchError, SearchSnapshot, SearchVerification, SearchVerifyRequest,
    owner::{Command, Operation, Query, Shared},
    ports::SearchLifecycleSource,
};

#[derive(Clone)]
pub struct SearchModule {
    owner: OwnerRuntimeHandle<Command, Query>,
    shared: Shared,
}

impl SearchModule {
    pub(crate) fn new(owner: OwnerRuntimeHandle<Command, Query>, shared: Shared) -> Self {
        Self { owner, shared }
    }

    pub fn observe_runtime_changes(
        &self,
        scope: &mut ModuleScope,
        mut source: Box<dyn SearchLifecycleSource>,
    ) {
        let search = self.clone();
        let (mut task, _) = OwnedTask::spawn(|cancellation| async move {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                ready = source.wait_ready() => if !ready { return; },
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                initialized = search.shared.wait_initialized() => {
                    if initialized.is_err() { return; }
                }
            }
            // Host may have shut down while storage was opening.
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                ready = source.wait_ready() => if !ready { return; },
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                result = search.start_saved() => {
                    if result.is_err() { eprintln!("[search] automatic startup failed"); }
                }
            }
            loop {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return,
                    changed = source.changed() => if !changed { return; },
                }
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return,
                    result = search.reconcile() => {
                        if result.is_err() { eprintln!("[search] native integration reconciliation failed"); }
                    }
                }
            }
        });
        let shared = self.shared.clone();
        scope.register_event_subscription("search-runtime-lifecycle", move || async move {
            shared.begin_shutdown();
            let _ = task.cancel_and_join().await;
        });
    }

    pub async fn snapshot(&self) -> Result<SearchSnapshot, SearchError> {
        self.shared.check_initialized()?;
        let (reply, response) = oneshot::channel();
        self.owner
            .send_query(Query::Snapshot(reply))
            .await
            .map_err(|_| SearchError::unavailable())?;
        response.await.map_err(|_| SearchError::unavailable())?
    }

    pub async fn replace_config(
        &self,
        expected_revision: u64,
        config: SearchConfig,
    ) -> Result<SearchSnapshot, SearchError> {
        self.shared.check_initialized()?;
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(Command::Replace {
                expected_revision,
                config,
                reply,
            })
            .await
            .map_err(|_| SearchError::unavailable())?;
        response.await.map_err(|_| SearchError::unavailable())?
    }

    pub async fn prepare(&self) -> Result<SearchSnapshot, SearchError> {
        self.operate(Operation::Prepare).await
    }
    pub async fn restart(&self) -> Result<SearchSnapshot, SearchError> {
        self.operate(Operation::Restart).await
    }
    pub async fn stop(&self) -> Result<SearchSnapshot, SearchError> {
        self.operate(Operation::Stop).await
    }
    async fn start_saved(&self) -> Result<SearchSnapshot, SearchError> {
        self.operate(Operation::StartSaved).await
    }
    async fn reconcile(&self) -> Result<SearchSnapshot, SearchError> {
        self.operate(Operation::Reconcile).await
    }
    pub async fn verify(
        &self,
        request: SearchVerifyRequest,
    ) -> Result<SearchVerification, SearchError> {
        self.shared.check_initialized()?;
        let (reply, response) = oneshot::channel();
        self.owner
            .send_query(Query::Verify(request, reply))
            .await
            .map_err(|_| SearchError::unavailable())?;
        response.await.map_err(|_| SearchError::unavailable())?
    }

    pub async fn logs(&self) -> Result<Vec<String>, SearchError> {
        self.shared.check_accepting()?;
        let (reply, response) = oneshot::channel();
        self.owner
            .send_query(Query::Logs(reply))
            .await
            .map_err(|_| SearchError::unavailable())?;
        response.await.map_err(|_| SearchError::unavailable())
    }

    async fn operate(&self, operation: Operation) -> Result<SearchSnapshot, SearchError> {
        self.shared.check_initialized()?;
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(Command::Operate { operation, reply })
            .await
            .map_err(|_| SearchError::unavailable())?;
        response.await.map_err(|_| SearchError::unavailable())?
    }
}
