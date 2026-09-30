use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use tokio::sync::Mutex;

use super::{
    WikiResearchTask, WikiResearchTaskInput, WikiResearchTaskStatus, WikiResearchTasksReceipt,
};
use crate::{
    WikiFailure,
    domain::{now_ms, stable_content_hash},
    owner::actor::{read_json, write_json},
};

const TASKS_FILE: &str = ".llm-wiki/research-tasks.json";
static TASK_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub(crate) struct ResearchTasks {
    projects: Mutex<BTreeMap<String, Vec<WikiResearchTask>>>,
}

impl ResearchTasks {
    pub(crate) fn recover(
        projects: impl Iterator<Item = (String, PathBuf)>,
    ) -> Result<Self, WikiFailure> {
        let mut recovered = BTreeMap::new();
        for (project_id, root) in projects {
            recovered.insert(project_id, recover_project(&root)?);
        }
        Ok(Self {
            projects: Mutex::new(recovered),
        })
    }

    pub(crate) async fn list(
        &self,
        root: &Path,
        project_id: &str,
    ) -> Result<WikiResearchTasksReceipt, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let tasks = load(&mut projects, root, project_id)?;
        Ok(WikiResearchTasksReceipt {
            project_id: project_id.to_owned(),
            tasks: tasks.clone(),
        })
    }

    pub(crate) async fn stage(
        &self,
        root: &Path,
        project_id: &str,
        inputs: Vec<WikiResearchTaskInput>,
    ) -> Result<Vec<WikiResearchTask>, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let tasks = load(&mut projects, root, project_id)?;
        let mut added = Vec::<WikiResearchTask>::new();
        for input in inputs {
            let topic = input.topic.trim().to_owned();
            if topic.is_empty() {
                return Err(WikiFailure::invalid_input(
                    "topic",
                    "Research topic must not be empty",
                ));
            }
            if let Some(parent) = &input.rerun_of_task_id {
                let source = tasks
                    .iter()
                    .find(|task| &task.id == parent)
                    .ok_or_else(|| {
                        WikiFailure::invalid_input("rerunOfTaskId", "Research task was not found")
                    })?;
                if !source.status.is_terminal()
                    || tasks.iter().chain(added.iter()).any(|task| {
                        !task.status.is_terminal()
                            && lineage(tasks, task.rerun_of_task_id.as_deref().unwrap_or(&task.id))
                                == lineage(tasks, parent)
                    })
                {
                    return Err(WikiFailure::invalid_input(
                        "rerunOfTaskId",
                        "Research lineage already has an active task",
                    ));
                }
            }
            let created_at = now_ms();
            let sequence = TASK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let id = format!(
                "research-{}",
                stable_content_hash(format!("{project_id}:{created_at}:{sequence}").as_bytes())
            );
            added.push(WikiResearchTask {
                id,
                topic,
                search_queries: input
                    .search_queries
                    .unwrap_or_default()
                    .into_iter()
                    .map(|query| query.trim().to_owned())
                    .filter(|query| !query.is_empty())
                    .collect(),
                source_review_id: input.source_review_id,
                rerun_of_task_id: input.rerun_of_task_id,
                status: WikiResearchTaskStatus::Queued,
                web_results: Vec::new(),
                synthesis: String::new(),
                saved_path: None,
                error: None,
                created_at,
                project_id: project_id.to_owned(),
            });
        }
        let mut next = tasks.clone();
        next.extend(added.clone());
        persist(root, &next)?;
        *tasks = next;
        Ok(added)
    }

    pub(crate) async fn update(
        &self,
        root: &Path,
        project_id: &str,
        id: &str,
        update: impl FnOnce(&mut WikiResearchTask),
    ) -> Result<WikiResearchTask, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let tasks = load(&mut projects, root, project_id)?;
        let mut next = tasks.clone();
        let task = next
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| WikiFailure::invalid_input("taskId", "Research task was not found"))?;
        update(task);
        let updated = task.clone();
        persist(root, &next)?;
        *tasks = next;
        Ok(updated)
    }

    pub(crate) async fn append_delta(
        &self,
        root: &Path,
        project_id: &str,
        id: &str,
        delta: &str,
    ) -> Result<(), WikiFailure> {
        let mut projects = self.projects.lock().await;
        let task = load(&mut projects, root, project_id)?
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| WikiFailure::invalid_input("taskId", "Research task was not found"))?;
        task.synthesis.push_str(delta);
        Ok(())
    }

    pub(crate) async fn flush(&self, root: &Path, project_id: &str) -> Result<(), WikiFailure> {
        let mut projects = self.projects.lock().await;
        persist(root, load(&mut projects, root, project_id)?)
    }

    pub(crate) async fn remove(
        &self,
        root: &Path,
        project_id: &str,
        id: &str,
    ) -> Result<WikiResearchTasksReceipt, WikiFailure> {
        let mut projects = self.projects.lock().await;
        let tasks = load(&mut projects, root, project_id)?;
        let task = tasks
            .iter()
            .find(|task| task.id == id)
            .ok_or_else(|| WikiFailure::invalid_input("taskId", "Research task was not found"))?;
        if !task.status.is_terminal() {
            return Err(WikiFailure::invalid_input(
                "taskId",
                "Only completed research tasks can be removed",
            ));
        }
        let next = tasks
            .iter()
            .filter(|task| task.id != id)
            .cloned()
            .collect::<Vec<_>>();
        persist(root, &next)?;
        *tasks = next;
        Ok(WikiResearchTasksReceipt {
            project_id: project_id.to_owned(),
            tasks: tasks.clone(),
        })
    }
}

fn load<'a>(
    projects: &'a mut BTreeMap<String, Vec<WikiResearchTask>>,
    root: &Path,
    project_id: &str,
) -> Result<&'a mut Vec<WikiResearchTask>, WikiFailure> {
    if !projects.contains_key(project_id) {
        projects.insert(project_id.to_owned(), recover_project(root)?);
    }
    Ok(projects
        .get_mut(project_id)
        .expect("research project was loaded"))
}

fn recover_project(root: &Path) -> Result<Vec<WikiResearchTask>, WikiFailure> {
    let mut tasks: Vec<WikiResearchTask> = read_json(root.join(TASKS_FILE))?;
    let mut changed = false;
    for task in &mut tasks {
        if !task.status.is_terminal() {
            task.status = WikiResearchTaskStatus::Error;
            task.synthesis = super::synthesis::clean(&task.synthesis);
            task.error = Some(
                "Research incomplete: the Wiki owner stopped. Rerun the task to retry.".to_owned(),
            );
            changed = true;
        }
    }
    if changed {
        persist(root, &tasks)?;
    }
    Ok(tasks)
}

fn persist(root: &Path, tasks: &[WikiResearchTask]) -> Result<(), WikiFailure> {
    let path = root.join(TASKS_FILE);
    let staged = path.with_extension("json.tmp");
    write_json(&staged, &tasks)?;
    std::fs::rename(&staged, &path).map_err(|error| WikiFailure::io(path.to_string_lossy(), error))
}

fn lineage<'a>(tasks: &'a [WikiResearchTask], id: &'a str) -> &'a str {
    let mut current = id;
    let mut visited = BTreeSet::new();
    while visited.insert(current) {
        match tasks
            .iter()
            .find(|task| task.id == current)
            .and_then(|task| task.rerun_of_task_id.as_deref())
        {
            Some(parent) => current = parent,
            None => break,
        }
    }
    current
}
