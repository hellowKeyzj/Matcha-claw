use reqwest::{
    Client, Url,
    multipart::{Form, Part},
};
use serde_json::{Value, json};

use crate::{ProviderModel, llm_client::LlmCredential};

use super::{
    Capabilities, Failure, Kind, MAX_OUTPUT_BYTES, Output, RemoteVideo, Request, VideoStatus,
    pixel_size, wire,
};

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
    let sizes: Option<&[&str]> = match kind {
        Kind::Image => {
            if model.aspect_ratio().is_some() {
                return Err(Failure::Unsupported);
            }
            match model.model_id() {
                "dall-e-2" => {
                    limits.max_images = 1;
                    limits.max_count = 10;
                    limits.mask = true;
                    if model.quality().is_some_and(|quality| quality != "standard") {
                        return Err(Failure::Unsupported);
                    }
                    Some(&["256x256", "512x512", "1024x1024"])
                }
                "dall-e-3" => {
                    if model
                        .quality()
                        .is_some_and(|quality| !matches!(quality, "standard" | "hd"))
                    {
                        return Err(Failure::Unsupported);
                    }
                    Some(&["1024x1024", "1792x1024", "1024x1792"])
                }
                id if is_gpt_image(id) => {
                    limits.max_images = 16;
                    limits.max_count = 10;
                    limits.mask = true;
                    limits.pixel_size_limits = pixel_size::for_model(id);
                    limits.pixel_size = limits.pixel_size_limits.is_some();
                    if model.quality().is_some_and(|quality| {
                        !matches!(quality, "auto" | "low" | "medium" | "high")
                            && !(id.starts_with("gpt-image-2.5-")
                                && matches!(quality, "xhigh" | "max"))
                    }) {
                        return Err(Failure::Unsupported);
                    }
                    Some(&["auto", "1024x1024", "1536x1024", "1024x1536"])
                }
                _ => {
                    // A configured custom model is not evidence of mask or multi-image support.
                    limits.max_images = 1;
                    None
                }
            }
        }
        Kind::Video => {
            if model.quality().is_some() || model.aspect_ratio().is_some() {
                return Err(Failure::Unsupported);
            }
            limits.max_images = 1;
            limits.durations_seconds = Some(vec![4, 8, 12]);
            match model.model_id() {
                "sora-2" | "sora-2-2025-10-06" | "sora-2-2025-12-08" => {
                    Some(&["720x1280", "1280x720"])
                }
                "sora-2-pro" | "sora-2-pro-2025-10-06" => {
                    Some(&["720x1280", "1280x720", "1024x1792", "1792x1024"])
                }
                _ => None,
            }
        }
        Kind::Speech | Kind::Transcription => {
            if model.quality().is_some()
                || model.aspect_ratio().is_some()
                || model.resolution().is_some()
            {
                return Err(Failure::Unsupported);
            }
            None
        }
        Kind::Music => return Err(Failure::Unsupported),
    };
    limits.sizes = sizes.map(|sizes| sizes.iter().map(|size| (*size).to_owned()).collect());
    if let Some(size) = model.resolution() {
        validate_size(&limits, kind, size)?;
    }
    Ok(limits)
}

pub(super) fn validate(model: &ProviderModel, request: &Request) -> Result<(), Failure> {
    let limits = capabilities(model, request.kind)?;
    if request.images.len() > usize::from(limits.max_images)
        || request.count.unwrap_or(1) > limits.max_count
        || request.mask.is_some() && !limits.mask
    {
        return Err(Failure::Unsupported);
    }
    match request.kind {
        Kind::Image | Kind::Video => {
            if request.audio.is_some() || request.voice.is_some() || request.language.is_some() {
                return Err(Failure::Unsupported);
            }
            if let Some(size) = request.size.as_deref().or(model.resolution()) {
                validate_size(&limits, request.kind, size)?;
            }
            match request.kind {
                Kind::Image if request.duration_seconds.is_some() => {
                    return Err(Failure::Unsupported);
                }
                Kind::Video
                    if request
                        .duration_seconds
                        .is_some_and(|seconds| !matches!(seconds, 4 | 8 | 12)) =>
                {
                    return Err(Failure::Unsupported);
                }
                _ => {}
            }
        }
        Kind::Speech | Kind::Transcription => {
            if request.size.is_some() || request.duration_seconds.is_some() {
                return Err(Failure::Unsupported);
            }
            if request.kind == Kind::Speech {
                if request.audio.is_some()
                    || request.language.is_some()
                    || request.prompt.chars().count() > 4096
                {
                    return Err(Failure::Unsupported);
                }
                if !request.voice.as_deref().is_some_and(|voice| {
                    matches!(
                        voice,
                        "alloy"
                            | "ash"
                            | "ballad"
                            | "coral"
                            | "echo"
                            | "fable"
                            | "onyx"
                            | "nova"
                            | "sage"
                            | "shimmer"
                            | "verse"
                            | "marin"
                            | "cedar"
                    )
                }) {
                    return Err(Failure::Unsupported);
                }
            } else {
                if request.voice.is_some()
                    || model.model_id() == "gpt-4o-transcribe-diarize" && !request.prompt.is_empty()
                    || request.language.as_deref().is_some_and(|language| {
                        language.len() != 2
                            || !language.bytes().all(|byte| byte.is_ascii_lowercase())
                    })
                {
                    return Err(Failure::Unsupported);
                }
                let audio = request.audio.as_ref().ok_or(Failure::InvalidRequest)?;
                audio_extension(&audio.mime_type)?;
            }
        }
        Kind::Music => return Err(Failure::Unsupported),
    }
    Ok(())
}

