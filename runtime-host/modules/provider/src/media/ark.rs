use reqwest::{Client, Url};
use serde_json::{Value, json};

use crate::{ProviderModel, llm_client::LlmCredential};

use super::{
    Capabilities, Content, Failure, Kind, MAX_OUTPUT_BYTES, Output, RemoteVideo, Request,
    VideoStatus, wire,
};

// Native schema: https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh
// https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
// https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh
pub(super) fn capabilities(model: &ProviderModel, kind: Kind) -> Result<Capabilities, Failure> {
    if model.quality().is_some() {
        return Err(Failure::Unsupported);
    }
    let mut limits = Capabilities {
        max_images: 0,
        max_count: 1,
        mask: false,
        endpoint_validates_options: true,
        pixel_size: false,
        pixel_size_limits: None,
        sizes: None,
        durations_seconds: None,
        storyboard: false,
    };
    match kind {
        Kind::Image => {
            if model.aspect_ratio().is_some() {
                return Err(Failure::Unsupported);
            }
            limits.max_images = 16;
        }
        Kind::Video => limits.max_images = 2,
        _ => return Err(Failure::Unsupported),
    }
    Ok(limits)
}

pub(super) fn validate(model: &ProviderModel, request: &Request) -> Result<(), Failure> {
    let limits = capabilities(model, request.kind)?;
    if request.mask.is_some()
        || request.audio.is_some()
        || request.voice.is_some()
        || request.language.is_some()
        || request.count.unwrap_or(1) != 1
        || request.images.len() > usize::from(limits.max_images)
        || request.kind == Kind::Image && request.duration_seconds.is_some()
    {
        return Err(Failure::Unsupported);
    }
    // Common Request validation has already checked base64/MIME and the total input budget.
    // Reject a single 30 MiB image before sending Ark's charged request.
    if request
        .images
        .iter()
        .any(|image| image.data.len() >= 40 * 1024 * 1024)
    {
        return Err(Failure::InvalidRequest);
    }
    Ok(())
}

pub(super) async fn generate(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    if request.kind != Kind::Image {
        return Err(Failure::Unsupported);
    }
    generate_image(client, endpoint, credential, model, request).await
}

async fn generate_image(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let mut body = json!({
        "model": model.model_id(),
        "prompt": request.prompt,
        "response_format": "b64_json",
    });
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        body["size"] = json!(size);
    }
    let images = request.images.iter().map(image_uri).collect::<Vec<_>>();
    match images.as_slice() {
        [] => {}
        [image] => body["image"] = json!(image),
        _ => body["image"] = json!(images),
    }
    // Groups choose their own count (max_images is only an upper bound), not SDK count.
    // Leaving sequential_image_generation/stream unset uses native single-image JSON defaults.
    let mut response = wire::json(
        wire::json_body(
            client
                .post(wire::resource(endpoint, &["images", "generations"])?)
                .bearer_auth(credential.token()),
            body,
        )?,
        wire::MAX_JSON_BYTES,
    )
    .await?;
    if has_error(&response) {
        return Err(Failure::GenerationFailed);
    }
    let images = response
        .get_mut("data")
        .and_then(Value::as_array_mut)
        .ok_or(Failure::InvalidResponse)?;
    if images.len() != 1 {
        return Err(Failure::InvalidResponse);
    }
    let image = &mut images[0];
    if has_error(image) {
        return Err(Failure::GenerationFailed);
    }
    let mut remaining = MAX_OUTPUT_BYTES;
    let output = if let Some(data) = image.get_mut("b64_json").and_then(wire::take_string) {
        wire::image_output(data, &mut remaining)?
    } else {
        let url = image
            .get("url")
            .and_then(Value::as_str)
            .ok_or(Failure::InvalidResponse)?;
        let output = wire::download(client, url, &mut remaining).await?;
        if !matches!(
            output.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp"
        ) {
            return Err(Failure::InvalidResponse);
        }
        output
    };
    Ok(Output {
        outputs: vec![output],
    })
}

