use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use crate::{
    PrepareOutcome, ToolchainRequestAdmissionClosed, ToolchainStatus,
    application::commands::{ToolchainCommand, ToolchainQuery},
};

#[derive(Clone)]
pub struct ToolchainModule {
    owner: OwnerRuntimeHandle<ToolchainCommand, ToolchainQuery>,
}

impl ToolchainModule {
    pub(crate) fn new(owner: OwnerRuntimeHandle<ToolchainCommand, ToolchainQuery>) -> Self {
        Self { owner }
    }

    pub async fn status(
        &self,
    ) -> Result<Result<ToolchainStatus, ToolchainRequestAdmissionClosed>, ()> {
        self.request_query(|reply| ToolchainQuery::Status { reply })
            .await
    }

    pub async fn prepare(
        &self,
    ) -> Result<Result<PrepareOutcome, ToolchainRequestAdmissionClosed>, ()> {
        self.request_command(|reply| ToolchainCommand::Prepare { reply })
            .await
    }

    async fn request_command<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> ToolchainCommand,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(command(reply))
            .await
            .map_err(|_| ())?;
        response.await.map_err(|_| ())
    }

    async fn request_query<T>(
        &self,
        query: impl FnOnce(oneshot::Sender<T>) -> ToolchainQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner.send_query(query(reply)).await.map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
