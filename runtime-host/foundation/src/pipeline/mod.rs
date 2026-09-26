use std::{
    collections::HashMap,
    error::Error,
    fmt::{Display, Formatter},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

use futures_util::{StreamExt, stream};
use serde_json::Value;
use tokio::{fs, sync::Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

pub type ProgressSink = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

pub type PipelineStepFuture<'a, T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'a>>;

#[derive(Clone)]
pub struct PipelineRun {
    run_id: String,
    cancellation: CancellationToken,
}

impl PipelineRun {
    pub fn new(run_id: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            cancellation: CancellationToken::new(),
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }
}

#[derive(Clone)]
pub struct PipelineContext {
    run: PipelineRun,
    progress: ProgressSink,
    artifacts: Arc<dyn ArtifactStore>,
    checkpoints: Arc<dyn CheckpointStore>,
}

impl PipelineContext {
    pub fn new(
        run: PipelineRun,
        progress: ProgressSink,
        artifacts: Arc<dyn ArtifactStore>,
        checkpoints: Arc<dyn CheckpointStore>,
    ) -> Self {
        Self {
            run,
            progress,
            artifacts,
            checkpoints,
        }
    }

    pub fn in_memory(run_id: impl Into<String>, progress: ProgressSink) -> Self {
        Self::new(
            PipelineRun::new(run_id),
            progress,
            Arc::new(MemoryArtifactStore::default()),
            Arc::new(MemoryCheckpointStore::default()),
        )
    }

    pub fn silent_in_memory(run_id: impl Into<String>) -> Self {
        Self::in_memory(run_id, Arc::new(|_| {}))
    }

    pub fn run_id(&self) -> &str {
        self.run.run_id()
    }

    pub fn cancellation(&self) -> CancellationToken {
        self.run.cancellation()
    }

    pub fn cancel(&self) {
        self.run.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.run.cancellation.is_cancelled()
    }

    pub fn emit_progress(&self, event: ProgressEvent) {
        (self.progress)(event);
    }

    pub fn artifacts(&self) -> Arc<dyn ArtifactStore> {
        self.artifacts.clone()
    }

    pub fn checkpoints(&self) -> Arc<dyn CheckpointStore> {
        self.checkpoints.clone()
    }

    pub async fn step<T, E, F>(&self, step_name: impl Into<String>, work: F) -> Result<T, E>
    where
        F: for<'a> FnOnce(&'a PipelineContext) -> PipelineStepFuture<'a, T, E> + Send,
        T: Send,
        E: From<PipelineError> + Display + Send,
    {
        let step_name = step_name.into();
        if self.is_cancelled() {
            self.emit_progress(ProgressEvent::cancelled(self.run_id(), &step_name));
            return Err(PipelineError::Cancelled.into());
        }

        self.emit_progress(ProgressEvent::started(self.run_id(), &step_name));
        let result = work(self).await;
        match result {
            Ok(_) if self.is_cancelled() => {
                self.emit_progress(ProgressEvent::cancelled(self.run_id(), &step_name));
                Err(PipelineError::Cancelled.into())
            }
            Ok(output) => {
                self.emit_progress(ProgressEvent::completed(self.run_id(), &step_name));
                Ok(output)
            }
            Err(error) => {
                self.emit_progress(ProgressEvent::failed(
                    self.run_id(),
                    &step_name,
                    error.to_string(),
                ));
                Err(error)
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgressEvent {
    pub run_id: String,
    pub step_name: String,
    pub stage: ProgressStage,
}

impl ProgressEvent {
    pub fn started(run_id: impl Into<String>, step_name: impl Into<String>) -> Self {
        Self::new(run_id, step_name, ProgressStage::Started)
    }

    pub fn completed(run_id: impl Into<String>, step_name: impl Into<String>) -> Self {
        Self::new(run_id, step_name, ProgressStage::Completed)
    }

    pub fn failed(
        run_id: impl Into<String>,
        step_name: impl Into<String>,
        error: impl Into<String>,
    ) -> Self {
        Self::new(
            run_id,
            step_name,
            ProgressStage::Failed {
                error: error.into(),
            },
        )
    }

    pub fn cancelled(run_id: impl Into<String>, step_name: impl Into<String>) -> Self {
        Self::new(run_id, step_name, ProgressStage::Cancelled)
    }

    fn new(run_id: impl Into<String>, step_name: impl Into<String>, stage: ProgressStage) -> Self {
        Self {
            run_id: run_id.into(),
            step_name: step_name.into(),
            stage,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProgressStage {
    Started,
    Completed,
    Failed { error: String },
    Cancelled,
}

pub trait ArtifactStore: Send + Sync {
    fn put<'a>(
        &'a self,
        name: &'a str,
        bytes: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = Result<ArtifactRef, PipelineError>> + Send + 'a>>;

    fn get<'a>(
        &'a self,
        artifact: &'a ArtifactRef,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, PipelineError>> + Send + 'a>>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactRef {
    pub name: String,
    pub location: String,
}

#[derive(Default)]
pub struct MemoryArtifactStore {
    artifacts: AsyncMutex<HashMap<String, Vec<u8>>>,
}

impl ArtifactStore for MemoryArtifactStore {
    fn put<'a>(
        &'a self,
        name: &'a str,
        bytes: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = Result<ArtifactRef, PipelineError>> + Send + 'a>> {
        Box::pin(async move {
            validate_safe_key(name)?;
            self.artifacts.lock().await.insert(name.to_string(), bytes);
            Ok(ArtifactRef {
                name: name.to_string(),
                location: format!("memory:{name}"),
            })
        })
    }

    fn get<'a>(
        &'a self,
        artifact: &'a ArtifactRef,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, PipelineError>> + Send + 'a>> {
        Box::pin(async move {
            validate_safe_key(&artifact.name)?;
            self.artifacts
                .lock()
                .await
                .get(&artifact.name)
                .cloned()
                .ok_or_else(|| PipelineError::MissingArtifact(artifact.name.clone()))
        })
    }
}

pub struct FileArtifactStore {
    root: PathBuf,
}

impl FileArtifactStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path_for(&self, name: &str) -> Result<PathBuf, PipelineError> {
        validate_safe_key(name)?;
        Ok(self.root.join(name))
    }
}

impl ArtifactStore for FileArtifactStore {
    fn put<'a>(
        &'a self,
        name: &'a str,
        bytes: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = Result<ArtifactRef, PipelineError>> + Send + 'a>> {
        Box::pin(async move {
            let path = self.path_for(name)?;
            fs::create_dir_all(&self.root).await?;
            fs::write(&path, bytes).await?;
            Ok(ArtifactRef {
                name: name.to_string(),
                location: path.to_string_lossy().into_owned(),
            })
        })
    }

    fn get<'a>(
        &'a self,
        artifact: &'a ArtifactRef,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, PipelineError>> + Send + 'a>> {
        Box::pin(async move {
            let path = self.path_for(&artifact.name)?;
            fs::read(path).await.map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    PipelineError::MissingArtifact(artifact.name.clone())
                }
                _ => PipelineError::Io(error),
            })
        })
    }
}

pub trait CheckpointStore: Send + Sync {
    fn put<'a>(
        &'a self,
        key: &'a str,
        value: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), PipelineError>> + Send + 'a>>;

    fn get<'a>(
        &'a self,
        key: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Value>, PipelineError>> + Send + 'a>>;
}

#[derive(Default)]
pub struct MemoryCheckpointStore {
    checkpoints: AsyncMutex<HashMap<String, Value>>,
}

impl CheckpointStore for MemoryCheckpointStore {
    fn put<'a>(
        &'a self,
        key: &'a str,
        value: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), PipelineError>> + Send + 'a>> {
        Box::pin(async move {
            validate_safe_key(key)?;
            self.checkpoints.lock().await.insert(key.to_string(), value);
            Ok(())
        })
    }

    fn get<'a>(
        &'a self,
        key: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Value>, PipelineError>> + Send + 'a>> {
        Box::pin(async move {
            validate_safe_key(key)?;
            Ok(self.checkpoints.lock().await.get(key).cloned())
        })
    }
}

