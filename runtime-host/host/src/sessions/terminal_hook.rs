use super::state::{RunPhase, SessionProvider, SessionSourceBinding};

pub(crate) struct SessionRunTerminalSnapshot {
    pub(crate) provider: SessionProvider,
    pub(crate) session_key: String,
    pub(crate) route_key: Option<String>,
    pub(crate) source_binding: SessionSourceBinding,
    pub(crate) native_run_id: String,
    pub(crate) phase: RunPhase,
    pub(crate) final_assistant_text: Option<String>,
}

pub(crate) trait SessionTerminalHook: Send + Sync {
    fn run_terminal(&self, snapshot: SessionRunTerminalSnapshot);
}
