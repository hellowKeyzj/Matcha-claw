pub(crate) mod prompts;
mod rules;

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use tokio_util::sync::CancellationToken;

use crate::{
    domain::WikiReviewItem,
    ports::{
        WikiIngestLlm, WikiIngestLlmMessage, WikiIngestLlmOptions, WikiIngestLlmRequest,
        WikiIngestLlmRole,
    },
};

#[derive(Default)]
pub(crate) struct ReviewSweeps {
    state: Mutex<SweepState>,
}

#[derive(Default)]
struct SweepState {
    closed: bool,
    projects: BTreeMap<String, Drain>,
}

#[derive(Default)]
struct Drain {
    active: usize,
    processed: bool,
    epoch: u64,
    cancellation: Option<CancellationToken>,
}

pub(crate) struct SourceWork {
    sweeps: Arc<ReviewSweeps>,
    project_id: String,
    epoch: u64,
}

impl ReviewSweeps {
    pub(crate) fn begin(
        self: &Arc<Self>,
        project_id: String,
    ) -> Result<SourceWork, crate::domain::WikiFailure> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(crate::domain::WikiFailure::OwnerUnavailable);
        }
        let drain = state.projects.entry(project_id.clone()).or_default();
        if let Some(cancellation) = drain.cancellation.take() {
            cancellation.cancel();
        }
        drain.active += 1;
        Ok(SourceWork {
            sweeps: self.clone(),
            project_id,
            epoch: drain.epoch,
        })
    }

    pub(crate) fn invalidate(&self, project_id: &str) {
        if let Some(drain) = self.state.lock().unwrap().projects.get_mut(project_id) {
            invalidate(drain);
        }
    }

    pub(crate) fn invalidate_all(&self) {
        for drain in self.state.lock().unwrap().projects.values_mut() {
            invalidate(drain);
        }
    }

    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        for drain in state.projects.values_mut() {
            invalidate(drain);
        }
    }

    pub(crate) fn claim(&self, project_id: &str) -> Option<CancellationToken> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return None;
        }
        let drain = state.projects.get_mut(project_id)?;
        if drain.active != 0 || !drain.processed {
            return None;
        }
        drain.processed = false;
        let cancellation = CancellationToken::new();
        drain.cancellation = Some(cancellation.clone());
        Some(cancellation)
    }
}

fn invalidate(drain: &mut Drain) {
    drain.epoch += 1;
    drain.processed = false;
    if let Some(cancellation) = drain.cancellation.take() {
        cancellation.cancel();
    }
}

impl SourceWork {
    pub(crate) fn project_id(&self) -> &str {
        &self.project_id
    }

    pub(crate) fn mark_processed(&self) {
        let mut state = self.sweeps.state.lock().unwrap();
        let drain = state.projects.get_mut(&self.project_id).unwrap();
        if drain.epoch == self.epoch {
            drain.processed = true;
        }
    }
}

impl Drop for SourceWork {
    fn drop(&mut self) {
        self.sweeps
            .state
            .lock()
            .unwrap()
            .projects
            .get_mut(&self.project_id)
            .unwrap()
            .active -= 1;
    }
}

pub(crate) struct ReviewSweepPlan {
    pub(crate) project_id: String,
    pub(crate) root: PathBuf,
    pub(crate) pending: Vec<WikiReviewItem>,
    pub(crate) pages: Vec<PageSummary>,
    pub(crate) llm: Option<Arc<dyn WikiIngestLlm>>,
    pub(crate) model_ref: Option<String>,
    pub(crate) cancellation: CancellationToken,
}

pub(crate) struct PageSummary {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
}

pub(crate) use rules::resolved_by_rules;

pub(crate) async fn judge(plan: &ReviewSweepPlan) -> Vec<String> {
    let (Some(llm), Some(model_ref)) = (&plan.llm, &plan.model_ref) else {
        return Vec::new();
    };
    let mut resolved = Vec::new();
    for batch in plan.pending.chunks(40).take(5) {
        if plan.cancellation.is_cancelled() {
            break;
        }
        let response = llm
            .generate_cancellable(
                WikiIngestLlmRequest {
                    model_ref: Some(model_ref.clone()),
                    messages: vec![WikiIngestLlmMessage {
                        role: WikiIngestLlmRole::User,
                        content: prompts::build(&plan.pages, batch),
                    }],
                    options: WikiIngestLlmOptions::default(),
                },
                plan.cancellation.clone(),
            )
            .await;
        let Ok(response) = response else { break };
        if plan.cancellation.is_cancelled() {
            break;
        }
        let ids = resolved_ids(&response.text, batch);
        if ids.is_empty() {
            break;
        }
        resolved.extend(ids);
    }
    resolved
}

fn resolved_ids(raw: &str, batch: &[WikiReviewItem]) -> Vec<String> {
    let Some(start) = raw.find('{') else {
        return Vec::new();
    };
    let Some(Ok(value)) = serde_json::Deserializer::from_str(&raw[start..])
        .into_iter::<serde_json::Value>()
        .next()
    else {
        return Vec::new();
    };
    let Some(ids) = value.get("resolved").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut resolved = Vec::new();
    for id in ids.iter().filter_map(serde_json::Value::as_str) {
        if batch.iter().any(|item| item.id == id) && !resolved.iter().any(|existing| existing == id)
        {
            resolved.push(id.to_owned());
        }
    }
    resolved
}
