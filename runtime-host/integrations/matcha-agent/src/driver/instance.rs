use std::{path::PathBuf, sync::Arc};

use foundation::process::{ShutdownOutcome, supervision::SupervisorSnapshot};
use sessions_module::command::SessionIngressEvent;
use tokio::sync::mpsc;
use toolchain::NativeToolchain;

use crate::{
    lifecycle::{output::StartupDiagnosticCategory, secret::Secret},
    peer::{
        ConstructionError, MatchaPeer, MatchaPeerFactory, MatchaPeerInput,
        MatchaPeerLifecycleHandle, MatchaPeerSessionHandle, RoleSessionNativeHandle,
    },
};

pub struct MatchaAgentInstance {
    peer: Option<MatchaPeer>,
    driver: MatchaRuntimeDriver,
}

#[derive(Clone)]
pub struct MatchaRuntimeDriver {
    lifecycle: MatchaPeerLifecycleHandle,
    session: MatchaPeerSessionHandle,
    native: RoleSessionNativeHandle,
    renderer_events: Option<mpsc::Sender<SessionIngressEvent>>,
}

impl MatchaRuntimeDriver {
    fn new(peer: &MatchaPeer) -> Self {
        Self {
            lifecycle: peer.lifecycle_handle(),
            session: peer.session_handle(),
            native: peer.role_session_native_handle(),
            renderer_events: None,
        }
    }

    pub fn lifecycle_handle(&self) -> MatchaPeerLifecycleHandle {
        self.lifecycle.clone()
    }

    pub fn session_handle(&self) -> MatchaPeerSessionHandle {
        self.session.clone()
    }

    pub fn native_handle(&self) -> RoleSessionNativeHandle {
        self.native.clone()
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
    pub bun_executable: PathBuf,
    pub entry: PathBuf,
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
            bun_executable: input.bun_executable,
            entry: input.entry,
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
