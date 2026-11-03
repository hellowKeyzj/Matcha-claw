use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Url};
use serde_json::{Value, json};

use crate::{ProviderModel, llm_client::LlmCredential};

use super::{
    Capabilities, Content, Failure, Kind, MAX_OUTPUT_BYTES, MAX_OUTPUT_COUNT, Output, RemoteVideo,
    Request, VideoStatus, wire,
};

// Official Interactions schemas: googleapis/python-genai, google/genai/_gaos/types/interactions.
// Keep existing generateContent models on their existing API; never retry through another API.
fn uses_interactions_image(model: &ProviderModel) -> bool {
    matches!(
        model.model_id().trim_start_matches("models/"),
        "gemini-nano-banana-2.1" | "gemini-3.1-flash-lite-image"
    )
}

pub(super) fn capabilities(model: &ProviderModel, kind: Kind) -> Result<Capabilities, Failure> {
    let name = model.model_id().trim_start_matches("models/");
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
        Kind::Image => {
            if matches!(
                name,
                "gemini-2.5-flash-image"
                    | "gemini-2.5-flash-image-preview"
                    | "gemini-3-pro-image-preview"
                    | "gemini-3-pro-image"
                    | "gemini-3.1-flash-image"
                    | "gemini-3.1-flash-image-preview"
                    | "gemini-3.1-flash-lite-image"
            ) {
                limits.max_images = 1;
            }
            limits.sizes = match name {
                "gemini-3-pro-image-preview" | "gemini-3-pro-image" | "gemini-nano-banana-2.1" => {
                    Some(vec!["1K", "2K", "4K"])
                }
                "gemini-3.1-flash-image" | "gemini-3.1-flash-image-preview" => {
                    Some(vec!["512", "1K", "2K", "4K"])
                }
                _ => None,
            }
            .map(|sizes| sizes.into_iter().map(str::to_owned).collect());
            if name == "gemini-nano-banana-2.1" {
                limits.max_images = 14;
            }
        }
        Kind::Video if name == "gemini-omni-1.1-flash" => {
            limits.max_images = 1;
            limits.sizes = Some(
                ["360p", "720p", "1080p", "4k"]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
            );
            limits.durations_seconds = Some((3..=10).collect());
        }
        Kind::Speech if matches!(name, "gemini-3.8-flash-tts" | "gemini-3.8-flash-lite-tts") => {}
        Kind::Music if name == "lyria-3.5" => {}
        _ => return Err(Failure::Unsupported),
    }
    if model.quality().is_some() {
        return Err(Failure::Unsupported);
    }
    Ok(limits)
}

