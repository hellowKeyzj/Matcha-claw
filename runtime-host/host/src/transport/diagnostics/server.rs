use std::{
    io,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use foundation::execution::{
    ControlObservation, ControlReason, ControlStage, EventObservation, EventReason, EventStage,
    ObservationRecord, ObservationSink, TraceContext,
};
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream, tcp::OwnedReadHalf},
    sync::Mutex,
    time::timeout,
};

use crate::{
    diagnostics::DiagnosticsArchiveCancellation, facade::DiagnosticsHandle,
    transport::common::authorization::CapabilityDecisionVerifier,
};

use super::{
    DOWNLOAD_ENDPOINT, DiagnosticsArchiveDelivery, DiagnosticsArchiveDownload, authorize,
    authorize_download, collect, download,
};

#[cfg(test)]
mod server_tests;

const MAX_REQUEST_BYTES: usize = 4 * 1024;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    diagnostics: DiagnosticsHandle,
    observation: ObservationSink,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        diagnostics: DiagnosticsHandle,
        observation: ObservationSink,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            diagnostics,
            observation,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let diagnostics = self.diagnostics.clone();
            let observation = self.observation.clone();
            tokio::spawn(async move {
                let _ = serve(stream, verifier, diagnostics, observation).await;
            });
        }
    }

    #[cfg(test)]
    pub(crate) fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .expect("diagnostics transport listener has a local address")
            .port()
    }
}

async fn serve(
    stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    diagnostics: DiagnosticsHandle,
    observation: ObservationSink,
) -> io::Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let request = match timeout(REQUEST_DEADLINE, read_request(&mut reader)).await {
        Ok(result) => result?,
        Err(_) => {
            observe_diagnostics_transport(
                &observation,
                DiagnosticsTransportObservation::RequestTimedOut,
            );
            return write_response(&mut writer, Response::bad_request()).await;
        }
    };
    let response = match request {
        Ok(request) => handle(request, verifier, diagnostics, observation, &mut reader).await?,
        Err(response) => {
            observe_diagnostics_transport(
                &observation,
                DiagnosticsTransportObservation::RequestDecodeRejected,
            );
            response
        }
    };
    write_response(&mut writer, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    diagnostics: DiagnosticsHandle,
    observation: ObservationSink,
    reader: &mut OwnedReadHalf,
) -> io::Result<Response> {
    let endpoint = EndpointKind::from_path(&request.path);
    if request.method != "POST" || endpoint == EndpointKind::Unknown {
        observe_diagnostics_transport(
            &observation,
            DiagnosticsTransportObservation::MethodOrPathRejected { endpoint },
        );
        return Ok(Response::not_found());
    }
    let Some(authorization) = request
        .headers
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
    let value = match serde_json::from_slice::<Value>(&request.body) {
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

    let cancellation = DiagnosticsArchiveCancellation::new();
    let archive = collect(&diagnostics, cancellation.clone());
    tokio::pin!(archive);
    tokio::select! {
        delivery = &mut archive => {
            observe_archive_delivery(&observation, &delivery);
            Ok(Response::from_delivery(delivery))
        }
        _ = wait_for_disconnect(reader) => {
            cancellation.cancel();
            let _ = archive.await;
            observe_diagnostics_transport(&observation, DiagnosticsTransportObservation::ArchiveCancelled);
            Err(io::Error::new(io::ErrorKind::ConnectionAborted, "diagnostics archive client disconnected"))
        }
    }
}

async fn wait_for_disconnect(reader: &mut OwnedReadHalf) {
    let mut buffer = [0_u8; 128];
    while reader.read(&mut buffer).await.unwrap_or(0) != 0 {}
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

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    body: Value,
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

async fn read_request(
    stream: &mut (impl AsyncRead + Unpin),
) -> io::Result<Result<Request, Response>> {
    let mut bytes = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(Err(Response::bad_request()));
        }
        if bytes.len() + read > MAX_REQUEST_BYTES {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = match std::str::from_utf8(&bytes[..header_end]) {
        Ok(value) => value,
        Err(_) => return Ok(Err(Response::bad_request())),
    };
    let mut lines = headers.split("\r\n");
    let Some(start) = lines.next() else {
        return Ok(Err(Response::bad_request()));
    };
    let mut start = start.split_whitespace();
    let (Some(method), Some(path), Some(version), None) =
        (start.next(), start.next(), start.next(), start.next())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if version != "HTTP/1.1" {
        return Ok(Err(Response::bad_request()));
    }
    let method = method.to_owned();
    let path = path.to_owned();
    let mut parsed_headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Ok(Err(Response::bad_request()));
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();
        if name.is_empty() || parsed_headers.iter().any(|(existing, _)| existing == &name) {
            return Ok(Err(Response::bad_request()));
        }
        parsed_headers.push((name, value));
    }
    let Some(content_length) = parsed_headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if content_length > MAX_REQUEST_BYTES || header_end + content_length > MAX_REQUEST_BYTES {
        return Ok(Err(Response::bad_request()));
    }
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 || bytes.len() + read > MAX_REQUEST_BYTES {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() != header_end + content_length {
        return Ok(Err(Response::bad_request()));
    }
    Ok(Ok(Request {
        method,
        path,
        headers: parsed_headers,
        body: bytes[header_end..].to_vec(),
    }))
}

async fn write_response(
    stream: &mut (impl AsyncWrite + Unpin),
    response: Response,
) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body)
        .expect("Diagnostics archive public response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                reason,
                body.len(),
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
