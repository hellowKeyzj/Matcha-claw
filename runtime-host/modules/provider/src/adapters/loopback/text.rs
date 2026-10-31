use std::{future::Future, io, pin::Pin, sync::Arc, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD};
use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{Request, Response, RouteOutcome, StreamHandler, StreamResponse},
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderHandle, ProviderTextGenerationOutcome, ProviderTextGenerationRequest,
    ProviderTextGenerationUnavailableReason,
    llm_client::{
        LlmFinishReason, LlmGenerationOptions, LlmImageContent, LlmMessage, LlmMessagePart, LlmRole,
    },
};

pub(super) const ENDPOINT: &str = "/api/provider/text/generate";
pub(super) const MAX_REQUEST_BYTES: usize = 48 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_DURATION: Duration = Duration::from_secs(5 * 60);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    prompt: String,
    selection_id: Option<String>,
    #[serde(default)]
    images: Vec<Image>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Image {
    data: String,
    mime_type: String,
}

impl Input {
    fn into_request(self) -> Result<(ProviderTextGenerationRequest, Option<String>), ()> {
        if self.prompt.trim().is_empty()
            || self.prompt.len() > 128_000
            || self.prompt.chars().count() > 32_000
            || self.images.len() > 16
            || self.selection_id.as_ref().is_some_and(|id| {
                !id.strip_prefix("model-selection:v1:")
                    .is_some_and(|digest| {
                        digest.len() == 64
                            && digest
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
            })
        {
            return Err(());
        }
        let mut input_bytes = 0;
        let mut parts = vec![LlmMessagePart::Text(self.prompt)];
        for image in self.images {
            if image.data.len() > 44 * 1024 * 1024 {
                return Err(());
            }
            let bytes = STANDARD.decode(&image.data).map_err(|_| ())?;
            input_bytes += bytes.len();
            let mime_type = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "image/png"
            } else if bytes.starts_with(b"\xff\xd8\xff") {
                "image/jpeg"
            } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                "image/webp"
            } else {
                return Err(());
            };
            if input_bytes > 32 * 1024 * 1024 || image.mime_type != mime_type {
                return Err(());
            }
            parts.push(LlmMessagePart::Image(LlmImageContent::new(
                image.mime_type,
                image.data,
            )));
        }
        Ok((
            ProviderTextGenerationRequest {
                model_ref: None,
                messages: vec![LlmMessage::parts(LlmRole::User, parts)],
                options: LlmGenerationOptions::default(),
            },
            self.selection_id,
        ))
    }
}

pub(super) async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> RouteOutcome {
    if request.method() != "POST" || request.path() != ENDPOINT {
        return Response::not_found().into();
    }
    let Some(authorization) = request.bearer_authorization() else {
        return unauthorized().into();
    };
    let decision = verifier.lock().await.verify(
        authorization,
        super::now_millis(),
        ENDPOINT,
        "providers:text",
        "providerText.generate",
        "provider-text",
    );
    let Ok(decision) = decision else {
        return unauthorized().into();
    };
    if decision.revision() != format!("{:x}", Sha256::digest(&request.body)) {
        return unauthorized().into();
    }
    let Ok(envelope) = serde_json::from_slice::<Envelope>(&request.body) else {
        return invalid_request().into();
    };
    let Ok((request, selection_id)) = envelope.input.into_request() else {
        return invalid_request().into();
    };
    // Owning the response socket lets a caller disconnect cancel the actual Provider Direct call.
    RouteOutcome::Stream(StreamResponse::owned(Generation {
        provider,
        request,
        selection_id,
    }))
}

struct Generation {
    provider: ProviderHandle,
    request: ProviderTextGenerationRequest,
    selection_id: Option<String>,
}

impl StreamHandler for Generation {
    fn write(
        self: Box<Self>,
        mut stream: TcpStream,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
        Box::pin(async move {
            let cancellation = CancellationToken::new();
            let _cancel_on_drop = cancellation.clone().drop_guard();
            let generation = async {
                match self.selection_id {
                    Some(selection_id) => {
                        self.provider
                            .generate_selected_text_cancellable(
                                self.request,
                                selection_id,
                                cancellation.clone(),
                            )
                            .await
                    }
                    None => {
                        self.provider
                            .generate_text_cancellable(self.request, cancellation.clone())
                            .await
                    }
                }
            };
            let mut extra = [0_u8; 1];
            let response = tokio::select! {
                biased;
                disconnected = stream.read(&mut extra) => {
                    cancellation.cancel();
                    disconnected?;
                    return Ok(());
                }
                _ = tokio::time::sleep(MAX_DURATION) => {
                    cancellation.cancel();
                    failure(504, "deadline", "Text generation exceeded its time limit; the provider request may already have occurred")
                }
                outcome = generation => match outcome {
                    Ok(ProviderTextGenerationOutcome::Generated { response, .. }) => {
                        if response.text.trim().is_empty() || response.text.len() > MAX_OUTPUT_BYTES
                            || !matches!(response.finish_reason, Some(LlmFinishReason::Stop)) {
                            failure(502, "invalid-response", "The provider returned empty, incomplete or oversized text")
                        } else {
                            Response::json(200, json!({"text": response.text}))
                        }
                    }
                    Ok(ProviderTextGenerationOutcome::Rejected) => failure(422, "selection-unavailable", "Configure a supported text or image-understanding model and its route"),
                    Ok(ProviderTextGenerationOutcome::Unavailable { reason }) => unavailable(reason),
                    Ok(ProviderTextGenerationOutcome::Cancelled) => failure(499, "cancelled", "Text generation was cancelled; the provider request may already have occurred"),
                    Err(()) => failure(503, "owner-unavailable", "The provider owner is unavailable"),
                },
            };
            let body = serde_json::to_vec(response.body()).map_err(io::Error::other)?;
            let head = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status(),
                reason_phrase(response.status()),
                body.len(),
            );
            tokio::time::timeout(Duration::from_secs(30), async {
                stream.write_all(head.as_bytes()).await?;
                stream.write_all(&body).await
            })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "text response write timed out"))?
        })
    }
}

fn unavailable(reason: ProviderTextGenerationUnavailableReason) -> Response {
    use ProviderTextGenerationUnavailableReason::*;
    let (status, code, message) = match reason {
        CredentialMissing => (
            503,
            "credential-missing",
            "Add credentials to the selected provider account",
        ),
        CredentialUnavailable => (
            503,
            "credential-unavailable",
            "Provider credentials could not be resolved",
        ),
        Authentication => (
            502,
            "authentication",
            "The text provider rejected its credentials",
        ),
        PermissionDenied => (
            502,
            "permission-denied",
            "The text provider denied this request",
        ),
        RateLimited => (
            429,
            "rate-limited",
            "The text provider rate limit was reached",
        ),
        Deadline => (
            504,
            "deadline",
            "Text generation exceeded its time limit; the provider request may already have occurred",
        ),
        InvalidResponse => (
            502,
            "invalid-response",
            "The text provider returned an invalid response",
        ),
        ProviderUnavailable => (
            503,
            "provider-unavailable",
            "The text provider is unavailable",
        ),
    };
    failure(status, code, message)
}

fn invalid_request() -> Response {
    failure(
        400,
        "invalid-request",
        "Text request or input image is invalid",
    )
}

fn unauthorized() -> Response {
    failure(
        401,
        "unauthorized",
        "Text capability authorization is invalid",
    )
}

fn failure(status: u16, code: &str, message: &str) -> Response {
    Response::json(
        status,
        json!({"success": false, "code": code, "error": message}),
    )
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        499 => "Client Closed Request",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Internal Server Error",
    }
}
