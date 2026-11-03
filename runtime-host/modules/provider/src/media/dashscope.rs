use std::time::Duration;

use reqwest::{Client, RequestBuilder, Url};
use serde_json::{Value, json};

use crate::{ProviderModel, llm_client::LlmCredential};

use super::{
    Capabilities, Content, Failure, Kind, MAX_OUTPUT_BYTES, Output, RemoteVideo, Request,
    VideoStatus, wire,
};

// Native schemas, not the OpenAI-compatible Images extension:
// https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference
// https://help.aliyun.com/zh/model-studio/qwen-image-api
// https://help.aliyun.com/zh/model-studio/qwen-image-edit-api
// https://help.aliyun.com/zh/model-studio/wan-image-generation-api-reference
// https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference
// https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference
// https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference
// https://help.aliyun.com/zh/model-studio/legacy-image-to-video-api-reference
// https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api
#[derive(Clone, Copy)]
enum ImageApi {
    Qwen,
    WanText,
    WanEdit,
    WanLegacy,
}

fn image_api(model: &str) -> Option<ImageApi> {
    match model {
        "qwen-image-3.0-pro"
        | "qwen-image-3.0"
        | "qwen-image-2.1-pro"
        | "qwen-image-2.1-turbo"
        | "qwen-image-2.0-pro"
        | "qwen-image-2.0-pro-2026-06-22"
        | "qwen-image-2.0-pro-2026-04-22"
        | "qwen-image-2.0-pro-2026-03-03"
        | "qwen-image-2.0"
        | "qwen-image-2.0-2026-03-03" => Some(ImageApi::Qwen),
        "wan2.6-t2i" => Some(ImageApi::WanText),
        "wan2.6-image" => Some(ImageApi::WanEdit),
        "wan2.5-t2i-preview" | "wan2.2-t2i-flash" | "wan2.2-t2i-plus" | "wanx2.1-t2i-turbo"
        | "wanx2.1-t2i-plus" | "wanx2.0-t2i-turbo" => Some(ImageApi::WanLegacy),
        _ => None,
    }
}

#[derive(Clone, Copy)]
enum VideoApi {
    Text,
    TextLegacy,
    Frame,
    FrameLegacy,
}

fn video_api(model: &str) -> Option<VideoApi> {
    match model {
        "wan2.7-t2v" | "wan2.7-t2v-2026-06-12" => Some(VideoApi::Text),
        "wan2.6-t2v" | "wan2.5-t2v-preview" | "wan2.2-t2v-plus" | "wan2.1-t2v-turbo"
        | "wan2.1-t2v-plus" => Some(VideoApi::TextLegacy),
        "wan2.7-i2v-2026-04-25" => Some(VideoApi::Frame),
        "wan2.6-i2v" | "wan2.6-i2v-flash" | "wan2.5-i2v-preview" | "wan2.2-i2v-flash"
        | "wan2.2-i2v-plus" | "wanx2.1-i2v-turbo" | "wanx2.1-i2v-plus" => {
            Some(VideoApi::FrameLegacy)
        }
        _ => None,
    }
}

