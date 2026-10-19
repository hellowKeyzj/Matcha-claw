use std::{io::Cursor, path::Path};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, Limits};
use platform::state_dir::CanonicalStateDir;
use serde_json::Value;

const MAX_DATA_URL_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES: usize =
    ((MAX_DATA_URL_BYTES - "data:image/jpeg;base64,".len()) / 4) * 3;
const MAX_DECODED_BYTES: u64 = 128 * 1024 * 1024;

pub(super) fn screenshot_data_url(
    state_dir: &CanonicalStateDir,
    payload: &Value,
) -> Result<String, ()> {
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(());
    }
    let path = payload.get("path").and_then(Value::as_str).ok_or(())?;
    let file_name = screenshot_file_name(state_dir, path)?;
    let bytes = state_dir
        .read_nested_regular_file_bounded(
            &["media".into(), "browser".into(), file_name],
            MAX_SCREENSHOT_BYTES,
        )
        .map_err(|_| ())?
        .ok_or(())?;
    let (format, mime) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes.ends_with(b"\0\0\0\0IEND\xaeB\x60\x82")
    {
        (ImageFormat::Png, "image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") && bytes.ends_with(b"\xff\xd9") {
        (ImageFormat::Jpeg, "image/jpeg")
    } else {
        return Err(());
    };
    let mut limits = Limits::default();
    limits.max_image_width = Some(super::MAX_VIEWPORT_DIMENSION as u32);
    limits.max_image_height = Some(super::MAX_VIEWPORT_DIMENSION as u32);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| ())?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(());
    }
    drop(decoded);
    let data_url = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));
    (data_url.len() <= MAX_DATA_URL_BYTES)
        .then_some(data_url)
        .ok_or(())
}

fn screenshot_file_name(state_dir: &CanonicalStateDir, raw_path: &str) -> Result<String, ()> {
    let path = Path::new(raw_path);
    if !path.is_absolute() || raw_path.contains('\0') {
        return Err(());
    }
    #[cfg(not(windows))]
    if raw_path.contains('\\') {
        return Err(());
    }
    // Reject dot segments before Path::components can discard them.
    let spelling = raw_path.replace('\\', "/");
    if spelling.split('/').any(|part| matches!(part, "." | "..")) {
        return Err(());
    }
    let media = state_dir.as_path().join("media").join("browser");
    let parent = path
        .parent()
        .ok_or(())?
        .to_string_lossy()
        .replace('\\', "/");
    let expected = media.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let (parent, expected) = (
        external_windows_path(&parent).to_ascii_lowercase(),
        external_windows_path(&expected).to_ascii_lowercase(),
    );
    if parent != expected {
        return Err(());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(())?;
    if name.is_empty()
        || name.len() > 255
        || name.starts_with('.')
        || name.ends_with(['.', ' '])
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || !matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("png" | "jpg" | "jpeg")
        )
    {
        return Err(());
    }
    Ok(name.to_owned())
}

#[cfg(windows)]
fn external_windows_path(path: &str) -> String {
    if let Some(path) = path.strip_prefix("//?/UNC/") {
        format!("//{path}")
    } else {
        path.strip_prefix("//?/").unwrap_or(path).to_owned()
    }
}
