use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose::STANDARD};

use crate::WorkspaceMediaFailure;

pub fn normalized_mime_type(
    requested: &str,
    relative_path: &str,
    content: &[u8],
) -> Result<String, WorkspaceMediaFailure> {
    let mime_type = if is_supported_image_mime(requested) || requested == "application/octet-stream"
    {
        requested.to_owned()
    } else if requested.starts_with("image/") {
        return Err(WorkspaceMediaFailure::Unavailable);
    } else {
        match relative_path
            .rsplit('.')
            .next()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("png") => "image/png".to_owned(),
            Some("jpg" | "jpeg") => "image/jpeg".to_owned(),
            Some("gif") => "image/gif".to_owned(),
            Some("webp") => "image/webp".to_owned(),
            Some("bmp") => "image/bmp".to_owned(),
            Some("svg") => "image/svg+xml".to_owned(),
            _ => "application/octet-stream".to_owned(),
        }
    };

    if is_supported_image_mime(&mime_type) && image_mime_type(content) != Some(mime_type.as_str()) {
        return Err(WorkspaceMediaFailure::Unavailable);
    }
    Ok(mime_type)
}

fn is_supported_image_mime(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/svg+xml"
    )
}

fn image_mime_type(content: &[u8]) -> Option<&'static str> {
    if content.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if content.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if content.starts_with(b"GIF87a") || content.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if content.len() >= 12 && content.starts_with(b"RIFF") && &content[8..12] == b"WEBP" {
        Some("image/webp")
    } else if content.starts_with(b"BM") {
        Some("image/bmp")
    } else if content.trim_ascii_start().starts_with(b"<svg") {
        Some("image/svg+xml")
    } else {
        None
    }
}

const MAX_PREVIEW_LONG_EDGE: u32 = 512;

pub fn image_preview(content: &[u8], mime_type: &str) -> Option<String> {
    if !is_supported_image_mime(mime_type)
        || image_mime_type(content) != Some(mime_type)
        || content.len() > (2 * 1024 * 1024)
    {
        return None;
    }
    if mime_type == "image/svg+xml" {
        return Some(format!(
            "data:{mime_type};base64,{}",
            STANDARD.encode(content)
        ));
    }

    let image = image::ImageReader::new(Cursor::new(content))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let (width, height) = (image.width(), image.height());
    if width <= MAX_PREVIEW_LONG_EDGE && height <= MAX_PREVIEW_LONG_EDGE {
        return Some(format!(
            "data:{mime_type};base64,{}",
            STANDARD.encode(content)
        ));
    }

    let resized = image.resize(
        MAX_PREVIEW_LONG_EDGE,
        MAX_PREVIEW_LONG_EDGE,
        image::imageops::FilterType::Lanczos3,
    );
    let mut encoded = Cursor::new(Vec::new());
    resized
        .write_to(&mut encoded, image::ImageFormat::Png)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(encoded.into_inner())
    ))
}
