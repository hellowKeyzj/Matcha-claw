mod directory;

use std::{
    collections::{BTreeMap, btree_map::Entry},
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
    WikiFailure,
    domain::model::{WikiQuestionStatus, WikiQuestionTask},
    owner::actor::read_json,
};

const TASKS_FILE: &str = ".llm-wiki/question-tasks.json";

pub(crate) struct QuestionTasks {
    projects: Arc<Mutex<Projects>>,
    blocking: Arc<crate::owner::blocking::BlockingTasks>,
}

#[derive(Default)]
struct Projects {
    aliases: BTreeMap<String, Arc<Mutex<Option<ProjectTasks>>>>,
    // Aliases stay bound for this owner's lifetime; external root replacement needs a restart.
    directories: BTreeMap<directory::Identity, Arc<Mutex<Option<ProjectTasks>>>>,
}

struct ProjectTasks {
    tasks: Vec<WikiQuestionTask>,
    cancellations: BTreeMap<String, CancellationToken>,
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
        blocking: Arc<crate::owner::blocking::BlockingTasks>,
    ) -> Result<Self, WikiFailure> {
        let mut recovered = Projects::default();
        for (project_id, root) in projects {
            let identity = match directory::read_identity(&root) {
                Ok(identity) => identity,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(WikiFailure::io(root.to_string_lossy(), error)),
            };
            let project = match recovered.directories.entry(identity) {
                Entry::Occupied(project) => project.get().clone(),
                Entry::Vacant(project) => project
                    .insert(Arc::new(Mutex::new(Some(recover_project(&root)?))))
                    .clone(),
            };
            recovered.aliases.insert(project_id, project);
        }
        Ok(Self {
            projects: Arc::new(Mutex::new(recovered)),
            blocking,
        })
    }

    async fn with_project<T: Send + 'static>(
        &self,
        root: &Path,
        project_id: &str,
        operation: impl FnOnce(&mut ProjectTasks, &Path) -> Result<T, WikiFailure> + Send + 'static,
    ) -> Result<T, WikiFailure> {
        let project = self.projects.lock().await.aliases.get(project_id).cloned();
        let project = match project {
            Some(project) => project,
            None => {
                let projects = self.projects.clone();
                let root = root.to_path_buf();
                let project_id = project_id.to_owned();
                self.blocking
                    .run(move || {
                        let identity = directory::read_identity(&root)
                            .map_err(|error| WikiFailure::io(root.to_string_lossy(), error))?;
                        let mut projects = projects.blocking_lock();
                        let project = projects.directories.entry(identity).or_default().clone();
                        projects.aliases.insert(project_id, project.clone());
                        Ok(project)
                    })
                    .await?
            }
        };
        let mut project = project.lock_owned().await;
        let root = root.to_path_buf();
        // The project guard travels with the real I/O, even if its observer is dropped.
        self.blocking
            .run(move || {
                if project.is_none() {
                    *project = Some(recover_project(&root)?);
                }
                operation(project.as_mut().expect("question project loaded"), &root)
            })
            .await
    }

    pub(crate) async fn stage(
        &self,
        root: &Path,
        task: WikiQuestionTask,
        cancellation: CancellationToken,
    ) -> Result<(), WikiFailure> {
        let project_id = task.project_id.clone();
        self.with_project(root, &project_id, move |project, root| {
            if project.tasks.iter().any(|existing| existing.id == task.id) {
                return Err(WikiFailure::invalid_input(
                    "taskId",
                    "Question task already exists; use a new taskId",
                ));
            }
            if project.tasks.iter().any(|existing| !is_terminal(existing.status))
                || !project.cancellations.is_empty()
            {
                return Err(WikiFailure::state(
                    "This Wiki project already has an active question",
                ));
            }
            let task_id = task.id.clone();
            let mut next = project.tasks.clone();
            next.push(task);
            persist(root, &next)?;
            project.tasks = next;
            project.pending_terminal_task_id = None;
            project.cancellations.insert(task_id, cancellation);
            Ok(())
        })
        .await
    }

    pub(crate) async fn get(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let task_id = task_id.to_owned();
        self.with_project(root, project_id, move |project, root| {
            let task = project
                .tasks
                .iter()
                .find(|task| task.id == task_id)
                .cloned()
                .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
            project.persist_terminal(root, &task_id)?;
            Ok(task)
        })
        .await
    }

    pub(crate) async fn finish(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
        status: WikiQuestionStatus,
        error: Option<String>,
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let task_id = task_id.to_owned();
        self.with_project(root, project_id, move |project, root| {
            let cancelled = project
                .cancellations
                .get(&task_id)
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
            project.persist_terminal(root, &task_id)?;
            Ok(updated)
        })
        .await
    }

    pub(crate) async fn update(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
        update: impl FnOnce(&mut WikiQuestionTask) + Send + 'static,
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let task_id = task_id.to_owned();
        self.with_project(root, project_id, move |project, root| {
            let mut next = project.tasks.clone();
            let task = next
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
            if task.status == WikiQuestionStatus::Cancelled {
                project.persist_terminal(root, &task_id)?;
                return Ok(task.clone());
            }
            update(task);
            task.revision += 1;
            let updated = task.clone();
            persist(root, &next)?;
            project.tasks = next;
            project.pending_terminal_task_id = None;
            Ok(updated)
        })
        .await
    }

    pub(crate) async fn append_delta(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
        delta: &str,
    ) -> Result<(), WikiFailure> {
        let task_id = task_id.to_owned();
        let delta = delta.to_owned();
        self.with_project(root, project_id, move |project, _| {
            let task = project
                .tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
            if task.status == WikiQuestionStatus::Cancelled {
                return Err(WikiFailure::cancelled());
            }
            task.answer.push_str(&delta);
            task.revision += 1;
            Ok(())
        })
        .await
    }

    pub(crate) async fn release(&self, project_id: &str, task_id: &str) {
        let project = self.projects.lock().await.aliases.get(project_id).cloned();
        if let Some(project) = project {
            if let Some(project) = project.lock().await.as_mut() {
                project.cancellations.remove(task_id);
            }
        }
    }

    pub(crate) async fn flush(&self, root: &Path, project_id: &str) -> Result<(), WikiFailure> {
        self.with_project(root, project_id, |project, root| project.persist(root))
            .await
    }

    pub(crate) async fn cancel(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let task_id = task_id.to_owned();
        self.with_project(root, project_id, move |project, root| {
            let task = project
                .tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
            if is_terminal(task.status) {
                let updated = task.clone();
                project.persist_terminal(root, &task_id)?;
                return Ok(updated);
            }
            if let Some(token) = project.cancellations.get(&task_id) {
                token.cancel();
            }
            task.status = WikiQuestionStatus::Cancelled;
            task.error = None;
            task.revision += 1;
            project.pending_terminal_task_id = Some(task.id.clone());
            let updated = task.clone();
            project.persist_terminal(root, &task_id)?;
            Ok(updated)
        })
        .await
    }
}

pub(crate) fn is_terminal(status: WikiQuestionStatus) -> bool {
    matches!(
        status,
        WikiQuestionStatus::Done | WikiQuestionStatus::Cancelled | WikiQuestionStatus::Error
    )
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
        cancellations: BTreeMap::new(),
        pending_terminal_task_id: None,
    })
}

fn persist(root: &Path, tasks: &[WikiQuestionTask]) -> Result<(), WikiFailure> {
    let path = root.join(TASKS_FILE);
    let bytes = serde_json::to_vec_pretty(tasks)
        .map_err(|error| WikiFailure::state(error.to_string()))?;
    crate::history::replace_store(&path, &bytes)
}
