use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use platform::call::CallId;
use serde::{Deserialize, Serialize};

use crate::{WikiApplyGeneratedPagesReceipt, WikiDeleteSourceReceipt, WikiFailure};

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "operation", content = "result", rename_all = "kebab-case")]
pub(crate) enum WikiCallResult {
    ApplyGeneratedPages(WikiApplyGeneratedPagesReceipt),
    DeleteSource(WikiDeleteSourceReceipt),
    DeletePage(crate::WikiDeletePageReceipt),
    #[serde(rename = "dedup.detect")]
    DedupDetect(crate::WikiDedupDetection),
    #[serde(rename = "missing-page.create")]
    MissingPageCreate(crate::WikiMissingPageReceipt),
    #[serde(rename = "selection.apply")]
    SelectionApply(crate::WikiSelectionApplyReceipt),
    EmbedPage(WikiEmbedResult),
    #[serde(rename = "project.import-archive")]
    ProjectImport(crate::WikiProjectsReceipt),
    RebuildIndex(crate::WikiRebuildIndexReceipt),
    #[serde(rename = "qa.save")]
    QaSave(crate::WikiQuestionSaveReceipt),
    #[serde(rename = "lint.fix")]
    LintFix(crate::lint::WikiLintFixReceipt),
    #[serde(rename = "lint.review")]
    LintReview(crate::lint::WikiLintFixReceipt),
    #[serde(rename = "lint.delete")]
    LintDelete(crate::lint::WikiLintFixReceipt),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum WikiEmbedResult {
    Completed {
        project_id: String,
    },
    Failed {
        project_id: String,
        code: WikiEmbedFailureCode,
    },
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WikiEmbedFailureCode {
    Disabled,
    NotConfigured,
    ModelUnavailable,
    ModelChanged,
    ProviderUnavailable,
    ProviderAuth,
    ProviderRateLimit,
    InvalidResponse,
    EmptyContent,
    InputTooLarge,
    IndexUnavailable,
    Failed,
}

impl WikiEmbedFailureCode {
    pub(crate) fn from_failure(failure: &WikiFailure) -> Self {
        let WikiFailure::IndexUnavailable { backend, reason } = failure else {
            return Self::Failed;
        };
        if reason == "wiki embedding model changed; rebuild the full vector index" {
            return Self::ModelChanged;
        }
        if backend != "embedding" {
            return Self::IndexUnavailable;
        }
        // Only exact owner/provider-safe reasons are classified; arbitrary text is never projected.
        match reason.as_str() {
            "wiki embedding is disabled" => Self::Disabled,
            "wiki embedding is not configured" => Self::NotConfigured,
            "local MiniLM model assets are missing; reinstall the bundled Wiki resources"
            | "local MiniLM ONNX Runtime library is missing; reinstall the bundled Wiki resources"
            | "local MiniLM ONNX Runtime library could not be loaded; reinstall the bundled Wiki resources"
            | "local MiniLM model could not be loaded; reinstall the bundled Wiki resources"
            | "local MiniLM tokenizer could not be loaded; reinstall the bundled Wiki resources"
            | "local MiniLM tokenizer truncation could not be configured"
            | "local MiniLM ONNX Runtime is not bundled for this platform" => {
                Self::ModelUnavailable
            }
            "embedding provider returned HTTP 401" | "embedding provider returned HTTP 403" => {
                Self::ProviderAuth
            }
            "embedding provider returned HTTP 429" => Self::ProviderRateLimit,
            "failed to initialize embedding HTTP client"
            | "embedding request failed"
            | "embedding batch request failed"
            | "embedding response could not be read"
            | "wiki embedding provider timed out after 300 seconds" => Self::ProviderUnavailable,
            "embedding response is not valid JSON"
            | "embedding response is missing a nonempty vector"
            | "embedding response contains invalid numeric values"
            | "embedding response contains out-of-range numeric values"
            | "embedding batch response is missing data"
            | "embedding batch response has an incomplete vector count"
            | "embedding batch response has an invalid index"
            | "embedding batch response has duplicate or out-of-range indexes"
            | "embedding batch response has inconsistent dimensions"
            | "embedding provider returned empty or inconsistent vector dimensions"
            | "local MiniLM output is missing token embeddings"
            | "local MiniLM output has an invalid tensor type"
            | "local MiniLM output has invalid dimensions"
            | "local MiniLM output cannot be normalized" => Self::InvalidResponse,
            "wiki page has no indexable content" => Self::EmptyContent,
            "wiki page exceeds the 512 chunk limit; increase maxChunkChars or split the page"
            | "embedding input exceeds the provider context; lower maxChunkChars"
            | "embedding batch input exceeds the provider context" => Self::InputTooLarge,
            _ => {
                let status = reason
                    .strip_prefix("embedding provider returned HTTP ")
                    .and_then(|status| status.parse::<u16>().ok())
                    .filter(|status| {
                        (100..600).contains(status)
                            && reason == &format!("embedding provider returned HTTP {status}")
                    });
                if status.is_some() {
                    Self::ProviderUnavailable
                } else {
                    Self::Failed
                }
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiCallResultReceipt {
    call_id: CallId,
    #[serde(flatten)]
    result: WikiCallResult,
}

#[derive(Default)]
pub(crate) struct WikiCallResults {
    slots: Mutex<Vec<(CallId, ResultSlot)>>,
}

enum ResultSlot {
    Pending,
    Completed { at: Instant, result: WikiCallResult },
}

impl WikiCallResults {
    pub(crate) fn reserve(
        self: &Arc<Self>,
        call_id: &CallId,
    ) -> Result<WikiResultReservation, WikiFailure> {
        let mut slots = self.slots.lock().unwrap();
        expire(&mut slots);
        if slots.len() == 64 {
            return Err(WikiFailure::OwnerUnavailable);
        }
        slots.push((call_id.clone(), ResultSlot::Pending));
        Ok(WikiResultReservation {
            results: self.clone(),
            call_id: call_id.clone(),
        })
    }

    pub(crate) fn get(&self, call_id: &CallId) -> Result<WikiCallResultReceipt, WikiFailure> {
        let mut slots = self.slots.lock().unwrap();
        expire(&mut slots);
        match slots.iter().find(|(id, _)| id == call_id) {
            Some((_, ResultSlot::Completed { result, .. })) => Ok(WikiCallResultReceipt {
                call_id: call_id.clone(),
                result: result.clone(),
            }),
            _ => Err(WikiFailure::not_found("Wiki call result")),
        }
    }
}

fn expire(slots: &mut Vec<(CallId, ResultSlot)>) {
    slots.retain(|(_, slot)| match slot {
        ResultSlot::Pending => true,
        ResultSlot::Completed { at, .. } => at.elapsed() < Duration::from_secs(10 * 60),
    });
}

pub(crate) struct WikiResultReservation {
    results: Arc<WikiCallResults>,
    call_id: CallId,
}

impl WikiResultReservation {
    pub(crate) fn complete(&self, result: WikiCallResult) {
        let mut slots = self.results.slots.lock().unwrap();
        if let Some((_, slot)) = slots.iter_mut().find(|(id, _)| id == &self.call_id) {
            *slot = ResultSlot::Completed {
                at: Instant::now(),
                result,
            };
        }
    }
}

impl Drop for WikiResultReservation {
    fn drop(&mut self) {
        self.results
            .slots
            .lock()
            .unwrap()
            .retain(|(id, slot)| id != &self.call_id || !matches!(slot, ResultSlot::Pending));
    }
}
