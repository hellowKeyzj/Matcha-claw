use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{RequestBuilder, Response, Url, multipart::Part};
use serde_json::Value;

use super::{Content, Failure, MAX_OUTPUT_BYTES, Protocol};

pub(super) use super::download::download;

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

pub(super) fn decode_audio_input(content: &Content) -> Result<Vec<u8>, Failure> {
    if content.data.len() > 44 * 1024 * 1024 {
        return Err(Failure::InvalidRequest);
    }
    let bytes = STANDARD
        .decode(&content.data)
        .map_err(|_| Failure::InvalidRequest)?;
    let mime_type = normalized_mime(&content.mime_type);
    if bytes.is_empty()
        || bytes.len() > 32 * 1024 * 1024
        || !mime_type.starts_with("audio/")
        || !is_media_mime(&bytes, &mime_type)
    {
        return Err(Failure::InvalidRequest);
    }
    Ok(bytes)
}

pub(super) fn media_output(
    bytes: Vec<u8>,
    mime_type: &str,
    remaining: &mut usize,
) -> Result<Content, Failure> {
    if bytes.len() > (*remaining).min(MAX_OUTPUT_BYTES) {
        return Err(Failure::ResponseTooLarge);
    }
    let mime_type = normalized_mime(mime_type);
    if bytes.is_empty() && mime_type != "text/plain" || !is_media_mime(&bytes, &mime_type) {
        return Err(Failure::InvalidResponse);
    }
    *remaining -= bytes.len();
    Ok(Content {
        data: STANDARD.encode(bytes),
        mime_type,
    })
}

fn normalized_mime(mime_type: &str) -> String {
    mime_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn is_media_mime(bytes: &[u8], mime_type: &str) -> bool {
    match mime_type {
        "image/png" | "image/jpeg" | "image/webp" => image_mime(bytes) == Some(mime_type),
        "video/mp4" | "audio/mp4" | "audio/x-m4a" => {
            bytes.len() >= 16
                && bytes.get(4..8) == Some(b"ftyp")
                && u32::from_be_bytes(bytes[..4].try_into().unwrap()) >= 16
                && u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize <= bytes.len()
        }
        "audio/wav" | "audio/x-wav" | "audio/wave" => {
            bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE")
        }
        "audio/flac" | "audio/x-flac" => bytes.len() >= 8 && bytes.starts_with(b"fLaC"),
        "audio/ogg" | "audio/opus" => bytes.len() >= 27 && bytes.starts_with(b"OggS\0"),
        "audio/mpeg" | "audio/mp3" => {
            bytes.len() >= 10 && bytes.starts_with(b"ID3")
                || bytes.len() >= 4
                    && bytes[0] == 0xff
                    && bytes[1] & 0xe0 == 0xe0
                    && bytes[1] & 0x18 != 0x08
                    && bytes[1] & 0x06 != 0
                    && !matches!(bytes[2] & 0xf0, 0 | 0xf0)
                    && bytes[2] & 0x0c != 0x0c
        }
        "audio/aac" => {
            bytes.len() >= 7
                && bytes[0] == 0xff
                && bytes[1] & 0xf6 == 0xf0
                && (bytes[2] >> 2) & 0x0f <= 12
        }
        "audio/webm" | "video/webm" => {
            bytes.starts_with(b"\x1a\x45\xdf\xa3")
                && bytes[..bytes.len().min(4096)]
                    .windows(7)
                    .any(|part| part == b"\x42\x82\x84webm")
        }
        "text/plain" => std::str::from_utf8(bytes).is_ok(),
        _ => false,
    }
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
