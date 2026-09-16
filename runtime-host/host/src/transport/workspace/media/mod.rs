use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    WorkspaceMediaError,
    runtime::driver::{
        ResolvedWorkspaceMedia, WorkspaceMediaReceipt, WorkspaceMediaThumbnail,
        WorkspaceMediaThumbnailEntry,
    },
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const CAPABILITY_ID: &str = "workspace.media";
const PREPARE_OPERATION_ID: &str = "media.prepare";
const RESOLVE_OPERATION_ID: &str = "media.resolve";
const THUMBNAIL_OPERATION_ID: &str = "media.thumbnail";
const THUMBNAILS_OPERATION_ID: &str = "media.thumbnails";
const STAGE_PATHS_OPERATION_ID: &str = "media.stagePaths";
const STAGE_BUFFER_OPERATION_ID: &str = "media.stageBuffer";
const AUTHORIZATION_ENDPOINT: &str = "/api/workspace/media";
const AUTHORIZATION_SCOPE: &str = "workspace-media:read";
const AUTHORIZATION_SUBJECT: &str = "workspace-media";
const MAX_MEDIA_BYTES: usize = 50 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = ((MAX_MEDIA_BYTES + 2) / 3) * 4;
const MAX_PATHS: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceMediaRequest {
    id: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

impl WorkspaceMediaRequest {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, ()> {
        let operation_id = value
            .get("operationId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                operation_id,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| ())?;
        let request = serde_json::from_value::<Self>(value).map_err(|_| ())?;
        request.valid().then_some(request).ok_or(())
    }

    fn valid(&self) -> bool {
        self.id == CAPABILITY_ID
            && matches!(
                self.operation_id.as_str(),
                PREPARE_OPERATION_ID
                    | RESOLVE_OPERATION_ID
                    | THUMBNAIL_OPERATION_ID
                    | THUMBNAILS_OPERATION_ID
                    | STAGE_PATHS_OPERATION_ID
                    | STAGE_BUFFER_OPERATION_ID
            )
            && self.scope.kind == "session"
            && self.scope.endpoint.is_openclaw_local()
            && self.scope.session_key == self.input.session_key()
            && self.input.endpoint() == &self.scope.endpoint
            && valid_session_key(self.input.session_key())
            && self.target.kind == "workspace-media"
            && match self.operation_id.as_str() {
                PREPARE_OPERATION_ID => self.input.is_relative_media(),
                THUMBNAIL_OPERATION_ID => self.input.is_relative_media() || self.input.is_gateway(),
                RESOLVE_OPERATION_ID => self.input.is_reference(),
                THUMBNAILS_OPERATION_ID => self.input.is_paths() && valid_paths(self.input.paths()),
                STAGE_PATHS_OPERATION_ID => {
                    self.input.is_paths()
                        && valid_paths(self.input.paths())
                        && self.input.paths().iter().all(MediaPathInput::is_relative)
                }
                STAGE_BUFFER_OPERATION_ID => self.input.is_stage_buffer(),
                _ => false,
            }
    }

    pub(crate) fn is_prepare(&self) -> bool {
        self.operation_id == PREPARE_OPERATION_ID
    }
    pub(crate) fn is_resolve(&self) -> bool {
        self.operation_id == RESOLVE_OPERATION_ID
    }
    pub(crate) fn is_thumbnail(&self) -> bool {
        self.operation_id == THUMBNAIL_OPERATION_ID
    }
    pub(crate) fn is_thumbnails(&self) -> bool {
        self.operation_id == THUMBNAILS_OPERATION_ID
    }
    pub(crate) fn is_stage_paths(&self) -> bool {
        self.operation_id == STAGE_PATHS_OPERATION_ID
    }
    pub(crate) fn is_stage_buffer(&self) -> bool {
        self.operation_id == STAGE_BUFFER_OPERATION_ID
    }
    pub(crate) fn session_key(&self) -> &str {
        &self.input.session_key
    }
    pub(crate) fn relative_path(&self) -> &str {
        self.input.relative_path.as_deref().unwrap_or_default()
    }
    pub(crate) fn gateway_url(&self) -> &str {
        self.input.gateway_url.as_deref().unwrap_or_default()
    }
    pub(crate) fn agent_id(&self) -> &str {
        self.input.agent_id.as_deref().unwrap_or_default()
    }
    pub(crate) fn mime_type(&self) -> &str {
        self.input.mime_type.as_deref().unwrap_or_default()
    }
    pub(crate) fn reference(&self) -> &str {
        self.input.reference.as_deref().unwrap_or_default()
    }
    pub(crate) fn paths(&self) -> &[MediaPathInput] {
        self.input.paths.as_deref().unwrap_or(&[])
    }
    pub(crate) fn base64(&self) -> &str {
        self.input.base64.as_deref().unwrap_or_default()
    }
    pub(crate) fn file_name(&self) -> &str {
        self.input.file_name.as_deref().unwrap_or_default()
    }
}

fn valid_session_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.as_bytes().contains(&0)
}

fn valid_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.as_bytes().contains(&0)
        && !value.starts_with(['/', '\\'])
        && !value.contains(':')
        && value
            .split(['/', '\\'])
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn valid_mime_type(value: &str) -> bool {
    !value.is_empty() && value.len() <= 255 && !value.as_bytes().contains(&0)
}

fn valid_gateway_url(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
        && outgoing_media_gateway_segments(value).is_some()
}

fn outgoing_media_gateway_segments(value: &str) -> Option<(&str, &str)> {
    const ABSOLUTE_PATH_PREFIX: &str = "/api/chat/media/outgoing/";
    const RELATIVE_PATH_PREFIX: &str = "api/chat/media/outgoing/";

    let tail = if let Some(value) = value.strip_prefix(ABSOLUTE_PATH_PREFIX) {
        value
    } else if let Some(value) = value.strip_prefix(RELATIVE_PATH_PREFIX) {
        value
    } else if let Some(value) = strip_http_gateway_path(value) {
        value
    } else {
        return None;
    };
    let mut segments = tail.split('/');
    let owner = segments.next()?;
    let attachment = segments.next()?;
    segments.next()?;
    if owner.is_empty() || attachment.is_empty() {
        return None;
    }
    Some((owner, attachment))
}

fn strip_http_gateway_path(value: &str) -> Option<&str> {
    let value = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))?;
    let (host, path) = value.split_once('/')?;
    if host.is_empty() {
        return None;
    }
    path.strip_prefix("api/chat/media/outgoing/")
}