fn validate_size(limits: &Capabilities, kind: Kind, size: &str) -> Result<(), Failure> {
    let supported = match &limits.sizes {
        Some(sizes) => {
            sizes.iter().any(|allowed| allowed == size)
                || limits
                    .pixel_size_limits
                    .as_ref()
                    .is_some_and(|limits| limits.supports(size))
        }
        None => is_pixel_size(size) || kind == Kind::Image && size == "auto",
    };
    if supported {
        Ok(())
    } else {
        Err(Failure::Unsupported)
    }
}

fn is_gpt_image(id: &str) -> bool {
    matches!(
        id,
        "gpt-image-1"
            | "gpt-image-1-mini"
            | "gpt-image-1.5"
            | "chatgpt-image-latest"
            | "gpt-image-2"
            | "gpt-image-2-2026-04-21"
            | "gpt-image-2.5-sunburst"
            | "gpt-image-2.5-sunburst-2026-09-08"
            | "gpt-image-2.5-flare"
            | "gpt-image-2.5-flare-2026-09-08"
    )
}

fn is_pixel_size(size: &str) -> bool {
    size.split_once('x').is_some_and(|(width, height)| {
        width.parse::<u32>().ok().is_some_and(|width| width > 0)
            && height.parse::<u32>().ok().is_some_and(|height| height > 0)
    })
}

pub(super) async fn generate(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    match request.kind {
        Kind::Image => generate_images(client, endpoint, credential, model, request).await,
        Kind::Speech => speech(client, endpoint, credential, model, request).await,
        Kind::Transcription => transcribe(client, endpoint, credential, model, request).await,
        Kind::Video | Kind::Music => Err(Failure::Unsupported),
    }
}

