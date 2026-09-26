use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

use foundation::execution::OwnedTask;
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::{WikiFailure, WikiHandle};

const EVENT_QUEUE_CAPACITY: usize = 8_192;
const CHANGE_DEBOUNCE_MS: u64 = 700;
const LINUX_RESCAN_INTERVAL_MS: u64 = 10_000;

#[derive(Clone)]
pub(crate) struct SourceWatchControl {
    project: watch::Sender<Option<WatchedProject>>,
    generation: Arc<AtomicU64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WatchedProject {
    project_id: String,
    root_path: PathBuf,
    auto_ingest: bool,
}

impl SourceWatchControl {
    pub(crate) fn channel() -> (Self, watch::Receiver<Option<WatchedProject>>) {
        let (project, receiver) = watch::channel(None);
        (
            Self {
                project,
                generation: Arc::new(AtomicU64::new(0)),
            },
            receiver,
        )
    }

    pub(crate) fn watch_project(&self, project_id: String, root_path: String, auto_ingest: bool) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _ = self.project.send(Some(WatchedProject {
            project_id,
            root_path: PathBuf::from(root_path),
            auto_ingest,
        }));
    }

    pub(crate) fn clear(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _ = self.project.send(None);
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

pub(crate) fn spawn(
    wiki: WikiHandle,
    control: SourceWatchControl,
    mut receiver: watch::Receiver<Option<WatchedProject>>,
) -> OwnedTask<()> {
    OwnedTask::spawn(|cancellation| async move {
        let mut current = initial_project(&wiki).await.or_else(|| receiver.borrow().clone());
        let mut session = current
            .take()
            .map(|project| spawn_project_session(wiki.clone(), control.clone(), project));

        loop {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    if let Some(task) = session.as_mut() {
                        let _ = task.cancel_and_join().await;
                    }
                    break;
                }
                changed = receiver.changed() => {
                    if changed.is_err() {
                        if let Some(task) = session.as_mut() {
                            let _ = task.cancel_and_join().await;
                        }
                        break;
                    }
                    let next = receiver.borrow().clone();
                    if session.as_ref().is_some() {
                        if let Some(task) = session.as_mut() {
                            let _ = task.cancel_and_join().await;
                        }
                        session = None;
                    }
                    if let Some(project) = next {
                        session = Some(spawn_project_session(wiki.clone(), control.clone(), project));
                    }
                }
            }
        }
    })
    .0
}

async fn initial_project(wiki: &WikiHandle) -> Option<WatchedProject> {
    let status = wiki.status().await.ok()?;
    let project = status.current_project()?;
    let receipt = wiki
        .source_watch_config(crate::domain::WikiProjectSelector {
            project_id: Some(project.project_id().to_owned()),
        })
        .await
        .ok()?;
    receipt.config().enabled().then(|| WatchedProject {
        project_id: project.project_id().to_owned(),
        root_path: PathBuf::from(project.root_path()),
        auto_ingest: receipt.config().auto_ingest(),
    })
}

fn spawn_project_session(
    wiki: WikiHandle,
    control: SourceWatchControl,
    project: WatchedProject,
) -> OwnedTask<()> {
    OwnedTask::spawn(|cancellation| async move {
        let generation = control.generation();
        let handle = tokio::runtime::Handle::current();
        let join = tokio::task::spawn_blocking(move || {
            if let Err(error) =
                run_project_watcher(wiki, control, project, generation, cancellation, handle)
            {
                eprintln!("[wiki] source watcher stopped: {error:?}");
            }
        });
        let _ = join.await;
    })
    .0
}

