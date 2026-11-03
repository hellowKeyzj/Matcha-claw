use reqwest::{Client, Response, StatusCode, Url};
use serde_json::{Value, json};

use crate::{ProviderModel, llm_client::LlmCredential};

use super::{
    Capabilities, Content, Failure, Kind, MAX_OUTPUT_BYTES, Output, RemoteVideo, Request,
    VideoStatus, wire,
};

// The model discovery record is a union, not an endpoint guarantee. Only these
// independently verified models expose optional controls without provider routing.
const GPT_IMAGE: &str = "openai/gpt-image-1";
const SEEDREAM: &str = "bytedance-seed/seedream-4.5";
const IMAGE_RATIOS: &[&str] = &[
    "1:1", "1:2", "2:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:19.5",
    "19.5:9", "9:20", "20:9", "9:21", "21:9", "auto",
];

pub(super) fn capabilities(model: &ProviderModel, kind: Kind) -> Result<Capabilities, Failure> {
    let mut limits = Capabilities {
        max_images: 0,
        max_count: 1,
        mask: false,
        pixel_size: false,
        pixel_size_limits: None,
        sizes: None,
        durations_seconds: None,
        storyboard: false,
    };
    match kind {
        Kind::Image => match model.model_id() {
            GPT_IMAGE => {
                limits.max_images = 16;
                limits.max_count = 10;
            }
            SEEDREAM => {
                limits.max_images = 14;
                limits.max_count = 10;
                limits.sizes = Some(vec!["1K".into(), "2K".into(), "4K".into()]);
            }
            _ => {}
        },
        Kind::Video => {
            if let Some((sizes, durations, _)) = video_parameters(model) {
                limits.max_images = 1;
                limits.sizes = Some(sizes.iter().map(|size| (*size).to_owned()).collect());
                limits.durations_seconds = Some(durations.to_vec());
            }
        }
        Kind::Speech | Kind::Transcription => {}
        Kind::Music => return Err(Failure::Unsupported),
    }
    Ok(limits)
}

