use platform::{
    call::{CallDetail, CallStatus},
    loopback::Response,
};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub access: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<crate::management::ConfigOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_count: Option<u64>,
}

impl CallDetail for Detail {
    const MODULE: &'static str = "skills";
}

pub(crate) fn request(path: &str, body: &[u8]) -> Option<(&'static str, Detail)> {
    let value = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let (command, access) = match path {
        "/api/skills/status" => ("skills.status", "read"),
        "/api/skills/detail" => ("skills.detail", "read"),
        "/api/skills/config" => ("skills.config", "write"),
        "/api/skills/clawhub/install" => ("skills.clawhub.install", "write"),
        "/api/skills/clawhub/update" => ("skills.clawhub.update", "write"),
        "/api/skills/upload/begin" => ("skills.upload.begin", "write"),
        "/api/skills/upload/chunk" => ("skills.upload.chunk", "write"),
        "/api/skills/upload/commit" => ("skills.upload.commit", "write"),
        "/api/skills/uninstall" => ("skills.uninstall", "write"),
        "/api/skills/import/markdown" => ("skills.import.markdown", "write"),
        "/api/skills/import/bundle" => ("skills.import.bundle", "write"),
        "/api/skills/readme" => ("skills.readme", "read"),
        "/api/clawhub/search" => ("clawhub.search", "read"),
        "/api/clawhub/skills/install" => ("clawhub.skills.install", "write"),
        "/api/subagents/skill-bundles/export" => ("skills.bundles.export", "read"),
        "/api/subagents/skill-bundles/import" => ("skills.bundles.import", "write"),
        "/api/sealed-skills/status" => ("sealedSkills.status", "read"),
        "/api/sealed-skills/export" => ("sealedSkills.export", "read"),
        "/api/sealed-skills/export-cloud" => ("sealedSkills.exportCloud", "read"),
        "/api/sealed-skills/install" => ("sealedSkills.install", "write"),
        "/api/sealed-skills/uninstall" => ("sealedSkills.uninstall", "write"),
        "/api/skills/capability/execute" => {
            let command = match value.get("operationId").and_then(Value::as_str) {
                Some("skills.refreshStatus") => ("skills.refreshStatus", "read"),
                Some("skills.updateConfig") => ("skills.updateConfig", "write"),
                Some("skills.updateState") => ("skills.updateState", "write"),
                Some("skills.updateBatchState") => ("skills.updateBatchState", "write"),
                Some("skills.exportBundles") => ("skills.exportBundles", "read"),
                Some("skills.importBundles") => ("skills.importBundles", "write"),
                Some("clawhub.openReadme") => ("clawhub.openReadme", "write"),
                Some("clawhub.openPath") => ("clawhub.openPath", "write"),
                _ => ("skills.capability.invalid", "unknown"),
            };
            return Some((
                command.0,
                input_detail(command.1, value.get("input").unwrap_or(&Value::Null)),
            ));
        }
        path if path.starts_with("/api/sealed-skills/read/") => ("sealedSkills.read", "read"),
        _ => return None,
    };
    Some((command, input_detail(access, &value)))
}

fn input_detail(access: &'static str, value: &Value) -> Detail {
    let bundles = value.get("skillBundles").and_then(Value::as_array);
    Detail {
        access,
        skill_key: text(value, "skillKey"),
        slug: text(value, "slug"),
        version: text(value, "version"),
        enabled: value.get("enabled").and_then(Value::as_bool),
        upload_id: text(value, "uploadId"),
        size_bytes: value
            .get("sizeBytes")
            .and_then(Value::as_u64)
            .or_else(|| {
                value
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|v| v.len() as u64)
            })
            .or_else(|| {
                value
                    .get("dataBase64")
                    .and_then(Value::as_str)
                    .and_then(|v| {
                        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, v).ok()
                    })
                    .map(|v| v.len() as u64)
            }),
        offset: value.get("offset").and_then(Value::as_u64),
        sha256: digest(value),
        bundle_count: bundles.map(|v| v.len() as u64),
        file_count: value
            .get("files")
            .and_then(Value::as_array)
            .map(|v| v.len() as u64),
        ..Detail::default()
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| {
            !v.is_empty()
                && v.len() <= (if key == "skillKey" { 4096 } else { 512 })
                && !v.chars().any(char::is_control)
        })
        .map(str::to_owned)
}

fn digest(value: &Value) -> Option<String> {
    value
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_owned)
}

pub(crate) fn terminal(mut detail: Detail, response: &Response) -> (CallStatus, Detail) {
    let body = response.body();
    detail.skill_key = text(body, "skillKey").or(detail.skill_key);
    detail.slug = text(body, "slug").or(detail.slug);
    detail.version = text(body, "version").or(detail.version);
    detail.upload_id = text(body, "uploadId").or(detail.upload_id);
    detail.received_bytes = body.get("receivedBytes").and_then(Value::as_u64);
    detail.expires_at = body.get("expiresAt").and_then(Value::as_u64);
    detail.sha256 = digest(body).or(detail.sha256);
    detail.result_ready = body.get("resultReady").and_then(Value::as_bool);
    detail.result = match body.get("result").and_then(Value::as_str) {
        Some("accepted") => Some(crate::management::ConfigOutcome::Accepted),
        Some("partial") => Some(crate::management::ConfigOutcome::Partial),
        Some("rejected") => Some(crate::management::ConfigOutcome::Rejected),
        Some("unknown") => Some(crate::management::ConfigOutcome::Unknown),
        _ => None,
    };
    detail.requested_count = body.get("requestedCount").and_then(Value::as_u64);
    detail.updated_count = body.get("updatedCount").and_then(Value::as_u64);
    detail.invalid_count = body.get("invalidCount").and_then(Value::as_u64);
    detail.failed_count = body.get("failedCount").and_then(Value::as_u64);
    detail.bundle_count = body
        .get("bundleCount")
        .and_then(Value::as_u64)
        .or(detail.bundle_count);
    detail.file_count = body
        .get("fileCount")
        .and_then(Value::as_u64)
        .or(detail.file_count);
    let (status, outcome) = match body.get("outcome").and_then(Value::as_str) {
        Some("partial") => (CallStatus::Failed, "partial"),
        Some("unknown") => (CallStatus::Unknown, "unknown"),
        Some("rejected") => (CallStatus::Rejected, "rejected"),
        Some("notFound") => (CallStatus::Failed, "notFound"),
        Some("removed") => (CallStatus::Succeeded, "removed"),
        Some("accepted") => (CallStatus::Succeeded, "accepted"),
        _ if matches!(response.status(), 400 | 401 | 403 | 409) => {
            (CallStatus::Rejected, "rejected")
        }
        _ if response.status() >= 500 => {
            if detail.access == "read" {
                (CallStatus::Failed, "unavailable")
            } else {
                (CallStatus::Unknown, "unknown")
            }
        }
        _ if response.status() >= 400 => (CallStatus::Failed, "notFound"),
        _ => (CallStatus::Succeeded, "succeeded"),
    };
    detail.outcome = Some(outcome);
    (status, detail)
}