fn run_project_watcher(
    wiki: WikiHandle,
    control: SourceWatchControl,
    project: WatchedProject,
    generation: u64,
    cancellation: CancellationToken,
    handle: tokio::runtime::Handle,
) -> Result<(), WikiFailure> {
    let root = project.root_path.clone();
    refresh_project_paths(
        &handle,
        &wiki,
        &control,
        &project.project_id,
        generation,
        project.auto_ingest,
        watch_roots(&root),
    );

    let (tx, rx) = mpsc::sync_channel::<PathBuf>(EVENT_QUEUE_CAPACITY);
    let tx_for_watcher = tx.clone();
    let root_for_overflow = root.clone();
    let root_for_error = root.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| match result {
            Ok(event) => {
                for path in event.paths {
                    if tx_for_watcher.try_send(path).is_err() {
                        let _ = tx_for_watcher.try_send(root_for_overflow.clone());
                        break;
                    }
                }
            }
            Err(error) => {
                eprintln!("[wiki] source watcher error; scheduling rescan: {error}");
                let _ = tx_for_watcher.try_send(root_for_error.clone());
            }
        },
        Config::default(),
    )
    .map_err(|error| WikiFailure::state(format!("source watcher unavailable: {error}")))?;

    watch_path(&mut watcher, &root)?;
    for relative in ["raw/sources", "wiki"] {
        let path = root.join(relative);
        if path.exists() {
            if let Err(error) = watch_path(&mut watcher, &path) {
                eprintln!(
                    "[wiki] failed to add supplemental watch '{}': {error:?}",
                    path.display()
                );
            }
        }
    }

    let mut pending = BTreeSet::<PathBuf>::new();
    let mut last_linux_rescan = crate::domain::now_ms();
    while !cancellation.is_cancelled() && control.generation() == generation {
        match rx.recv_timeout(Duration::from_millis(CHANGE_DEBOUNCE_MS)) {
            Ok(path) => {
                pending.insert(path);
                while let Ok(path) = rx.try_recv() {
                    pending.insert(path);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if pending.is_empty() {
                    maybe_linux_rescan(
                        &handle,
                        &wiki,
                        &control,
                        &project.project_id,
                        &root,
                        generation,
                        project.auto_ingest,
                        &mut last_linux_rescan,
                    );
                    continue;
                }
                let paths = pending.iter().cloned().collect::<Vec<_>>();
                pending.clear();
                refresh_project_paths(
                    &handle,
                    &wiki,
                    &control,
                    &project.project_id,
                    generation,
                    project.auto_ingest,
                    paths,
                );
                maybe_linux_rescan(
                    &handle,
                    &wiki,
                    &control,
                    &project.project_id,
                    &root,
                    generation,
                    project.auto_ingest,
                    &mut last_linux_rescan,
                );
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(watcher);
    Ok(())
}

fn watch_path(watcher: &mut RecommendedWatcher, path: &std::path::Path) -> Result<(), WikiFailure> {
    watcher
        .watch(path, RecursiveMode::Recursive)
        .map_err(|error| {
            WikiFailure::state(format!("failed to watch '{}': {error}", path.display()))
        })
}

fn maybe_linux_rescan(
    handle: &tokio::runtime::Handle,
    wiki: &WikiHandle,
    control: &SourceWatchControl,
    project_id: &str,
    root: &Path,
    generation: u64,
    auto_ingest: bool,
    last_linux_rescan: &mut u64,
) {
    if !cfg!(target_os = "linux") {
        return;
    }
    let now = crate::domain::now_ms();
    if now.saturating_sub(*last_linux_rescan) < LINUX_RESCAN_INTERVAL_MS {
        return;
    }
    *last_linux_rescan = now;
    refresh_project_paths(
        handle,
        wiki,
        control,
        project_id,
        generation,
        auto_ingest,
        watch_roots(root),
    );
}

fn watch_roots(root: &Path) -> Vec<PathBuf> {
    ["raw/sources", "wiki", "purpose.md", "schema.md"]
        .into_iter()
        .map(|relative| root.join(relative))
        .filter(|path| path.exists())
        .collect()
}

fn refresh_project_paths(
    handle: &tokio::runtime::Handle,
    wiki: &WikiHandle,
    control: &SourceWatchControl,
    project_id: &str,
    generation: u64,
    auto_ingest: bool,
    paths: Vec<PathBuf>,
) {
    if paths.is_empty() || control.generation() != generation {
        return;
    }
    let result =
        handle.block_on(wiki.refresh_source_paths(project_id.to_owned(), paths, auto_ingest));
    if let Err(error) = result {
        eprintln!("[wiki] source watcher refresh failed: {error:?}");
    }
}
