use platform::capability::CapabilityDecisionVerifier;

use std::{collections::BTreeMap, sync::Arc};

use crate::management::{
    Command, Detail, ImportOutcome, MutationOutcome, Outcome, ReadError, ReadmeError,
    RemoveOutcome, UploadOutcome,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{SkillsModule, control};

pub(super) const ENDPOINT: &str = "/api/skills/status";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const STATUS_SCOPE: &str = "skills:read";
const STATUS_CAPABILITY: &str = "skills.status";
const STATUS_SUBJECT: &str = "skills-status";

pub(super) const DETAIL_ENDPOINT: &str = "/api/skills/detail";
pub(super) const CONFIG_ENDPOINT: &str = "/api/skills/config";
pub(super) const CLAWHUB_INSTALL_ENDPOINT: &str = "/api/skills/clawhub/install";
pub(super) const CLAWHUB_UPDATE_ENDPOINT: &str = "/api/skills/clawhub/update";
pub(super) const UPLOAD_BEGIN_ENDPOINT: &str = "/api/skills/upload/begin";
pub(super) const UPLOAD_CHUNK_ENDPOINT: &str = "/api/skills/upload/chunk";
pub(super) const UPLOAD_COMMIT_ENDPOINT: &str = "/api/skills/upload/commit";
pub(super) const UNINSTALL_ENDPOINT: &str = "/api/skills/uninstall";
pub(super) const IMPORT_MARKDOWN_ENDPOINT: &str = "/api/skills/import/markdown";
pub(super) const IMPORT_BUNDLE_ENDPOINT: &str = "/api/skills/import/bundle";
pub(super) const README_ENDPOINT: &str = "/api/skills/readme";
pub(super) const CAPABILITY_EXECUTE_ENDPOINT: &str = "/api/skills/capability/execute";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RequestError {
    Invalid,
    Unauthorized,
    Admission(platform::call::CallLogError),
}

pub(super) async fn handle_status(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsModule,
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
        crate::status::Outcome::Available(catalog) => {
            eprintln!(
                "[startup-trace] source=skills-status phase=transport detail=available entries={}",
                catalog.entries.len()
            );
            Ok(crate::projection::status::project(&catalog))
        }
        crate::status::Outcome::Unavailable => {
            eprintln!("[startup-trace] source=skills-status phase=transport detail=unavailable");
            Err(RequestError::Invalid)
        }
    }
}

pub(super) async fn handle_management(
    endpoint: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsModule,
    now: u64,
    call: Option<crate::operation::RecordedCall>,
) -> Result<(u16, Value), RequestError> {
    let (scope, capability, subject) = authorization(endpoint).ok_or(RequestError::Invalid)?;
    let authorization = bearer(headers).ok_or(RequestError::Unauthorized)?;
    let principal = verifier
        .lock()
        .await
        .verify(authorization, now, endpoint, scope, capability, subject)
        .map_err(|_| RequestError::Unauthorized)?
        .principal()
        .to_owned();
    let value = serde_json::from_slice::<Value>(body).map_err(|_| RequestError::Invalid)?;
    let command = decode(endpoint, value).map_err(|_| RequestError::Invalid)?;
    if matches!(
        command,
        Command::Config { .. } | Command::UploadCommit { .. }
    ) {
        let call = call.ok_or(RequestError::Admission(
            platform::call::CallLogError::Unavailable,
        ))?;
        let access = crate::result::ResultAccess {
            principal,
            scope: scope.into(),
            capability: capability.into(),
            subject: subject.into(),
            private: false,
        };
        let worker = handle.clone();
        let receipt = handle
            .submit_result(
                call,
                access,
                crate::result::SMALL_RESULT_BUDGET,
                async move {
                    if matches!(command, Command::Config { .. }) {
                        return Ok(crate::result::configure(&worker, command).await);
                    }
                    let (outcome, receipt) = match worker.manage_skills(command).await {
                        Ok(Outcome::Upload(UploadOutcome::Accepted(receipt))) => {
                            (crate::management::ConfigOutcome::Accepted, Some(receipt))
                        }
                        Ok(Outcome::Upload(UploadOutcome::Rejected) | Outcome::Rejected) => {
                            (crate::management::ConfigOutcome::Rejected, None)
                        }
                        _ => (crate::management::ConfigOutcome::Unknown, None),
                    };
                    Ok(crate::result::SkillResult::UploadCommit { outcome, receipt })
                },
            )
            .await
            .map_err(RequestError::Admission)?;
        return Ok((202, json!(receipt)));
    }
    if matches!(
        command,
        Command::ClawHubInstall { .. }
            | Command::ClawHubUpdate { .. }
            | Command::ImportMarkdown { .. }
            | Command::ImportBundle { .. }
            | Command::Uninstall { .. }
    ) {
        let call = call.ok_or(RequestError::Admission(
            platform::call::CallLogError::Unavailable,
        ))?;
        {
            let worker = handle.clone();
            let receipt = handle
                .submit_operation(call, async move {
                    match worker.manage_skills(command).await {
                        Ok(outcome) => {
                            let (status, body) = response(outcome);
                            platform::loopback::Response::json(status, body)
                        }
                        Err(_) => {
                            eprintln!("[startup-trace] source=skills-management phase=port detail=unavailable");
                            platform::loopback::Response::json(503, json!({ "outcome": "unknown" }))
                        }
                    }
                })
                .await
                .map_err(RequestError::Admission)?;
            return Ok((202, json!(receipt)));
        }
    }
    handle
        .manage_skills(command)
        .await
        .map(response)
        .map_err(|_| RequestError::Invalid)
}

