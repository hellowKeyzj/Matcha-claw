use std::sync::Arc;

use crate::composition::{HostAdmission, PeerHandle, RequestAdmission};

#[derive(Clone)]
pub(in crate::composition::host) struct HostDiagnostics {
    admission: Arc<HostAdmission>,
    peer: PeerHandle,
}

impl HostDiagnostics {
    pub(in crate::composition::host) fn new(
        admission: Arc<HostAdmission>,
        peer: PeerHandle,
    ) -> Self {
        Self { admission, peer }
    }
}

impl ::diagnostics::DiagnosticsHostPort for HostDiagnostics {
    fn state(
        &self,
    ) -> ::diagnostics::DiagnosticsFuture<
        '_,
        Result<::diagnostics::HostState, ::diagnostics::DiagnosticsArchiveError>,
    > {
        Box::pin(async move {
            self.peer
                .state()
                .await
                .map_err(|_| ::diagnostics::DiagnosticsArchiveError::OutputUnavailable)
        })
    }

    fn wait_for_admission_closed(&self) -> ::diagnostics::DiagnosticsFuture<'static, ()> {
        let mut admission = self.admission.subscribe();
        Box::pin(async move {
            loop {
                if admission.borrow().request_admission() == RequestAdmission::Closed {
                    return;
                }
                if admission.changed().await.is_err() {
                    return;
                }
            }
        })
    }
}
