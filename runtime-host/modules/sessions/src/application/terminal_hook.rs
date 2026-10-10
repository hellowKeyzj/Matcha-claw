use super::state::{RunPhase, SessionSourceBinding};

pub struct SessionRunTerminalSnapshot {
    pub identity: crate::state::SessionIdentity,
    pub source_binding: SessionSourceBinding,
    pub native_run_id: String,
    pub delivery_context: Option<super::state::SessionDeliveryContext>,
    pub phase: RunPhase,
    pub assistant_texts: Vec<String>,
}

pub trait SessionTerminalHook: Send + Sync {
    fn run_terminal(&self, snapshot: SessionRunTerminalSnapshot);
}
