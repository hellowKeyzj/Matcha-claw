use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};

use crate::{
    DiagnosticsArchiveError, DiagnosticsArchiveReceipt,
    application::commands::{DiagnosticsCommand, DiagnosticsOwnerKey, DiagnosticsQuery},
    ports::{DiagnosticsArchiveCancellation, DiagnosticsArchivePort, DiagnosticsRequestAdmission},
};

pub struct DiagnosticsOwnerInput {
    pub admission: Arc<dyn DiagnosticsRequestAdmission>,
    pub archive: Arc<dyn DiagnosticsArchivePort>,
}

#[derive(Clone)]
pub(crate) struct DiagnosticsShared {
    admission: Arc<dyn DiagnosticsRequestAdmission>,
    archive: Arc<dyn DiagnosticsArchivePort>,
}

pub(crate) struct DiagnosticsGlobalState;
pub(crate) struct DiagnosticsLaneState;

pub(crate) struct DiagnosticsOwner {
    shared: DiagnosticsShared,
}

impl DiagnosticsOwner {
    pub fn new(input: DiagnosticsOwnerInput) -> Self {
        Self {
            shared: DiagnosticsShared {
                admission: input.admission,
                archive: input.archive,
            },
        }
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for DiagnosticsOwner {
    type Command = DiagnosticsCommand;
    type Query = DiagnosticsQuery;
    type Key = DiagnosticsOwnerKey;
    type Shared = DiagnosticsShared;
    type GlobalState = DiagnosticsGlobalState;
    type LaneState = DiagnosticsLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, DiagnosticsGlobalState)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        DiagnosticsLaneState
    }

    async fn handle_keyed_command(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _command: Self::Command,
    ) {
    }

    async fn handle_global_command(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            DiagnosticsCommand::CollectArchive {
                cancellation,
                reply,
            } => {
                let _ = reply.send(collect_archive(&shared, cancellation).await);
            }
        }
    }

    async fn handle_direct_query(_shared: Self::Shared, _query: Self::Query) {}

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _query: Self::Query,
    ) {
    }

    async fn handle_global_query(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        match query {
            DiagnosticsQuery::DownloadArchive { archive_id, reply } => {
                let _ = reply.send(download_archive(&shared, archive_id).await);
            }
        }
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        Self::handle_global_query(shared, global, query).await;
    }
}

async fn collect_archive(
    shared: &DiagnosticsShared,
    cancellation: DiagnosticsArchiveCancellation,
) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
    shared.archive.collect_archive(cancellation).await
}

async fn download_archive(
    shared: &DiagnosticsShared,
    archive_id: String,
) -> Result<Vec<u8>, DiagnosticsArchiveError> {
    if shared.admission.admit_diagnostics_request().is_err() {
        return Err(DiagnosticsArchiveError::OutputUnavailable);
    }
    shared.archive.download_archive(archive_id).await
}
