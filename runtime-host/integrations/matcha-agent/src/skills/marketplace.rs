use std::{path::PathBuf, sync::{Arc, atomic::{AtomicU64, Ordering}}, time::{SystemTime, UNIX_EPOCH}};

use clawhub::{ClawHubCliInstaller, ClawHubInstallRequest};
use foundation::process::OneShotContainment;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{ResourceError, Skills};

static NEXT_DOWNLOAD: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct Marketplace {
    config: Arc<Config>,
}

struct Config {
    electron_image: PathBuf,
    cli_entries: Vec<PathBuf>,
    registries: Vec<String>,
    staging_root: PathBuf,
    containment: OneShotContainment,
}

impl Marketplace {
    pub fn new(electron_image: PathBuf, cli_entries: Vec<PathBuf>, registries: Vec<String>, staging_root: PathBuf, containment: OneShotContainment) -> Self {
        Self {config:Arc::new(Config {electron_image,cli_entries,registries,staging_root,containment})}
    }

    pub(super) async fn install(&self, skills: &Skills, agent: &str, slug: String, version: Option<String>, replace: bool, cancellation: &CancellationToken) -> Result<(), ResourceError> {
        let request = ClawHubInstallRequest::try_new(slug.clone(), version, false).map_err(|_| ResourceError::Rejected)?;
        if self.config.registries.is_empty() || cancellation.is_cancelled() { return Err(ResourceError::Unavailable); }
        tokio::fs::create_dir_all(&self.config.staging_root).await.map_err(|_| ResourceError::Unavailable)?;
        let root = tokio::fs::canonicalize(&self.config.staging_root).await.map_err(|_| ResourceError::Unavailable)?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| ResourceError::Unavailable)?.as_nanos();
        let directory = root.join(format!("{stamp}-{}", NEXT_DOWNLOAD.fetch_add(1,Ordering::Relaxed)));
        tokio::fs::create_dir(&directory).await.map_err(|_| ResourceError::Unavailable)?;
        let installer = ClawHubCliInstaller::new(self.config.electron_image.clone(),directory.clone(),self.config.cli_entries.clone(),self.config.registries.clone()).with_containment(self.config.containment.clone());
        let result = async {
            installer.install_cancellable(request, cancellation.clone()).await.map_err(|_| ResourceError::Unavailable)?;
            if cancellation.is_cancelled() { return Err(ResourceError::Unavailable); }
            let source = directory.join("skills").join(&slug);
            let path = source.to_str().ok_or(ResourceError::Rejected)?;
            skills.install_source(agent,&slug,json!({"type":"local","path":path}),replace,cancellation).await?;
            Ok(())
        }.await;
        let cleanup = tokio::fs::remove_dir_all(&directory).await;
        match (result,cleanup) {
            (Ok(()),Ok(())) => Ok(()),
            (Err(error),_) => Err(error),
            (Ok(()),Err(_)) => Err(ResourceError::Unknown),
        }
    }
}
