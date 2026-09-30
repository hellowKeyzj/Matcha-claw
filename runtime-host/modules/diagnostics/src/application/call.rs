use platform::call::{CallContext, CallDetail, CallLogError, CallStatus};
use serde::Serialize;

use crate::{DiagnosticsArchiveError, DiagnosticsArchiveReceipt, DiagnosticsArchiveTerminal};

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum DiagnosticsCallDetail {
    CollectArchive {
        receipt: Option<DiagnosticsArchiveReceipt>,
        failure: Option<CallFailure>,
    },
    DownloadArchive {
        #[serde(rename = "archiveId")]
        archive_id: Option<String>,
        bytes: Option<u64>,
        failure: Option<CallFailure>,
    },
}

impl CallDetail for DiagnosticsCallDetail {
    const MODULE: &'static str = "diagnostics";
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CallFailure {
    OwnerUnavailable,
    InvalidRoot,
    OutputUnavailable,
    ArchiveNotFound,
    ArchiveIdUnavailable,
}

impl From<DiagnosticsArchiveError> for CallFailure {
    fn from(error: DiagnosticsArchiveError) -> Self {
        match error {
            DiagnosticsArchiveError::InvalidRoot => Self::InvalidRoot,
            DiagnosticsArchiveError::OutputUnavailable => Self::OutputUnavailable,
            DiagnosticsArchiveError::ArchiveNotFound => Self::ArchiveNotFound,
            DiagnosticsArchiveError::ArchiveIdUnavailable => Self::ArchiveIdUnavailable,
        }
    }
}

impl DiagnosticsCallDetail {
    pub fn collect() -> Self {
        Self::CollectArchive {
            receipt: None,
            failure: None,
        }
    }

    pub fn download(archive_id: &str) -> Self {
        let opaque = archive_id.len() == 32
            && archive_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        Self::DownloadArchive {
            archive_id: opaque.then(|| archive_id.to_owned()),
            bytes: None,
            failure: None,
        }
    }

    pub fn failed(mut self, failure: CallFailure) -> Self {
        match &mut self {
            Self::CollectArchive { failure: field, .. }
            | Self::DownloadArchive { failure: field, .. } => *field = Some(failure),
        }
        self
    }
}

pub(crate) fn observe_collection(
    observation: &foundation::execution::ObservationSink,
    result: &Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError>,
) {
    use foundation::execution::{
        ControlObservation, ControlReason, ControlStage, EventObservation, EventReason, EventStage,
        ObservationRecord, TraceContext,
    };

    let (event_kind, control_reason, event_stage, event_reason) =
        match result.as_ref().map(|receipt| receipt.terminal()) {
            Ok(DiagnosticsArchiveTerminal::Completed) => (
                "diagnostics.archive.completed",
                ControlReason::Accepted,
                EventStage::Emit,
                EventReason::Accepted,
            ),
            Ok(DiagnosticsArchiveTerminal::Cancelled) => (
                "diagnostics.archive.cancelled",
                ControlReason::OutputClosed,
                EventStage::Drop,
                EventReason::SinkClosed,
            ),
            Ok(DiagnosticsArchiveTerminal::Failed) | Err(_) => (
                "diagnostics.archive.failed",
                ControlReason::Rejected,
                EventStage::Drop,
                EventReason::ValidationRejected,
            ),
        };
    observation.observe(ObservationRecord::Control(ControlObservation {
        trace: TraceContext::absent(),
        command_kind: "diagnostics.archive",
        stage: ControlStage::Settle,
        reason: Some(control_reason),
    }));
    observation.observe(ObservationRecord::Event(EventObservation {
        trace: TraceContext::absent(),
        event_kind,
        stage: event_stage,
        reason: Some(event_reason),
    }));
}

pub(crate) async fn finish_collection(
    call: Option<&CallContext<DiagnosticsCallDetail>>,
    result: &Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError>,
) {
    let (status, detail) = match result {
        Ok(receipt) => (
            match receipt.terminal() {
                DiagnosticsArchiveTerminal::Completed => CallStatus::Succeeded,
                DiagnosticsArchiveTerminal::Cancelled => CallStatus::Unknown,
                DiagnosticsArchiveTerminal::Failed => CallStatus::Failed,
            },
            DiagnosticsCallDetail::CollectArchive {
                receipt: Some(receipt.clone()),
                failure: None,
            },
        ),
        Err(error) => (
            CallStatus::Failed,
            DiagnosticsCallDetail::collect().failed((*error).into()),
        ),
    };
    finish(call, status, &detail).await;
}

pub(crate) async fn finish(
    call: Option<&CallContext<DiagnosticsCallDetail>>,
    status: CallStatus,
    detail: &DiagnosticsCallDetail,
) {
    if let Some(call) = call {
        if let Err(error) = call.finish(status, detail).await {
            eprintln!(
                "[diagnostics:call] terminal record failed call_id={} error={error}",
                call.id().as_str()
            );
        }
    }
}

pub(crate) async fn running(
    call: Option<&CallContext<DiagnosticsCallDetail>>,
) -> Result<(), CallLogError> {
    if let Some(call) = call {
        call.running().await.map_err(|error| {
            eprintln!(
                "[diagnostics:call] running record failed call_id={} error={error}",
                call.id().as_str()
            );
            error
        })?;
    }
    Ok(())
}
