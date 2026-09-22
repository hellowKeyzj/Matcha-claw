use std::{future::Future, pin::Pin};

use tokio_util::sync::CancellationToken;

use crate::{DiagnosticsArchiveError, DiagnosticsArchiveReceipt};

pub type DiagnosticsFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait DiagnosticsRequestAdmission: Send + Sync {
    fn admit_diagnostics_request(&self) -> Result<(), DiagnosticsRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiagnosticsRequestAdmissionClosed;

pub trait DiagnosticsArchivePort: Send + Sync {
    fn collect_archive<'a>(
        &'a self,
        cancellation: DiagnosticsArchiveCancellation,
    ) -> DiagnosticsFuture<'a, Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError>>;

    fn download_archive<'a>(
        &'a self,
        archive_id: String,
    ) -> DiagnosticsFuture<'a, Result<Vec<u8>, DiagnosticsArchiveError>>;
}

#[derive(Clone)]
pub struct DiagnosticsArchiveCancellation(CancellationToken);

pub struct DiagnosticsArchiveCancellationGuard(DiagnosticsArchiveCancellation);

impl DiagnosticsArchiveCancellation {
    pub fn new() -> Self {
        Self(CancellationToken::new())
    }

    pub fn cancel(&self) {
        self.0.cancel();
    }

    pub fn cancel_on_drop(&self) -> DiagnosticsArchiveCancellationGuard {
        DiagnosticsArchiveCancellationGuard(self.clone())
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }
}

impl Default for DiagnosticsArchiveCancellation {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for DiagnosticsArchiveCancellationGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
