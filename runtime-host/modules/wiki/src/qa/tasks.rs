use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
    WikiFailure,
    domain::model::{WikiQuestionStatus, WikiQuestionTask},
    owner::actor::{read_json, write_json},
};

const TASKS_FILE: &str = ".llm-wiki/question-tasks.json";

#[derive(Default)]
pub(crate) struct QuestionTasks {
    projects: Mutex<BTreeMap<String, Vec<WikiQuestionTask>>>,
    cancellations: Mutex<BTreeMap<(String, String), CancellationToken>>,
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
        let tasks = load(&mut projects, root, &task.project_id)?;
        if tasks.iter().any(|existing| existing.id == task.id) {
            return Err(WikiFailure::invalid_input(
                "taskId",
                "Question task already exists; use a new taskId",
            ));
        }
        if tasks.iter().any(|existing| !is_terminal(existing.status))
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
        let mut next = tasks.clone();
        next.push(task);
        persist(root, &next)?;
        *tasks = next;
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
        load(&mut projects, root, project_id)?
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or_else(|| WikiFailure::not_found("Wiki question task"))
    }

    pub(crate) async fn update(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
        update: impl FnOnce(&mut WikiQuestionTask),
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let tasks = load(&mut projects, root, project_id)?;
        let mut next = tasks.clone();
        let task = next
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
        if task.status == WikiQuestionStatus::Cancelled {
            return Ok(task.clone());
        }
        update(task);
        task.revision += 1;
        let updated = task.clone();
        persist(root, &next)?;
        *tasks = next;
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
        persist(root, load(&mut projects, root, project_id)?)
    }

    pub(crate) async fn cancel(
        &self,
        root: &Path,
        project_id: &str,
        task_id: &str,
    ) -> Result<WikiQuestionTask, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let tasks = load(&mut projects, root, project_id)?;
        let mut next = tasks.clone();
        let task = next
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| WikiFailure::not_found("Wiki question task"))?;
        if is_terminal(task.status) {
            return Ok(task.clone());
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
        let updated = task.clone();
        persist(root, &next)?;
        *tasks = next;
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
    projects: &'a mut BTreeMap<String, Vec<WikiQuestionTask>>,
    root: &Path,
    project_id: &str,
) -> Result<&'a mut Vec<WikiQuestionTask>, WikiFailure> {
    if !projects.contains_key(project_id) {
        projects.insert(project_id.to_owned(), recover_project(root)?);
    }
    Ok(projects
        .get_mut(project_id)
        .expect("question project loaded"))
}

fn recover_project(root: &Path) -> Result<Vec<WikiQuestionTask>, WikiFailure> {
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
    Ok(tasks)
}

fn persist(root: &Path, tasks: &[WikiQuestionTask]) -> Result<(), WikiFailure> {
    let path = root.join(TASKS_FILE);
    let staged = path.with_extension("json.tmp");
    write_json(&staged, &tasks)?;
    std::fs::rename(&staged, &path).map_err(|error| WikiFailure::io(path.to_string_lossy(), error))
}
