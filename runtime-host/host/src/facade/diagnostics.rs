use std::sync::Arc;

use tokio::sync::{Mutex, watch};

use crate::{
    composition::{AdmissionState, HostAdmission, PeerHandle, RequestAdmission},
    diagnostics::{
        DiagnosticsArchiveCancellation, DiagnosticsArchiveError, DiagnosticsArchiveProducer,
        DiagnosticsArchiveReceipt,
    },
};

#[derive(Clone)]
pub(crate) struct DiagnosticsHandle {
    admission: Arc<HostAdmission>,
    producer: DiagnosticsArchiveProducer,
    peer: PeerHandle,
    archive: Arc<Mutex<Option<Arc<ActiveDiagnosticsArchive>>>>,
}

struct ActiveDiagnosticsArchive {
    completion: watch::Sender<Option<Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError>>>,
}

impl ActiveDiagnosticsArchive {
    fn new() -> Self {
        let (completion, _) = watch::channel(None);
        Self { completion }
    }

    fn spawn(
        self: &Arc<Self>,
        archive: Arc<Mutex<Option<Arc<ActiveDiagnosticsArchive>>>>,
        mut admission_state: watch::Receiver<AdmissionState>,
        peer: PeerHandle,
        producer: DiagnosticsArchiveProducer,
        cancellation: DiagnosticsArchiveCancellation,
    ) {
        let active = Arc::clone(self);
        tokio::spawn(async move {
            let result = match peer.state().await {
                Ok(state) => {
                    let archive_cancellation = cancellation.clone();
                    let admission = producer.admit(state);
                    let mut collection = tokio::task::spawn_blocking(move || {
                        admission.collect(&archive_cancellation)
                    });
                    tokio::select! {
                        result = &mut collection => {
                            result.map_err(|_| DiagnosticsArchiveError::OutputUnavailable)
                        }
                        _ = wait_for_admission_closed(&mut admission_state) => {
                            cancellation.cancel();
                            collection.await.map_err(|_| DiagnosticsArchiveError::OutputUnavailable)
                        }
                    }
                }
                Err(_) => Err(DiagnosticsArchiveError::OutputUnavailable),
            };
            let mut current = archive.lock().await;
            if current
                .as_ref()
                .is_some_and(|candidate| Arc::ptr_eq(candidate, &active))
            {
                *current = None;
            }
            drop(current);
            let _ = active.completion.send(Some(result));
        });
    }

    async fn wait(&self) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
        let mut completion = self.completion.subscribe();
        loop {
            if let Some(result) = completion.borrow().clone() {
                return result;
            }
            if completion.changed().await.is_err() {
                return Err(DiagnosticsArchiveError::OutputUnavailable);
            }
        }
    }
}

async fn wait_for_admission_closed(admission: &mut watch::Receiver<AdmissionState>) {
    loop {
        if admission.borrow().request_admission() == RequestAdmission::Closed {
            return;
        }
        if admission.changed().await.is_err() {
            return;
        }
    }
}

impl DiagnosticsHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        producer: DiagnosticsArchiveProducer,
        peer: PeerHandle,
    ) -> Self {
        Self {
            admission,
            producer,
            peer,
            archive: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) async fn collect_archive(
        &self,
        cancellation: DiagnosticsArchiveCancellation,
    ) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
        let active = {
            let mut archive = self.archive.lock().await;
            if let Some(active) = archive.as_ref() {
                Arc::clone(active)
            } else {
                self.admission
                    .admit_request()
                    .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
                let active = Arc::new(ActiveDiagnosticsArchive::new());
                *archive = Some(Arc::clone(&active));
                active.spawn(
                    Arc::clone(&self.archive),
                    self.admission.subscribe(),
                    self.peer.clone(),
                    self.producer.clone(),
                    cancellation,
                );
                active
            }
        };
        active.wait().await
    }

    pub(crate) async fn download_archive(
        &self,
        archive_id: String,
    ) -> Result<Vec<u8>, DiagnosticsArchiveError> {
        self.admission
            .admit_request()
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        self.producer.download(&archive_id)
    }
}