pub(super) async fn submit_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<RemoteVideo, Failure> {
    if request.kind != Kind::Video {
        return Err(Failure::InvalidRequest);
    }
    let mut content = vec![json!({"type": "text", "text": request.prompt})];
    // SDK images are an ordered first-frame / last-frame pair here, never reference_image.
    for (image, role) in request.images.iter().zip(["first_frame", "last_frame"]) {
        content.push(json!({
            "type": "image_url",
            "image_url": {"url": image_uri(image)},
            "role": role,
        }));
    }
    let mut body = json!({"model": model.model_id(), "content": content});
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        body["resolution"] = json!(size);
    }
    if let Some(ratio) = model.aspect_ratio() {
        body["ratio"] = json!(ratio);
    }
    if let Some(duration) = request.duration_seconds {
        body["duration"] = json!(duration);
    }
    let response = wire::json(
        wire::json_body(
            client
                .post(wire::resource(
                    endpoint,
                    &["contents", "generations", "tasks"],
                )?)
                .bearer_auth(credential.token()),
            body,
        )?,
        256 * 1024,
    )
    .await?;
    if has_error(&response) {
        return Err(Failure::GenerationFailed);
    }
    let id = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_remote_id(id))
        .ok_or(Failure::InvalidResponse)?;
    // Create returns only an ID; do not poll before the caller can persist its receipt.
    Ok(RemoteVideo {
        id: id.to_owned(),
        status: VideoStatus::Queued,
        progress: None,
    })
}

pub(super) async fn query_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<RemoteVideo, Failure> {
    observation(&query(client, endpoint, credential, id).await?)
}

pub(super) async fn collect_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<Output, Failure> {
    // Refresh the original task's URL; expired URLs never cause another charged submission.
    let response = query(client, endpoint, credential, id).await?;
    match observation(&response)?.status {
        VideoStatus::Completed => {}
        VideoStatus::Failed => return Err(Failure::GenerationFailed),
        VideoStatus::Queued | VideoStatus::InProgress => return Err(Failure::InvalidRequest),
        VideoStatus::Unknown => return Err(Failure::InvalidResponse),
    }
    let url = response
        .get("content")
        .and_then(|content| content.get("video_url"))
        .and_then(Value::as_str)
        .ok_or(Failure::InvalidResponse)?;
    // last_frame_url, if present, is an image, not the requested video output.
    let mut remaining = MAX_OUTPUT_BYTES;
    let output = wire::download(client, url, &mut remaining).await?;
    if output.mime_type != "video/mp4" {
        return Err(Failure::InvalidResponse);
    }
    Ok(Output {
        outputs: vec![output],
    })
}

async fn query(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<Value, Failure> {
    if !is_remote_id(id) {
        return Err(Failure::InvalidRequest);
    }
    let response = wire::json(
        client
            .get(wire::resource(
                endpoint,
                &["contents", "generations", "tasks", id],
            )?)
            .bearer_auth(credential.token()),
        256 * 1024,
    )
    .await?;
    if response.get("id").and_then(Value::as_str) != Some(id) {
        return Err(Failure::InvalidResponse);
    }
    Ok(response)
}

fn observation(response: &Value) -> Result<RemoteVideo, Failure> {
    let id = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_remote_id(id))
        .ok_or(Failure::InvalidResponse)?;
    let status = if has_error(response) {
        VideoStatus::Failed
    } else {
        match response.get("status").and_then(Value::as_str) {
            Some("queued") => VideoStatus::Queued,
            Some("running") => VideoStatus::InProgress,
            Some("succeeded") => VideoStatus::Completed,
            Some("failed" | "cancelled" | "expired") => VideoStatus::Failed,
            Some(_) => VideoStatus::Unknown,
            None => return Err(Failure::InvalidResponse),
        }
    };
    Ok(RemoteVideo {
        id: id.to_owned(),
        status,
        progress: None,
    })
}

pub(super) fn is_remote_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn image_uri(image: &Content) -> String {
    format!("data:{};base64,{}", image.mime_type, image.data)
}

fn has_error(response: &Value) -> bool {
    response.get("error").is_some_and(|error| !error.is_null())
}