fn valid_agent_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
}

fn valid_file_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.as_bytes().contains(&0)
}

fn valid_base64(value: &str) -> bool {
    value.len() <= MAX_BASE64_BYTES
        && value.len().is_multiple_of(4)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

fn valid_paths(value: &[MediaPathInput]) -> bool {
    !value.is_empty() && value.len() <= MAX_PATHS && value.iter().all(MediaPathInput::valid)
}

fn valid_reference(value: &str) -> bool {
    value.len() == 38
        && value.starts_with("media_")
        && value[6..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Scope {
    kind: String,
    endpoint: Endpoint,
    #[serde(rename = "sessionKey")]
    session_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Input {
    endpoint: Endpoint,
    #[serde(rename = "sessionKey")]
    session_key: String,
    #[serde(rename = "relativePath")]
    relative_path: Option<String>,
    #[serde(rename = "gatewayUrl")]
    gateway_url: Option<String>,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    reference: Option<String>,
    paths: Option<Vec<MediaPathInput>>,
    base64: Option<String>,
    #[serde(rename = "fileName")]
    file_name: Option<String>,
}

impl Input {
    fn session_key(&self) -> &str {
        &self.session_key
    }

    fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    fn paths(&self) -> &[MediaPathInput] {
        self.paths.as_deref().unwrap_or(&[])
    }

    fn is_relative_media(&self) -> bool {
        valid_relative_path(self.relative_path.as_deref().unwrap_or_default())
            && valid_mime_type(self.mime_type.as_deref().unwrap_or_default())
            && self.gateway_url.is_none()
            && self.agent_id.is_none()
            && self.reference.is_none()
            && self.paths.is_none()
            && self.base64.is_none()
            && self.file_name.is_none()
    }

    fn is_gateway(&self) -> bool {
        valid_gateway_url(self.gateway_url.as_deref().unwrap_or_default())
            && valid_agent_id(self.agent_id.as_deref().unwrap_or_default())
            && valid_mime_type(self.mime_type.as_deref().unwrap_or_default())
            && self.relative_path.is_none()
            && self.reference.is_none()
            && self.paths.is_none()
            && self.base64.is_none()
            && self.file_name.is_none()
    }

    fn is_reference(&self) -> bool {
        valid_reference(self.reference.as_deref().unwrap_or_default())
            && self.relative_path.is_none()
            && self.gateway_url.is_none()
            && self.mime_type.is_none()
            && self.agent_id.is_none()
            && self.paths.is_none()
            && self.base64.is_none()
            && self.file_name.is_none()
    }

    fn is_paths(&self) -> bool {
        self.paths.is_some()
            && self.relative_path.is_none()
            && self.gateway_url.is_none()
            && self.mime_type.is_none()
            && self.agent_id.is_none()
            && self.reference.is_none()
            && self.base64.is_none()
            && self.file_name.is_none()
    }

    fn is_stage_buffer(&self) -> bool {
        self.base64.as_deref().is_some_and(valid_base64)
            && valid_file_name(self.file_name.as_deref().unwrap_or_default())
            && valid_mime_type(self.mime_type.as_deref().unwrap_or_default())
            && self.relative_path.is_none()
            && self.gateway_url.is_none()
            && self.agent_id.is_none()
            && self.reference.is_none()
            && self.paths.is_none()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaPathInput {
    key: String,
    #[serde(rename = "relativePath")]
    relative_path: Option<String>,
    #[serde(rename = "gatewayUrl")]
    gateway_url: Option<String>,
    #[serde(rename = "mimeType")]
    mime_type: String,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
}

impl MediaPathInput {
    fn valid(&self) -> bool {
        !self.key.is_empty()
            && self.key.len() <= 4096
            && !self.key.as_bytes().contains(&0)
            && ((self
                .relative_path
                .as_deref()
                .is_some_and(valid_relative_path)
                && self.gateway_url.is_none()
                && self.agent_id.is_none())
                || (self.relative_path.is_none()
                    && self.gateway_url.as_deref().is_some_and(valid_gateway_url)
                    && self.agent_id.as_deref().is_some_and(valid_agent_id)))
            && valid_mime_type(&self.mime_type)
    }

    fn is_relative(&self) -> bool {
        self.relative_path.is_some()
    }

    fn is_gateway(&self) -> bool {
        self.gateway_url.is_some()
    }

    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn relative_path(&self) -> &str {
        self.relative_path.as_deref().unwrap_or_default()
    }

    pub(crate) fn gateway_url(&self) -> &str {
        self.gateway_url.as_deref().unwrap_or_default()
    }

    pub(crate) fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub(crate) fn agent_id(&self) -> &str {
        self.agent_id.as_deref().unwrap_or_default()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    #[serde(rename = "runtimeAdapterId")]
    runtime_adapter_id: String,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: String,
}

impl Endpoint {
    fn is_openclaw_local(&self) -> bool {
        self.kind == "native-runtime"
            && self.runtime_adapter_id == "openclaw"
            && self.runtime_instance_id == "local"
    }
}

pub(crate) enum WorkspaceMediaDelivery {
    Prepared(PreparedMedia),
    Resolved(ResolvedMedia),
    Thumbnail(ThumbnailMedia),
    Thumbnails(serde_json::Map<String, Value>),
    StagePaths(Vec<PreparedMedia>),
    StageBuffer(PreparedMedia),
    InvalidPath,
    InvalidReference,
    NotFile,
    TooLarge,
    Unavailable,
}

impl WorkspaceMediaDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Prepared(_)
            | Self::Resolved(_)
            | Self::Thumbnail(_)
            | Self::Thumbnails(_)
            | Self::StagePaths(_)
            | Self::StageBuffer(_) => 200,
            Self::InvalidPath | Self::InvalidReference | Self::NotFile | Self::TooLarge => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Prepared(value) => serde_json::to_value(value).expect("media receipt serializes"),
            Self::Resolved(value) => serde_json::to_value(value).expect("media bytes serialize"),
            Self::Thumbnail(value) => {
                serde_json::to_value(value).expect("media thumbnail serializes")
            }
            Self::Thumbnails(value) => Value::Object(value.clone()),
            Self::StagePaths(value) => {
                serde_json::to_value(value).expect("media receipts serialize")
            }
            Self::StageBuffer(value) => {
                serde_json::to_value(value).expect("media receipt serializes")
            }
            Self::InvalidPath => error("Workspace media path is invalid"),
            Self::InvalidReference => error("Workspace media reference is invalid"),
            Self::NotFile => error("Workspace media target is not a file"),
            Self::TooLarge => error("Workspace media target exceeds the limit"),
            Self::Unavailable => error("Workspace media is unavailable"),
        }
    }
}

fn error(message: &'static str) -> Value {
    serde_json::json!({ "success": false, "error": message })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedMedia {
    reference: String,
    name: String,
    mime_type: String,
    size: u64,
    preview: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedMedia {
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThumbnailMedia {
    preview: Option<String>,
    file_size: u64,
}

fn map_receipt(receipt: WorkspaceMediaReceipt) -> PreparedMedia {
    PreparedMedia {
        reference: receipt.reference().to_owned(),
        name: receipt.name().to_owned(),
        mime_type: receipt.mime_type().to_owned(),
        size: receipt.size(),
        preview: receipt.preview().map(str::to_owned),
    }
}

pub(crate) fn map_prepare(
    result: Result<WorkspaceMediaReceipt, WorkspaceMediaError>,
) -> WorkspaceMediaDelivery {
    result
        .map(map_receipt)
        .map(WorkspaceMediaDelivery::Prepared)
        .unwrap_or_else(map_error)
}

pub(crate) fn map_thumbnail(
    result: Result<WorkspaceMediaThumbnail, WorkspaceMediaError>,
) -> WorkspaceMediaDelivery {
    result
        .map(|thumbnail| {
            WorkspaceMediaDelivery::Thumbnail(ThumbnailMedia {
                preview: thumbnail.preview().map(str::to_owned),
                file_size: thumbnail.file_size(),
            })
        })
        .unwrap_or_else(map_error)
}

pub(crate) fn map_thumbnails(
    result: Result<Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaError>,
) -> WorkspaceMediaDelivery {
    result
        .map(|entries| {
            WorkspaceMediaDelivery::Thumbnails(
                entries
                    .into_iter()
                    .map(|entry| {
                        (
                            entry.key().to_owned(),
                            serde_json::json!({
                                "preview": entry.thumbnail().preview(),
                                "fileSize": entry.thumbnail().file_size(),
                            }),
                        )
                    })
                    .collect(),
            )
        })
        .unwrap_or_else(map_error)
}

pub(crate) fn map_stage_paths(
    result: Result<Vec<WorkspaceMediaReceipt>, WorkspaceMediaError>,
) -> WorkspaceMediaDelivery {
    result
        .map(|receipts| {
            WorkspaceMediaDelivery::StagePaths(receipts.into_iter().map(map_receipt).collect())
        })
        .unwrap_or_else(map_error)
}

pub(crate) fn map_stage_buffer(
    result: Result<WorkspaceMediaReceipt, WorkspaceMediaError>,
) -> WorkspaceMediaDelivery {
    result
        .map(map_receipt)
        .map(WorkspaceMediaDelivery::StageBuffer)
        .unwrap_or_else(map_error)
}

pub(crate) fn map_resolve(
    result: Result<ResolvedWorkspaceMedia, WorkspaceMediaError>,
) -> WorkspaceMediaDelivery {
    match result {
        Ok(media) if media.content().len() <= MAX_MEDIA_BYTES => {
            WorkspaceMediaDelivery::Resolved(ResolvedMedia {
                data: STANDARD.encode(media.content()),
            })
        }
        Ok(_) | Err(WorkspaceMediaError::TooLarge) => WorkspaceMediaDelivery::TooLarge,
        Err(error) => map_error(error),
    }
}

fn map_error(error: WorkspaceMediaError) -> WorkspaceMediaDelivery {
    match error {
        WorkspaceMediaError::InvalidPath => WorkspaceMediaDelivery::InvalidPath,
        WorkspaceMediaError::InvalidReference => WorkspaceMediaDelivery::InvalidReference,
        WorkspaceMediaError::NotFile => WorkspaceMediaDelivery::NotFile,
        WorkspaceMediaError::TooLarge => WorkspaceMediaDelivery::TooLarge,
        WorkspaceMediaError::AdmissionClosed(_) | WorkspaceMediaError::Unavailable => {
            WorkspaceMediaDelivery::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request() -> Value {
        json!({
            "id": "workspace.media",
            "operationId": "media.prepare",
            "scope": {
                "kind": "session",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
            },
            "target": { "kind": "workspace-media" },
            "input": {
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
                "sessionKey": "agent:main:demo",
                "relativePath": "images/asset.png",
                "mimeType": "image/png",
            },
        })
    }

    #[test]
    fn accepts_the_fixed_openclaw_local_prepare_wire_only() {
        let request = request();
        let parsed: WorkspaceMediaRequest =
            serde_json::from_value(request.clone()).expect("camel-case endpoint wire decodes");
        assert!(parsed.valid());

        for relative_path in ["/private/asset.png", "C:/private/asset.png", "../asset.png"] {
            let mut invalid = request.clone();
            invalid["input"]["relativePath"] = json!(relative_path);
            let parsed: WorkspaceMediaRequest =
                serde_json::from_value(invalid).expect("wire remains structurally valid");
            assert!(!parsed.valid(), "{relative_path}");
        }
    }

    fn gateway_request(gateway_url: &str) -> Value {
        let mut request = request();
        request["operationId"] = json!(THUMBNAIL_OPERATION_ID);
        let input = request["input"].as_object_mut().expect("input object");
        input.remove("relativePath");
        input.insert("gatewayUrl".to_owned(), json!(gateway_url));
        input.insert("agentId".to_owned(), json!("agent:main"));
        request
    }

    #[test]
    fn accepts_only_relative_or_http_workspace_media_gateway_urls() {
        for gateway_url in [
            "/api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full",
            "api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full",
            "http://gateway.local/api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full",
            "https://gateway.local/api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full",
        ] {
            let parsed: WorkspaceMediaRequest =
                serde_json::from_value(gateway_request(gateway_url))
                    .expect("gateway thumbnail request decodes");
            assert!(parsed.valid(), "{gateway_url}");
        }

        for gateway_url in [
            "file:///tmp/api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full",
            "ftp://gateway.local/api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full",
            "http:///api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full",
            "prefix/api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full",
        ] {
            let parsed: WorkspaceMediaRequest =
                serde_json::from_value(gateway_request(gateway_url))
                    .expect("gateway thumbnail request decodes");
            assert!(!parsed.valid(), "{gateway_url}");
        }
    }

    fn batch_request(operation_id: &str, paths: Value) -> Value {
        let mut request = request();
        request["operationId"] = json!(operation_id);
        let input = request["input"].as_object_mut().expect("input object");
        input.remove("relativePath");
        input.remove("mimeType");
        input.insert("paths".to_owned(), paths);
        request
    }

    #[test]
    fn accepts_mixed_thumbnail_paths_but_rejects_gateway_stage_paths_and_empty_batches() {
        let mixed_paths = json!([
            {
                "key": "relative.png",
                "relativePath": "images/relative.png",
                "mimeType": "image/png"
            },
            {
                "key": "gateway.png",
                "gatewayUrl": "https://gateway.local/api/chat/media/outgoing/agent%3Amain%3Ademo/attachment-1/full",
                "mimeType": "image/png",
                "agentId": "agent:main"
            }
        ]);

        let thumbnails: WorkspaceMediaRequest =
            serde_json::from_value(batch_request(THUMBNAILS_OPERATION_ID, mixed_paths.clone()))
                .expect("mixed thumbnail paths decode");
        assert!(thumbnails.valid());

        let stage_paths: WorkspaceMediaRequest =
            serde_json::from_value(batch_request(STAGE_PATHS_OPERATION_ID, mixed_paths))
                .expect("mixed stage paths decode");
        assert!(!stage_paths.valid());

        let empty_thumbnails: WorkspaceMediaRequest =
            serde_json::from_value(batch_request(THUMBNAILS_OPERATION_ID, json!([])))
                .expect("empty thumbnail batch decodes");
        assert!(!empty_thumbnails.valid());
    }
}
