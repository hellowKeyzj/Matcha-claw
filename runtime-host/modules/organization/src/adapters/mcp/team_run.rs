use platform::mcp::ToolCallOutcome;
use serde_json::{Map, Value};

/// The stdio adapter submits all Team operations to the Host's single Organization owner.
pub struct TeamRunMcpFacade {
    call: Box<dyn FnMut(&str, &Map<String, Value>) -> ToolCallOutcome>,
}

impl TeamRunMcpFacade {
    pub fn new(call: impl FnMut(&str, &Map<String, Value>) -> ToolCallOutcome + 'static) -> Self {
        Self {
            call: Box::new(call),
        }
    }

    pub(super) fn call_host(
        &mut self,
        name: &str,
        arguments: &Map<String, Value>,
    ) -> ToolCallOutcome {
        (self.call)(name, arguments)
    }
}