pub struct FileCheckpointStore {
    root: PathBuf,
}

impl FileCheckpointStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path_for(&self, key: &str) -> Result<PathBuf, PipelineError> {
        validate_safe_key(key)?;
        Ok(self.root.join(format!("{key}.json")))
    }
}

impl CheckpointStore for FileCheckpointStore {
    fn put<'a>(
        &'a self,
        key: &'a str,
        value: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), PipelineError>> + Send + 'a>> {
        Box::pin(async move {
            let path = self.path_for(key)?;
            fs::create_dir_all(&self.root).await?;
            let bytes = serde_json::to_vec(&value)?;
            fs::write(path, bytes).await?;
            Ok(())
        })
    }

    fn get<'a>(
        &'a self,
        key: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Value>, PipelineError>> + Send + 'a>> {
        Box::pin(async move {
            let path = self.path_for(key)?;
            let bytes = match fs::read(path).await {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(PipelineError::Io(error)),
            };
            Ok(Some(serde_json::from_slice(&bytes)?))
        })
    }
}

pub async fn map_concurrent<I, F, Fut, T, E>(
    limit: usize,
    items: Vec<I>,
    map_item: F,
) -> Result<Vec<T>, E>
where
    F: Fn(I) -> Fut + Send + Sync,
    Fut: Future<Output = Result<T, E>> + Send,
    I: Send,
    T: Send,
    E: From<PipelineError> + Send,
{
    if limit == 0 {
        return Err(PipelineError::InvalidConcurrencyLimit.into());
    }

    let mut indexed = stream::iter(items.into_iter().enumerate())
        .map(|(index, item)| {
            let future = map_item(item);
            async move { (index, future.await) }
        })
        .buffer_unordered(limit)
        .collect::<Vec<_>>()
        .await;

    indexed.sort_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, result)| result)
        .collect::<Result<Vec<_>, _>>()
}

