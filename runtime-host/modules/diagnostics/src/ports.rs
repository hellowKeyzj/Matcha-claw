use std::{future::Future, pin::Pin};

use tokio_util::sync::CancellationToken;

use crate::{DiagnosticsArchiveError, HostState};

pub type DiagnosticsFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub const RUNTIME_LOG_SNAPSHOT_BYTE_LIMIT: usize = 128 * 1024;

pub trait DiagnosticsRequestAdmission: Send + Sync {
    fn admit_diagnostics_request(&self) -> Result<(), DiagnosticsRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiagnosticsRequestAdmissionClosed;

pub trait DiagnosticsHostPort: Send + Sync {
    fn state(&self) -> DiagnosticsFuture<'_, Result<HostState, DiagnosticsArchiveError>>;

    /// Bounded UTF-8 log text sanitized by the runtime, including source and coverage.
    /// `None` means no runtime source; an error means its snapshot was unavailable.
    fn runtime_log_snapshot(
        &self,
    ) -> DiagnosticsFuture<'_, Result<Option<String>, DiagnosticsArchiveError>> {
        Box::pin(async { Ok(None) })
    }

    fn wait_for_admission_closed(&self) -> DiagnosticsFuture<'static, ()>;
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

    pub(crate) async fn cancelled(&self) {
        self.0.cancelled().await;
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
