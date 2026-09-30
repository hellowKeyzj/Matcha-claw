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
    #[serde(rename = "graph.insights.research-input")]
    GraphInsightResearchInput(crate::insights::WikiGraphInsightResearchReceipt),
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
