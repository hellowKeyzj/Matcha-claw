use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
    WikiFailure,
    domain::model::{WikiQuestionStatus, WikiQuestionTask},
    owner::actor::read_json,
};

const TASKS_FILE: &str = ".llm-wiki/question-tasks.json";

#[derive(Default)]
pub(crate) struct QuestionTasks {
    projects: Mutex<BTreeMap<String, ProjectTasks>>,
    cancellations: Mutex<BTreeMap<(String, String), CancellationToken>>,
}

struct ProjectTasks {
    tasks: Vec<WikiQuestionTask>,
    // At most one terminal is pending: staging the next task commits the entire project first.
    pending_terminal_task_id: Option<String>,
}

impl ProjectTasks {
    fn persist(&mut self, root: &Path) -> Result<(), WikiFailure> {
        persist(root, &self.tasks)?;
        self.pending_terminal_task_id = None;
        Ok(())
    }

    fn persist_terminal(&mut self, root: &Path, task_id: &str) -> Result<(), WikiFailure> {
        if self.pending_terminal_task_id.as_deref() == Some(task_id) {
            self.persist(root)?;
        }
        Ok(())
    }
}

impl QuestionTasks {
    pub(crate) fn recover(
        projects: impl Iterator<Item = (String, PathBuf)>,
    ) -> Result<Self, WikiFailure> {
        let mut recovered = BTreeMap::new();
        for (project_id, root) in projects {
            recovered.insert(project_id, recover_project(&root)?);
        }
        Ok(Self {
            projects: Mutex::new(recovered),
            cancellations: Mutex::new(BTreeMap::new()),
        })
    }

    pub(crate) async fn stage(
        &self,
        root: &Path,
        task: WikiQuestionTask,
        cancellation: CancellationToken,
    ) -> Result<(), WikiFailure> {
        let mut projects = self.projects.lock().await;
        let project = load(&mut projects, root, &task.project_id)?;
        if project.tasks.iter().any(|existing| existing.id == task.id) {
            return Err(WikiFailure::invalid_input(
                "taskId",
                "Question task already exists; use a new taskId",
            ));
        }
        if project.tasks.iter().any(|existing| !is_terminal(existing.status))
            || self
                .cancellations
                .lock()
                .await
                .keys()
                .any(|(project_id, _)| project_id == &task.project_id)
        {
            return Err(WikiFailure::state(
                "This Wiki project already has an active question",
            ));
        }
        let key = (task.project_id.clone(), task.id.clone());
        let mut next = project.tasks.clone();
        next.push(task);
        persist(root, &next)?;
        project.tasks = next;
        project.pending_terminal_task_id = None;
        self.cancellations.lock().await.insert(key, cancellation);
        Ok(())
    }

    pub(crate) async fn get(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let project = load(&mut projects, root, project_id)?;
        let task = project
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
        project.persist_terminal(root, task_id)?;
        Ok(task)
    }

    pub(crate) async fn finish(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
        status: WikiQuestionStatus,
        error: Option<String>,
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let project = load(&mut projects, root, project_id)?;
        let cancelled = self
            .cancellations
            .lock()
            .await
            .get(&(project_id.to_owned(), task_id.to_owned()))
            .is_some_and(CancellationToken::is_cancelled);
        let task = project
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
        if !is_terminal(task.status) {
            task.status = if cancelled {
                WikiQuestionStatus::Cancelled
            } else {
                status
            };
            task.error = if cancelled { None } else { error };
            task.revision += 1;
            project.pending_terminal_task_id = Some(task.id.clone());
        }
        let updated = task.clone();
        project.persist_terminal(root, task_id)?;
        Ok(updated)
    }

    pub(crate) async fn update(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
        update: impl FnOnce(&mut WikiQuestionTask),
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let project = load(&mut projects, root, project_id)?;
        let mut next = project.tasks.clone();
        let task = next
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
        if task.status == WikiQuestionStatus::Cancelled {
            project.persist_terminal(root, task_id)?;
            return Ok(task.clone());
        }
        update(task);
        task.revision += 1;
        let updated = task.clone();
        persist(root, &next)?;
        project.tasks = next;
        project.pending_terminal_task_id = None;
        Ok(updated)
    }

    pub(crate) async fn append_delta(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
        delta: &str,
    ) -> Result<(), WikiFailure> {
        let mut projects = self.projects.lock().await;
        let task = load(&mut projects, root, project_id)?
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
        if task.status == WikiQuestionStatus::Cancelled {
            return Err(WikiFailure::cancelled());
        }
        task.answer.push_str(delta);
        task.revision += 1;
        Ok(())
    }

    pub(crate) async fn release(&self, project_id: &str, task_id: &str) {
        self.cancellations
            .lock()
            .await
            .remove(&(project_id.to_owned(), task_id.to_owned()));
    }

    pub(crate) async fn flush(&self, root: &Path, project_id: &str) -> Result<(), WikiFailure> {
        let mut projects = self.projects.lock().await;
        load(&mut projects, root, project_id)?.persist(root)
    }

    pub(crate) async fn cancel(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let project = load(&mut projects, root, project_id)?;
        let task = project
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
        if is_terminal(task.status) {
            let updated = task.clone();
            project.persist_terminal(root, task_id)?;
            return Ok(updated);
        }
        if let Some(token) = self
            .cancellations
            .lock()
            .await
            .get(&(project_id.to_owned(), task_id.to_owned()))
        {
            token.cancel();
        }
        task.status = WikiQuestionStatus::Cancelled;
        task.error = None;
        task.revision += 1;
        project.pending_terminal_task_id = Some(task.id.clone());
        let updated = task.clone();
        project.persist_terminal(root, task_id)?;
        Ok(updated)
    }
}

pub(crate) fn is_terminal(status: WikiQuestionStatus) -> bool {
    matches!(
        status,
        WikiQuestionStatus::Done | WikiQuestionStatus::Cancelled | WikiQuestionStatus::Error
    )
}

fn load<'a>(
    projects: &'a mut BTreeMap<String, ProjectTasks>,
    root: &Path,
    project_id: &str,
) -> Result<&'a mut ProjectTasks, WikiFailure> {
    if !projects.contains_key(project_id) {
        projects.insert(project_id.to_owned(), recover_project(root)?);
    }
    Ok(projects
        .get_mut(project_id)
        .expect("question project loaded"))
}

fn recover_project(root: &Path) -> Result<ProjectTasks, WikiFailure> {
    let mut tasks: Vec<WikiQuestionTask> = read_json(root.join(TASKS_FILE))?;
    let mut changed = false;
    for task in &mut tasks {
        if !is_terminal(task.status) {
            task.status = WikiQuestionStatus::Error;
            task.error = Some(
                "Question incomplete: the Wiki owner stopped. Ask again with a new taskId."
                    .to_owned(),
            );
            task.revision += 1;
            changed = true;
        }
    }
    if changed {
        persist(root, &tasks)?;
    }
    Ok(ProjectTasks {
        tasks,
        pending_terminal_task_id: None,
    })
}

fn persist(root: &Path, tasks: &[WikiQuestionTask]) -> Result<(), WikiFailure> {
    let path = root.join(TASKS_FILE);
    let bytes = serde_json::to_vec_pretty(tasks)
        .map_err(|error| WikiFailure::state(error.to_string()))?;
    crate::history::replace_store(&path, &bytes)
}