pub(super) fn validate(model: &ProviderModel, request: &Request) -> Result<(), Failure> {
    let name = model.model_id().trim_start_matches("models/");
    if name.is_empty()
        || name.len() > 512
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || matches!(name, "." | "..")
        || request.mask.is_some()
        || request.count.unwrap_or(1) != 1
        || request.audio.is_some()
        || model.quality().is_some()
    {
        return Err(Failure::Unsupported);
    }
    match request.kind {
        Kind::Image => {
            if !uses_interactions_image(model) && !name.starts_with("gemini-")
                || request.duration_seconds.is_some()
                || request.voice.is_some()
                || request.language.is_some()
                || request
                    .size
                    .as_deref()
                    .or(model.resolution())
                    .is_some_and(|size| !matches!(size, "512" | "1K" | "2K" | "4K"))
            {
                return Err(Failure::Unsupported);
            }
            if uses_interactions_image(model) {
                let limits = capabilities(model, Kind::Image)?;
                if request.images.len() > usize::from(limits.max_images)
                    || request
                        .size
                        .as_deref()
                        .or(model.resolution())
                        .is_some_and(|size| {
                            !limits.sizes.as_ref().is_some_and(|sizes| {
                                sizes.iter().any(|supported| supported == size)
                            })
                        })
                    || model.aspect_ratio().is_some_and(|ratio| {
                        name != "gemini-nano-banana-2.1"
                            || !matches!(
                                ratio,
                                "1:1"
                                    | "2:3"
                                    | "3:2"
                                    | "3:4"
                                    | "4:3"
                                    | "4:5"
                                    | "5:4"
                                    | "9:16"
                                    | "16:9"
                                    | "21:9"
                                    | "1:8"
                                    | "8:1"
                                    | "1:4"
                                    | "4:1"
                            )
                    })
                {
                    return Err(Failure::Unsupported);
                }
            }
        }
        Kind::Video => {
            let limits = capabilities(model, Kind::Video)?;
            if request.images.len() > usize::from(limits.max_images)
                || request.voice.is_some()
                || request.language.is_some()
                || request
                    .duration_seconds
                    .is_some_and(|seconds| !(3..=10).contains(&seconds))
                || request
                    .size
                    .as_deref()
                    .or(model.resolution())
                    .is_some_and(|size| !matches!(size, "360p" | "720p" | "1080p" | "4k"))
                || model
                    .aspect_ratio()
                    .is_some_and(|ratio| !matches!(ratio, "16:9" | "9:16"))
            {
                return Err(Failure::Unsupported);
            }
        }
        Kind::Speech | Kind::Music => {
            capabilities(model, request.kind)?;
            if !request.images.is_empty()
                || request.size.is_some()
                || request.duration_seconds.is_some()
                || model.resolution().is_some()
                || model.aspect_ratio().is_some()
                || request.kind == Kind::Music
                    && (request.voice.is_some() || request.language.is_some())
            {
                return Err(Failure::Unsupported);
            }
        }
        Kind::Transcription => return Err(Failure::Unsupported),
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
    if request.kind == Kind::Image && !uses_interactions_image(model) {
        return generate_content_image(client, endpoint, credential, model, request).await;
    }
    let mut body = json!({
        "model": model.model_id().trim_start_matches("models/"),
        "input": interaction_input(&request),
        "store": false,
    });
    let output_type = match request.kind {
        Kind::Image => {
            let mut format = json!({"type": "image", "delivery": "inline"});
            if let Some(size) = request.size.as_deref().or(model.resolution()) {
                format["image_size"] = json!(size);
            }
            if let Some(ratio) = model.aspect_ratio() {
                format["aspect_ratio"] = json!(ratio);
            }
            body["response_format"] = format;
            "image"
        }
        Kind::Speech => {
            // Unary Gemini 3.8 TTS supports WAV; do not label headerless PCM as WAV.
            body["response_format"] =
                json!({"type": "audio", "mime_type": "audio/wav", "delivery": "inline"});
            if request.voice.is_some() || request.language.is_some() {
                let mut speaker = json!({});
                if let Some(voice) = request.voice {
                    speaker["voice"] = json!(voice);
                }
                if let Some(language) = request.language {
                    speaker["language"] = json!(language);
                }
                body["generation_config"] = json!({"speech_config": [speaker]});
            }
            "audio"
        }
        Kind::Music => "audio",
        _ => return Err(Failure::Unsupported),
    };
    let value = create_interaction(client, endpoint, credential, body).await?;
    require_completed(&value)?;
    interaction_output(client, endpoint, credential, value, output_type).await
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
    let mut format = json!({"type": "video", "delivery": "uri"});
    if let Some(seconds) = request.duration_seconds {
        format["duration"] = json!(format!("{seconds}s"));
    }
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        format["resolution"] = json!(size);
    }
    if let Some(ratio) = model.aspect_ratio() {
        format["aspect_ratio"] = json!(ratio);
    }
    let task = if request.images.is_empty() {
        "text_to_video"
    } else {
        "image_to_video"
    };
    let body = json!({
        "model": model.model_id().trim_start_matches("models/"),
        "input": interaction_input(&request),
        "generation_config": {"video_config": {"task": task}},
        "response_format": format,
        // Background execution requires storage, including when create already completes.
        "background": true,
        "store": true,
    });
    remote_video(&create_interaction(client, endpoint, credential, body).await?)
}

pub(super) async fn query_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<RemoteVideo, Failure> {
    let value = get_interaction(client, endpoint, credential, id).await?;
    remote_video(&value)
}

pub(super) async fn collect_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<Output, Failure> {
    // GET can return inline bytes even when the initial create returned a URI.
    // The receipt therefore stores only the interaction resource, never that URI.
    let value = get_interaction(client, endpoint, credential, id).await?;
    require_completed(&value)?;
    interaction_output(client, endpoint, credential, value, "video").await
}

pub(super) fn is_remote_id(id: &str) -> bool {
    id.strip_prefix("interactions/").is_some_and(is_token)
}

fn is_token(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 2048
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn remote_video(value: &Value) -> Result<RemoteVideo, Failure> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or(Failure::InvalidResponse)?;
    if !is_token(id) {
        return Err(Failure::InvalidResponse);
    }
    Ok(RemoteVideo {
        id: format!("interactions/{id}"),
        status: interaction_status(value),
        progress: None,
    })
}

