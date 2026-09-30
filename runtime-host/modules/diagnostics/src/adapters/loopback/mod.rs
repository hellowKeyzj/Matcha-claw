use std::{io, sync::Arc, time::Duration};

use base64::Engine as _;
use foundation::execution::{
    ControlObservation, ControlReason, ControlStage, EventObservation, EventReason, EventStage,
    ObservationRecord, ObservationSink, TraceContext,
};
use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    DiagnosticsArchiveError, api::DiagnosticsHandle, ports::DiagnosticsArchiveCancellation,
};

pub const ARCHIVE_PATH: &str = "/api/diagnostics/archive";
pub const DOWNLOAD_PATH: &str = "/api/diagnostics/archive/download";
const AUTHORIZATION_SCOPE: &str = "diagnostics:write";
const DOWNLOAD_SCOPE: &str = "diagnostics:read";
const AUTHORIZATION_CAPABILITY: &str = "diagnostics.archive";
const DOWNLOAD_CAPABILITY: &str = "diagnostics.archive.download";
const AUTHORIZATION_SUBJECT: &str = "host-diagnostics";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const REQUEST_BYTES: usize = 4 * 1024;
const SHORT_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    diagnostics: DiagnosticsHandle,
    observation: ObservationSink,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        diagnostics: DiagnosticsHandle,
        observation: ObservationSink,
    ) -> Self {
        Self {
            verifier,
            diagnostics,
            observation,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("diagnostics"),
        vec![RouteDescriptor::bound(
            "diagnostics.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    is_diagnostics_route(path).then(|| {
        RouteHeadPlan::new(
            body_policy_for_method(head.method.as_str(), REQUEST_BYTES),
            SHORT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        match handle(request, dependencies).await {
            Ok(response) => response,
            Err(_) => Response::error(503, "Diagnostics archive is unavailable"),
        }
        .into()
    })
}

async fn handle(request: Request, dependencies: Dependencies) -> io::Result<Response> {
    let endpoint = EndpointKind::from_path(request.path());
    if request.method() != "POST" || endpoint == EndpointKind::Unknown {
        observe_diagnostics_transport(
            &dependencies.observation,
            DiagnosticsTransportObservation::MethodOrPathRejected { endpoint },
        );
        return Ok(ResponseBody::not_found().into_response());
    }
    let Some(authorization) = request
        .headers()
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        observe_diagnostics_transport(
            &dependencies.observation,
            DiagnosticsTransportObservation::MissingAuthorization { endpoint },
        );
        return Ok(ResponseBody::unauthorized().into_response());
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => {
            observe_diagnostics_transport(
                &dependencies.observation,
                DiagnosticsTransportObservation::BadJson { endpoint },
            );
            return Ok(ResponseBody::bad_request().into_response());
        }
    };
    let mut verifier = dependencies.verifier.lock().await;
    if endpoint == EndpointKind::Download {
        let archive_id = match authorize_download(value, authorization, &mut verifier, now_millis())
        {
            Ok(archive_id) => archive_id,
            Err(_) => {
                drop(verifier);
                observe_diagnostics_transport(
                    &dependencies.observation,
                    DiagnosticsTransportObservation::CapabilityRejected { endpoint },
                );
                return Ok(ResponseBody::unauthorized().into_response());
            }
        };
        drop(verifier);
        observe_diagnostics_transport(
            &dependencies.observation,
            DiagnosticsTransportObservation::Accepted { endpoint },
        );
        let download = download(&dependencies.diagnostics, archive_id).await;
        observe_download_delivery(&dependencies.observation, &download);
        return Ok(ResponseBody::from_download(download).into_response());
    }
    if authorize(value, authorization, &mut verifier, now_millis()).is_err() {
        drop(verifier);
        observe_diagnostics_transport(
            &dependencies.observation,
            DiagnosticsTransportObservation::CapabilityRejected { endpoint },
        );
        return Ok(ResponseBody::unauthorized().into_response());
    }
    drop(verifier);
    observe_diagnostics_transport(
        &dependencies.observation,
        DiagnosticsTransportObservation::Accepted { endpoint },
    );

    match dependencies
        .diagnostics
        .admit_archive(DiagnosticsArchiveCancellation::new())
        .await
    {
        Ok(receipt) => Ok(Response::json(202, serde_json::to_value(receipt)?)),
        Err(_) => {
            Ok(ResponseBody::fixed(503, "Diagnostics archive is unavailable").into_response())
        }
    }
}

fn authorize(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<(), ()> {
    authorize_for(
        value,
        authorization,
        verifier,
        now,
        ARCHIVE_PATH,
        AUTHORIZATION_SCOPE,
        AUTHORIZATION_CAPABILITY,
    )
}

fn authorize_download(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<String, ()> {
    let object = value.as_object().ok_or(())?;
    if object.len() != 1 {
        return Err(());
    }
    let archive_id = object
        .get("archiveId")
        .and_then(Value::as_str)
        .filter(|value| opaque_archive_id(value))
        .ok_or(())?
        .to_owned();
    authorize_for(
        value,
        authorization,
        verifier,
        now,
        DOWNLOAD_PATH,
        DOWNLOAD_SCOPE,
        DOWNLOAD_CAPABILITY,
    )?;
    Ok(archive_id)
}

fn authorize_for(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
    endpoint: &str,
    scope: &str,
    capability: &str,
) -> Result<(), ()> {
    verifier
        .verify(
            authorization,
            now,
            endpoint,
            scope,
            capability,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| ())?;
    if endpoint == ARCHIVE_PATH {
        (value == serde_json::json!({})).then_some(()).ok_or(())
    } else {
        Ok(())
    }
}

fn opaque_archive_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DiagnosticsArchiveDelivery {
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum DiagnosticsArchiveDownload {
    Ok { archive_id: String, data: String },
    NotFound,
    Unavailable,
}

impl DiagnosticsArchiveDownload {
    const fn status_code(&self) -> u16 {
        match self {
            Self::Ok { .. } => 200,
            Self::NotFound => 404,
            Self::Unavailable => 503,
        }
    }

    fn body(&self) -> Value {
        match self {
            Self::Ok { archive_id, data } => serde_json::json!({
                "archiveId": archive_id,
                "data": data,
            }),
            Self::NotFound => serde_json::json!({
                "success": false,
                "error": "Diagnostics archive was not found",
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Diagnostics archive is unavailable",
            }),
        }
    }
}

#[cfg(test)]
impl DiagnosticsArchiveDelivery {
    const fn status_code(&self) -> u16 {
        503
    }

    fn body(&self) -> Value {
        serde_json::json!({
            "success": false,
            "error": "Diagnostics archive is unavailable",
        })
    }
}

async fn download(
    diagnostics: &DiagnosticsHandle,
    archive_id: String,
) -> DiagnosticsArchiveDownload {
    match diagnostics.download_archive(archive_id.clone()).await {
        Ok(bytes) => DiagnosticsArchiveDownload::Ok {
            archive_id,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        },
        Err(DiagnosticsArchiveError::ArchiveNotFound) => DiagnosticsArchiveDownload::NotFound,
        Err(_) => DiagnosticsArchiveDownload::Unavailable,
    }
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
            ARCHIVE_PATH => Self::Archive,
            DOWNLOAD_PATH => Self::Download,
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
    MethodOrPathRejected { endpoint: EndpointKind },
    MissingAuthorization { endpoint: EndpointKind },
    BadJson { endpoint: EndpointKind },
    CapabilityRejected { endpoint: EndpointKind },
    Accepted { endpoint: EndpointKind },
    DownloadCompleted,
    DownloadArchiveNotFound,
    DownloadOutputUnavailable,
}

impl DiagnosticsTransportObservation {
    const fn endpoint(self) -> EndpointKind {
        match self {
            Self::MethodOrPathRejected { endpoint }
            | Self::MissingAuthorization { endpoint }
            | Self::BadJson { endpoint }
            | Self::CapabilityRejected { endpoint }
            | Self::Accepted { endpoint } => endpoint,
            Self::DownloadCompleted
            | Self::DownloadArchiveNotFound
            | Self::DownloadOutputUnavailable => EndpointKind::Download,
        }
    }

    const fn category_kind(self) -> &'static str {
        match self {
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
            Self::DownloadCompleted => "diagnostics.download.completed",
            Self::DownloadArchiveNotFound => "diagnostics.download.archiveNotFound",
            Self::DownloadOutputUnavailable => "diagnostics.download.outputUnavailable",
        }
    }

    const fn control_stage(self) -> ControlStage {
        match self {
            Self::BadJson { .. } => ControlStage::Decode,
            Self::MethodOrPathRejected { .. } => ControlStage::Dispatch,
            Self::MissingAuthorization { .. }
            | Self::CapabilityRejected { .. }
            | Self::Accepted { .. } => ControlStage::Admit,
            Self::DownloadCompleted
            | Self::DownloadArchiveNotFound
            | Self::DownloadOutputUnavailable => ControlStage::Settle,
        }
    }

    const fn control_reason(self) -> ControlReason {
        match self {
            Self::BadJson { .. } => ControlReason::DecodeRejected,
            Self::Accepted { .. } | Self::DownloadCompleted => ControlReason::Accepted,
            Self::MethodOrPathRejected { .. }
            | Self::MissingAuthorization { .. }
            | Self::CapabilityRejected { .. }
            | Self::DownloadArchiveNotFound
            | Self::DownloadOutputUnavailable => ControlReason::Rejected,
        }
    }

    const fn event_stage(self) -> EventStage {
        match self {
            Self::MethodOrPathRejected { .. }
            | Self::MissingAuthorization { .. }
            | Self::BadJson { .. }
            | Self::CapabilityRejected { .. }
            | Self::Accepted { .. } => EventStage::Validate,
            Self::DownloadCompleted => EventStage::Emit,
            Self::DownloadArchiveNotFound | Self::DownloadOutputUnavailable => EventStage::Drop,
        }
    }

    const fn event_reason(self) -> EventReason {
        match self {
            Self::Accepted { .. } | Self::DownloadCompleted => EventReason::Accepted,
            Self::MethodOrPathRejected { .. } => EventReason::RouteMismatch,
            Self::MissingAuthorization { .. }
            | Self::BadJson { .. }
            | Self::CapabilityRejected { .. }
            | Self::DownloadArchiveNotFound
            | Self::DownloadOutputUnavailable => EventReason::ValidationRejected,
        }
    }
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

struct ResponseBody {
    status: u16,
    body: Value,
}

impl ResponseBody {
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

    fn from_download(download: DiagnosticsArchiveDownload) -> Self {
        Self {
            status: download.status_code(),
            body: download.body(),
        }
    }

    fn into_response(self) -> Response {
        Response::json(self.status, self.body)
    }
}

fn body_policy_for_method(method: &str, max_bytes: usize) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else if method == "POST" {
        BodyPolicy::Required { max_bytes }
    } else {
        BodyPolicy::Optional {
            max_bytes: 64 * 1024,
        }
    }
}

fn timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}

fn is_diagnostics_route(path: &str) -> bool {
    matches!(path, ARCHIVE_PATH | DOWNLOAD_PATH)
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(pathname, _)| pathname)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_is_fixed_and_redacted() {
        let delivery = DiagnosticsArchiveDelivery::Unavailable;
        assert_eq!(delivery.status_code(), 503);
        assert_eq!(
            delivery.body(),
            serde_json::json!({
                "success": false,
                "error": "Diagnostics archive is unavailable",
            })
        );
    }
}
