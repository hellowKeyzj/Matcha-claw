use super::*;

pub(crate) struct MatchaAgentInstance {
    peer: Option<MatchaPeer>,
    pub(super) team: MatchaRuntimeDriver,
}

#[derive(Clone)]
pub(crate) struct MatchaRuntimeDriver {
    pub(super) lifecycle: MatchaPeerLifecycleHandle,
    pub(super) session: MatchaPeerSessionHandle,
    pub(super) prompt: RoleSessionPromptHandle,
    pub(super) native: RoleSessionNativeHandle,
    pub(super) renderer_events: Option<mpsc::Sender<SessionSubscriptionItem>>,
}

impl MatchaRuntimeDriver {
    fn new(peer: &MatchaPeer) -> Self {
        Self {
            lifecycle: peer.lifecycle_handle(),
            session: peer.session_handle(),
            prompt: peer.role_session_prompt_handle(),
            native: peer.role_session_native_handle(),
            renderer_events: None,
        }
    }
}

impl MatchaAgentInstance {
    pub(crate) fn new(peer: MatchaPeer) -> Self {
        let team = MatchaRuntimeDriver::new(&peer);
        Self {
            peer: Some(peer),
            team,
        }
    }

    pub(crate) fn runtime_driver(&self) -> Arc<MatchaRuntimeDriver> {
        Arc::new(self.team.clone())
    }

    pub(crate) fn set_renderer_events(
        &mut self,
        renderer_events: Option<mpsc::Sender<SessionSubscriptionItem>>,
    ) {
        self.team.renderer_events = renderer_events;
    }

    pub(super) fn peer(&self) -> &MatchaPeer {
        self.peer
            .as_ref()
            .expect("matcha peer must be present before shutdown completes")
    }

    pub(crate) fn peer_if_present(&self) -> Option<&MatchaPeer> {
        self.peer.as_ref()
    }

    pub(crate) fn take_peer(&mut self) -> MatchaPeer {
        self.peer
            .take()
            .expect("matcha peer must be present before shutdown completes")
    }

    pub(crate) fn snapshot(&self) -> SupervisorSnapshot {
        self.peer().snapshot()
    }

    pub(crate) async fn confirm_shutdown(
        &self,
    ) -> Result<ShutdownOutcome, ::matcha_agent::peer::ShutdownError> {
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

pub(crate) fn build_peer(
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
