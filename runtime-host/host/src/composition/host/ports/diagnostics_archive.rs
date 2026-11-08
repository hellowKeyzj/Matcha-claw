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

    fn runtime_log_snapshot(
        &self,
    ) -> ::diagnostics::DiagnosticsFuture<
        '_,
        Result<Option<String>, ::diagnostics::DiagnosticsArchiveError>,
    > {
        Box::pin(async move {
            let snapshot = self
                .peer
                .open_claw_logs(None)
                .await
                .map_err(|_| ::diagnostics::DiagnosticsArchiveError::OutputUnavailable)?
                .map_err(|_| ::diagnostics::DiagnosticsArchiveError::OutputUnavailable)?;
            let mut text = format!(
                "source=openclaw\ncoverage=boundedSnapshot\ntruncated={}\nlifecycleTailEvicted={}\nreset={}\n\n",
                snapshot.truncated, snapshot.lifecycle_tail_evicted, snapshot.reset,
            );
            const MARKER: &str = "\n[archive snapshot truncated]\n";
            let limit = ::diagnostics::RUNTIME_LOG_SNAPSHOT_BYTE_LIMIT - MARKER.len();
            for entry in snapshot.entries {
                let line = format!("[{}] {}\n", entry.source, entry.line);
                let remaining = limit.saturating_sub(text.len());
                if line.len() > remaining {
                    text.push_str(&line[..line.floor_char_boundary(remaining)]);
                    text.push_str(MARKER);
                    break;
                }
                text.push_str(&line);
            }
            Ok(Some(text))
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
