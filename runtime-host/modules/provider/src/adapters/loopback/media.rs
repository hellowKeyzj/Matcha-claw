use std::{future::Future, io, pin::Pin, sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{Request, Response, RouteOutcome, StreamHandler, StreamResponse},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

use crate::{ProviderHandle, media::Failure};

pub(super) const ENDPOINT: &str = "/api/provider/media/generate";
pub(super) const MODELS_ENDPOINT: &str = "/api/provider/media/models";
pub(super) const SUBMIT_ENDPOINT: &str = "/api/provider/media/video/submit";
pub(super) const QUERY_ENDPOINT: &str = "/api/provider/media/video/query";
pub(super) const COLLECT_ENDPOINT: &str = "/api/provider/media/video/collect";
const SCOPE: &str = "providers:media";
const SUBJECT: &str = "provider-media";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    id: String,
    operation_id: String,
    scope: Kind,
    target: Kind,
    input: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Kind {
    kind: String,
}

enum Operation {
    Generate(crate::media::Request),
    List(crate::media::ListRequest),
    Submit(crate::media::Request),
    Query(crate::media::VideoTaskRequest),
    Collect(crate::media::VideoTaskRequest),
}

pub(super) async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> RouteOutcome {
    let operation_id = match request.path() {
        ENDPOINT => "providerMedia.generate",
        MODELS_ENDPOINT => "providerMedia.list",
        SUBMIT_ENDPOINT => "providerMedia.submitVideo",
        QUERY_ENDPOINT => "providerMedia.queryVideo",
        COLLECT_ENDPOINT => "providerMedia.collectVideo",
        _ => return Response::not_found().into(),
    };
    if request.method() != "POST" {
        return Response::not_found().into();
    }
    let Some(authorization) = request.bearer_authorization() else {
        return unauthorized().into();
    };
    let Ok(envelope) = serde_json::from_slice::<Envelope>(&request.body) else {
        return failure(Failure::InvalidRequest).into();
    };
    if envelope.id != "provider.media"
        || envelope.operation_id != operation_id
        || envelope.scope.kind != SUBJECT
        || envelope.target.kind != SUBJECT
    {
        return failure(Failure::InvalidRequest).into();
    }
    let decision = verifier.lock().await.verify(
        authorization,
        super::now_millis(),
        request.path(),
        SCOPE,
        operation_id,
        SUBJECT,
    );
    let Ok(decision) = decision else {
        return unauthorized().into();
    };
    if decision.revision() != format!("{:x}", Sha256::digest(&request.body)) {
        return unauthorized().into();
    }
    let operation = match request.path() {
        ENDPOINT => serde_json::from_value(envelope.input).map(Operation::Generate),
        MODELS_ENDPOINT => serde_json::from_value(envelope.input).map(Operation::List),
        SUBMIT_ENDPOINT => serde_json::from_value(envelope.input).map(Operation::Submit),
        QUERY_ENDPOINT => serde_json::from_value(envelope.input).map(Operation::Query),
        COLLECT_ENDPOINT => serde_json::from_value(envelope.input).map(Operation::Collect),
        _ => unreachable!(),
    };
    let Ok(operation) = operation else {
        return failure(Failure::InvalidRequest).into();
    };
    // The normal route dispatcher cannot observe disconnects while awaiting a response.
    // Owning this socket keeps the existing JSON contract and cancels actual network work.
    RouteOutcome::Stream(StreamResponse::owned(Generation {
        provider,
        operation,
    }))
}

struct Generation {
    provider: ProviderHandle,
    operation: Operation,
}

impl Generation {
    async fn execute(self, cancellation: CancellationToken) -> Result<Value, Failure> {
        match self.operation {
            Operation::Generate(request) => self
                .provider
                .generate_media_cancellable(request, cancellation)
                .await
                .map(|output| json!(output)),
            Operation::List(request) => self
                .provider
                .list_media_models(request)
                .await
                .map(|output| json!(output)),
            Operation::Submit(request) => self
                .provider
                .submit_video_cancellable(request, cancellation)
                .await
                .map(|output| json!(output)),
            Operation::Query(request) => self
                .provider
                .query_video_cancellable(request, cancellation)
                .await
                .map(|output| json!(output)),
            Operation::Collect(request) => self
                .provider
                .collect_video_cancellable(request, cancellation)
                .await
                .map(|output| json!(output)),
        }
    }
}

impl StreamHandler for Generation {
    fn write(
        self: Box<Self>,
        mut stream: TcpStream,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
        Box::pin(async move {
            let cancellation = CancellationToken::new();
            let _cancel_on_drop = cancellation.clone().drop_guard();
            let mut extra = [0_u8; 1];
            let outcome = tokio::select! {
                biased;
                disconnected = stream.read(&mut extra) => {
                    cancellation.cancel();
                    disconnected?;
                    return Ok(());
                }
                outcome = (*self).execute(cancellation.clone()) => outcome,
            };
            let response = match outcome {
                Ok(output) => Response::json(200, output),
                Err(error) => failure(error),
            };
            let body = serde_json::to_vec(response.body()).map_err(io::Error::other)?;
            let head = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status(),
                reason_phrase(response.status()),
                body.len()
            );
            tokio::time::timeout(Duration::from_secs(30), async {
                stream.write_all(head.as_bytes()).await?;
                stream.write_all(&body).await
            })
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "media response write timed out")
            })?
        })
    }
}

fn failure(error: Failure) -> Response {
    Response::json(
        error.status(),
        json!({"success": false, "code": error, "error": error.message()}),
    )
}

fn unauthorized() -> Response {
    Response::json(
        401,
        json!({"success": false, "code": "unauthorized", "error": "Media capability authorization is invalid"}),
    )
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        409 => "Conflict",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        499 => "Client Closed Request",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Internal Server Error",
    }
}