pub(super) fn validate(model: &ProviderModel, request: &Request) -> Result<(), Failure> {
    let limits = capabilities(model, request.kind)?;
    if request.mask.is_some()
        || request.images.len() > usize::from(limits.max_images)
        || request.count.unwrap_or(1) > limits.max_count
        || request
            .size
            .as_deref()
            .or(model.resolution())
            .is_some_and(|size| {
                !limits
                    .sizes
                    .as_ref()
                    .is_some_and(|sizes| sizes.iter().any(|supported| supported == size))
            })
        || request.duration_seconds.is_some_and(|seconds| {
            !limits
                .durations_seconds
                .as_ref()
                .is_some_and(|durations| durations.contains(&seconds))
        })
    {
        return Err(Failure::Unsupported);
    }
    let quality_supported = match request.kind {
        Kind::Image if model.model_id() == GPT_IMAGE => model
            .quality()
            .is_none_or(|quality| matches!(quality, "auto" | "low" | "medium" | "high")),
        _ => model.quality().is_none(),
    };
    let ratio_supported = match request.kind {
        Kind::Image if model.model_id() == GPT_IMAGE => model
            .aspect_ratio()
            .is_none_or(|ratio| matches!(ratio, "1:1" | "3:2" | "2:3" | "auto")),
        Kind::Image if model.model_id() == SEEDREAM => model
            .aspect_ratio()
            .is_none_or(|ratio| IMAGE_RATIOS.contains(&ratio)),
        Kind::Video => model.aspect_ratio().is_none_or(|ratio| {
            video_parameters(model).is_some_and(|(_, _, ratios)| ratios.contains(&ratio))
        }),
        _ => model.aspect_ratio().is_none(),
    };
    if !quality_supported || !ratio_supported {
        return Err(Failure::Unsupported);
    }
    match request.kind {
        Kind::Image | Kind::Video => {
            if request.audio.is_some() || request.voice.is_some() || request.language.is_some() {
                return Err(Failure::Unsupported);
            }
        }
        Kind::Speech => {
            if request.audio.is_some() || request.language.is_some() {
                return Err(Failure::Unsupported);
            }
        }
        Kind::Transcription => {
            if !request.prompt.is_empty() || request.voice.is_some() {
                return Err(Failure::Unsupported);
            }
            let audio = request.audio.as_ref().ok_or(Failure::InvalidRequest)?;
            audio_format(&audio.mime_type)?;
            if request.language.as_ref().is_some_and(|language| {
                language.len() != 2 || !language.bytes().all(|byte| byte.is_ascii_lowercase())
            }) {
                return Err(Failure::Unsupported);
            }
        }
        Kind::Music => return Err(Failure::Unsupported),
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
    match request.kind {
        Kind::Image => generate_image(client, endpoint, credential, model, request).await,
        Kind::Speech => speech(client, endpoint, credential, model, request).await,
        Kind::Transcription => transcribe(client, endpoint, credential, model, request).await,
        Kind::Video | Kind::Music => Err(Failure::Unsupported),
    }
}

async fn generate_image(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let count = request.count.unwrap_or(1);
    let mut body = json!({
        "model": model.model_id(),
        "prompt": request.prompt,
        "n": count,
        "provider": {"allow_fallbacks": false},
    });
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        body["resolution"] = json!(size);
    }
    if let Some(ratio) = model.aspect_ratio() {
        body["aspect_ratio"] = json!(ratio);
    }
    if let Some(quality) = model.quality() {
        body["quality"] = json!(quality);
    }
    if !request.images.is_empty() {
        body["input_references"] =
            Value::Array(request.images.iter().map(image_reference).collect());
    }
    let mut response = wire::json(
        wire::json_body(
            client
                .post(wire::resource(endpoint, &["images"])?)
                .bearer_auth(credential.token()),
            body,
        )?,
        wire::MAX_JSON_BYTES,
    )
    .await?;
    let images = response
        .get_mut("data")
        .and_then(Value::as_array_mut)
        .filter(|images| !images.is_empty() && images.len() <= usize::from(count))
        .ok_or(Failure::InvalidResponse)?;
    let mut remaining = MAX_OUTPUT_BYTES;
    let mut outputs = Vec::with_capacity(images.len());
    for image in images {
        let data = image
            .get_mut("b64_json")
            .and_then(wire::take_string)
            .ok_or(Failure::InvalidResponse)?;
        let output = wire::image_output(data, &mut remaining)?;
        if image
            .get("media_type")
            .is_some_and(|mime| mime.as_str() != Some(&output.mime_type))
        {
            return Err(Failure::InvalidResponse);
        }
        outputs.push(output);
    }
    Ok(Output { outputs })
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
    let mut body = json!({"model": model.model_id(), "prompt": request.prompt});
    if let Some(seconds) = request.duration_seconds {
        body["duration"] = json!(seconds);
    }
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        let field = if size.contains('x') {
            "size"
        } else {
            "resolution"
        };
        body[field] = json!(size);
    }
    if let Some(ratio) = model.aspect_ratio() {
        body["aspect_ratio"] = json!(ratio);
    }
    if let Some(image) = request.images.first() {
        let mut frame = image_reference(image);
        frame["frame_type"] = json!("first_frame");
        body["frame_images"] = json!([frame]);
    }
    let response = wire::send(wire::json_body(
        client
            .post(wire::resource(endpoint, &["videos"])?)
            .bearer_auth(credential.token()),
        body,
    )?)
    .await?;
    if response.status() != StatusCode::ACCEPTED {
        return Err(Failure::InvalidResponse);
    }
    let bytes = wire::bytes(response, 256 * 1024).await?;
    decode_video(serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidResponse)?)
}

pub(super) async fn query_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<RemoteVideo, Failure> {
    if !is_remote_id(id) {
        return Err(Failure::InvalidRequest);
    }
    let response = wire::json(
        client
            .get(wire::resource(endpoint, &["videos", id])?)
            .bearer_auth(credential.token()),
        256 * 1024,
    )
    .await?;
    let job = decode_video(response)?;
    if job.id != id {
        return Err(Failure::InvalidResponse);
    }
    Ok(job)
}

pub(super) async fn collect_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<Output, Failure> {
    if !is_remote_id(id) {
        return Err(Failure::InvalidRequest);
    }
    // Never authenticate a returned polling/signed URL. This authenticated content
    // resource is constructed from the bound original endpoint and opaque job ID.
    let response = wire::send(
        client
            .get(wire::resource(endpoint, &["videos", id, "content"])?)
            .bearer_auth(credential.token()),
    )
    .await?;
    binary_output(response, "video/mp4").await
}

pub(super) fn is_remote_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn decode_video(response: Value) -> Result<RemoteVideo, Failure> {
    let id = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_remote_id(id))
        .ok_or(Failure::InvalidResponse)?;
    let status = match response.get("status").and_then(Value::as_str) {
        Some("pending") => VideoStatus::Queued,
        Some("in_progress") => VideoStatus::InProgress,
        Some("completed") => VideoStatus::Completed,
        // All three are terminal jobs with no collectable result in the SDK model.
        Some("failed" | "cancelled" | "expired") => VideoStatus::Failed,
        _ => return Err(Failure::InvalidResponse),
    };
    Ok(RemoteVideo {
        id: id.to_owned(),
        status,
        progress: None,
    })
}