async fn generate_images(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let count = request.count.unwrap_or(1);
    let size = request.size.as_deref().or(model.resolution());
    let response = if request.images.is_empty() {
        let mut body = json!({"model": model.model_id(), "prompt": request.prompt, "n": count});
        if let Some(size) = size {
            body["size"] = json!(size);
        }
        if let Some(quality) = model.quality() {
            body["quality"] = json!(quality);
        }
        if is_gpt_image(model.model_id()) {
            body["output_format"] = json!("png");
        } else {
            body["response_format"] = json!("b64_json");
        }
        wire::json_body(
            client
                .post(wire::resource(endpoint, &["images", "generations"])?)
                .bearer_auth(credential.token()),
            body,
        )?
    } else {
        let mut form = Form::new()
            .text("model", model.model_id().to_owned())
            .text("prompt", request.prompt)
            .text("n", count.to_string());
        if let Some(size) = size {
            form = form.text("size", size.to_owned());
        }
        if let Some(quality) = model.quality() {
            form = form.text("quality", quality.to_owned());
        }
        if is_gpt_image(model.model_id()) {
            form = form.text("output_format", "png");
        } else {
            form = form.text("response_format", "b64_json");
        }
        let field = if request.images.len() > 1 {
            "image[]"
        } else {
            "image"
        };
        for image in &request.images {
            form = form.part(field, wire::image_part(image)?);
        }
        if let Some(mask) = &request.mask {
            form = form.part("mask", wire::image_part(mask)?);
        }
        client
            .post(wire::resource(endpoint, &["images", "edits"])?)
            .bearer_auth(credential.token())
            .multipart(form)
    };
    let mut response = wire::json(response, wire::MAX_JSON_BYTES).await?;
    let images = response
        .get_mut("data")
        .and_then(Value::as_array_mut)
        .ok_or(Failure::InvalidResponse)?;
    if images.len() != usize::from(count) {
        return Err(Failure::InvalidResponse);
    }
    let mut remaining = MAX_OUTPUT_BYTES;
    let mut outputs = Vec::with_capacity(images.len());
    for image in images {
        let output = if let Some(data) = image.get_mut("b64_json").filter(|data| !data.is_null()) {
            wire::image_output(
                wire::take_string(data).ok_or(Failure::InvalidResponse)?,
                &mut remaining,
            )?
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
        outputs.push(output);
    }
    Ok(Output { outputs })
}

// The retired Sora API's wire contract remains useful for explicitly configured custom services.
pub(super) async fn submit_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<RemoteVideo, Failure> {
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
    decode_video(
        wire::json(
            client
                .post(wire::resource(endpoint, &["videos"])?)
                .bearer_auth(credential.token())
                .multipart(form),
            256 * 1024,
        )
        .await?,
    )
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
    let remote = decode_video(
        wire::json(
            client
                .get(wire::resource(endpoint, &["videos", id])?)
                .bearer_auth(credential.token()),
            256 * 1024,
        )
        .await?,
    )?;
    if remote.id != id {
        return Err(Failure::InvalidResponse);
    }
    Ok(remote)
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
    let response = wire::send(
        client
            .get(wire::resource(endpoint, &["videos", id, "content"])?)
            .bearer_auth(credential.token()),
    )
    .await?;
    if response_mime(&response)? != "video/mp4" {
        return Err(Failure::InvalidResponse);
    }
    let bytes = wire::bytes(response, MAX_OUTPUT_BYTES).await?;
    let mut remaining = MAX_OUTPUT_BYTES;
    Ok(Output {
        outputs: vec![wire::media_output(bytes, "video/mp4", &mut remaining)?],
    })
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
        .ok_or(Failure::InvalidResponse)?
        .to_owned();
    let status = if response.get("error").is_some_and(|error| !error.is_null()) {
        VideoStatus::Failed
    } else {
        match response.get("status").and_then(Value::as_str) {
            Some("queued") => VideoStatus::Queued,
            Some("in_progress") => VideoStatus::InProgress,
            Some("completed") => VideoStatus::Completed,
            Some("failed") => VideoStatus::Failed,
            _ => VideoStatus::Unknown,
        }
    };
    let progress = response
        .get("progress")
        .and_then(Value::as_f64)
        .filter(|progress| progress.is_finite() && (0.0..=100.0).contains(progress));
    Ok(RemoteVideo {
        id,
        status,
        progress,
    })
}

async fn speech(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let response = wire::send(wire::json_body(
        client
            .post(wire::resource(endpoint, &["audio", "speech"])?)
            .bearer_auth(credential.token()),
        json!({"model": model.model_id(), "input": request.prompt,
            "voice": request.voice.ok_or(Failure::InvalidRequest)?, "response_format": "wav"}),
    )?)
    .await?;
    if !matches!(
        response_mime(&response)?,
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" | "application/octet-stream"
    ) {
        return Err(Failure::InvalidResponse);
    }
    let bytes = wire::bytes(response, MAX_OUTPUT_BYTES).await?;
    let mut remaining = MAX_OUTPUT_BYTES;
    Ok(Output {
        outputs: vec![wire::media_output(bytes, "audio/wav", &mut remaining)?],
    })
}

async fn transcribe(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    let audio = request.audio.as_ref().ok_or(Failure::InvalidRequest)?;
    let extension = audio_extension(&audio.mime_type)?;
    let file = Part::bytes(wire::decode_audio_input(audio)?)
        .file_name(format!("audio.{extension}"))
        .mime_str(&audio.mime_type)
        .map_err(|_| Failure::InvalidRequest)?;
    let mut form = Form::new()
        .text("model", model.model_id().to_owned())
        .text("response_format", "json")
        .part("file", file);
    if !request.prompt.is_empty() {
        form = form.text("prompt", request.prompt);
    }
    if let Some(language) = request.language {
        form = form.text("language", language);
    }
    if model.model_id() == "gpt-4o-transcribe-diarize" {
        form = form.text("chunking_strategy", "auto");
    }
    let mut response = wire::json(
        client
            .post(wire::resource(endpoint, &["audio", "transcriptions"])?)
            .bearer_auth(credential.token())
            .multipart(form),
        wire::MAX_JSON_BYTES,
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

fn audio_extension(mime_type: &str) -> Result<&'static str, Failure> {
    match mime_type {
        "audio/flac" | "audio/x-flac" => Ok("flac"),
        "audio/mpeg" | "audio/mp3" => Ok("mp3"),
        "audio/mp4" | "audio/x-m4a" => Ok("m4a"),
        "audio/ogg" => Ok("ogg"),
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => Ok("wav"),
        "audio/webm" => Ok("webm"),
        _ => Err(Failure::Unsupported),
    }
}

fn response_mime(response: &reqwest::Response) -> Result<&str, Failure> {
    response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .ok_or(Failure::InvalidResponse)
}
