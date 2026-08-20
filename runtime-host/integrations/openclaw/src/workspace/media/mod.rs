mod store;

use std::{fmt, io::Cursor};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use getrandom::fill;

use super::{WorkspaceBinaryFailure, WorkspaceFiles};
use crate::lifecycle::state_dir::CanonicalStateDir;
use store::MediaStore;

const MAX_MEDIA_BYTES: usize = 50 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = ((MAX_MEDIA_BYTES + 2) / 3) * 4;
const HANDLE_BYTES: usize = 16;
const HANDLE_PREFIX: &str = "media_";

pub(super) struct WorkspaceMedia {
    store: MediaStore,
}

impl WorkspaceMedia {
    pub fn new() -> Self {
        Self {
            store: MediaStore::new(),
        }
    }

    pub fn prepare(
        &self,
        session_key: &str,
        files: &WorkspaceFiles,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure> {
        let binary = files
            .read_binary(relative_path, MAX_MEDIA_BYTES)
            .map_err(WorkspaceMediaFailure::from)?;
        let mime_type = normalized_mime_type(mime_type, relative_path, &binary.content)?;
        let handle = MediaHandle::generate()?;
        let name = file_name(relative_path);
        let size = binary.size;
        let preview = image_preview(&binary.content, &mime_type);
        self.store
            .insert(session_key, handle.clone(), binary.content)
            .map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        Ok(WorkspaceMediaReceipt {
            handle,
            name,
            mime_type,
            size,
            preview,
        })
    }

    pub(super) fn resolve(
        &self,
        session_key: &str,
        handle: &str,
    ) -> Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure> {
        let handle = MediaHandle::parse(handle)?;
        self.store
            .take(session_key, &handle)
            .ok_or(WorkspaceMediaFailure::Unavailable)
    }

    pub fn thumbnail_gateway(
        &self,
        state_dir: &CanonicalStateDir,
        session_key: &str,
        gateway_url: &str,
        agent_id: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
        let (owner_key, attachment_id) = parse_gateway_url(gateway_url)?;
        let record_name = format!("{attachment_id}.json");
        let components = vec![
            "media".to_owned(),
            "outgoing".to_owned(),
            "records".to_owned(),
            record_name,
        ];
        let record = state_dir
            .read_nested_regular_file_bounded(&components, 1_048_576)
            .map_err(|_| WorkspaceMediaFailure::Unavailable)?
            .ok_or(WorkspaceMediaFailure::Unavailable)?;
        let record: serde_json::Value =
            serde_json::from_slice(&record).map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        if !gateway_owner_matches(&record, &owner_key, agent_id, session_key) {
            return Err(WorkspaceMediaFailure::Unavailable);
        }
        let original = record
            .get("original")
            .and_then(serde_json::Value::as_object)
            .ok_or(WorkspaceMediaFailure::Unavailable)?;
        let original_path = original
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or(WorkspaceMediaFailure::Unavailable)?;
        let content_type = original
            .get("contentType")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(mime_type);
        let path = std::path::Path::new(original_path);
        let (content, size) = WorkspaceFiles::read_external_file(path, MAX_MEDIA_BYTES)
            .map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        let preview = if size as usize > MAX_THUMBNAIL_BYTES {
            None
        } else {
            let normalized = normalized_mime_type(content_type, original_path, &content)?;
            image_preview(&content, &normalized)
        };
        Ok(WorkspaceMediaThumbnail {
            preview,
            file_size: size,
        })
    }

    pub fn thumbnail(
        &self,
        files: &WorkspaceFiles,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
        let entry = files
            .stat(relative_path)
            .map_err(WorkspaceMediaFailure::from)?;
        if entry.kind != super::access::WorkspaceEntryKind::File {
            return Err(WorkspaceMediaFailure::NotFile);
        }
        let entry_size =
            usize::try_from(entry.size).map_err(|_| WorkspaceMediaFailure::TooLarge)?;
        if entry_size > MAX_MEDIA_BYTES {
            return Err(WorkspaceMediaFailure::TooLarge);
        }
        if entry_size > MAX_THUMBNAIL_BYTES {
            return Ok(WorkspaceMediaThumbnail {
                preview: None,
                file_size: entry.size,
            });
        }
        let binary = files
            .read_binary(relative_path, MAX_THUMBNAIL_BYTES)
            .map_err(WorkspaceMediaFailure::from)?;
        let mime_type = normalized_mime_type(mime_type, relative_path, &binary.content)?;
        Ok(WorkspaceMediaThumbnail {
            preview: image_preview(&binary.content, &mime_type),
            file_size: entry.size,
        })
    }

    pub fn thumbnails(
        &self,
        files: &WorkspaceFiles,
        paths: &[WorkspaceMediaPath],
    ) -> Vec<WorkspaceMediaThumbnailEntry> {
        paths
            .iter()
            .map(|path| {
                let thumbnail = self
                    .thumbnail(files, path.relative_path(), path.mime_type())
                    .unwrap_or_else(|_| WorkspaceMediaThumbnail::empty());
                WorkspaceMediaThumbnailEntry {
                    key: path.key().to_owned(),
                    thumbnail,
                }
            })
            .collect()
    }

    pub fn thumbnails_with_gateway_context(
        &self,
        state_dir: &CanonicalStateDir,
        session_key: &str,
        files: &WorkspaceFiles,
        paths: &[WorkspaceMediaPath],
    ) -> Vec<WorkspaceMediaThumbnailEntry> {
        paths
            .iter()
            .map(|path| {
                let thumbnail = if path.is_gateway() {
                    self.thumbnail_gateway(
                        state_dir,
                        session_key,
                        path.gateway_url(),
                        path.agent_id(),
                        path.mime_type(),
                    )
                } else {
                    self.thumbnail(files, path.relative_path(), path.mime_type())
                }
                .unwrap_or_else(|_| WorkspaceMediaThumbnail::empty());
                WorkspaceMediaThumbnailEntry {
                    key: path.key().to_owned(),
                    thumbnail,
                }
            })
            .collect()
    }

    pub fn stage_paths(
        &self,
        session_key: &str,
        files: &WorkspaceFiles,
        paths: &[WorkspaceMediaPath],
    ) -> Result<Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure> {
        paths
            .iter()
            .map(|path| self.prepare(session_key, files, path.relative_path(), path.mime_type()))
            .collect()
    }

    pub fn stage_buffer(
        &self,
        session_key: &str,
        base64: &str,
        file_name_value: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure> {
        if base64.len() > MAX_BASE64_BYTES {
            return Err(WorkspaceMediaFailure::TooLarge);
        }
        let content = STANDARD
            .decode(base64)
            .map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        if content.len() > MAX_MEDIA_BYTES {
            return Err(WorkspaceMediaFailure::TooLarge);
        }
        let mime_type = normalized_mime_type(mime_type, file_name_value, &content)?;
        let handle = MediaHandle::generate()?;
        let size = content.len() as u64;
        let preview = image_preview(&content, &mime_type);
        self.store
            .insert(session_key, handle.clone(), content)
            .map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        Ok(WorkspaceMediaReceipt {
            handle,
            name: file_name(file_name_value),
            mime_type,
            size,
            preview,
        })
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct WorkspaceMediaPath {
    key: String,
    relative_path: Option<String>,
    gateway_url: Option<String>,
    agent_id: Option<String>,
    mime_type: String,
}

impl fmt::Debug for WorkspaceMediaPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceMediaPath")
            .field(
                "kind",
                &if self.is_gateway() {
                    "gateway"
                } else {
                    "relative"
                },
            )
            .field("mime_type", &self.mime_type)
            .finish_non_exhaustive()
    }
}

impl WorkspaceMediaPath {
    pub fn new(key: String, relative_path: String, mime_type: String) -> Self {
        Self {
            key,
            relative_path: Some(relative_path),
            gateway_url: None,
            agent_id: None,
            mime_type,
        }
    }

    pub fn new_gateway(
        key: String,
        gateway_url: String,
        mime_type: String,
        agent_id: String,
    ) -> Self {
        Self {
            key,
            relative_path: None,
            gateway_url: Some(gateway_url),
            agent_id: Some(agent_id),
            mime_type,
        }
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn relative_path(&self) -> &str {
        self.relative_path.as_deref().unwrap_or_default()
    }

    pub fn gateway_url(&self) -> &str {
        self.gateway_url.as_deref().unwrap_or_default()
    }

    pub fn agent_id(&self) -> &str {
        self.agent_id.as_deref().unwrap_or_default()
    }

    pub fn is_gateway(&self) -> bool {
        self.gateway_url.is_some()
    }

    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceMediaThumbnail {
    preview: Option<String>,
    file_size: u64,
}

impl WorkspaceMediaThumbnail {
    fn empty() -> Self {
        Self {
            preview: None,
            file_size: 0,
        }
    }

    pub fn preview(&self) -> Option<&str> {
        self.preview.as_deref()
    }

    pub const fn file_size(&self) -> u64 {
        self.file_size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceMediaThumbnailEntry {
    key: String,
    thumbnail: WorkspaceMediaThumbnail,
}

impl WorkspaceMediaThumbnailEntry {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn thumbnail(&self) -> &WorkspaceMediaThumbnail {
        &self.thumbnail
    }
}

fn parse_gateway_url(value: &str) -> Result<(String, String), WorkspaceMediaFailure> {
    let marker = "/api/chat/media/outgoing/";
    let start = value
        .find(marker)
        .ok_or(WorkspaceMediaFailure::Unavailable)?
        + marker.len();
    let tail = &value[start..];
    let mut segments = tail.split('/');
    let owner = percent_decode(segments.next().ok_or(WorkspaceMediaFailure::Unavailable)?)?;
    let attachment = percent_decode(segments.next().ok_or(WorkspaceMediaFailure::Unavailable)?)?;
    if segments.next().is_none()
        || owner.is_empty()
        || attachment.is_empty()
        || !attachment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(WorkspaceMediaFailure::Unavailable);
    }
    Ok((owner, attachment))
}

fn percent_decode(value: &str) -> Result<String, WorkspaceMediaFailure> {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(WorkspaceMediaFailure::Unavailable);
            }
            let high = hex(bytes[index + 1]).ok_or(WorkspaceMediaFailure::Unavailable)?;
            let low = hex(bytes[index + 2]).ok_or(WorkspaceMediaFailure::Unavailable)?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| WorkspaceMediaFailure::Unavailable)
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn gateway_owner_matches(
    record: &serde_json::Value,
    owner: &str,
    agent_id: &str,
    session_key: &str,
) -> bool {
    if record.get("sessionIdentity").is_some() {
        let Some(identity) = record
            .get("sessionIdentity")
            .and_then(serde_json::Value::as_object)
        else {
            return false;
        };
        return identity.get("agentId").and_then(serde_json::Value::as_str) == Some(agent_id)
            && identity
                .get("sessionKey")
                .and_then(serde_json::Value::as_str)
                == Some(session_key);
    }
    if session_key.starts_with("team-role-session-") {
        return owner == session_key;
    }
    owner == session_key
        || owner == format!("agent:{agent_id}:{session_key}")
        || record
            .get("owner")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value == owner)
}

fn file_name(relative_path: &str) -> String {
    relative_path
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("file")
        .to_owned()
}

fn normalized_mime_type(
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
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp"
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
    } else {
        None
    }
}

const MAX_PREVIEW_LONG_EDGE: u32 = 512;

fn image_preview(content: &[u8], mime_type: &str) -> Option<String> {
    if !is_supported_image_mime(mime_type)
        || image_mime_type(content) != Some(mime_type)
        || content.len() > MAX_THUMBNAIL_BYTES
    {
        return None;
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

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct MediaHandle(String);

impl MediaHandle {
    fn generate() -> Result<Self, WorkspaceMediaFailure> {
        let mut entropy = [0_u8; HANDLE_BYTES];
        fill(&mut entropy).map_err(|_| WorkspaceMediaFailure::Unavailable)?;
        let mut value = String::with_capacity(HANDLE_PREFIX.len() + HANDLE_BYTES * 2);
        value.push_str(HANDLE_PREFIX);
        for byte in entropy {
            use std::fmt::Write as _;
            let _ = write!(value, "{byte:02x}");
        }
        Ok(Self(value))
    }

    fn parse(value: &str) -> Result<Self, WorkspaceMediaFailure> {
        (value.len() == HANDLE_PREFIX.len() + HANDLE_BYTES * 2
            && value.starts_with(HANDLE_PREFIX)
            && value
                .as_bytes()
                .get(HANDLE_PREFIX.len()..)
                .is_some_and(|bytes| bytes.iter().all(u8::is_ascii_hexdigit)))
        .then(|| Self(value.to_owned()))
        .ok_or(WorkspaceMediaFailure::InvalidReference)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for MediaHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MediaHandle([OPAQUE])")
    }
}

#[derive(PartialEq)]
pub struct WorkspaceMediaReceipt {
    handle: MediaHandle,
    name: String,
    mime_type: String,
    size: u64,
    preview: Option<String>,
}

impl WorkspaceMediaReceipt {
    pub fn handle(&self) -> &MediaHandle {
        &self.handle
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }
    pub const fn size(&self) -> u64 {
        self.size
    }
    pub fn preview(&self) -> Option<&str> {
        self.preview.as_deref()
    }
}

impl fmt::Debug for WorkspaceMediaReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkspaceMediaReceipt")
            .field("handle", &self.handle)
            .field("name", &self.name)
            .field("mime_type", &self.mime_type)
            .field("size", &self.size)
            .field("has_preview", &self.preview.is_some())
            .finish()
    }
}

pub struct ResolvedWorkspaceMedia {
    content: Vec<u8>,
}

impl ResolvedWorkspaceMedia {
    pub fn content(&self) -> &[u8] {
        &self.content
    }
}

impl fmt::Debug for ResolvedWorkspaceMedia {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ResolvedWorkspaceMedia([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceMediaFailure {
    InvalidPath,
    InvalidReference,
    Unavailable,
    NotFile,
    TooLarge,
}

impl From<super::access::WorkspaceFileError> for WorkspaceMediaFailure {
    fn from(value: super::access::WorkspaceFileError) -> Self {
        match value {
            super::access::WorkspaceFileError::InvalidRelative => Self::InvalidPath,
            super::access::WorkspaceFileError::NotFile => Self::NotFile,
            super::access::WorkspaceFileError::TooLarge => Self::TooLarge,
            _ => Self::Unavailable,
        }
    }
}

impl From<WorkspaceBinaryFailure> for WorkspaceMediaFailure {
    fn from(value: WorkspaceBinaryFailure) -> Self {
        match value {
            WorkspaceBinaryFailure::InvalidPath => Self::InvalidPath,
            WorkspaceBinaryFailure::NotFile => Self::NotFile,
            WorkspaceBinaryFailure::TooLarge => Self::TooLarge,
            WorkspaceBinaryFailure::Unavailable => Self::Unavailable,
        }
    }
}

impl fmt::Display for WorkspaceMediaFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPath => "workspace media path is invalid",
            Self::InvalidReference => "workspace media reference is invalid",
            Self::Unavailable => "workspace media is unavailable",
            Self::NotFile => "workspace media target is not a file",
            Self::TooLarge => "workspace media target exceeds the limit",
        })
    }
}

impl std::error::Error for WorkspaceMediaFailure {}
