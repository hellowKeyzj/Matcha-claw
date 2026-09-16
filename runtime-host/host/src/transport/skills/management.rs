use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path},
    sync::Arc,
};

use crate::skills::management::{
    Command, Detail, ImportOutcome, MutationOutcome, Outcome, ReadError, ReadmeError,
    RemoveOutcome, UploadOutcome,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{facade::SkillsHandle, transport::common::authorization::CapabilityDecisionVerifier};

pub(crate) const ENDPOINT: &str = "/api/skills/status";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const STATUS_SCOPE: &str = "skills:read";
const STATUS_CAPABILITY: &str = "skills.status";
const STATUS_SUBJECT: &str = "skills-status";
const MAX_BUNDLE_FILES: usize = 64;
const MAX_BUNDLE_FILE_BYTES: usize = 48 * 1024;
const MAX_BUNDLE_BYTES: usize = 48 * 1024;
const MAX_BUNDLE_PATH_BYTES: usize = 240;
const MAX_BUNDLE_SKILL_KEY_BYTES: usize = 96;
const SKILL_MANIFEST: &str = "SKILL.md";

pub(crate) const DETAIL_ENDPOINT: &str = "/api/skills/detail";
pub(crate) const CONFIG_ENDPOINT: &str = "/api/skills/config";
pub(crate) const CLAWHUB_INSTALL_ENDPOINT: &str = "/api/skills/clawhub/install";
pub(crate) const CLAWHUB_UPDATE_ENDPOINT: &str = "/api/skills/clawhub/update";
pub(crate) const UPLOAD_BEGIN_ENDPOINT: &str = "/api/skills/upload/begin";
pub(crate) const UPLOAD_CHUNK_ENDPOINT: &str = "/api/skills/upload/chunk";
pub(crate) const UPLOAD_COMMIT_ENDPOINT: &str = "/api/skills/upload/commit";
pub(crate) const UNINSTALL_ENDPOINT: &str = "/api/skills/uninstall";
pub(crate) const IMPORT_MARKDOWN_ENDPOINT: &str = "/api/skills/import/markdown";
pub(crate) const IMPORT_BUNDLE_ENDPOINT: &str = "/api/skills/import/bundle";
pub(crate) const README_ENDPOINT: &str = "/api/skills/readme";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

pub(crate) async fn handle_status(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsHandle,
    now: u64,
) -> Result<Value, RequestError> {
    verify(
        headers,
        verifier,
        now,
        ENDPOINT,
        STATUS_SCOPE,
        STATUS_CAPABILITY,
        STATUS_SUBJECT,
    )
    .await?;
    match handle
        .skill_status()
        .await
        .map_err(|_| RequestError::Invalid)?
    {
        crate::skills::status::Outcome::Available(catalog) => {
            eprintln!(
                "[startup-trace] source=skills-status phase=transport detail=available entries={}",
                catalog.entries.len()
            );
            Ok(crate::skills::status::project(&catalog))
        }
        crate::skills::status::Outcome::Unavailable => {
            eprintln!("[startup-trace] source=skills-status phase=transport detail=unavailable");
            Err(RequestError::Invalid)
        }
    }
}

pub(crate) async fn handle_management(
    endpoint: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsHandle,
    now: u64,
) -> Result<Outcome, RequestError> {
    let (scope, capability, subject) = authorization(endpoint).ok_or(RequestError::Invalid)?;
    let authorization = bearer(headers).ok_or(RequestError::Unauthorized)?;
    {
        let mut verifier = verifier.lock().await;
        verifier
            .verify(authorization, now, endpoint, scope, capability, subject)
            .map_err(|_| RequestError::Unauthorized)?;
    }
    let value = serde_json::from_slice::<Value>(body).map_err(|_| RequestError::Invalid)?;
    let command = decode(endpoint, value).map_err(|_| RequestError::Invalid)?;
    handle
        .manage_skills(command)
        .await
        .map_err(|_| RequestError::Invalid)
}

fn authorization(endpoint: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match endpoint {
        DETAIL_ENDPOINT => ("skills:read", "skills.detail", "skills-detail"),
        CONFIG_ENDPOINT => (
            "skills:config:write",
            "skills.config.update",
            "skills-config",
        ),
        CLAWHUB_INSTALL_ENDPOINT => ("skills:install", "skills.install", "skills-clawhub-install"),
        CLAWHUB_UPDATE_ENDPOINT => ("skills:update", "skills.update", "skills-clawhub-update"),
        UPLOAD_BEGIN_ENDPOINT => (
            "skills:upload",
            "skills.upload.begin",
            "skills-upload-begin",
        ),
        UPLOAD_CHUNK_ENDPOINT => (
            "skills:upload",
            "skills.upload.chunk",
            "skills-upload-chunk",
        ),
        UPLOAD_COMMIT_ENDPOINT => (
            "skills:upload",
            "skills.upload.commit",
            "skills-upload-commit",
        ),
        UNINSTALL_ENDPOINT => ("skills:uninstall", "skills.uninstall", "skills-uninstall"),
        IMPORT_MARKDOWN_ENDPOINT => (
            "skills:import",
            "skills.import.markdown",
            "skills-import-markdown",
        ),
        IMPORT_BUNDLE_ENDPOINT => (
            "skills:import",
            "skills.import.bundle",
            "skills-import-bundle",
        ),
        README_ENDPOINT => ("skills:read", "skills.readme", "skills-readme"),
        _ => return None,
    })
}

