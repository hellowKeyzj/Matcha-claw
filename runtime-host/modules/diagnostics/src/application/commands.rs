use tokio::sync::oneshot;

use crate::{
    DiagnosticsArchiveError, DiagnosticsArchiveReceipt, ports::DiagnosticsArchiveCancellation,
};

pub(crate) enum DiagnosticsCommand {
    CollectArchive {
        cancellation: DiagnosticsArchiveCancellation,
        reply: oneshot::Sender<Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError>>,
    },
}

pub(crate) enum DiagnosticsQuery {
    DownloadArchive {
        archive_id: String,
        reply: oneshot::Sender<Result<Vec<u8>, DiagnosticsArchiveError>>,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum DiagnosticsOwnerKey {}

impl DiagnosticsCommand {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<DiagnosticsOwnerKey> {
        foundation::execution::CommandRoute::Global
    }
}

impl DiagnosticsQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<DiagnosticsOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
