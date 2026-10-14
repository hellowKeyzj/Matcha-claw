use platform::mcp::{ToolCallError, ToolCallFuture, ToolCallOutcome};
use serde_json::{Map, Value};

/// The stdio adapter submits all Team operations to the Host's single Organization owner.
pub struct TeamRunMcpFacade {
    call: Box<dyn for<'a> Fn(&'a str, &'a Map<String, Value>) -> ToolCallFuture<'a> + Send + Sync>,
}

impl TeamRunMcpFacade {
    pub fn new(
        call: Box<dyn for<'a> Fn(&'a str, &'a Map<String, Value>) -> ToolCallFuture<'a> + Send + Sync>,
    ) -> Self {
        Self { call }
    }

    pub(super) async fn call_host(
        &self,
        name: &str,
        arguments: &Map<String, Value>,
    ) -> ToolCallOutcome {
        let result = (self.call)(name, arguments).await?;
        if result.get("success").and_then(Value::as_bool) == Some(false) {
            Err(ToolCallError::Execution(result))
        } else {
            Ok(result)
        }
    }
}
