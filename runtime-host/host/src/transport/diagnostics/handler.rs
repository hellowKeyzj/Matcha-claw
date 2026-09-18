use std::{
    io,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use foundation::execution::{
    ControlObservation, ControlReason, ControlStage, EventObservation, EventReason, EventStage,
    ObservationRecord, ObservationSink, TraceContext,
};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    facade::DiagnosticsHandle,
    transport::{common::authorization::CapabilityDecisionVerifier, localhost},
};

use super::{
    DOWNLOAD_ENDPOINT, DiagnosticsArchiveDelivery, DiagnosticsArchiveDownload, authorize,
    authorize_download, collect, download,
};

const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    diagnostics: DiagnosticsHandle,
    observation: ObservationSink,
) -> io::Result<localhost::Response> {
    handle_request(
        method,
        path,
        headers,
        body,
        verifier,
        diagnostics,
        observation,
    )
    .await
    .map(Into::into)
}

async fn handle_request(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    diagnostics: DiagnosticsHandle,
    observation: ObservationSink,
) -> io::Result<Response> {
    let endpoint = EndpointKind::from_path(path);
    if method != "POST" || endpoint == EndpointKind::Unknown {
        observe_diagnostics_transport(
            &observation,
            DiagnosticsTransportObservation::MethodOrPathRejected { endpoint },
        );
        return Ok(Response::not_found());
    }
    let Some(authorization) = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        observe_diagnostics_transport(
            &observation,
            DiagnosticsTransportObservation::MissingAuthorization { endpoint },
        );
        return Ok(Response::unauthorized());
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => {
            observe_diagnostics_transport(
                &observation,
                DiagnosticsTransportObservation::BadJson { endpoint },
            );
            return Ok(Response::bad_request());
        }
    };
    let mut verifier = verifier.lock().await;
    if endpoint == EndpointKind::Download {
        let archive_id = match authorize_download(value, authorization, &mut verifier, now_millis())
        {
            Ok(archive_id) => archive_id,
            Err(_) => {
                drop(verifier);
                observe_diagnostics_transport(
                    &observation,
                    DiagnosticsTransportObservation::CapabilityRejected { endpoint },
                );
                return Ok(Response::unauthorized());
            }
        };
        drop(verifier);
        observe_diagnostics_transport(
            &observation,
            DiagnosticsTransportObservation::Accepted { endpoint },
        );
        let download = download(&diagnostics, archive_id).await;
        observe_download_delivery(&observation, &download);
        return Ok(Response::from_download(download));
    }
    if authorize(value, authorization, &mut verifier, now_millis()).is_err() {
        drop(verifier);
        observe_diagnostics_transport(
            &observation,
            DiagnosticsTransportObservation::CapabilityRejected { endpoint },
        );
        return Ok(Response::unauthorized());
    }
    drop(verifier);
    observe_diagnostics_transport(
        &observation,
        DiagnosticsTransportObservation::Accepted { endpoint },
    );

    let delivery = collect(
        &diagnostics,
        crate::diagnostics::DiagnosticsArchiveCancellation::new(),
    )
    .await;
    observe_archive_delivery(&observation, &delivery);
    Ok(Response::from_delivery(delivery))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EndpointKind {
    Archive,
    Download,
    Unknown,
}

impl EndpointKind {
    fn from_path(path: &str) -> Self {
        match path {
            "/api/diagnostics/archive" => Self::Archive,
            DOWNLOAD_ENDPOINT => Self::Download,
            _ => Self::Unknown,
        }
    }