fn interaction_status(value: &Value) -> VideoStatus {
    match value.get("status").and_then(Value::as_str) {
        Some("queued") => VideoStatus::Queued,
        Some("in_progress") => VideoStatus::InProgress,
        Some("completed") => VideoStatus::Completed,
        Some(
            "failed"
            | "cancelled"
            | "incomplete"
            | "budget_exceeded"
            | "requires_action"
            | "requires_continuation",
        ) => VideoStatus::Failed,
        _ => VideoStatus::Unknown,
    }
}

fn require_completed(value: &Value) -> Result<(), Failure> {
    match interaction_status(value) {
        VideoStatus::Completed => Ok(()),
        VideoStatus::Failed => Err(Failure::GenerationFailed),
        _ => Err(Failure::InvalidResponse),
    }
}

fn interaction_input(request: &Request) -> Vec<Value> {
    let mut parts = vec![json!({"type": "text", "text": request.prompt})];
    parts.extend(
        request.images.iter().map(
            |image| json!({"type": "image", "mime_type": image.mime_type, "data": image.data}),
        ),
    );
    parts
}

async fn create_interaction(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    body: Value,
) -> Result<Value, Failure> {
    wire::json(
        wire::json_body(
            client
                .post(wire::resource(endpoint, &["interactions"])?)
                .header("x-goog-api-key", credential.token())
                .header("Api-Revision", "2026-05-20"),
            body,
        )?,
        wire::MAX_JSON_BYTES,
    )
    .await
}

