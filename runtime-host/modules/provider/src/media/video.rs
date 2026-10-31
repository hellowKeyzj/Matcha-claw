use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Url, multipart::Form};
use serde::Deserialize;
use serde_json::Value;

use crate::{ProviderModel, llm_client::LlmCredential};

use super::{Content, Failure, MAX_OUTPUT_BYTES, Output, Request, image::is_pixel_size, wire};

pub(super) fn validate_openai(model: &ProviderModel, request: &Request) -> Result<(), Failure> {
    if request.mask.is_some()
        || request.images.len() > 1
        || request.count.unwrap_or(1) != 1
        || model.quality().is_some()
        || model.aspect_ratio().is_some()
        || request
            .duration_seconds
            .is_some_and(|seconds| !matches!(seconds, 4 | 8 | 12))
        || request
            .size
            .as_deref()
            .or(model.resolution())
            .is_some_and(|size| !is_pixel_size(size))
    {
        return Err(Failure::Unsupported);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Queued,
    InProgress,
    Completed,
    Failed,
}

#[derive(Deserialize)]
struct Job {
    id: String,
    status: Status,
    error: Option<Value>,
}

impl Job {
    fn decode(value: Value) -> Result<Self, Failure> {
        let job = serde_json::from_value::<Self>(value).map_err(|_| Failure::InvalidResponse)?;
        if !is_remote_id(&job.id) {
            return Err(Failure::InvalidResponse);
        }
        Ok(job)
    }
}

pub(super) fn is_remote_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(super) async fn openai(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let mut job = Job::decode(submit(client, endpoint, credential, model, request).await?)?;
    let id = job.id.clone();
    loop {
        if job.error.is_some() {
            return Err(Failure::GenerationFailed);
        }
        match job.status {
            Status::Completed => break,
            Status::Failed => return Err(Failure::GenerationFailed),
            Status::Queued | Status::InProgress => {
                tokio::time::sleep(Duration::from_secs(2)).await;
                job = Job::decode(query(client, endpoint, credential, &id).await?)?;
                if job.id != id {
                    return Err(Failure::InvalidResponse);
                }
            }
        }
    }
    collect(client, endpoint, credential, &id).await
}

pub(super) async fn submit(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Value, Failure> {
    let mut form = Form::new()
        .text("model", model.model_id().to_owned())
        .text("prompt", request.prompt);
    if let Some(seconds) = request.duration_seconds {
        form = form.text("seconds", seconds.to_string());
    }
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        form = form.text("size", size.to_owned());
    }
    if let Some(image) = request.images.first() {
        form = form.part("input_reference", wire::image_part(image)?);
    }
    wire::json(
        client
            .post(wire::resource(endpoint, &["videos"])?)
            .bearer_auth(credential.token())
            .multipart(form),
        256 * 1024,
    )
    .await
}

pub(super) async fn query(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<Value, Failure> {
    wire::json(
        client
            .get(wire::resource(endpoint, &["videos", id])?)
            .bearer_auth(credential.token()),
        256 * 1024,
    )
    .await
}

pub(super) async fn collect(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<Output, Failure> {
    let response = wire::send(
        client
            .get(wire::resource(endpoint, &["videos", id, "content"])?)
            .bearer_auth(credential.token()),
    )
    .await?;
    let mime_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .ok_or(Failure::InvalidResponse)?
        .to_owned();
    if mime_type != "video/mp4" {
        return Err(Failure::InvalidResponse);
    }
    let bytes = wire::bytes(response, MAX_OUTPUT_BYTES).await?;
    if bytes.get(4..8) != Some(b"ftyp") {
        return Err(Failure::InvalidResponse);
    }
    Ok(Output {
        outputs: vec![Content {
            data: STANDARD.encode(bytes),
            mime_type,
        }],
    })
}