    const fn observation_kind(self) -> &'static str {
        match self {
            Self::Archive => "diagnostics.archive",
            Self::Download => "diagnostics.download",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DiagnosticsTransportObservation {
    RequestDecodeRejected,
    RequestTimedOut,
    MethodOrPathRejected { endpoint: EndpointKind },
    MissingAuthorization { endpoint: EndpointKind },
    BadJson { endpoint: EndpointKind },
    CapabilityRejected { endpoint: EndpointKind },
    Accepted { endpoint: EndpointKind },
    ArchiveCompleted,
    ArchiveCancelled,
    ArchiveFailed,
    DownloadCompleted,
    DownloadArchiveNotFound,
    DownloadOutputUnavailable,
}

impl DiagnosticsTransportObservation {
    const fn endpoint(self) -> EndpointKind {
        match self {
            Self::RequestDecodeRejected | Self::RequestTimedOut => EndpointKind::Unknown,
            Self::MethodOrPathRejected { endpoint }
            | Self::MissingAuthorization { endpoint }
            | Self::BadJson { endpoint }
            | Self::CapabilityRejected { endpoint }
            | Self::Accepted { endpoint } => endpoint,
            Self::ArchiveCompleted | Self::ArchiveCancelled | Self::ArchiveFailed => {
                EndpointKind::Archive
            }
            Self::DownloadCompleted
            | Self::DownloadArchiveNotFound
            | Self::DownloadOutputUnavailable => EndpointKind::Download,
        }
    }

    const fn category_kind(self) -> &'static str {
        match self {
            Self::RequestDecodeRejected => "diagnostics.ingress.decodeRejected",
            Self::RequestTimedOut => "diagnostics.ingress.timedOut",
            Self::MethodOrPathRejected { .. } => "diagnostics.ingress.methodOrPathRejected",
            Self::MissingAuthorization { .. } => "diagnostics.ingress.missingAuthorization",
            Self::BadJson { .. } => "diagnostics.ingress.badJson",
            Self::CapabilityRejected { .. } => "diagnostics.ingress.capabilityRejected",
            Self::Accepted {
                endpoint: EndpointKind::Archive,
            } => "diagnostics.archive.accepted",
            Self::Accepted {
                endpoint: EndpointKind::Download,
            } => "diagnostics.download.accepted",
            Self::Accepted {
                endpoint: EndpointKind::Unknown,
            } => "diagnostics.ingress.accepted",
            Self::ArchiveCompleted => "diagnostics.archive.completed",
            Self::ArchiveCancelled => "diagnostics.archive.cancelled",
            Self::ArchiveFailed => "diagnostics.archive.failed",
            Self::DownloadCompleted => "diagnostics.download.completed",
            Self::DownloadArchiveNotFound => "diagnostics.download.archiveNotFound",
            Self::DownloadOutputUnavailable => "diagnostics.download.outputUnavailable",
        }
    }

    const fn control_stage(self) -> ControlStage {
        match self {
            Self::RequestDecodeRejected | Self::RequestTimedOut | Self::BadJson { .. } => {
                ControlStage::Decode
            }
            Self::MethodOrPathRejected { .. } => ControlStage::Dispatch,
            Self::MissingAuthorization { .. }
            | Self::CapabilityRejected { .. }
            | Self::Accepted { .. } => ControlStage::Admit,
            Self::ArchiveCompleted
            | Self::ArchiveCancelled
            | Self::ArchiveFailed
            | Self::DownloadCompleted
            | Self::DownloadArchiveNotFound
            | Self::DownloadOutputUnavailable => ControlStage::Settle,
        }
    }

    const fn control_reason(self) -> ControlReason {
        match self {
            Self::RequestTimedOut => ControlReason::TimedOut,
            Self::RequestDecodeRejected | Self::BadJson { .. } => ControlReason::DecodeRejected,
            Self::Accepted { .. } | Self::ArchiveCompleted | Self::DownloadCompleted => {
                ControlReason::Accepted
            }
            Self::ArchiveCancelled => ControlReason::OutputClosed,
            Self::MethodOrPathRejected { .. }
            | Self::MissingAuthorization { .. }
            | Self::CapabilityRejected { .. }
            | Self::ArchiveFailed
            | Self::DownloadArchiveNotFound
            | Self::DownloadOutputUnavailable => ControlReason::Rejected,
        }
    }

    const fn event_stage(self) -> EventStage {
        match self {
            Self::RequestDecodeRejected
            | Self::RequestTimedOut
            | Self::MethodOrPathRejected { .. }
            | Self::MissingAuthorization { .. }
            | Self::BadJson { .. }
            | Self::CapabilityRejected { .. }
            | Self::Accepted { .. } => EventStage::Validate,
            Self::ArchiveCompleted | Self::DownloadCompleted => EventStage::Emit,
            Self::ArchiveCancelled
            | Self::ArchiveFailed
            | Self::DownloadArchiveNotFound
            | Self::DownloadOutputUnavailable => EventStage::Drop,
        }
    }

    const fn event_reason(self) -> EventReason {
        match self {
            Self::Accepted { .. } | Self::ArchiveCompleted | Self::DownloadCompleted => {
                EventReason::Accepted
            }
            Self::MethodOrPathRejected { .. } => EventReason::RouteMismatch,
            Self::ArchiveCancelled => EventReason::SinkClosed,
            Self::RequestDecodeRejected
            | Self::RequestTimedOut
            | Self::MissingAuthorization { .. }
            | Self::BadJson { .. }
            | Self::CapabilityRejected { .. }
            | Self::ArchiveFailed
            | Self::DownloadArchiveNotFound
            | Self::DownloadOutputUnavailable => EventReason::ValidationRejected,
        }
    }
}

fn observe_archive_delivery(observation: &ObservationSink, delivery: &DiagnosticsArchiveDelivery) {
    let record = match delivery {
        DiagnosticsArchiveDelivery::Ok(receipt) => match receipt.terminal() {
            crate::diagnostics::DiagnosticsArchiveTerminal::Completed => {
                DiagnosticsTransportObservation::ArchiveCompleted
            }
            crate::diagnostics::DiagnosticsArchiveTerminal::Cancelled => {
                DiagnosticsTransportObservation::ArchiveCancelled
            }
            crate::diagnostics::DiagnosticsArchiveTerminal::Failed => {
                DiagnosticsTransportObservation::ArchiveFailed
            }
        },
        DiagnosticsArchiveDelivery::Unavailable => DiagnosticsTransportObservation::ArchiveFailed,
    };
    observe_diagnostics_transport(observation, record);
}

fn observe_download_delivery(observation: &ObservationSink, download: &DiagnosticsArchiveDownload) {
    let record = match download {
        DiagnosticsArchiveDownload::Ok { .. } => DiagnosticsTransportObservation::DownloadCompleted,
        DiagnosticsArchiveDownload::NotFound => {
            DiagnosticsTransportObservation::DownloadArchiveNotFound
        }
        DiagnosticsArchiveDownload::Unavailable => {
            DiagnosticsTransportObservation::DownloadOutputUnavailable
        }
    };
    observe_diagnostics_transport(observation, record);
}

fn observe_diagnostics_transport(
    observation: &ObservationSink,
    record: DiagnosticsTransportObservation,
) {
    observation.observe(ObservationRecord::Control(ControlObservation {
        trace: TraceContext::absent(),
        command_kind: record.endpoint().observation_kind(),
        stage: record.control_stage(),
        reason: Some(record.control_reason()),
    }));
    observation.observe(ObservationRecord::Event(EventObservation {
        trace: TraceContext::absent(),
        event_kind: record.category_kind(),
        stage: record.event_stage(),
        reason: Some(record.event_reason()),
    }));
}

struct Response {
    status: u16,
    body: Value,
}

impl From<Response> for localhost::Response {
    fn from(response: Response) -> Self {
        Self::json(response.status, response.body)
    }
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Diagnostics archive request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Diagnostics archive authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Diagnostics archive route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: DiagnosticsArchiveDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn from_download(download: DiagnosticsArchiveDownload) -> Self {
        Self {
            status: download.status_code(),
            body: download.body(),
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
