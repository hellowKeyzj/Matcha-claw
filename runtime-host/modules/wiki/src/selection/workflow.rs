use super::{SelectionPlan, SelectionRun, prompts};
use crate::{
    WikiFailure, WikiHandle,
    domain::{WikiSearchInput, WikiSelectionIntent, WikiSelectionReference, WikiSelectionStatus},
    ports::{WikiFuture, WikiIngestLlmDeltaSink},
};

pub(crate) async fn run(owner: WikiHandle, plan: SelectionPlan) -> Result<(), WikiFailure> {
    let result = execute(&owner, &plan).await;
    plan.run.finish(&result)?;
    result.map_err(|error| {
        if error.is_cancelled() {
            error
        } else {
            WikiFailure::state(super::REQUEST_FAILED)
        }
    })
}

async fn execute(owner: &WikiHandle, plan: &SelectionPlan) -> Result<(), WikiFailure> {
    plan.run.ensure_active()?;
    let references = if plan.input.intent == WikiSelectionIntent::Ask {
        plan.run
            .update(WikiSelectionStatus::Retrieving, Vec::new())?;
        let result = tokio::select! {
            biased;
            _ = plan.run.cancellation.cancelled() => return Err(WikiFailure::cancelled()),
            result = owner.search(WikiSearchInput {
                project_id: plan.input.project_id.clone(),
                query: format!("{} {}", plan.input.instruction, prompts::utf16_prefix(&plan.input.selection.selected_text, 500)),
                limit: 20,
            }) => result,
        };
        result
            .map(|receipt| {
                receipt
                    .hits()
                    .iter()
                    .take(5)
                    .map(|hit| WikiSelectionReference {
                        path: hit.relative_path.clone(),
                        title: hit.title.clone(),
                        snippet: hit.snippets.join("\n"),
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    plan.run
        .update(WikiSelectionStatus::Generating, references.clone())?;
    let request = prompts::request(&plan.input, &references);
    let mut sink = SelectionSink { run: &plan.run };
    tokio::select! {
        biased;
        _ = plan.run.cancellation.cancelled() => Err(WikiFailure::cancelled()),
        response = plan.llm.stream_generate_cancellable(request, plan.run.cancellation.clone(), &mut sink) => response.map(|_| ()),
    }
}

struct SelectionSink<'a> {
    run: &'a SelectionRun,
}

impl WikiIngestLlmDeltaSink for SelectionSink<'_> {
    fn send<'a>(&'a mut self, delta: String) -> WikiFuture<'a, Result<(), WikiFailure>> {
        Box::pin(async move { self.run.append(&delta) })
    }
}
