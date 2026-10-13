use std::{future::Future, pin::Pin};

use tokio_util::sync::CancellationToken;

use crate::{DiagnosticsArchiveError, HostState};

pub type DiagnosticsFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait DiagnosticsRequestAdmission: Send + Sync {
    fn admit_diagnostics_request(&self) -> Result<(), DiagnosticsRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiagnosticsRequestAdmissionClosed;

pub trait DiagnosticsHostPort: Send + Sync {
    fn state(&self) -> DiagnosticsFuture<'_, Result<HostState, DiagnosticsArchiveError>>;

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