const SIZES_480: &[&str] = &["832x480", "480x832", "624x624"];
const SIZES_720: &[&str] = &["1280x720", "720x1280", "960x960", "1088x832", "832x1088"];
const SIZES_1080: &[&str] = &[
    "1920x1080",
    "1080x1920",
    "1440x1440",
    "1632x1248",
    "1248x1632",
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
    let name = model.model_id();
    if model.quality().is_some()
        || model.aspect_ratio().is_some_and(|ratio| {
            kind != Kind::Video
                || !matches!(video_api(name), Some(VideoApi::Text))
                || !matches!(ratio, "16:9" | "9:16" | "1:1" | "4:3" | "3:4")
        })
    {
        return Err(Failure::Unsupported);
    }
    match kind {
        Kind::Image => match image_api(name) {
            Some(ImageApi::Qwen) => {
                limits.max_images = if name.starts_with("qwen-image-2.1-") {
                    10
                } else {
                    3
                };
                limits.max_count = 6;
                limits.sizes = Some(strings(&[
                    "512x512",
                    "1024x1024",
                    "1536x1024",
                    "1024x1536",
                    "2048x2048",
                    "2688x1536",
                    "1536x2688",
                ]));
            }
            Some(ImageApi::WanEdit) => {
                limits.max_images = 4;
                limits.max_count = 4;
                limits.sizes = Some(strings(&[
                    "1K",
                    "2K",
                    "1280x1280",
                    "800x1200",
                    "1200x800",
                    "960x1280",
                    "1280x960",
                    "720x1280",
                    "1280x720",
                ]));
            }
            Some(ImageApi::WanText | ImageApi::WanLegacy) => {
                limits.max_count = 4;
                limits.sizes = Some(if matches!(name, "wan2.6-t2i" | "wan2.5-t2i-preview") {
                    strings(&["1280x1280", "1440x1440"])
                } else {
                    strings(&["1024x1024", "720x1280", "1280x720", "512x512", "1440x1440"])
                });
            }
            None => return Err(Failure::Unsupported),
        },
        Kind::Video => {
            if let Some(api) = video_api(name) {
                limits.max_images =
                    u8::from(matches!(api, VideoApi::Frame | VideoApi::FrameLegacy));
                let mut sizes = Vec::new();
                if matches!(api, VideoApi::TextLegacy) {
                    if matches!(
                        name,
                        "wan2.5-t2v-preview" | "wan2.2-t2v-plus" | "wan2.1-t2v-turbo"
                    ) {
                        sizes.extend(strings(SIZES_480));
                    }
                    if name != "wan2.2-t2v-plus" {
                        sizes.extend(strings(SIZES_720));
                    }
                    if matches!(
                        name,
                        "wan2.6-t2v" | "wan2.5-t2v-preview" | "wan2.2-t2v-plus"
                    ) {
                        sizes.extend(strings(SIZES_1080));
                    }
                } else {
                    if matches!(
                        name,
                        "wan2.5-i2v-preview"
                            | "wan2.2-i2v-flash"
                            | "wan2.2-i2v-plus"
                            | "wanx2.1-i2v-turbo"
                    ) {
                        sizes.push("480P".to_owned());
                    }
                    if name != "wan2.2-i2v-plus" {
                        sizes.push("720P".to_owned());
                    }
                    if !name.starts_with("wanx2.1-") {
                        sizes.push("1080P".to_owned());
                    }
                }
                limits.sizes = Some(sizes);
                limits.durations_seconds = Some(
                    if name.starts_with("wan2.7-") || name.starts_with("wan2.6-") {
                        (2..=15).collect()
                    } else if name.starts_with("wan2.5-") {
                        vec![5, 10]
                    } else if name == "wanx2.1-i2v-turbo" {
                        vec![3, 4, 5]
                    } else {
                        vec![5]
                    },
                );
            } else {
                return Err(Failure::Unsupported);
            }
        }
        Kind::Speech if name == "qwen3-tts-flash" => {}
        _ => return Err(Failure::Unsupported),
    }
    if let Some(size) = model.resolution() {
        if kind == Kind::Image {
            let api = image_api(name).ok_or(Failure::Unsupported)?;
            if !image_size(name, api, size) {
                return Err(Failure::Unsupported);
            }
            let sizes = limits.sizes.as_mut().ok_or(Failure::Unsupported)?;
            let size = size.replace('*', "x");
            if !sizes.contains(&size) {
                sizes.push(size);
            }
        } else if kind != Kind::Video
            || !limits
                .sizes
                .as_ref()
                .is_some_and(|sizes| sizes.contains(&size.replace('*', "x")))
        {
            return Err(Failure::Unsupported);
        }
    }
    Ok(limits)
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

pub(super) fn validate(model: &ProviderModel, request: &Request) -> Result<(), Failure> {
    if request.mask.is_some() || request.audio.is_some() || model.quality().is_some() {
        return Err(Failure::Unsupported);
    }
    let name = model.model_id();
    let size = request.size.as_deref().or(model.resolution());
    match request.kind {
        Kind::Image => {
            let api = image_api(name).ok_or(Failure::Unsupported)?;
            let limits = capabilities(model, Kind::Image)?;
            if request.duration_seconds.is_some()
                || request.voice.is_some()
                || request.language.is_some()
                || model.aspect_ratio().is_some()
                || request.images.len() > usize::from(limits.max_images)
                || request.count.unwrap_or(1) > limits.max_count
                || matches!(api, ImageApi::WanEdit) && request.images.is_empty()
            {
                return Err(Failure::Unsupported);
            }
            let prompt_limit = match api {
                ImageApi::WanText => 2100,
                ImageApi::WanEdit => 2000,
                ImageApi::WanLegacy if name == "wan2.5-t2i-preview" => 2000,
                ImageApi::WanLegacy if name == "wanx2.0-t2i-turbo" => 800,
                ImageApi::WanLegacy => 500,
                ImageApi::Qwen => 32_000,
            };
            if request.prompt.chars().count() > prompt_limit {
                return Err(Failure::InvalidRequest);
            }
            if size.is_some_and(|size| !image_size(name, api, size)) {
                return Err(Failure::Unsupported);
            }
        }
        Kind::Video => {
            let api = video_api(name).ok_or(Failure::Unsupported)?;
            let first_frame = matches!(api, VideoApi::Frame | VideoApi::FrameLegacy);
            if request.images.len() != usize::from(first_frame)
                || request.count.unwrap_or(1) != 1
                || request.voice.is_some()
                || request.language.is_some()
                || model.aspect_ratio().is_some_and(|ratio| {
                    !matches!(api, VideoApi::Text)
                        || !matches!(ratio, "16:9" | "9:16" | "1:1" | "4:3" | "3:4")
                })
            {
                return Err(Failure::Unsupported);
            }
            let prompt_limit = if name.starts_with("wan2.7-") {
                5000
            } else if name.starts_with("wan2.6-") || name.starts_with("wan2.5-") {
                1500
            } else {
                800
            };
            if request.prompt.chars().count() > prompt_limit {
                return Err(Failure::InvalidRequest);
            }
            let limits = capabilities(model, Kind::Video)?;
            if size.is_some_and(|size| {
                !limits
                    .sizes
                    .as_ref()
                    .is_some_and(|sizes| sizes.contains(&size.replace('*', "x")))
            }) || request.duration_seconds.is_some_and(|seconds| {
                !limits
                    .durations_seconds
                    .as_ref()
                    .is_some_and(|durations| durations.contains(&seconds))
            }) {
                return Err(Failure::Unsupported);
            }
        }
        Kind::Speech if name == "qwen3-tts-flash" => {
            if !request.images.is_empty()
                || size.is_some()
                || model.aspect_ratio().is_some()
                || request.duration_seconds.is_some()
                || request.count.unwrap_or(1) != 1
                || request.voice.as_ref().is_some_and(|voice| {
                    voice.trim().is_empty()
                        || voice.len() > 256
                        || voice.chars().any(char::is_control)
                })
                || request.language.as_deref().is_some_and(|language| {
                    !matches!(
                        language,
                        "Auto"
                            | "Chinese"
                            | "English"
                            | "German"
                            | "Italian"
                            | "Portuguese"
                            | "Spanish"
                            | "Japanese"
                            | "Korean"
                            | "French"
                            | "Russian"
                    )
                })
            {
                return Err(Failure::Unsupported);
            }
            if request.prompt.chars().count() > 600 {
                return Err(Failure::InvalidRequest);
            }
        }
        _ => return Err(Failure::Unsupported),
    }
    let max_image_bytes = if request.kind == Kind::Video
        && (name.starts_with("wan2.7-")
            || name.starts_with("wan2.6-")
            || name.starts_with("wan2.5-"))
    {
        20 * 1024 * 1024
    } else {
        10 * 1024 * 1024
    };
    for image in &request.images {
        // The shared request validator already checked canonical base64 and MIME.
        if image.data.trim_end_matches('=').len() * 3 / 4 > max_image_bytes {
            return Err(Failure::InvalidRequest);
        }
    }
    Ok(())
}

fn image_size(name: &str, api: ImageApi, size: &str) -> bool {
    if matches!(api, ImageApi::WanEdit) && matches!(size, "1K" | "2K") {
        return true;
    }
    let Some((width, height)) = size.split_once('x').or_else(|| size.split_once('*')) else {
        return false;
    };
    let (Ok(width), Ok(height)) = (width.parse::<u32>(), height.parse::<u32>()) else {
        return false;
    };
    if width == 0 || height == 0 {
        return false;
    }
    let (width, height) = (u64::from(width), u64::from(height));
    let pixels = width * height;
    match api {
        ImageApi::Qwen => {
            (512 * 512..=2048 * 2048).contains(&pixels)
                && (name.starts_with("qwen-image-2.0")
                    || width.max(height) <= width.min(height) * 8)
        }
        ImageApi::WanEdit => {
            (768 * 768..=2048 * 2048).contains(&pixels)
                && width.max(height) <= width.min(height) * 4
        }
        ImageApi::WanText | ImageApi::WanLegacy
            if name == "wan2.5-t2i-preview" || matches!(api, ImageApi::WanText) =>
        {
            (1280 * 1280..=1440 * 1440).contains(&pixels)
                && width.max(height) <= width.min(height) * 4
        }
        ImageApi::WanLegacy => (512..=1440).contains(&width) && (512..=1440).contains(&height),
        ImageApi::WanText => false,
    }
}

pub(super) async fn generate(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Output, Failure> {
    match request.kind {
        Kind::Image => {
            let api = image_api(model.model_id()).ok_or(Failure::Unsupported)?;
            let count = request.count.unwrap_or(1);
            let mut parameters = json!({"n": count});
            if let Some(size) = request.size.as_deref().or(model.resolution()) {
                parameters["size"] = json!(size.replace('x', "*"));
            }
            if matches!(api, ImageApi::WanEdit) {
                // The SDK has no interleaved-text contract. This is image editing only.
                parameters["enable_interleave"] = json!(false);
            }
            let input = if matches!(api, ImageApi::WanLegacy) {
                json!({"prompt": request.prompt})
            } else {
                let mut content = request
                    .images
                    .iter()
                    .map(|image| json!({"image": data_url(image)}))
                    .collect::<Vec<_>>();
                content.push(json!({"text": request.prompt}));
                json!({"messages": [{"role": "user", "content": content}]})
            };
            let service = match api {
                ImageApi::Qwen => ["multimodal-generation", "generation"],
                ImageApi::WanText | ImageApi::WanEdit => ["image-generation", "generation"],
                ImageApi::WanLegacy => ["text2image", "image-synthesis"],
            };
            let submission = service_request(client, endpoint, credential, &service)?;
            let submission = if matches!(api, ImageApi::Qwen) {
                submission
            } else {
                submission.header("X-DashScope-Async", "enable")
            };
            let response = api_json(wire::json_body(
                submission,
                json!({"model": model.model_id(), "input": input, "parameters": parameters}),
            )?)
            .await?;
            let response = if matches!(api, ImageApi::Qwen) {
                response
            } else {
                wait_task(client, endpoint, credential, response).await?
            };
            image_output(client, &response, count, matches!(api, ImageApi::WanLegacy)).await
        }
        Kind::Speech if model.model_id() == "qwen3-tts-flash" => {
            let mut input = json!({"text": request.prompt, "voice": request.voice.as_deref().unwrap_or("Cherry")});
            if let Some(language) = request.language {
                input["language_type"] = json!(language);
            }
            // Non-streaming returns a complete audio.url. SSE audio.data contains PCM
            // segments, not standalone WAV files, and is deliberately not requested here.
            let response = api_json(wire::json_body(
                service_request(
                    client,
                    endpoint,
                    credential,
                    &["multimodal-generation", "generation"],
                )?,
                json!({"model": model.model_id(), "input": input}),
            )?)
            .await?;
            if response
                .pointer("/output/finish_reason")
                .and_then(Value::as_str)
                != Some("stop")
            {
                return Err(Failure::GenerationFailed);
            }
            let url = response
                .pointer("/output/audio/url")
                .and_then(Value::as_str)
                .ok_or(Failure::InvalidResponse)?;
            let url = speech_download_url(url)?;
            let mut remaining = MAX_OUTPUT_BYTES;
            let mut output = wire::download(client, &url, &mut remaining).await?;
            if !matches!(
                output.mime_type.as_str(),
                "audio/wav" | "audio/x-wav" | "audio/wave"
            ) {
                return Err(Failure::InvalidResponse);
            }
            output.mime_type = "audio/wav".to_owned();
            Ok(Output {
                outputs: vec![output],
            })
        }
        _ => Err(Failure::Unsupported),
    }
}

fn speech_download_url(url: &str) -> Result<String, Failure> {
    let Some(suffix) = url.strip_prefix("http://") else {
        return Ok(url.to_owned());
    };
    let parsed = Url::parse(url).map_err(|_| Failure::InvalidResponse)?;
    let host = parsed.host_str().ok_or(Failure::InvalidResponse)?;
    let Some((bucket, region)) = host.split_once(".oss-") else {
        return Err(Failure::InvalidResponse);
    };
    let Some(region) = region.strip_suffix(".aliyuncs.com") else {
        return Err(Failure::InvalidResponse);
    };
    if !bucket
        .strip_prefix("dashscope-result-")
        .is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        || region.is_empty()
        || !region
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || !["OSSAccessKeyId", "Expires", "Signature"]
            .iter()
            .all(|key| {
                parsed
                    .query_pairs()
                    .any(|(name, value)| name == *key && !value.is_empty())
            })
    {
        return Err(Failure::InvalidResponse);
    }
    // OSS V1 signs VERB/MD5/TYPE/EXPIRES/OSS headers/resource, not the scheme.
    // https://www.alibabacloud.com/help/en/oss/developer-reference/ddd-signatures-to-urls
    // Preserve the signed host, path and raw query exactly; never enable HTTP downloads.
    Ok(format!("https://{suffix}"))
}

fn data_url(content: &Content) -> String {
    format!("data:{};base64,{}", content.mime_type, content.data)
}

fn service_request(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    service: &[&str; 2],
) -> Result<RequestBuilder, Failure> {
    Ok(client
        .post(wire::resource(
            endpoint,
            &["services", "aigc", service[0], service[1]],
        )?)
        .bearer_auth(credential.token()))
}

async fn api_json(request: RequestBuilder) -> Result<Value, Failure> {
    let response = wire::json(request, 1024 * 1024).await?;
    if let Some(code) = response
        .get("code")
        .and_then(Value::as_str)
        .filter(|code| !code.is_empty())
    {
        return Err(match code {
            "InvalidApiKey" => Failure::Authentication,
            "AccessDenied" => Failure::PermissionDenied,
            "Throttling" | "Throttling.RateQuota" => Failure::RateLimited,
            _ => Failure::GenerationFailed,
        });
    }
    if response
        .get("status_code")
        .and_then(Value::as_u64)
        .is_some_and(|status| status != 200)
    {
        return Err(Failure::GenerationFailed);
    }
    Ok(response)
}

async fn image_output(
    client: &Client,
    response: &Value,
    count: u8,
    legacy: bool,
) -> Result<Output, Failure> {
    let mut urls = Vec::new();
    if legacy {
        let results = response
            .pointer("/output/results")
            .and_then(Value::as_array)
            .ok_or(Failure::InvalidResponse)?;
        for result in results {
            let url = result
                .get("url")
                .and_then(Value::as_str)
                .ok_or(Failure::GenerationFailed)?;
            urls.push(url);
        }
    } else {
        let choices = response
            .pointer("/output/choices")
            .and_then(Value::as_array)
            .ok_or(Failure::InvalidResponse)?;
        for choice in choices {
            if choice.get("finish_reason").and_then(Value::as_str) != Some("stop") {
                return Err(Failure::GenerationFailed);
            }
            let content = choice
                .pointer("/message/content")
                .and_then(Value::as_array)
                .ok_or(Failure::InvalidResponse)?;
            for part in content {
                if let Some(url) = part.get("image").and_then(Value::as_str) {
                    urls.push(url);
                }
            }
        }
    }
    if urls.len() != usize::from(count) {
        return Err(Failure::GenerationFailed);
    }
    let mut remaining = MAX_OUTPUT_BYTES;
    let mut outputs = Vec::with_capacity(urls.len());
    for url in urls {
        let output = wire::download(client, url, &mut remaining).await?;
        if output.mime_type != "image/png" {
            return Err(Failure::InvalidResponse);
        }
        outputs.push(output);
    }
    Ok(Output { outputs })
}

async fn video_submission(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<Value, Failure> {
    let api = video_api(model.model_id()).ok_or(Failure::Unsupported)?;
    let mut input = json!({"prompt": request.prompt});
    match api {
        VideoApi::Frame => {
            let image = request.images.first().ok_or(Failure::InvalidRequest)?;
            // One SDK reference means only first_frame, never last_frame/driving_audio/first_clip.
            input["media"] = json!([{"type": "first_frame", "url": data_url(image)}]);
        }
        VideoApi::FrameLegacy => {
            let image = request.images.first().ok_or(Failure::InvalidRequest)?;
            input["img_url"] = json!(data_url(image));
        }
        VideoApi::Text | VideoApi::TextLegacy => {}
    }
    let mut parameters = json!({});
    if let Some(size) = request.size.as_deref().or(model.resolution()) {
        let field = if matches!(api, VideoApi::TextLegacy) {
            "size"
        } else {
            "resolution"
        };
        parameters[field] = json!(size.replace('x', "*"));
    }
    if let Some(ratio) = model.aspect_ratio() {
        parameters["ratio"] = json!(ratio);
    }
    if let Some(seconds) = request.duration_seconds {
        parameters["duration"] = json!(seconds);
    }
    api_json(wire::json_body(
        service_request(
            client,
            endpoint,
            credential,
            &["video-generation", "video-synthesis"],
        )?
        .header("X-DashScope-Async", "enable"),
        json!({"model": model.model_id(), "input": input, "parameters": parameters}),
    )?)
    .await
}

pub(super) async fn submit_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    model: &ProviderModel,
    request: Request,
) -> Result<RemoteVideo, Failure> {
    remote_video(&video_submission(client, endpoint, credential, model, request).await?)
}

pub(super) fn is_remote_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn remote_video(response: &Value) -> Result<RemoteVideo, Failure> {
    let output = response.get("output").ok_or(Failure::InvalidResponse)?;
    let id = output
        .get("task_id")
        .and_then(Value::as_str)
        .filter(|id| is_remote_id(id))
        .ok_or(Failure::InvalidResponse)?;
    let status = if output
        .get("code")
        .and_then(Value::as_str)
        .is_some_and(|code| !code.is_empty())
    {
        VideoStatus::Failed
    } else {
        match output.get("task_status").and_then(Value::as_str) {
            Some("PENDING") => VideoStatus::Queued,
            Some("RUNNING") => VideoStatus::InProgress,
            Some("SUCCEEDED") => VideoStatus::Completed,
            // UNKNOWN is the documented nonexistent/expired task, not permission to resubmit.
            Some("FAILED" | "CANCELED" | "UNKNOWN") => VideoStatus::Failed,
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

async fn task_response(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<Value, Failure> {
    if !is_remote_id(id) {
        return Err(Failure::InvalidRequest);
    }
    let response = api_json(
        client
            .get(wire::resource(endpoint, &["tasks", id])?)
            .bearer_auth(credential.token()),
    )
    .await?;
    if remote_video(&response)?.id != id {
        return Err(Failure::InvalidResponse);
    }
    Ok(response)
}

async fn wait_task(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    mut response: Value,
) -> Result<Value, Failure> {
    let id = remote_video(&response)?.id;
    loop {
        match remote_video(&response)?.status {
            VideoStatus::Completed => return Ok(response),
            VideoStatus::Failed => return Err(Failure::GenerationFailed),
            VideoStatus::Unknown => return Err(Failure::InvalidResponse),
            VideoStatus::Queued | VideoStatus::InProgress => {
                tokio::time::sleep(Duration::from_secs(10)).await;
                response = task_response(client, endpoint, credential, &id).await?;
            }
        }
    }
}

pub(super) async fn query_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<RemoteVideo, Failure> {
    remote_video(&task_response(client, endpoint, credential, id).await?)
}

pub(super) async fn collect_video(
    client: &Client,
    endpoint: &Url,
    credential: &LlmCredential,
    id: &str,
) -> Result<Output, Failure> {
    // Native DashScope has no /content endpoint: retrieve the URL from this same task.
    let response = task_response(client, endpoint, credential, id).await?;
    if !matches!(remote_video(&response)?.status, VideoStatus::Completed) {
        return Err(Failure::GenerationFailed);
    }
    video_output(client, &response).await
}

async fn video_output(client: &Client, response: &Value) -> Result<Output, Failure> {
    let url = response
        .pointer("/output/video_url")
        .and_then(Value::as_str)
        .ok_or(Failure::InvalidResponse)?;
    let mut remaining = MAX_OUTPUT_BYTES;
    let output = wire::download(client, url, &mut remaining).await?;
    if output.mime_type != "video/mp4" {
        return Err(Failure::InvalidResponse);
    }
    Ok(Output {
        outputs: vec![output],
    })
}