async fn speech(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let mut body = json!({
        "model": model.model_id(),
        "input": request.prompt,
        "response_format": "mp3",
    });
    if let Some(voice) = request.voice {
        body["voice"] = json!(voice);
    }
    let response = wire::send(wire::json_body(
        client
            .post(wire::resource(endpoint, &["audio", "speech"])?)
            .bearer_auth(credential.token()),
        body,
    )?)
    .await?;
    binary_output(response, "audio/mpeg").await
}

async fn transcribe(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let audio = request.audio.ok_or(Failure::InvalidRequest)?;
    let mut body = json!({
        "model": model.model_id(),
        "input_audio": {"format": audio_format(&audio.mime_type)?, "data": audio.data},
        "response_format": "json",
    });
    if let Some(language) = request.language {
        body["language"] = json!(language);
    }
    let mut response = wire::json(
        wire::json_body(
            client
                .post(wire::resource(endpoint, &["audio", "transcriptions"])?)
                .bearer_auth(credential.token()),
            body,
        )?,
        1024 * 1024,
    )
    .await?;
    let text = response
        .get_mut("text")
        .and_then(wire::take_string)
        .ok_or(Failure::InvalidResponse)?;
    let mut remaining = MAX_OUTPUT_BYTES;
    Ok(Output {
        outputs: vec![wire::media_output(
            text.into_bytes(),
            "text/plain",
            &mut remaining,
        )?],
    })
}

async fn binary_output(response: Response, expected_mime: &str) -> Result<Output, Failure> {
    let mime = response
        .headers()
        .get("content-type")
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.split(';').next())
        .map(str::trim)
        .ok_or(Failure::InvalidResponse)?;
    if mime != expected_mime {
        return Err(Failure::InvalidResponse);
    }
    let bytes = wire::bytes(response, MAX_OUTPUT_BYTES).await?;
    let mut remaining = MAX_OUTPUT_BYTES;
    Ok(Output {
        outputs: vec![wire::media_output(bytes, expected_mime, &mut remaining)?],
    })
}

fn image_reference(image: &Content) -> Value {
    json!({
        "type": "image_url",
        "image_url": {"url": format!("data:{};base64,{}", image.mime_type, image.data)},
    })
}

// Conservative controls from the official /videos/models records. Image inputs
// are first-frame only; two images do not imply storyboard/reference support.
fn video_parameters(
    model: &ProviderModel,
) -> Option<(
    &'static [&'static str],
    &'static [u32],
    &'static [&'static str],
)> {
    match model.model_id() {
        "google/veo-3.1" => Some((
            &[
                "720p",
                "1080p",
                "4K",
                "1280x720",
                "720x1280",
                "1920x1080",
                "1080x1920",
                "3840x2160",
                "2160x3840",
            ],
            &[4, 6, 8],
            &["16:9", "9:16"],
        )),
        "bytedance/seedance-2.0" => Some((
            &[
                "480p",
                "720p",
                "1080p",
                "4K",
                "480x480",
                "480x640",
                "480x854",
                "640x480",
                "854x480",
                "1120x480",
                "720x720",
                "720x960",
                "720x1280",
                "720x1680",
                "960x720",
                "1280x720",
                "1680x720",
                "1080x1080",
                "1080x1440",
                "1080x1920",
                "1440x1080",
                "1920x1080",
                "2520x1080",
                "3840x2160",
                "2160x3840",
                "2160x2160",
                "2880x2160",
                "2160x2880",
                "5040x2160",
            ],
            &[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            &["1:1", "3:4", "9:16", "4:3", "16:9", "21:9", "9:21"],
        )),
        "alibaba/wan-2.7" => Some((
            &[
                "720p",
                "1080p",
                "1280x720",
                "720x1280",
                "1920x1080",
                "1080x1920",
                "720x720",
                "1080x1080",
                "960x720",
                "720x960",
                "1440x1080",
                "1080x1440",
            ],
            &[2, 3, 4, 5, 6, 7, 8, 9, 10],
            &["16:9", "9:16", "1:1", "4:3", "3:4"],
        )),
        _ => None,
    }
}

fn audio_format(mime_type: &str) -> Result<&'static str, Failure> {
    match mime_type {
        "audio/wav" => Ok("wav"),
        "audio/mpeg" => Ok("mp3"),
        "audio/flac" => Ok("flac"),
        _ => Err(Failure::Unsupported),
    }
}