async fn verify<'a>(
    headers: &'a [(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    now: u64,
    endpoint: &str,
    scope: &str,
    capability: &str,
    subject: &str,
) -> Result<&'a str, RequestError> {
    let authorization = bearer(headers).ok_or(RequestError::Unauthorized)?;
    verifier
        .lock()
        .await
        .verify(authorization, now, endpoint, scope, capability, subject)
        .map_err(|_| RequestError::Unauthorized)?;
    Ok(authorization)
}

fn bearer(headers: &[(String, String)]) -> Option<&str> {
    headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DetailRequest {
    slug: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigRequest {
    skill_key: String,
    enabled: Option<bool>,
    api_key: Option<String>,
    env: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallRequest {
    slug: String,
    version: Option<String>,
    force: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateRequest {
    slug: Option<String>,
    all: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadBeginRequest {
    kind: String,
    slug: String,
    size_bytes: u64,
    sha256: String,
    force: Option<bool>,
    idempotency_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadChunkRequest {
    upload_id: String,
    offset: u64,
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadCommitRequest {
    upload_id: String,
    sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UninstallRequest {
    skill_key: String,
    slug: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkdownImportRequest {
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleImportRequest {
    skill_key: String,
    files: Vec<BundleFileRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleFileRequest {
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadmeRequest {
    skill_key: String,
    slug: Option<String>,
    file_path: Option<String>,
    base_dir: Option<String>,
}

fn decode(endpoint: &str, value: Value) -> Result<Command, ()> {
    match endpoint {
        DETAIL_ENDPOINT => {
            let request = serde_json::from_value::<DetailRequest>(value).map_err(|_| ())?;
            Command::detail(request.slug)
        }
        CONFIG_ENDPOINT => {
            reject_nulls(&value, &["enabled", "apiKey", "env"])?;
            let request = serde_json::from_value::<ConfigRequest>(value).map_err(|_| ())?;
            Command::config(
                request.skill_key,
                request.enabled,
                request.api_key,
                request.env,
            )
        }
        CLAWHUB_INSTALL_ENDPOINT => {
            reject_nulls(&value, &["version", "force"])?;
            let request = serde_json::from_value::<InstallRequest>(value).map_err(|_| ())?;
            Command::clawhub_install(
                request.slug,
                request.version,
                request.force.unwrap_or(false),
            )
        }
        CLAWHUB_UPDATE_ENDPOINT => {
            reject_nulls(&value, &["slug", "all"])?;
            let request = serde_json::from_value::<UpdateRequest>(value).map_err(|_| ())?;
            let all = request.all.unwrap_or(false);
            Command::clawhub_update(request.slug, all)
        }
        UPLOAD_BEGIN_ENDPOINT => {
            reject_nulls(&value, &["force", "idempotencyKey"])?;
            let request = serde_json::from_value::<UploadBeginRequest>(value).map_err(|_| ())?;
            if request.kind != "skill-archive" {
                return Err(());
            }
            Command::upload_begin(
                request.slug,
                request.size_bytes,
                request.sha256,
                request.force.unwrap_or(false),
                request.idempotency_key,
            )
        }
        UPLOAD_CHUNK_ENDPOINT => {
            let request = serde_json::from_value::<UploadChunkRequest>(value).map_err(|_| ())?;
            let bytes = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                request.data_base64,
            )
            .map_err(|_| ())?;
            Command::upload_chunk(request.upload_id, request.offset, bytes)
        }
        UPLOAD_COMMIT_ENDPOINT => {
            let request = serde_json::from_value::<UploadCommitRequest>(value).map_err(|_| ())?;
            Command::upload_commit(request.upload_id, request.sha256)
        }
        UNINSTALL_ENDPOINT => {
            reject_nulls(&value, &["slug"])?;
            let request = serde_json::from_value::<UninstallRequest>(value).map_err(|_| ())?;
            Command::uninstall(request.skill_key, request.slug)
        }
        IMPORT_MARKDOWN_ENDPOINT => {
            let request = serde_json::from_value::<MarkdownImportRequest>(value).map_err(|_| ())?;
            if request.content.len() > 48 * 1024 || request.content.contains('\0') {
                return Err(());
            }
            Command::import_markdown(request.content)
        }
        IMPORT_BUNDLE_ENDPOINT => decode_bundle_import(value),
        README_ENDPOINT => {
            reject_nulls(&value, &["slug", "filePath", "baseDir"])?;
            let request = serde_json::from_value::<ReadmeRequest>(value).map_err(|_| ())?;
            Command::readme(
                request.skill_key,
                request.slug,
                request.file_path,
                request.base_dir,
            )
        }
        _ => Err(()),
    }
}

fn reject_nulls(value: &Value, optional_fields: &[&str]) -> Result<(), ()> {
    let object = value.as_object().ok_or(())?;
    if optional_fields
        .iter()
        .any(|field| object.get(*field).is_some_and(Value::is_null))
    {
        Err(())
    } else {
        Ok(())
    }
}

fn decode_bundle_import(value: Value) -> Result<Command, ()> {
    let request = serde_json::from_value::<BundleImportRequest>(value).map_err(|_| ())?;
    if request.files.is_empty() || request.files.len() > MAX_BUNDLE_FILES {
        return Err(());
    }
    validate_bundle_skill_key(&request.skill_key)?;
    let mut paths = BTreeSet::new();
    let mut total_bytes = 0usize;
    let mut files = Vec::with_capacity(request.files.len());
    for file in request.files {
        validate_bundle_path(&file.path)?;
        if file.content.len() > MAX_BUNDLE_FILE_BYTES
            || file.content.contains('\0')
            || !paths.insert(file.path.clone())
        {
            return Err(());
        }
        total_bytes = total_bytes.checked_add(file.content.len()).ok_or(())?;
        if total_bytes > MAX_BUNDLE_BYTES {
            return Err(());
        }
        files.push(
            crate::skills::bundle::BundleFile::try_new(file.path, file.content).map_err(|_| ())?,
        );
    }
    if !paths.contains(SKILL_MANIFEST) {
        return Err(());
    }
    let bundle =
        crate::skills::bundle::Bundle::try_new(request.skill_key, files).map_err(|_| ())?;
    Command::import_bundle(bundle)
}

fn validate_bundle_path(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > MAX_BUNDLE_PATH_BYTES
        || value.contains('\\')
        || value.contains('\0')
        || value.starts_with('/')
        || value.starts_with("\\\\")
        || Path::new(value).is_absolute()
        || value
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
        || Path::new(value)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.split('/').next().is_some_and(|component| {
            let bytes = component.as_bytes();
            bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
        })
    {
        return Err(());
    }
    Ok(())
}

fn validate_bundle_skill_key(value: &str) -> Result<(), ()> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_BUNDLE_SKILL_KEY_BYTES
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && byte == b'-'))
        || value.ends_with('-')
    {
        return Err(());
    }
    Ok(())
}

pub(crate) fn response(outcome: Outcome) -> (u16, Value) {
    match outcome {
        Outcome::Detail(Ok(detail)) => (200, detail_projection(&detail)),
        Outcome::Detail(Err(ReadError::Rejected)) | Outcome::Rejected => {
            (400, json!({ "outcome": "rejected" }))
        }
        Outcome::Detail(Err(_)) | Outcome::Unavailable => (503, json!({ "outcome": "unknown" })),
        Outcome::Upload(UploadOutcome::Accepted(receipt)) => {
            let mut value = json!({
                "uploadId": receipt.upload_id,
                "receivedBytes": receipt.received_bytes,
                "expiresAt": receipt.expires_at,
            });
            if let Some(sha256) = receipt.sha256 {
                value["sha256"] = json!(sha256);
            }
            (200, value)
        }
        Outcome::Uninstall(RemoveOutcome::Removed) => (200, json!({ "outcome": "removed" })),
        Outcome::Uninstall(RemoveOutcome::NotFound) => (404, json!({ "outcome": "notFound" })),
        Outcome::Uninstall(RemoveOutcome::Rejected) => (400, json!({ "outcome": "rejected" })),
        Outcome::Uninstall(RemoveOutcome::Unknown) => (503, json!({ "outcome": "unknown" })),
        Outcome::Import(ImportOutcome::Accepted) => (200, json!({ "outcome": "accepted" })),
        Outcome::Import(ImportOutcome::Rejected) => (400, json!({ "outcome": "rejected" })),
        Outcome::Import(ImportOutcome::Unknown) => (503, json!({ "outcome": "unknown" })),
        Outcome::Readme(Ok(receipt)) => (
            200,
            json!({
                "success": true,
                "content": receipt.content,
                "filePath": receipt.file_path,
            }),
        ),
        Outcome::Readme(Err(ReadmeError::Rejected)) => (400, json!({ "outcome": "rejected" })),
        Outcome::Readme(Err(ReadmeError::Unknown)) => (503, json!({ "outcome": "unknown" })),
        Outcome::OpenPath(Ok(_)) => (200, json!({ "success": true })),
        Outcome::OpenPath(Err(ReadmeError::Rejected)) => (400, json!({ "outcome": "rejected" })),
        Outcome::OpenPath(Err(ReadmeError::Unknown)) => (503, json!({ "outcome": "unknown" })),
        Outcome::Upload(UploadOutcome::Rejected) => (400, json!({ "outcome": "rejected" })),
        Outcome::Upload(UploadOutcome::Unknown) => (503, json!({ "outcome": "unknown" })),
        Outcome::Mutation(MutationOutcome::Accepted) => (200, json!({ "outcome": "accepted" })),
        Outcome::Mutation(MutationOutcome::Rejected) => (400, json!({ "outcome": "rejected" })),
        Outcome::Mutation(MutationOutcome::Unknown) => (503, json!({ "outcome": "unknown" })),
    }
}

fn detail_projection(detail: &Detail) -> Value {
    let skill = detail.skill.as_ref().map(|skill| {
        json!({
            "slug": skill.slug, "displayName": skill.display_name, "summary": skill.summary,
            "tags": skill.tags, "createdAt": skill.created_at, "updatedAt": skill.updated_at,
        })
    });
    let latest = detail.latest_version.as_ref().map(|version| json!({
        "version": version.version, "createdAt": version.created_at, "changelog": version.changelog,
    }));
    let metadata = detail
        .metadata
        .as_ref()
        .map(|metadata| json!({ "os": metadata.os, "systems": metadata.systems }));
    let owner = detail.owner.as_ref().map(|owner| {
        json!({
            "handle": owner.handle, "displayName": owner.display_name, "image": owner.image,
        })
    });
    json!({ "skill": skill, "latestVersion": latest, "metadata": metadata, "owner": owner })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_import_decoders_reject_unknown_fields_and_validate_bundle_shape() {
        assert!(
            decode(
                IMPORT_MARKDOWN_ENDPOINT,
                json!({"content": "---\\nname: x\\ndescription: y\\n---\\n", "path": "secret"})
            )
            .is_err()
        );
        assert!(decode(
            IMPORT_BUNDLE_ENDPOINT,
            json!({
                "skillKey": "web-search",
                "files": [{"path": "SKILL.md", "content": "---\nname: web-search\ndescription: Search\n---\n"}]
            })
        )
        .is_ok());
        for path in [
            "../secret",
            "/absolute/secret",
            "C:/absolute/secret",
            "C:relative/secret",
            "nested/../secret",
            "nested/./secret",
            "nested//secret",
            "safe\0name",
        ] {
            assert!(
                decode(
                    IMPORT_BUNDLE_ENDPOINT,
                    json!({
                        "skillKey": "web-search",
                        "files": [{"path": path, "content": "x"}]
                    })
                )
                .is_err(),
                "unsafe bundle path accepted: {path:?}"
            );
        }
        assert!(
            decode(
                IMPORT_BUNDLE_ENDPOINT,
                json!({
                    "skillKey": "web-search",
                    "files": [{"path": "SKILL.md", "content": "safe\0content"}]
                })
            )
            .is_err()
        );
        assert!(
            decode(
                IMPORT_BUNDLE_ENDPOINT,
                json!({
                    "skillKey": "web-search",
                    "files": [{"path": "a".repeat(MAX_BUNDLE_PATH_BYTES + 1), "content": "x"}]
                })
            )
            .is_err()
        );
        assert!(
            decode(
                IMPORT_BUNDLE_ENDPOINT,
                json!({
                    "skillKey": "web-search",
                    "files": [
                        {"path": "SKILL.md", "content": "x"},
                        {"path": "README.md", "content": "x".repeat(MAX_BUNDLE_FILE_BYTES)}
                    ]
                })
            )
            .is_err()
        );
    }

    #[test]
    fn config_and_clawhub_install_decode_current_api_payloads() {
        assert!(matches!(
            decode(CONFIG_ENDPOINT, json!({"skillKey": "web-search", "enabled": false})),
            Ok(Command::Config { skill_key, enabled: Some(false), api_key: None, env: None })
                if skill_key == "web-search"
        ));
        assert!(matches!(
            decode(CLAWHUB_INSTALL_ENDPOINT, json!({"slug": "web-search", "force": true})),
            Ok(Command::ClawHubInstall { slug, version: None, force: true })
                if slug == "web-search"
        ));
        assert!(matches!(
            decode(
                UNINSTALL_ENDPOINT,
                json!({"skillKey": "163邮箱助手专业版", "slug": "163-email-assistant"})
            ),
            Ok(Command::Uninstall { skill_key, slug: Some(slug) })
                if skill_key == "163邮箱助手专业版" && slug == "163-email-assistant"
        ));
        assert!(
            decode(
                UNINSTALL_ENDPOINT,
                json!({"skillKey": "163邮箱助手专业版", "slug": null})
            )
            .is_err()
        );
        assert!(matches!(
            decode(
                README_ENDPOINT,
                json!({
                    "skillKey": "web-search",
                    "slug": "web-search",
                    "filePath": "C:/skills/web-search/SKILL.md",
                    "baseDir": "C:/skills/web-search"
                })
            ),
            Ok(Command::Readme { skill_key, slug: Some(slug), file_path: Some(file_path), base_dir: Some(base_dir) })
                if skill_key == "web-search"
                    && slug == "web-search"
                    && file_path == "C:/skills/web-search/SKILL.md"
                    && base_dir == "C:/skills/web-search"
        ));
    }

    #[test]
    fn skill_mutation_response_preserves_config_status_codes() {
        assert_eq!(
            response(Outcome::Mutation(MutationOutcome::Accepted)),
            (200, json!({"outcome": "accepted"}))
        );
        assert_eq!(
            response(Outcome::Mutation(MutationOutcome::Rejected)),
            (400, json!({"outcome": "rejected"}))
        );
        assert_eq!(
            response(Outcome::Mutation(MutationOutcome::Unknown)),
            (503, json!({"outcome": "unknown"}))
        );
    }

    #[test]
    fn readme_response_preserves_public_file_path() {
        let (status, body) = response(Outcome::Readme(Ok(
            crate::skills::management::ReadmeReceipt {
                skill_key: "web-search".into(),
                content: "markdown".into(),
                file_path: "C:\\skills\\web-search\\SKILL.md".into(),
            },
        )));
        assert_eq!(status, 200);
        assert_eq!(
            body,
            json!({
                "success": true,
                "content": "markdown",
                "filePath": "C:\\skills\\web-search\\SKILL.md"
            })
        );
        assert_eq!(
            response(Outcome::Import(ImportOutcome::Rejected)),
            (400, json!({"outcome": "rejected"}))
        );
        assert_eq!(
            response(Outcome::Readme(Err(ReadmeError::Unknown))),
            (503, json!({"outcome": "unknown"}))
        );
    }
}
