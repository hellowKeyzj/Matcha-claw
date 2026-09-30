use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use futures_util::{StreamExt, stream};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{ResearchCounts, ResearchTasks, WikiResearchTask, WikiResearchTaskStatus};
use crate::{
    WikiFailure, WikiHandle,
    application::commands::WikiCommand,
    external_search::ExternalSearch,
    owner::actor::WikiShared,
    ports::{WikiFuture, WikiIngestLlmDeltaSink},
    search_config,
};

pub(crate) struct ResearchPlan {
    pub shared: WikiShared,
    pub project_root: PathBuf,
    pub state_root: PathBuf,
    pub project_id: String,
    pub model_ref: Option<String>,
    pub language: String,
    pub tasks: Vec<WikiResearchTask>,
}

#[derive(Default)]
pub(crate) struct ResearchScheduler {
    state: Mutex<SchedulerState>,
    changed: Notify,
}

#[derive(Default)]
struct SchedulerState {
    next_ticket: u64,
    queued: VecDeque<u64>,
    active: usize,
}

pub(crate) struct ResearchSlot {
    scheduler: Arc<ResearchScheduler>,
    ticket: u64,
    active: bool,
}

impl ResearchScheduler {
    pub(crate) fn reserve(
        self: &Arc<Self>,
        count: usize,
    ) -> Result<Vec<ResearchSlot>, WikiFailure> {
        let mut state = self.state.lock().expect("research scheduler lock");
        if count == 0 || state.queued.len() + state.active + count > 32 {
            return Err(WikiFailure::invalid_input(
                "inputs",
                "Research queue accepts 1 to 32 tasks and is currently full",
            ));
        }
        let mut slots = Vec::with_capacity(count);
        for _ in 0..count {
            let ticket = state.next_ticket;
            state.next_ticket += 1;
            state.queued.push_back(ticket);
            slots.push(ResearchSlot {
                scheduler: self.clone(),
                ticket,
                active: false,
            });
        }
        Ok(slots)
    }
}

impl ResearchSlot {
    async fn start(&mut self, cancellation: &CancellationToken) -> Result<(), WikiFailure> {
        loop {
            if cancellation.is_cancelled() {
                return Err(WikiFailure::cancelled());
            }
            let changed = self.scheduler.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let mut state = self
                    .scheduler
                    .state
                    .lock()
                    .expect("research scheduler lock");
                if state.active < 3 && state.queued.front() == Some(&self.ticket) {
                    state.queued.pop_front();
                    state.active += 1;
                    self.active = true;
                    self.scheduler.changed.notify_waiters();
                    return Ok(());
                }
            }
            tokio::select! { _ = cancellation.cancelled() => return Err(WikiFailure::cancelled()), _ = changed => {} }
        }
    }
}

impl Drop for ResearchSlot {
    fn drop(&mut self) {
        let mut state = self
            .scheduler
            .state
            .lock()
            .expect("research scheduler lock");
        if self.active {
            state.active -= 1;
        } else {
            state.queued.retain(|ticket| *ticket != self.ticket);
        }
        self.scheduler.changed.notify_waiters();
    }
}

pub(crate) async fn run(
    owner: WikiHandle,
    plan: ResearchPlan,
    slots: Vec<ResearchSlot>,
    cancellation: CancellationToken,
) -> Result<ResearchCounts, WikiFailure> {
    let plan = Arc::new(plan);
    let results = stream::iter(plan.tasks.iter().cloned().zip(slots)).map(|(task, mut slot)| {
        let plan = plan.clone(); let owner = owner.clone(); let cancellation = cancellation.clone();
        async move {
            let result = match slot.start(&cancellation).await {
                Ok(()) => execute(&owner, &plan, &task, cancellation).await,
                Err(error) => Err(error),
            };
            match result {
                Ok(task) => Ok(task),
                Err(error) => plan.shared.research_tasks.update(&plan.project_root, &plan.project_id, &task.id, |task| {
                    task.status = WikiResearchTaskStatus::Error;
                    task.synthesis = super::synthesis::clean(&task.synthesis);
                    task.error = Some(if error.is_cancelled() { "Research incomplete: the Wiki owner stopped. Rerun the task to retry.".to_owned() } else { failure_message(&error) });
                }).await,
            }
        }
    }).buffer_unordered(3).collect::<Vec<_>>().await;
    let mut counts = ResearchCounts::default();
    for task in results {
        let task = task?;
        if task.status == WikiResearchTaskStatus::Done {
            counts.done += 1;
        } else {
            counts.error += 1;
        }
        if task.saved_path.is_some() {
            counts.saved += 1;
        }
    }
    Ok(counts)
}