async fn get_interaction(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<Value, Failure> {
    if !is_remote_id(id) {
        return Err(Failure::InvalidRequest);
    }
    let token = &id["interactions/".len()..];
    let mut url = wire::resource(endpoint, &["interactions", token])?;
    url.query_pairs_mut().append_pair("stream", "false");
    let value = wire::json(
        client
            .get(url)
            .header("x-goog-api-key", credential.token())
            .header("Api-Revision", "2026-05-20"),
        wire::MAX_JSON_BYTES,
    )
    .await?;
    if value.get("id").and_then(Value::as_str) != Some(token) {
        return Err(Failure::InvalidResponse);
    }
    Ok(value)
}

async fn interaction_output(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    mut value: Value,
    output_type: &str,
) -> Result<Output, Failure> {
    let steps = value
        .get_mut("steps")
        .and_then(Value::as_array_mut)
        .ok_or(Failure::InvalidResponse)?;
    let mut outputs = Vec::new();
    let mut remaining = MAX_OUTPUT_BYTES;
    for step in steps {
        if step.get("type").and_then(Value::as_str) != Some("model_output") {
            continue;
        }
        if step.get("error").is_some_and(|error| !error.is_null()) {
            return Err(Failure::GenerationFailed);
        }
        let Some(parts) = step.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for part in parts {
            if part.get("type").and_then(Value::as_str) != Some(output_type) {
                continue;
            }
            if outputs.len() == usize::from(MAX_OUTPUT_COUNT) {
                return Err(Failure::InvalidResponse);
            }
            let mime_type = part
                .get("mime_type")
                .and_then(Value::as_str)
                .ok_or(Failure::InvalidResponse)?
                .to_owned();
            if !mime_type.starts_with(&format!("{output_type}/")) {
                return Err(Failure::InvalidResponse);
            }
            let output = if let Some(data) = part.get_mut("data").and_then(wire::take_string) {
                if data.len() > remaining.saturating_add(2) / 3 * 4 {
                    return Err(Failure::ResponseTooLarge);
                }
                let bytes = STANDARD
                    .decode(data)
                    .map_err(|_| Failure::InvalidResponse)?;
                wire::media_output(bytes, &mime_type, &mut remaining)?
            } else {
                let uri = part
                    .get("uri")
                    .and_then(Value::as_str)
                    .ok_or(Failure::InvalidResponse)?;
                download_file(
                    client,
                    endpoint,
                    credential,
                    uri,
                    &mime_type,
                    &mut remaining,
                )
                .await?
            };
            outputs.push(output);
        }
    }
    if outputs.is_empty() {
        return Err(Failure::GenerationFailed);
    }
    Ok(Output { outputs })
}

async fn download_file(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    uri: &str,
    mime_type: &str,
    remaining: &mut usize,
) -> Result<Content, Failure> {
    let uri = Url::parse(uri).map_err(|_| Failure::InvalidResponse)?;
    // Only the documented Developer API file service receives the account key.
    // In particular, neither a custom endpoint's arbitrary URI nor a CDN gets it.
    if endpoint.scheme() != "https"
        || endpoint.host_str() != Some("generativelanguage.googleapis.com")
        || endpoint.port_or_known_default() != Some(443)
        || uri.origin() != endpoint.origin()
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.fragment().is_some()
        || uri.query().is_some_and(|query| query != "alt=media")
    {
        return Err(Failure::Unsupported);
    }
    let path = uri.path().strip_suffix(":download").unwrap_or(uri.path());
    let file_id = path
        .strip_prefix("/v1beta/files/")
        .or_else(|| path.strip_prefix("/v1/files/"))
        .or_else(|| path.strip_prefix("/files/"))
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 256
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
        .ok_or(Failure::InvalidResponse)?;
    let file_url = wire::resource(endpoint, &["files", file_id])?;
    loop {
        let metadata = wire::json(
            client
                .get(file_url.clone())
                .header("x-goog-api-key", credential.token()),
            256 * 1024,
        )
        .await?;
        if metadata.get("name").and_then(Value::as_str) != Some(format!("files/{file_id}").as_str())
        {
            return Err(Failure::InvalidResponse);
        }
        match metadata.get("state").and_then(Value::as_str) {
            Some("ACTIVE") => break,
            Some("PROCESSING") => tokio::time::sleep(Duration::from_secs(2)).await,
            Some("FAILED") => return Err(Failure::GenerationFailed),
            _ => return Err(Failure::InvalidResponse),
        }
    }
    let mut download = wire::resource(endpoint, &["files", &format!("{file_id}:download")])?;
    download.query_pairs_mut().append_pair("alt", "media");
    let response = wire::send(
        client
            .get(download)
            .header("x-goog-api-key", credential.token()),
    )
    .await?;
    let response_mime = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .ok_or(Failure::InvalidResponse)?;
    if response_mime != mime_type {
        return Err(Failure::InvalidResponse);
    }
    wire::media_output(
        wire::bytes(response, *remaining).await?,
        mime_type,
        remaining,
    )
}

async fn generate_content_image(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let mut parts = vec![json!({"text": request.prompt})];
    parts.extend(
        request
            .images
            .into_iter()
            .map(|image| json!({"inlineData": {"data": image.data, "mimeType": image.mime_type}})),
    );
    let mut config = json!({"responseModalities": ["TEXT", "IMAGE"]});
    let mut image_config = json!({});
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        image_config["imageSize"] = json!(size);
    }
    if let Some(aspect_ratio) = model.aspect_ratio() {
        image_config["aspectRatio"] = json!(aspect_ratio);
    }
    if image_config
        .as_object()
        .is_some_and(|config| !config.is_empty())
    {
        config["imageConfig"] = image_config;
    }
    let body = json!({"contents": [{"role": "user", "parts": parts}], "generationConfig": config});
    let model_id = format!(
        "{}:generateContent",
        model.model_id().trim_start_matches("models/")
    );
    let request = wire::json_body(
        client
            .post(wire::resource(endpoint, &["models", &model_id])?)
            .header("x-goog-api-key", credential.token()),
        body,
    )?;
    let mut value = wire::json(request, wire::MAX_JSON_BYTES).await?;
    let candidates = value
        .get_mut("candidates")
        .and_then(Value::as_array_mut)
        .ok_or(Failure::GenerationFailed)?;
    if candidates.len() != 1 {
        return Err(Failure::InvalidResponse);
    }
    let parts = candidates[0]
        .get_mut("content")
        .and_then(|content| content.get_mut("parts"))
        .and_then(Value::as_array_mut)
        .ok_or(Failure::GenerationFailed)?;
    let mut outputs = Vec::new();
    let mut remaining = MAX_OUTPUT_BYTES;
    for part in parts {
        let inline_key = if part.get("inlineData").is_some() {
            "inlineData"
        } else {
            "inline_data"
        };
        let Some(inline) = part.get_mut(inline_key) else {
            continue;
        };
        if outputs.len() == usize::from(MAX_OUTPUT_COUNT) {
            return Err(Failure::InvalidResponse);
        }
        let mime_type = inline
            .get("mimeType")
            .or_else(|| inline.get("mime_type"))
            .and_then(Value::as_str)
            .ok_or(Failure::InvalidResponse)?
            .to_owned();
        let data = inline
            .get_mut("data")
            .and_then(wire::take_string)
            .ok_or(Failure::InvalidResponse)?;
        let output = wire::image_output(data, &mut remaining)?;
        if output.mime_type != mime_type {
            return Err(Failure::InvalidResponse);
        }
        outputs.push(output);
    }
    if outputs.is_empty() {
        return Err(Failure::GenerationFailed);
    }
    Ok(Output { outputs })
}
