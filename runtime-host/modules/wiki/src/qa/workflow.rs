use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use super::{QuestionPlan, QuestionTasks, prompts};
use crate::{
    WikiFailure, WikiHandle,
    domain::{
        WikiRetrieveContextInput,
        model::{WikiQuestionStatus, WikiQuestionTaskReceipt},
    },
    ports::{WikiFuture, WikiIngestLlmDeltaSink},
};

pub(crate) async fn run(
    owner: WikiHandle,
    plan: QuestionPlan,
) -> Result<WikiQuestionTaskReceipt, WikiFailure> {
    let result = execute(&owner, &plan).await;
    let (status, error) = match &result {
        Ok(()) => (WikiQuestionStatus::Done, None),
        Err(error) if error.is_cancelled() => (WikiQuestionStatus::Cancelled, None),
        Err(error) => (WikiQuestionStatus::Error, Some(failure_message(error))),
    };
    let terminal = plan
        .tasks
        .finish(
            &plan.project_root,
            &plan.project_id,
            &plan.task.id,
            status,
            error,
        )
        .await;
    plan.tasks.release(&plan.project_id, &plan.task.id).await;
    let task = terminal?;
    if task.status == WikiQuestionStatus::Cancelled {
        return Err(WikiFailure::cancelled());
    }
    result?;
    Ok(WikiQuestionTaskReceipt {
        project_id: plan.project_id.clone(),
        task,
    })
}

async fn execute(
    owner: &WikiHandle,
    plan: &QuestionPlan,
) -> Result<(), WikiFailure> {
    ensure_active(plan)?;
    plan.tasks
        .update(
            &plan.project_root,
            &plan.project_id,
            &plan.task.id,
            |task| task.status = WikiQuestionStatus::Retrieving,
        )
        .await?;
    let context = tokio::select! {
        _ = plan.cancellation.cancelled() => return Err(WikiFailure::cancelled()),
        context = owner.retrieve_context(WikiRetrieveContextInput { project_id: Some(plan.project_id.clone()), query: plan.task.question.clone(), limit: 5 }) => context?,
    };
    ensure_active(plan)?;
    let references = prompts::references(context.hits());
    plan.tasks
        .update(
            &plan.project_root,
            &plan.project_id,
            &plan.task.id,
            |task| {
                task.references = references.clone();
                task.status = WikiQuestionStatus::Answering;
            },
        )
        .await?;
    let mut sink = QuestionSink {
        tasks: plan.tasks.clone(),
        root: plan.project_root.clone(),
        project_id: plan.project_id.clone(),
        task_id: plan.task.id.clone(),
        cancellation: plan.cancellation.clone(),
        last_flush: Instant::now(),
    };
    plan.llm
        .stream_generate_cancellable(
            prompts::request(plan, &references),
            plan.cancellation.clone(),
            &mut sink,
        )
        .await?;
    ensure_active(plan)?;
    let streamed = plan
        .tasks
        .get(&plan.project_root, &plan.project_id, &plan.task.id)
        .await?;
    if prompts::clean_for_save(&streamed.answer).is_empty() {
        return Err(WikiFailure::state(
            "The question model returned no answer. Check the Wiki model and ask again.",
        ));
    }
    Ok(())
}

fn ensure_active(plan: &QuestionPlan) -> Result<(), WikiFailure> {
    if plan.cancellation.is_cancelled() {
        Err(WikiFailure::cancelled())
    } else {
        Ok(())
    }
}

struct QuestionSink {
    tasks: Arc<QuestionTasks>,
    root: PathBuf,
    project_id: String,
    task_id: String,
    cancellation: tokio_util::sync::CancellationToken,
    last_flush: Instant,
}

impl WikiIngestLlmDeltaSink for QuestionSink {
    fn send<'a>(&'a mut self, delta: String) -> WikiFuture<'a, Result<(), WikiFailure>> {
        Box::pin(async move {
            if self.cancellation.is_cancelled() {
                return Err(WikiFailure::cancelled());
            }
            self.tasks
                .append_delta(&self.root, &self.project_id, &self.task_id, &delta)
                .await?;
            if self.last_flush.elapsed() >= Duration::from_millis(200) {
                self.tasks.flush(&self.root, &self.project_id).await?;
                self.last_flush = Instant::now();
            }
            Ok(())
        })
    }
}

pub(crate) fn failure_message(error: &WikiFailure) -> String {
    match error {
        WikiFailure::InvalidInput { message, .. } | WikiFailure::StateUnavailable { message } => message.clone(),
        _ => "The question could not finish. Check the Wiki model or project and ask again with a new taskId.".to_owned(),
    }
}