async fn execute(
    owner: &WikiHandle,
    plan: &ResearchPlan,
    task: &WikiResearchTask,
    cancellation: CancellationToken,
) -> Result<WikiResearchTask, WikiFailure> {
    let tasks = &plan.shared.research_tasks;
    tasks
        .update(&plan.project_root, &plan.project_id, &task.id, |task| {
            task.status = WikiResearchTaskStatus::Searching
        })
        .await?;
    let (config, credentials) =
        search_config::execution_snapshot(&plan.project_root, &plan.state_root, &plan.project_id)?;
    let queries = if task.search_queries.is_empty() {
        vec![task.topic.clone()]
    } else {
        task.search_queries.clone()
    };
    let search = ExternalSearch::new(plan.shared.http_client.clone());
    let (sources, errors) = super::sources::collect(
        &search,
        &queries,
        &config,
        &credentials,
        plan.shared.ingest_llm.as_deref(),
        plan.model_ref.as_deref(),
        &plan.project_root,
        &cancellation,
    )
    .await?;
    let task = tasks
        .update(&plan.project_root, &plan.project_id, &task.id, |task| {
            task.web_results = sources;
            task.status = if task.web_results.is_empty() {
                if errors.is_empty() {
                    WikiResearchTaskStatus::Done
                } else {
                    WikiResearchTaskStatus::Error
                }
            } else {
                WikiResearchTaskStatus::Synthesizing
            };
            if task.web_results.is_empty() {
                task.synthesis = if errors.is_empty() {
                    "No research sources found.".to_owned()
                } else {
                    String::new()
                };
                task.error = (!errors.is_empty()).then(|| errors.join("\n"));
            }
        })
        .await?;
    if task.status.is_terminal() {
        return Ok(task);
    }
    let llm = plan.shared.ingest_llm.as_ref().ok_or_else(|| {
        WikiFailure::state(
            "Research generation model is unavailable. Configure a Wiki model and rerun.",
        )
    })?;
    let index_path = plan.project_root.join("wiki/index.md");
    let index = match std::fs::read_to_string(&index_path) {
        Ok(index) => index,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(WikiFailure::io(index_path.to_string_lossy(), error)),
    };
    let request = super::synthesis::request(&task, plan.model_ref.clone(), &plan.language, &index);
    let mut sink = ResearchSink {
        tasks: tasks.clone(),
        root: plan.project_root.clone(),
        project_id: plan.project_id.clone(),
        task_id: task.id.clone(),
        text: String::new(),
        last_flush: std::time::Instant::now(),
    };
    llm.stream_generate_cancellable(request, cancellation.clone(), &mut sink)
        .await?;
    tasks
        .update(&plan.project_root, &plan.project_id, &task.id, |task| {
            task.synthesis = super::synthesis::clean(&sink.text)
        })
        .await?;
    let (synthesis, cited) = super::synthesis::validate(&sink.text, task.web_results.len())?;
    let task = tasks
        .update(&plan.project_root, &plan.project_id, &task.id, |task| {
            task.status = WikiResearchTaskStatus::Saving;
            task.synthesis = synthesis;
        })
        .await?;
    if cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    owner
        .request_command(None, |reply| WikiCommand::CommitResearch {
            project_id: plan.project_id.clone(),
            task,
            cited,
            reply,
        })
        .await
        .unwrap_or(Err(WikiFailure::OwnerUnavailable))
}

struct ResearchSink {
    tasks: Arc<ResearchTasks>,
    root: PathBuf,
    project_id: String,
    task_id: String,
    text: String,
    last_flush: std::time::Instant,
}

impl WikiIngestLlmDeltaSink for ResearchSink {
    fn send<'a>(&'a mut self, delta: String) -> WikiFuture<'a, Result<(), WikiFailure>> {
        Box::pin(async move {
            self.text.push_str(&delta);
            self.tasks
                .append_delta(&self.root, &self.project_id, &self.task_id, &delta)
                .await?;
            if self.last_flush.elapsed() >= std::time::Duration::from_millis(200) {
                self.tasks.flush(&self.root, &self.project_id).await?;
                self.last_flush = std::time::Instant::now();
            }
            Ok(())
        })
    }
}

fn failure_message(error: &WikiFailure) -> String {
    match error {
        WikiFailure::StateUnavailable { message } | WikiFailure::InvalidInput { message, .. } => {
            message.clone()
        }
        _ => {
            "Research could not finish. Check the search/model configuration and rerun.".to_owned()
        }
    }
}
