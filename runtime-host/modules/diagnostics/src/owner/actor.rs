use std::sync::{Arc, Mutex};

use foundation::execution::{LaneRetention, OwnerSpec};
use tokio::{sync::oneshot, task::JoinSet};

use crate::{
    DiagnosticsArchiveError, DiagnosticsArchiveProducer, DiagnosticsArchiveReceipt,
    application::{
        call::{self, DiagnosticsCallDetail},
        commands::{DiagnosticsCommand, DiagnosticsOwnerKey, DiagnosticsQuery},
    },
    ports::{DiagnosticsArchiveCancellation, DiagnosticsRequestAdmission},
};

use super::archive::ArchiveCollection;

pub struct DiagnosticsOwnerInput {
    pub admission: Arc<dyn DiagnosticsRequestAdmission>,
    pub producer: crate::DiagnosticsArchiveProducer,
    pub host: Arc<dyn crate::DiagnosticsHostPort>,
}

#[derive(Clone)]
pub(crate) struct DiagnosticsShared {
    admission: Arc<dyn DiagnosticsRequestAdmission>,
    producer: DiagnosticsArchiveProducer,
    archive: ArchiveCollection,
    downloads: Arc<Mutex<JoinSet<()>>>,
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
                producer: input.producer,
                archive: ArchiveCollection::new(input.host),
                downloads: Arc::new(Mutex::new(JoinSet::new())),
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
                call,
                observation,
                cancellation,
                reply,
            } => {
                let result = if call::running(call.as_ref()).await.is_err() {
                    Err(DiagnosticsArchiveError::OutputUnavailable)
                } else {
                    collect_archive(&shared, cancellation).await
                };
                call::observe_collection(&observation, &result);
                call::finish_collection(call.as_ref(), &result).await;
                let _ = reply.send(result);
            }
        }
    }

    async fn handle_direct_query(shared: Self::Shared, query: Self::Query) {
        match query {
            DiagnosticsQuery::DownloadArchive {
                call,
                archive_id,
                reply,
            } => {
                let mut detail = DiagnosticsCallDetail::download(&archive_id);
                let result = if call::running(call.as_ref()).await.is_err() {
                    Err(DiagnosticsArchiveError::OutputUnavailable)
                } else {
                    download_archive(&shared, archive_id).await
                };
                let status = match &result {
                    Ok(image) => {
                        if let DiagnosticsCallDetail::DownloadArchive { bytes, .. } = &mut detail {
                            *bytes = Some(image.len() as u64);
                        }
                        platform::call::CallStatus::Succeeded
                    }
                    Err(error) => {
                        detail = detail.failed((*error).into());
                        platform::call::CallStatus::Failed
                    }
                };
                call::finish(call.as_ref(), status, &detail).await;
                let _ = reply.send(result);
            }
        }
    }

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _query: Self::Query,
    ) {
    }

    async fn handle_global_query(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _query: Self::Query,
    ) {
    }

    async fn handle_exclusive_query(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _query: Self::Query,
    ) {
    }

    async fn shutdown(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _lanes: Vec<(Self::Key, Self::LaneState)>,
    ) {
        let mut downloads = {
            let mut downloads = shared
                .downloads
                .lock()
                .expect("diagnostics download task lock poisoned");
            std::mem::take(&mut *downloads)
        };
        while downloads.join_next().await.is_some() {}
    }
}

async fn collect_archive(
    shared: &DiagnosticsShared,
    cancellation: DiagnosticsArchiveCancellation,
) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
    shared
        .archive
        .collect(shared.admission.as_ref(), &shared.producer, cancellation)
        .await
}

async fn download_archive(
    shared: &DiagnosticsShared,
    archive_id: String,
) -> Result<Vec<u8>, DiagnosticsArchiveError> {
    if shared.admission.admit_diagnostics_request().is_err() {
        return Err(DiagnosticsArchiveError::OutputUnavailable);
    }
    let producer = shared.producer.clone();
    let (reply, response) = oneshot::channel();
    {
        let mut downloads = shared
            .downloads
            .lock()
            .expect("diagnostics download task lock poisoned");
        while downloads.try_join_next().is_some() {}
        downloads.spawn_blocking(move || {
            let _ = reply.send(producer.download(&archive_id));
        });
    }
    let result = response
        .await
        .unwrap_or(Err(DiagnosticsArchiveError::OutputUnavailable));
    {
        let mut downloads = shared
            .downloads
            .lock()
            .expect("diagnostics download task lock poisoned");
        while downloads.try_join_next().is_some() {}
    }
    result
}
