use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use crate::{
    SearchConfig, SearchError, SearchSnapshot, SearchVerification, SearchVerifyRequest,
    owner::{Command, Operation, Query},
};

#[derive(Clone)]
pub struct SearchModule {
    owner: OwnerRuntimeHandle<Command, Query>,
}

impl SearchModule {
    pub(crate) fn new(owner: OwnerRuntimeHandle<Command, Query>) -> Self {
        Self { owner }
    }

    pub async fn snapshot(&self) -> Result<SearchSnapshot, SearchError> {
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
    pub async fn start_saved(&self) -> Result<SearchSnapshot, SearchError> {
        self.operate(Operation::StartSaved).await
    }
    pub async fn reconcile(&self) -> Result<SearchSnapshot, SearchError> {
        self.operate(Operation::Reconcile).await
    }
    pub async fn shutdown(&self) -> Result<(), SearchError> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(Command::Shutdown(reply))
            .await
            .map_err(|_| SearchError::unavailable())?;
        response.await.map_err(|_| SearchError::unavailable())?
    }

    pub async fn verify(
        &self,
        request: SearchVerifyRequest,
    ) -> Result<SearchVerification, SearchError> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_query(Query::Verify(request, reply))
            .await
            .map_err(|_| SearchError::unavailable())?;
        response.await.map_err(|_| SearchError::unavailable())?
    }

    pub async fn logs(&self) -> Result<Vec<String>, SearchError> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_query(Query::Logs(reply))
            .await
            .map_err(|_| SearchError::unavailable())?;
        response.await.map_err(|_| SearchError::unavailable())
    }

    async fn operate(&self, operation: Operation) -> Result<SearchSnapshot, SearchError> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(Command::Operate { operation, reply })
            .await
            .map_err(|_| SearchError::unavailable())?;
        response.await.map_err(|_| SearchError::unavailable())?
    }
}
