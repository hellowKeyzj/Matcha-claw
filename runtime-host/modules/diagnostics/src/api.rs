use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use crate::{
    DiagnosticsArchiveError, DiagnosticsArchiveReceipt,
    application::commands::{DiagnosticsCommand, DiagnosticsQuery},
    ports::DiagnosticsArchiveCancellation,
};

#[derive(Clone)]
pub struct DiagnosticsHandle {
    owner: OwnerRuntimeHandle<DiagnosticsCommand, DiagnosticsQuery>,
}

impl DiagnosticsHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<DiagnosticsCommand, DiagnosticsQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn collect_archive(
        &self,
        cancellation: DiagnosticsArchiveCancellation,
    ) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
        self.request_command(|reply| DiagnosticsCommand::CollectArchive {
            cancellation,
            reply,
        })
        .await
        .unwrap_or(Err(DiagnosticsArchiveError::OutputUnavailable))
    }

    pub(crate) async fn download_archive(
        &self,
        archive_id: String,
    ) -> Result<Vec<u8>, DiagnosticsArchiveError> {
        self.request_query(|reply| DiagnosticsQuery::DownloadArchive { archive_id, reply })
            .await
            .unwrap_or(Err(DiagnosticsArchiveError::OutputUnavailable))
    }

    async fn request_command<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> DiagnosticsCommand,
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
        query: impl FnOnce(oneshot::Sender<T>) -> DiagnosticsQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner.send_query(query(reply)).await.map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
