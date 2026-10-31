use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{RequestBuilder, Response, Url, multipart::Part};
use serde_json::Value;

use super::{Content, Failure, MAX_OUTPUT_BYTES, Protocol};

pub(super) const MAX_JSON_BYTES: usize = MAX_OUTPUT_BYTES / 3 * 4 + 1024 * 1024;

pub(super) fn endpoint(endpoint: &str, protocol: Protocol) -> Result<Url, Failure> {
    let mut url = Url::parse(endpoint).map_err(|_| Failure::Unsupported)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Failure::Unsupported);
    }
    if matches!(protocol, Protocol::OpenAi) {
        let path = url.path().trim_end_matches('/');
        if let Some(base) = path
            .strip_suffix("/chat/completions")
            .or_else(|| path.strip_suffix("/responses"))
        {
            let base = base.to_owned();
            url.set_path(&base);
        }
    }
    Ok(url)
}

pub(super) fn resource(endpoint: &Url, segments: &[&str]) -> Result<Url, Failure> {
    let mut url = endpoint.clone();
    url.path_segments_mut()
        .map_err(|_| Failure::Unsupported)?
        .pop_if_empty()
        .extend(segments.iter().copied());
    Ok(url)
}

pub(super) fn decode_input(content: &Content) -> Result<Vec<u8>, Failure> {
    if !matches!(
        content.mime_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp"
    ) || content.data.len() > 44 * 1024 * 1024
    {
        return Err(Failure::InvalidRequest);
    }
    let bytes = STANDARD
        .decode(&content.data)
        .map_err(|_| Failure::InvalidRequest)?;
    if bytes.is_empty() || image_mime(&bytes) != Some(content.mime_type.as_str()) {
        return Err(Failure::InvalidRequest);
    }
    Ok(bytes)
}

pub(super) fn image_part(content: &Content) -> Result<Part, Failure> {
    let extension = match content.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err(Failure::InvalidRequest),
    };
    Part::bytes(decode_input(content)?)
        .file_name(format!("image.{extension}"))
        .mime_str(&content.mime_type)
        .map_err(|_| Failure::InvalidRequest)
}

pub(super) fn take_string(value: &mut Value) -> Option<String> {
    match value.take() {
        Value::String(value) => Some(value),
        _ => None,
    }
}

pub(super) fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

pub(super) fn image_output(data: String, remaining: &mut usize) -> Result<Content, Failure> {
    if data.len() > remaining.saturating_add(2) / 3 * 4 {
        return Err(Failure::ResponseTooLarge);
    }
    let bytes = STANDARD
        .decode(&data)
        .map_err(|_| Failure::InvalidResponse)?;
    if bytes.is_empty() || bytes.len() > *remaining {
        return Err(Failure::ResponseTooLarge);
    }
    let mime_type = image_mime(&bytes)
        .ok_or(Failure::InvalidResponse)?
        .to_owned();
    *remaining -= bytes.len();
    Ok(Content { data, mime_type })
}

pub(super) async fn send(request: RequestBuilder) -> Result<Response, Failure> {
    let response = request.send().await.map_err(http_failure)?;
    if response.status().is_success() {
        return Ok(response);
    }
    // Never forward an upstream body: it can echo private credentials or input images.
    Err(match response.status().as_u16() {
        401 => Failure::Authentication,
        403 => Failure::PermissionDenied,
        429 => Failure::RateLimited,
        400 | 404 | 405 | 415 | 422 => Failure::Unsupported,
        _ => Failure::ProviderUnavailable,
    })
}

pub(super) async fn json(request: RequestBuilder, limit: usize) -> Result<Value, Failure> {
    let bytes = bytes(send(request).await?, limit).await?;
    serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidResponse)
}

pub(super) async fn bytes(mut response: Response, limit: usize) -> Result<Vec<u8>, Failure> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(Failure::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(http_failure)? {
        if chunk.len() > limit - bytes.len() {
            return Err(Failure::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(super) fn json_body(request: RequestBuilder, body: Value) -> Result<RequestBuilder, Failure> {
    Ok(request
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&body).map_err(|_| Failure::InvalidRequest)?))
}

pub(super) fn http_failure(error: reqwest::Error) -> Failure {
    if error.is_timeout() {
        Failure::Deadline
    } else {
        Failure::ProviderUnavailable
    }
}
