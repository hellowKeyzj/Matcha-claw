use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};

use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

use crate::{
    domain::{WikiDedupTask, WikiDedupTaskStatus, WikiFailure},
    owner::actor::{read_json, write_json},
};

const QUEUE: &str = ".llm-wiki/dedup-queue.json";

#[derive(Default)]
pub(crate) struct DedupRuns {
    pub(crate) projects: Mutex<BTreeMap<String, ProjectQueue>>,
    pub(crate) detections: StdMutex<BTreeMap<(String, String), CancellationToken>>,
    pub(crate) shutdown: CancellationToken,
}

pub(crate) struct ProjectQueue {
    pub root: PathBuf,
    pub tasks: Vec<WikiDedupTask>,
    pub cancellations: BTreeMap<String, CancellationToken>,
    pub serial: Arc<Mutex<()>>,
}

impl ProjectQueue {
    pub fn load(root: &Path, project_id: &str) -> Result<Self, WikiFailure> {
        let mut tasks: Vec<WikiDedupTask> = read_json(root.join(QUEUE))?;
        tasks.retain(|task| {
            task.project_id == project_id && task.status != WikiDedupTaskStatus::Done
        });
        for task in &mut tasks {
            if task.status == WikiDedupTaskStatus::Processing {
                task.status = WikiDedupTaskStatus::Pending;
            }
            if task.status == WikiDedupTaskStatus::Pending {
                task.paused = true;
            }
        }
        let queue = Self {
            root: root.to_owned(),
            tasks,
            cancellations: BTreeMap::new(),
            serial: Arc::new(Mutex::new(())),
        };
        queue.save()?;
        Ok(queue)
    }

    pub fn save(&self) -> Result<(), WikiFailure> {
        write_json(self.root.join(QUEUE), &self.tasks)
    }
}

impl DedupRuns {
    pub(crate) async fn serial(
        &self,
        project_id: &str,
    ) -> Result<OwnedMutexGuard<()>, WikiFailure> {
        let serial = self
            .projects
            .lock()
            .await
            .get(project_id)
            .ok_or_else(|| WikiFailure::state("dedup queue is not loaded"))?
            .serial
            .clone();
        Ok(serial.lock_owned().await)
    }

    pub(crate) async fn pause(&self, project_id: &str) -> Result<(), WikiFailure> {
        for ((project, _), cancellation) in
            self.detections.lock().expect("dedup detection lock").iter()
        {
            if project == project_id {
                cancellation.cancel();
            }
        }
        let mut projects = self.projects.lock().await;
        if let Some(queue) = projects.get_mut(project_id) {
            for cancellation in queue.cancellations.values() {
                cancellation.cancel();
            }
            queue.cancellations.clear();
            for task in &mut queue.tasks {
                if task.status == WikiDedupTaskStatus::Processing {
                    task.status = WikiDedupTaskStatus::Pending;
                }
                if task.status == WikiDedupTaskStatus::Pending {
                    task.paused = true;
                }
            }
            queue.save()?;
        }
        Ok(())
    }

    pub(crate) async fn shutdown(&self) {
        self.shutdown.cancel();
        let project_ids = self
            .projects
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for cancellation in self
            .detections
            .lock()
            .expect("dedup detection lock")
            .values()
        {
            cancellation.cancel();
        }
        for project_id in project_ids {
            if self.pause(&project_id).await.is_err() {
                eprintln!("[wiki:dedup] shutdown queue persistence failed");
            }
        }
    }
}

pub(crate) fn group_key(slugs: &[String]) -> String {
    let mut slugs = slugs
        .iter()
        .map(|slug| slug.to_lowercase())
        .collect::<Vec<_>>();
    slugs.sort();
    slugs.join(",")
}
