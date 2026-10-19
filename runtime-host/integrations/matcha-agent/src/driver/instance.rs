use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use foundation::process::{ShutdownOutcome, supervision::SupervisorSnapshot};
use sessions_module::command::SessionIngressEvent;
use tokio::sync::mpsc;
use toolchain::NativeToolchain;

use crate::{
    lifecycle::{output::StartupDiagnosticCategory, secret::Secret},
    peer::{
        ConstructionError, MatchaPeer, MatchaPeerFactory, MatchaPeerInput,
        MatchaPeerLifecycleHandle, MatchaPeerSessionHandle,
    },
};

pub struct MatchaAgentInstance {
    peer: Option<MatchaPeer>,
    driver: MatchaRuntimeDriver,
}

#[derive(Clone)]
pub struct MatchaRuntimeDriver {
    lifecycle: MatchaPeerLifecycleHandle,
    pub(crate) search: crate::search::OfflineControl,
    session: MatchaPeerSessionHandle,
    channels: crate::channels::Channels,
    skill_marketplace: Option<crate::skills::Marketplace>,
    sealed_reader_source: Arc<OnceLock<crate::sealed::ReaderSource>>,
    renderer_events: Option<mpsc::Sender<SessionIngressEvent>>,
}

impl MatchaRuntimeDriver {
    fn new(peer: &MatchaPeer) -> Self {
        Self {
            lifecycle: peer.lifecycle_handle(),
            search: peer.search_control(),
            session: peer.session_handle(),
            channels: crate::channels::Channels::new(peer.native_client()),
            skill_marketplace: None,
            sealed_reader_source: Arc::new(OnceLock::new()),
            renderer_events: None,
        }
    }

    pub fn lifecycle_handle(&self) -> MatchaPeerLifecycleHandle {
        self.lifecycle.clone()
    }

    pub fn session_handle(&self) -> MatchaPeerSessionHandle {
        self.session.clone()
    }

    pub fn native_client(&self) -> crate::client::Client {
        self.session.native_client()
    }

    pub fn native_channels(&self) -> &crate::channels::Channels {
        &self.channels
    }

    pub fn native_skills(&self) -> crate::skills::Skills {
        let skills = crate::skills::Skills::new(self.native_client());
        match &self.skill_marketplace {
            Some(marketplace) => skills.with_marketplace(marketplace.clone()),
            None => skills,
        }
    }

    pub fn set_sealed_reader_source(
        &self,
        source: crate::sealed::ReaderSource,
    ) -> Result<(), crate::sealed::ReaderSource> {
        self.sealed_reader_source.set(source)
    }

    pub fn sealed_reader_source(&self) -> Option<&crate::sealed::ReaderSource> {
        self.sealed_reader_source.get()
    }

    pub fn renderer_events(&self) -> Option<mpsc::Sender<SessionIngressEvent>> {
        self.renderer_events.clone()
    }

    pub fn advance_source_epoch(&self) -> u64 {
        self.lifecycle.advance_source_epoch()
    }
}

impl MatchaAgentInstance {
    pub fn new(peer: MatchaPeer) -> Self {
        let driver = MatchaRuntimeDriver::new(&peer);
        Self {
            peer: Some(peer),
            driver,
        }
    }

    pub fn with_skill_marketplace(mut self, marketplace: crate::skills::Marketplace) -> Self {
        self.driver.skill_marketplace = Some(marketplace);
        self
    }

    pub fn runtime_driver(&self) -> Arc<MatchaRuntimeDriver> {
        Arc::new(self.driver.clone())
    }

    pub fn set_renderer_events(
        &mut self,
        renderer_events: Option<mpsc::Sender<SessionIngressEvent>>,
    ) {
        self.driver.renderer_events = renderer_events;
    }

    fn peer(&self) -> &MatchaPeer {
        self.peer
            .as_ref()
            .expect("matcha peer must be present before shutdown completes")
    }

    pub fn peer_if_present(&self) -> Option<&MatchaPeer> {
        self.peer.as_ref()
    }

    pub fn take_peer(&mut self) -> MatchaPeer {
        self.peer
            .take()
            .expect("matcha peer must be present before shutdown completes")
    }

    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.peer().snapshot()
    }

    pub async fn confirm_shutdown(&self) -> Result<ShutdownOutcome, crate::peer::ShutdownError> {
        self.peer().confirm_shutdown().await
    }
}

pub struct MatchaAgentInput {
    pub server_executable: PathBuf,
    pub cli_executable: PathBuf,
    pub cli_args: Vec<String>,
    pub working_directory: PathBuf,
    pub storage_root: PathBuf,
    pub port: u16,
    #[cfg(windows)]
    pub git_bash: PathBuf,
    #[cfg(unix)]
    pub guardian_executable: PathBuf,
}

pub fn build_peer(
    input: MatchaAgentInput,
    secret: Secret,
    toolchain: Arc<NativeToolchain>,
    report_diagnostic: Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync>,
) -> Result<MatchaPeer, ConstructionError> {
    Ok(MatchaPeerFactory::try_new(
        MatchaPeerInput {
            server_executable: input.server_executable,
            cli_executable: input.cli_executable,
            cli_args: input.cli_args,
            working_directory: input.working_directory,
            storage_root: input.storage_root,
            port: input.port,
            toolchain,
            report_diagnostic,
            #[cfg(windows)]
            git_bash: input.git_bash,
            #[cfg(unix)]
            guardian_executable: input.guardian_executable,
        },
        secret,
    )?
    .build())
}
