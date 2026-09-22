use super::state::{RunPhase, SessionProvider, SessionSourceBinding};

pub struct SessionRunTerminalSnapshot {
    pub provider: SessionProvider,
    pub session_key: String,
    pub route_key: Option<String>,
    pub source_binding: SessionSourceBinding,
    pub native_run_id: String,
    pub phase: RunPhase,
    pub final_assistant_text: Option<String>,
}

pub trait SessionTerminalHook: Send + Sync {
    fn run_terminal(&self, snapshot: SessionRunTerminalSnapshot);
}
