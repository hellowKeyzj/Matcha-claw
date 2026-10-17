use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::json;
use skills_module::management::{Command, UploadOutcome, UploadReceipt};
use tokio_util::sync::CancellationToken;

use super::{Mutation, Skills};
use crate::client::Delivery;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    upload_id: String,
    received_bytes: u64,
    expires_at: u64,
    sha256: Option<String>,
}

impl Skills {
    pub(super) async fn upload(
        &self,
        agent: &str,
        command: Command,
        cancellation: &CancellationToken,
    ) -> UploadOutcome {
        let (method, params, expected_id) = match command {
            Command::UploadBegin {
                slug,
                size,
                sha256,
                force,
                idempotency_key,
            } => (
                "skills.upload.begin",
                json!({"scope":"agent","agentId":agent,"slug":slug,"size":size,"sha256":sha256,"force":force,"trust":true,"idempotencyKey":idempotency_key}),
                None,
            ),
            Command::UploadChunk {
                upload_id,
                offset,
                bytes,
            } => (
                "skills.upload.chunk",
                json!({"scope":"agent","agentId":agent,"uploadId":upload_id,"offset":offset,"bytesBase64":STANDARD.encode(bytes)}),
                Some(upload_id),
            ),
            Command::UploadCommit { upload_id, sha256 } => (
                "skills.upload.commit",
                json!({"scope":"agent","agentId":agent,"uploadId":upload_id,"sha256":sha256}),
                Some(upload_id),
            ),
            _ => return UploadOutcome::Rejected,
        };
        let response = match self
            .client
            .call_cancellable(method, params, cancellation)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let partial = error.data().is_some_and(|data| {
                    data.get("nativeDirectoryRemoved")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true)
                        || data
                            .get("changesMayBePartial")
                            .and_then(serde_json::Value::as_bool)
                            == Some(true)
                        || data.get("cleanup").and_then(serde_json::Value::as_str) == Some("failed")
                });
                platform::trace::runtime_trace("matcha.skills.upload.failed", || {
                    json!({
                        "method": method,
                        "code": error.code(),
                        "delivery": match error.delivery() {
                            Delivery::NotSent => "notSent",
                            Delivery::Unknown => "unknown",
                            Delivery::ResponseReceived => "responseReceived",
                        },
                        "partial": partial,
                        "kind": match error.kind() {
                            "skill_discovery_disabled" => "skill_discovery_disabled",
                            "skill_user_settings_disabled" => "skill_user_settings_disabled",
                            "skill_upload_capacity" => "skill_upload_capacity",
                            "skill_upload_commit_unconfirmed" => "skill_upload_commit_unconfirmed",
                            _ => "native_upload_failed",
                        },
                    })
                });
                // Only a complete, non-partial native refusal is a rejected upload.
                return if !partial
                    && error.delivery() == Delivery::ResponseReceived
                    && matches!(error.code(), Some(-32602 | -32001 | -32002 | -32007))
                {
                    UploadOutcome::Rejected
                } else {
                    UploadOutcome::Unknown
                };
            }
        };
        if method == "skills.upload.commit" {
            let mutation: Mutation = match serde_json::from_value(response.clone()) {
                Ok(mutation) => mutation,
                Err(_) => return UploadOutcome::Unknown,
            };
            if !mutation.materialized || !mutation.skill.belongs_to(agent) {
                return UploadOutcome::Unknown;
            }
            let cleanup_failed = response
                .get("cleanupFailed")
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            let upload_cleanup_failed = response
                .get("uploadCleanupFailed")
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            if cleanup_failed || upload_cleanup_failed {
                platform::trace::runtime_trace("matcha.skills.upload.cleanup-failed", || {
                    json!({
                        "method": method,
                        "materialized": mutation.materialized,
                        "cleanupFailed": cleanup_failed,
                        "uploadCleanupFailed": upload_cleanup_failed,
                    })
                });
                return UploadOutcome::Unknown;
            }
        }
        match serde_json::from_value::<Progress>(response) {
            Ok(progress)
                if !progress.upload_id.is_empty()
                    && expected_id
                        .as_ref()
                        .is_none_or(|id| id == &progress.upload_id) =>
            {
                UploadOutcome::Accepted(UploadReceipt {
                    upload_id: progress.upload_id,
                    received_bytes: progress.received_bytes,
                    expires_at: progress.expires_at,
                    sha256: if method == "skills.upload.commit" {
                        progress.sha256
                    } else {
                        None
                    },
                })
            }
            _ => UploadOutcome::Unknown,
        }
    }
}
