use std::{future::Future, pin::Pin};

use serde_json::{Map, Value};

use super::{CallToolResult, CapabilityProvider, ReadResourceFuture, Tool, ToolResultFuture};

// Business facades return their own JSON DTOs; this is their explicit MCP text adapter.
pub trait ToolProvider: Send + Sync {
    fn tools(&self) -> Vec<Value>;
    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> Option<ToolCallFuture<'a>>;
}

pub type ToolCallOutcome = Result<Value, ToolCallError>;
pub type ToolCallFuture<'a> = Pin<Box<dyn Future<Output = ToolCallOutcome> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolCallError {
    InvalidParams,
    Internal,
    Execution(Value),
    ExecutionText(String),
}

pub struct ToolCatalog {
    providers: Vec<Box<dyn ToolProvider>>,
}

impl ToolCatalog {
    pub fn new(providers: Vec<Box<dyn ToolProvider>>) -> Self {
        Self { providers }
    }

    pub(super) fn tools(&self) -> Result<Vec<Tool>, serde_json::Error> {
        self.providers
            .iter()
            .flat_map(|provider| provider.tools())
            .map(serde_json::from_value)
            .collect()
    }
}

impl CapabilityProvider for ToolCatalog {
    fn call_tool<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> ToolResultFuture<'a> {
        Box::pin(async move {
            for provider in &self.providers {
                if let Some(call) = provider.call(name, arguments) {
                    return match call.await {
                        Ok(result) => Ok(CallToolResult::json(result, false)),
                        Err(ToolCallError::Execution(result)) => {
                            Ok(CallToolResult::json(result, true))
                        }
                        Err(ToolCallError::ExecutionText(text)) => Ok(CallToolResult::error(text)),
                        Err(error) => Err(error),
                    };
                }
            }
            Err(ToolCallError::InvalidParams)
        })
    }

    fn read_resource<'a>(&'a self, _uri: &'a str) -> ReadResourceFuture<'a> {
        Box::pin(async { Err(super::ResourceReadError::NotFound) })
    }
}
