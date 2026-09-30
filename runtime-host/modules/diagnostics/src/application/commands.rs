use platform::call::CallContext;
use tokio::sync::oneshot;

use super::call::DiagnosticsCallDetail;

use crate::{
    DiagnosticsArchiveError, DiagnosticsArchiveReceipt, ports::DiagnosticsArchiveCancellation,
};

pub(crate) enum DiagnosticsCommand {
    CollectArchive {
        observation: foundation::execution::ObservationSink,
        call: Option<CallContext<DiagnosticsCallDetail>>,
        cancellation: DiagnosticsArchiveCancellation,
        reply: oneshot::Sender<Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError>>,
    },
}

pub(crate) enum DiagnosticsQuery {
    DownloadArchive {
        call: Option<CallContext<DiagnosticsCallDetail>>,
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
