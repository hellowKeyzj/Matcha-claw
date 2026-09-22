use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicU64, Ordering},
};

use foundation::execution::OwnedTask;
use tokio::sync::{Mutex, watch};

use crate::composition::{AdmissionState, HostAdmission, PeerHandle, RequestAdmission};
use ::diagnostics::{DiagnosticsArchiveProducer, DiagnosticsRequestAdmission};

#[derive(Clone)]
pub(in crate::composition::host) struct HostDiagnosticsArchive {
    admission: Arc<HostAdmission>,
    producer: DiagnosticsArchiveProducer,
    peer: PeerHandle,
    archive: Arc<Mutex<Option<Arc<ActiveDiagnosticsArchive>>>>,
}

struct ActiveDiagnosticsArchive {
    id: u64,
    completion: watch::Sender<
        Option<
            Result<
                ::diagnostics::DiagnosticsArchiveReceipt,
                ::diagnostics::DiagnosticsArchiveError,
            >,
        >,
    >,
    task: StdMutex<Option<OwnedTask<()>>>,
}

static NEXT_ARCHIVE_TASK_ID: AtomicU64 = AtomicU64::new(1);

impl HostDiagnosticsArchive {
    pub(in crate::composition::host) fn new(
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
}

impl ::diagnostics::DiagnosticsArchivePort for HostDiagnosticsArchive {
    fn collect_archive<'a>(
        &'a self,
        cancellation: ::diagnostics::DiagnosticsArchiveCancellation,
    ) -> ::diagnostics::DiagnosticsFuture<
        'a,
        Result<::diagnostics::DiagnosticsArchiveReceipt, ::diagnostics::DiagnosticsArchiveError>,
    > {
        Box::pin(async move {
            let active = {
                let mut archive = self.archive.lock().await;
                if let Some(active) = archive.as_ref() {
                    Arc::clone(active)
                } else {
                    self.admission
                        .admit_diagnostics_request()
                        .map_err(|_| ::diagnostics::DiagnosticsArchiveError::OutputUnavailable)?;
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
        })
    }

    fn download_archive<'a>(
        &'a self,
        archive_id: String,
    ) -> ::diagnostics::DiagnosticsFuture<'a, Result<Vec<u8>, ::diagnostics::DiagnosticsArchiveError>>
    {
        Box::pin(async move { self.producer.download(&archive_id) })
    }
}

impl ActiveDiagnosticsArchive {
    fn new() -> Self {
        let (completion, _) = watch::channel(None);
        Self {
            id: NEXT_ARCHIVE_TASK_ID.fetch_add(1, Ordering::Relaxed),
            completion,
            task: StdMutex::new(None),
        }
    }

    fn spawn(
        self: &Arc<Self>,
        archive: Arc<Mutex<Option<Arc<ActiveDiagnosticsArchive>>>>,
        mut admission_state: watch::Receiver<AdmissionState>,
        peer: PeerHandle,
        producer: DiagnosticsArchiveProducer,
        cancellation: ::diagnostics::DiagnosticsArchiveCancellation,
    ) {
        let id = self.id;
        let completion = self.completion.clone();
        let (task, _) = OwnedTask::spawn(move |task_cancellation| async move {
            let result = match peer.state().await {
                Ok(state) => {
                    let archive_cancellation = cancellation.clone();
                    let admission = producer.admit(state);
                    let mut collection = tokio::task::spawn_blocking(move || {
                        admission.collect(&archive_cancellation)
                    });
                    tokio::select! {
                        result = &mut collection => result.map_err(|_| ::diagnostics::DiagnosticsArchiveError::OutputUnavailable),
                        _ = wait_for_admission_closed(&mut admission_state) => {
                            cancellation.cancel();
                            collection.await.map_err(|_| ::diagnostics::DiagnosticsArchiveError::OutputUnavailable)
                        }
                        _ = task_cancellation.cancelled() => {
                            cancellation.cancel();
                            collection.await.map_err(|_| ::diagnostics::DiagnosticsArchiveError::OutputUnavailable)
                        }
                    }
                }
                Err(_) => Err(::diagnostics::DiagnosticsArchiveError::OutputUnavailable),
            };
            let mut current = archive.lock().await;
            if current.as_ref().is_some_and(|candidate| candidate.id == id) {
                *current = None;
            }
            drop(current);
            let _ = completion.send(Some(result));
        });
        *self
            .task
            .lock()
            .expect("diagnostics archive task lock poisoned") = Some(task);
    }

    async fn wait(
        &self,
    ) -> Result<::diagnostics::DiagnosticsArchiveReceipt, ::diagnostics::DiagnosticsArchiveError>
    {
        let mut completion = self.completion.subscribe();
        loop {
            let result = completion.borrow().clone();
            if let Some(result) = result {
                let mut task = self
                    .task
                    .lock()
                    .expect("diagnostics archive task lock poisoned")
                    .take();
                if let Some(task) = task.as_mut() {
                    let _ = task.join().await;
                }
                return result;
            }
            if completion.changed().await.is_err() {
                return Err(::diagnostics::DiagnosticsArchiveError::OutputUnavailable);
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
