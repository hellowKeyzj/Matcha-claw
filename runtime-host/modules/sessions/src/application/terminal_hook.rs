use super::state::{RunPhase, SessionSourceBinding};

pub struct SessionRunTerminalSnapshot {
    pub identity: crate::state::SessionIdentity,
    pub source_binding: SessionSourceBinding,
    pub native_run_id: String,
    pub delivery_context: Option<super::state::SessionDeliveryContext>,
    pub phase: RunPhase,
    pub final_assistant_text: Option<String>,
}

pub trait SessionTerminalHook: Send + Sync {
    fn run_terminal(&self, snapshot: SessionRunTerminalSnapshot);
}
