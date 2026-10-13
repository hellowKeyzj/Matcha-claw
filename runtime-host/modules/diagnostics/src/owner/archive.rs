use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicU64, Ordering},
};

use foundation::execution::OwnedTask;
use tokio::sync::{Mutex, watch};

use crate::{
    DiagnosticsArchiveCancellation, DiagnosticsArchiveError, DiagnosticsArchiveProducer,
    DiagnosticsArchiveReceipt, DiagnosticsFuture, DiagnosticsHostPort, DiagnosticsRequestAdmission,
};

#[derive(Clone)]
pub(super) struct ArchiveCollection {
    host: Arc<dyn DiagnosticsHostPort>,
    active: Arc<Mutex<Option<Arc<ActiveArchive>>>>,
}

struct ActiveArchive {
    id: u64,
    completion: watch::Sender<Option<Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError>>>,
    task: StdMutex<Option<OwnedTask<()>>>,
}

static NEXT_ARCHIVE_TASK_ID: AtomicU64 = AtomicU64::new(1);

impl ArchiveCollection {
    pub(super) fn new(host: Arc<dyn DiagnosticsHostPort>) -> Self {
        Self {
            host,
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub(super) async fn collect(
        &self,
        admission: &dyn DiagnosticsRequestAdmission,
        producer: &DiagnosticsArchiveProducer,
        cancellation: DiagnosticsArchiveCancellation,
    ) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
        let active = {
            let mut archive = self.active.lock().await;
            if let Some(active) = archive.as_ref() {
                Arc::clone(active)
            } else {
                admission
                    .admit_diagnostics_request()
                    .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
                let active = Arc::new(ActiveArchive::new());
                *archive = Some(Arc::clone(&active));
                active.spawn(
                    Arc::clone(&self.active),
                    self.host.wait_for_admission_closed(),
                    Arc::clone(&self.host),
                    producer.clone(),
                    cancellation,
                );
                active
            }
        };
        active.wait().await
    }
}

impl ActiveArchive {
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
        archive: Arc<Mutex<Option<Arc<ActiveArchive>>>>,
        admission_closed: DiagnosticsFuture<'static, ()>,
        host: Arc<dyn DiagnosticsHostPort>,
        producer: DiagnosticsArchiveProducer,
        cancellation: DiagnosticsArchiveCancellation,
    ) {
        let id = self.id;
        let completion = self.completion.clone();
        let (task, _) = OwnedTask::spawn(move |task_cancellation| async move {
            let result = match host.state().await {
                Ok(state) => {
                    let archive_cancellation = cancellation.clone();
                    let admission = producer.admit(state);
                    let mut collection = tokio::task::spawn_blocking(move || {
                        admission.collect(&archive_cancellation)
                    });
                    tokio::select! {
                        result = &mut collection => result.map_err(|_| DiagnosticsArchiveError::OutputUnavailable),
                        _ = admission_closed => {
                            cancellation.cancel();
                            collection.await.map_err(|_| DiagnosticsArchiveError::OutputUnavailable)
                        }
                        _ = task_cancellation.cancelled() => {
                            cancellation.cancel();
                            collection.await.map_err(|_| DiagnosticsArchiveError::OutputUnavailable)
                        }
                    }
                }
                Err(_) => Err(DiagnosticsArchiveError::OutputUnavailable),
            };
            let mut current = archive.lock().await;
            if current.as_ref().is_some_and(|candidate| candidate.id == id) {
                *current = None;
            }
            drop(current);
            completion.send_replace(Some(result));
        });
        *self
            .task
            .lock()
            .expect("diagnostics archive task lock poisoned") = Some(task);
    }

    async fn wait(&self) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
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
                return Err(DiagnosticsArchiveError::OutputUnavailable);
            }
        }
    }
}