pub(super) async fn handle_capability_execute(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsModule,
    now: u64,
    call: Option<crate::operation::RecordedCall>,
) -> Result<control::ManagementOutcome, RequestError> {
    let value = serde_json::from_slice::<Value>(body).map_err(|_| RequestError::Invalid)?;
    let operation_id = value
        .get("operationId")
        .and_then(Value::as_str)
        .ok_or(RequestError::Invalid)?;
    let principal = verifier
        .lock()
        .await
        .verify(
            bearer(headers).ok_or(RequestError::Unauthorized)?,
            now,
            CAPABILITY_EXECUTE_ENDPOINT,
            "skill.management",
            operation_id,
            "skill-management",
        )
        .map_err(|_| RequestError::Unauthorized)?
        .principal()
        .to_owned();
    let operation_id = operation_id.to_owned();
    let request = control::decode_management_request(value).map_err(|_| RequestError::Invalid)?;
    if matches!(
        request,
        control::ManagementRequest::UpdateConfig(_)
            | control::ManagementRequest::UpdateState(_)
            | control::ManagementRequest::UpdateBatchState { .. }
            | control::ManagementRequest::ExportBundles(_)
    ) {
        let call = call.ok_or(RequestError::Admission(
            platform::call::CallLogError::Unavailable,
        ))?;
        let budget = if matches!(request, control::ManagementRequest::ExportBundles(_)) {
            crate::result::BUNDLE_RESULT_BUDGET
        } else {
            crate::result::SMALL_RESULT_BUDGET
        };
        let access = crate::result::ResultAccess {
            principal,
            scope: "skill.management".into(),
            capability: operation_id,
            subject: "skill-management".into(),
            private: false,
        };
        let worker = handle.clone();
        let receipt = handle
            .submit_result(call, access, budget, async move {
                Ok(match request {
                    control::ManagementRequest::UpdateConfig(command)
                    | control::ManagementRequest::UpdateState(command) => {
                        crate::result::configure(&worker, command).await
                    }
                    control::ManagementRequest::UpdateBatchState {
                        commands,
                        skill_keys,
                        enabled,
                    } => crate::result::batch_state(&worker, commands, skill_keys, enabled).await,
                    control::ManagementRequest::ExportBundles(command) => {
                        crate::result::export_bundles(&worker, command).await
                    }
                    _ => unreachable!(),
                })
            })
            .await
            .map_err(RequestError::Admission)?;
        return Ok(control::ManagementOutcome::Succeeded(json!(receipt)));
    }
    if matches!(request, control::ManagementRequest::ImportBundles(_)) {
        let call = call.ok_or(RequestError::Admission(
            platform::call::CallLogError::Unavailable,
        ))?;
        {
            let worker = handle.clone();
            let receipt = handle
                .submit_operation(call, async move {
                    super::capability_response(
                        control::dispatch_management_request(&worker, request).await,
                    )
                })
                .await
                .map_err(RequestError::Admission)?;
            return Ok(control::ManagementOutcome::Succeeded(json!(receipt)));
        }
    }
    Ok(control::dispatch_management_request(&handle, request).await)
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
    let files = request
        .files
        .into_iter()
        .map(|file| crate::bundle::BundleFile::try_new(file.path, file.content))
        .collect::<Result<Vec<_>, _>>()?;
    let bundle = crate::bundle::Bundle::try_new(request.skill_key, files).map_err(|_| ())?;
    Command::import_bundle(bundle)
}

pub(super) fn response(outcome: Outcome) -> (u16, Value) {
    match outcome {
        Outcome::Config {
            outcome,
            invalid_keys,
        } => {
            let status = match outcome {
                crate::management::ConfigOutcome::Rejected => 400,
                crate::management::ConfigOutcome::Unknown => 503,
                _ => 200,
            };
            (
                status,
                json!({ "outcome": outcome, "invalidKeys": invalid_keys }),
            )
        }
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
                    "files": [{"path": "a".repeat(crate::bundle::MAX_PATH_BYTES + 1), "content": "x"}]
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
                        {"path": "README.md", "content": "x".repeat(crate::bundle::MAX_CONTENT_BYTES)}
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
        let (status, body) = response(Outcome::Readme(Ok(crate::management::ReadmeReceipt {
            skill_key: "web-search".into(),
            content: "markdown".into(),
            file_path: "C:\\skills\\web-search\\SKILL.md".into(),
        })));
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
