use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use platform::{
    call::{CallId, CallLogError},
    loopback::Response,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    bundle::Bundle,
    management::{ConfigOutcome, UploadReceipt},
};

const MAX_RESULTS: usize = 16;
const MAX_RESULT_BYTES: usize = 64 * 1024 * 1024;
const RESULT_TTL: Duration = Duration::from_secs(10 * 60);
// 64 KiB request strings retained in at most three lists, escaping <=6x.
pub(crate) const SMALL_RESULT_BUDGET: usize = 2 * 1024 * 1024;
// 32 bundles * 64 paths * 240 bytes, JSON escaping <=6x, plus 48 KiB content.
pub(crate) const BUNDLE_RESULT_BUDGET: usize = 4 * 1024 * 1024;
pub(crate) const SEALED_RESULT_BUDGET: usize = 14 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SkillResult {
    Config {
        outcome: ConfigOutcome,
        #[serde(rename = "skillKey")]
        skill_key: String,
        #[serde(rename = "invalidKeys")]
        invalid_keys: Vec<String>,
    },
    BatchState {
        success: bool,
        outcome: ConfigOutcome,
        enabled: bool,
        requested: Vec<String>,
        updated: Vec<String>,
        #[serde(rename = "invalidKeys")]
        invalid_keys: Vec<String>,
        failed: Vec<BatchFailure>,
    },
    UploadCommit {
        outcome: ConfigOutcome,
        #[serde(skip_serializing_if = "Option::is_none")]
        receipt: Option<UploadReceipt>,
    },
    BundleExport {
        outcome: ConfigOutcome,
        #[serde(rename = "skillBundles", skip_serializing_if = "Option::is_none")]
        skill_bundles: Option<Vec<Bundle>>,
    },
    SealedCloudExport {
        #[serde(rename = "skillKey")]
        skill_key: String,
        #[serde(rename = "fileName")]
        file_name: String,
        #[serde(rename = "packageSha256")]
        package_sha256: String,
        #[serde(rename = "packageBase64")]
        package_base64: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchFailure {
    pub skill_key: String,
    pub outcome: BatchFailureOutcome,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BatchFailureOutcome {
    Rejected,
    Unknown,
    NotAttempted,
}

impl SkillResult {
    pub fn response(&self) -> Response {
        let outcome = match self {
            Self::Config { outcome, .. }
            | Self::BatchState { outcome, .. }
            | Self::UploadCommit { outcome, .. }
            | Self::BundleExport { outcome, .. } => *outcome,
            Self::SealedCloudExport { .. } => ConfigOutcome::Accepted,
        };
        let status = match outcome {
            ConfigOutcome::Rejected => 400,
            ConfigOutcome::Unknown => 503,
            _ => 200,
        };
        let mut body = json!({ "outcome": outcome, "result": outcome, "resultReady": true });
        match self {
            Self::BatchState {
                requested,
                updated,
                invalid_keys,
                failed,
                ..
            } => {
                body["requestedCount"] = json!(requested.len());
                body["updatedCount"] = json!(updated.len());
                body["invalidCount"] = json!(invalid_keys.len());
                body["failedCount"] = json!(failed.len());
            }
            Self::Config { invalid_keys, .. } => body["invalidCount"] = json!(invalid_keys.len()),
            Self::UploadCommit {
                receipt: Some(receipt),
                ..
            } => {
                body["uploadId"] = json!(receipt.upload_id);
                body["receivedBytes"] = json!(receipt.received_bytes);
                body["expiresAt"] = json!(receipt.expires_at);
                body["sha256"] = json!(receipt.sha256);
            }
            Self::BundleExport {
                skill_bundles: Some(bundles),
                ..
            } => {
                body["bundleCount"] = json!(bundles.len());
                body["fileCount"] = json!(
                    bundles
                        .iter()
                        .map(|bundle| bundle.files().len())
                        .sum::<usize>()
                );
            }
            _ => {}
        }
        Response::json(status, body)
    }
}

#[derive(Clone)]
pub(crate) struct ResultAccess {
    pub principal: String,
    pub scope: String,
    pub capability: String,
    pub subject: String,
    pub private: bool,
}

pub(crate) struct RetainedResult {
    call_id: CallId,
    command: &'static str,
    access: ResultAccess,
    budget: usize,
    completed: Option<Instant>,
    result: Option<Arc<SkillResult>>,
}

#[derive(Clone, Default)]
pub(crate) struct Results(Arc<Mutex<Vec<RetainedResult>>>);

impl Results {
    pub async fn occupied(&self) -> Vec<CallId> {
        let mut results = self.0.lock().await;
        results.retain(|entry| {
            entry
                .completed
                .is_none_or(|completed| completed.elapsed() < RESULT_TTL)
        });
        results.iter().map(|entry| entry.call_id.clone()).collect()
    }

    pub async fn reserve(
        &self,
        call_id: CallId,
        command: &'static str,
        access: ResultAccess,
        budget: usize,
    ) -> Result<(), CallLogError> {
        let mut results = self.0.lock().await;
        results.retain(|entry| {
            entry
                .completed
                .is_none_or(|completed| completed.elapsed() < RESULT_TTL)
        });
        if results.len() >= MAX_RESULTS
            || results.iter().map(|entry| entry.budget).sum::<usize>() + budget > MAX_RESULT_BYTES
        {
            return Err(CallLogError::QueueFull);
        }
        results.push(RetainedResult {
            call_id,
            command,
            access,
            budget,
            completed: None,
            result: None,
        });
        Ok(())
    }

    pub async fn complete(&self, call_id: &CallId, result: SkillResult) {
        if let Some(entry) = self
            .0
            .lock()
            .await
            .iter_mut()
            .find(|entry| &entry.call_id == call_id)
        {
            entry.result = Some(Arc::new(result));
            entry.completed = Some(Instant::now());
        }
    }

    pub async fn remove(&self, call_id: &CallId) {
        self.0
            .lock()
            .await
            .retain(|entry| &entry.call_id != call_id);
    }

    pub async fn access(&self, call_id: &CallId, private: bool) -> Option<ResultAccess> {
        self.0
            .lock()
            .await
            .iter()
            .find(|entry| {
                &entry.call_id == call_id
                    && entry.access.private == private
                    && entry
                        .completed
                        .is_none_or(|completed| completed.elapsed() < RESULT_TTL)
            })
            .map(|entry| entry.access.clone())
    }

    pub async fn read(&self, call_id: &CallId) -> Option<Value> {
        let (command, result) = {
            let results = self.0.lock().await;
            let entry = results.iter().find(|entry| {
                &entry.call_id == call_id
                    && entry
                        .completed
                        .is_some_and(|completed| completed.elapsed() < RESULT_TTL)
            })?;
            (entry.command, Arc::clone(entry.result.as_ref()?))
        };
        Some(json!({ "callId": call_id, "command": command, "result": result.as_ref() }))
    }

    pub async fn clear(&self) {
        self.0.lock().await.clear();
    }
}

pub(crate) async fn configure(
    handle: &crate::SkillsModule,
    command: crate::management::Command,
) -> SkillResult {
    let skill_key = match &command {
        crate::management::Command::Config { skill_key, .. } => skill_key.clone(),
        _ => unreachable!(),
    };
    let (outcome, invalid_keys) = match handle.manage_skills(command).await {
        Ok(crate::management::Outcome::Config {
            outcome,
            invalid_keys,
        }) => (outcome, invalid_keys),
        Ok(
            crate::management::Outcome::Mutation(crate::management::MutationOutcome::Rejected)
            | crate::management::Outcome::Rejected,
        ) => (ConfigOutcome::Rejected, Vec::new()),
        _ => (ConfigOutcome::Unknown, Vec::new()),
    };
    SkillResult::Config {
        outcome,
        skill_key,
        invalid_keys,
    }
}

pub(crate) async fn export_bundles(
    handle: &crate::SkillsModule,
    command: crate::bundle::Command,
) -> SkillResult {
    let (outcome, skill_bundles) = match handle.skill_bundles(command).await {
        Ok(crate::bundle::Outcome::Exported(bundles)) => (ConfigOutcome::Accepted, Some(bundles)),
        Ok(crate::bundle::Outcome::Rejected) => (ConfigOutcome::Rejected, None),
        _ => (ConfigOutcome::Unknown, None),
    };
    SkillResult::BundleExport {
        outcome,
        skill_bundles,
    }
}

pub(crate) async fn batch_state(
    handle: &crate::SkillsModule,
    commands: Vec<crate::management::Command>,
    requested: Vec<String>,
    enabled: bool,
) -> SkillResult {
    let mut updated = Vec::new();
    let mut invalid_keys = Vec::new();
    let mut failed = Vec::new();
    let mut stopped = false;
    let mut uncertain = false;
    for (command, skill_key) in commands.into_iter().zip(&requested) {
        if stopped {
            failed.push(BatchFailure {
                skill_key: skill_key.clone(),
                outcome: BatchFailureOutcome::NotAttempted,
            });
            continue;
        }
        let SkillResult::Config {
            outcome,
            invalid_keys: keys,
            ..
        } = configure(handle, command).await
        else {
            unreachable!()
        };
        invalid_keys.extend(keys);
        match outcome {
            ConfigOutcome::Accepted => updated.push(skill_key.clone()),
            ConfigOutcome::Partial => {
                updated.push(skill_key.clone());
                stopped = true;
            }
            ConfigOutcome::Rejected | ConfigOutcome::Unknown => {
                uncertain = outcome == ConfigOutcome::Unknown;
                failed.push(BatchFailure {
                    skill_key: skill_key.clone(),
                    outcome: if uncertain {
                        BatchFailureOutcome::Unknown
                    } else {
                        BatchFailureOutcome::Rejected
                    },
                });
                stopped = true;
            }
        }
    }
    let success = failed.is_empty() && invalid_keys.is_empty();
    let outcome = if success {
        ConfigOutcome::Accepted
    } else if uncertain {
        ConfigOutcome::Unknown
    } else if !updated.is_empty() {
        ConfigOutcome::Partial
    } else {
        ConfigOutcome::Rejected
    };
    SkillResult::BatchState {
        success,
        outcome,
        enabled,
        requested,
        updated,
        invalid_keys,
        failed,
    }
}