#[derive(Debug)]
pub enum PipelineError {
    Cancelled,
    InvalidConcurrencyLimit,
    InvalidKey(String),
    MissingArtifact(String),
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl Display for PipelineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("pipeline run cancelled"),
            Self::InvalidConcurrencyLimit => {
                formatter.write_str("pipeline concurrency limit must be greater than zero")
            }
            Self::InvalidKey(key) => write!(formatter, "invalid pipeline key: {key}"),
            Self::MissingArtifact(name) => write!(formatter, "missing pipeline artifact: {name}"),
            Self::Io(error) => write!(formatter, "pipeline I/O error: {error}"),
            Self::Json(error) => write!(formatter, "pipeline JSON error: {error}"),
        }
    }
}

impl Error for PipelineError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for PipelineError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for PipelineError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

fn validate_safe_key(key: &str) -> Result<(), PipelineError> {
    let is_safe = !key.is_empty()
        && key != "."
        && key != ".."
        && !key.contains("..")
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        });
    if is_safe && Path::new(key).file_name().and_then(|name| name.to_str()) == Some(key) {
        Ok(())
    } else {
        Err(PipelineError::InvalidKey(key.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use serde_json::json;

    use super::*;

    #[derive(Debug)]
    enum TestError {
        Pipeline(PipelineError),
        Business(&'static str),
    }

    impl Display for TestError {
        fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Pipeline(error) => Display::fmt(error, formatter),
                Self::Business(error) => formatter.write_str(error),
            }
        }
    }

    impl From<PipelineError> for TestError {
        fn from(error: PipelineError) -> Self {
            Self::Pipeline(error)
        }
    }

    #[tokio::test]
    async fn step_emits_terminal_progress_without_swallowing_error() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let context = PipelineContext::in_memory(
            "run-1",
            Arc::new(move |event| captured.lock().expect("events lock").push(event)),
        );

        let output = context
            .step("load", |_| Box::pin(async { Ok::<_, TestError>(7) }))
            .await
            .expect("step should complete");
        assert_eq!(output, 7);

        let error = context
            .step("fail", |_| {
                Box::pin(async { Err::<(), _>(TestError::Business("boom")) })
            })
            .await
            .expect_err("business error should pass through");
        assert!(matches!(error, TestError::Business("boom")));

        context.cancel();
        let cancelled = context
            .step("cancelled", |_| Box::pin(async { Ok::<_, TestError>(()) }))
            .await
            .expect_err("cancelled step should fail before work");
        assert!(matches!(
            cancelled,
            TestError::Pipeline(PipelineError::Cancelled)
        ));

        let stages = events
            .lock()
            .expect("events lock")
            .iter()
            .map(|event| event.stage.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            stages,
            vec![
                ProgressStage::Started,
                ProgressStage::Completed,
                ProgressStage::Started,
                ProgressStage::Failed {
                    error: "boom".to_string()
                },
                ProgressStage::Cancelled,
            ]
        );
    }

    #[tokio::test]
    async fn stores_roundtrip_and_reject_unsafe_file_keys() {
        let artifacts = MemoryArtifactStore::default();
        let artifact = artifacts
            .put("artifact-1", b"large text".to_vec())
            .await
            .expect("artifact write");
        assert_eq!(
            artifacts.get(&artifact).await.expect("artifact read"),
            b"large text"
        );

        let checkpoints = MemoryCheckpointStore::default();
        checkpoints
            .put("state", json!({ "cursor": 3 }))
            .await
            .expect("checkpoint write");
        assert_eq!(
            checkpoints.get("state").await.expect("checkpoint read"),
            Some(json!({ "cursor": 3 }))
        );

        let root =
            std::env::temp_dir().join(format!("matcha-pipeline-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root).await;
        let file_artifacts = FileArtifactStore::new(root.join("artifacts"));
        let file_checkpoints = FileCheckpointStore::new(root.join("checkpoints"));

        let artifact = file_artifacts
            .put("artifact.txt", b"file text".to_vec())
            .await
            .expect("file artifact write");
        assert_eq!(
            file_artifacts
                .get(&artifact)
                .await
                .expect("file artifact read"),
            b"file text"
        );
        file_checkpoints
            .put("checkpoint", json!({ "ready": true }))
            .await
            .expect("file checkpoint write");
        assert_eq!(
            file_checkpoints
                .get("checkpoint")
                .await
                .expect("file checkpoint read"),
            Some(json!({ "ready": true }))
        );
        assert!(matches!(
            file_artifacts.put("../escape", Vec::new()).await,
            Err(PipelineError::InvalidKey(_))
        ));
        let _ = fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn map_concurrent_preserves_input_order() {
        let output = map_concurrent(2, vec![3_u64, 1, 2], |item| async move {
            tokio::time::sleep(Duration::from_millis(4 - item)).await;
            Ok::<_, PipelineError>(item * 10)
        })
        .await
        .expect("map should complete");

        assert_eq!(output, vec![30, 10, 20]);
    }
}
