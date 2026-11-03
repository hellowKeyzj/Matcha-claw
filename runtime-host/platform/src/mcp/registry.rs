use std::{
    collections::BTreeMap,
    fmt,
    future::Future,
    pin::Pin,
    sync::{Arc, RwLock},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::watch;

use super::{CallToolResult, ReadResourceResult, ToolCallError, ToolCatalog};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub input_schema: ObjectSchema,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<ObjectSchema>,
    #[serde(flatten)]
    pub attributes: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ObjectSchema {
    #[serde(rename = "type")]
    pub schema_type: ObjectType,
    #[serde(flatten)]
    pub keywords: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjectType {
    Object,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Resource {
    pub uri: String,
    pub name: String,
    #[serde(flatten)]
    pub attributes: Map<String, Value>,
}

#[derive(Clone, Default, Debug, PartialEq)]
pub struct CapabilityCatalog {
    pub tools: Vec<Tool>,
    pub resources: Vec<Resource>,
}

pub type ToolResultFuture<'a> =
    Pin<Box<dyn Future<Output = Result<CallToolResult, ToolCallError>> + Send + 'a>>;
pub type ReadResourceFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ReadResourceResult, ResourceReadError>> + Send + 'a>>;

pub trait CapabilityProvider: Send + Sync {
    fn call_tool<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> ToolResultFuture<'a>;
    fn call_tool_with_meta<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
        _meta: Option<&'a Map<String, Value>>,
    ) -> ToolResultFuture<'a> {
        self.call_tool(name, arguments)
    }
    fn read_resource<'a>(&'a self, uri: &'a str) -> ReadResourceFuture<'a>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceReadError {
    InvalidParams,
    NotFound,
    Internal,
}

#[derive(Debug)]
pub enum RegistryError {
    InvalidTool,
    InvalidResource,
    DuplicateTool(String),
    DuplicateResource(String),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTool => formatter.write_str("MCP tool descriptor is invalid"),
            Self::InvalidResource => formatter.write_str("MCP resource descriptor is invalid"),
            Self::DuplicateTool(name) => write!(formatter, "MCP tool name collision: {name}"),
            Self::DuplicateResource(uri) => write!(formatter, "MCP resource URI collision: {uri}"),
        }
    }
}

impl std::error::Error for RegistryError {}

#[derive(Clone)]
pub struct Registry {
    state: Arc<RwLock<RegistryState>>,
    changes: watch::Sender<CatalogRevision>,
}

struct RegistryState {
    providers: Vec<(Arc<dyn CapabilityProvider>, CapabilityCatalog)>,
    tools: BTreeMap<String, usize>,
    resources: BTreeMap<String, usize>,
}

#[derive(Clone, Copy, Default, PartialEq)]
pub(super) struct CatalogRevision {
    pub tools: u64,
    pub resources: u64,
}

pub struct ProviderRegistration {
    registry: Registry,
    index: usize,
}

impl Registry {
    pub fn new(tools: ToolCatalog) -> Result<Self, RegistryError> {
        let catalog = CapabilityCatalog {
            tools: tools.tools().map_err(|_| RegistryError::InvalidTool)?,
            resources: Vec::new(),
        };
        let registry = Self {
            state: Arc::new(RwLock::new(RegistryState {
                providers: Vec::new(),
                tools: BTreeMap::new(),
                resources: BTreeMap::new(),
            })),
            changes: watch::channel(CatalogRevision::default()).0,
        };
        registry.register(Arc::new(tools), catalog)?;
        Ok(registry)
    }

    pub fn register(
        &self,
        provider: Arc<dyn CapabilityProvider>,
        catalog: CapabilityCatalog,
    ) -> Result<ProviderRegistration, RegistryError> {
        let mut state = self.state.write().expect("MCP registry lock poisoned");
        let index = state.providers.len();
        validate_catalog(&state, index, &catalog)?;
        state
            .providers
            .push((provider, CapabilityCatalog::default()));
        replace_catalog(&mut state, index, catalog, &self.changes);
        Ok(ProviderRegistration {
            registry: self.clone(),
            index,
        })
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<CatalogRevision> {
        self.changes.subscribe()
    }

    pub(super) fn tools(&self) -> Vec<Tool> {
        self.state
            .read()
            .expect("MCP registry lock poisoned")
            .providers
            .iter()
            .flat_map(|(_, catalog)| catalog.tools.clone())
            .collect()
    }

    pub(super) fn resources(&self) -> Vec<Resource> {
        self.state
            .read()
            .expect("MCP registry lock poisoned")
            .providers
            .iter()
            .flat_map(|(_, catalog)| catalog.resources.clone())
            .collect()
    }

    pub(super) async fn call(
        &self,
        name: &str,
        arguments: &Map<String, Value>,
        meta: Option<&Map<String, Value>>,
    ) -> Result<CallToolResult, ToolCallError> {
        let provider = {
            let state = self.state.read().expect("MCP registry lock poisoned");
            state
                .tools
                .get(name)
                .map(|index| Arc::clone(&state.providers[*index].0))
        }
        .ok_or(ToolCallError::InvalidParams)?;
        provider.call_tool_with_meta(name, arguments, meta).await
    }

    pub(super) async fn read(&self, uri: &str) -> Result<ReadResourceResult, ResourceReadError> {
        let provider = {
            let state = self.state.read().expect("MCP registry lock poisoned");
            state
                .resources
                .get(uri)
                .map(|index| Arc::clone(&state.providers[*index].0))
        }
        .ok_or(ResourceReadError::NotFound)?;
        provider.read_resource(uri).await
    }
}

impl ProviderRegistration {
    pub fn replace(&self, catalog: CapabilityCatalog) -> Result<(), RegistryError> {
        let mut state = self
            .registry
            .state
            .write()
            .expect("MCP registry lock poisoned");
        validate_catalog(&state, self.index, &catalog)?;
        replace_catalog(&mut state, self.index, catalog, &self.registry.changes);
        Ok(())
    }
}

fn validate_catalog(
    state: &RegistryState,
    index: usize,
    catalog: &CapabilityCatalog,
) -> Result<(), RegistryError> {
    let mut names = std::collections::BTreeSet::new();
    for tool in &catalog.tools {
        if tool.name.is_empty() {
            return Err(RegistryError::InvalidTool);
        }
        if !names.insert(&tool.name)
            || state
                .tools
                .get(&tool.name)
                .is_some_and(|owner| *owner != index)
        {
            return Err(RegistryError::DuplicateTool(tool.name.clone()));
        }
    }
    let mut uris = std::collections::BTreeSet::new();
    for resource in &catalog.resources {
        if resource.uri.is_empty() || resource.name.is_empty() {
            return Err(RegistryError::InvalidResource);
        }
        if !uris.insert(&resource.uri)
            || state
                .resources
                .get(&resource.uri)
                .is_some_and(|owner| *owner != index)
        {
            return Err(RegistryError::DuplicateResource(resource.uri.clone()));
        }
    }
    Ok(())
}

fn replace_catalog(
    state: &mut RegistryState,
    index: usize,
    catalog: CapabilityCatalog,
    changes: &watch::Sender<CatalogRevision>,
) {
    let previous = &state.providers[index].1;
    let tools_changed = previous.tools != catalog.tools;
    let resources_changed = previous.resources != catalog.resources;
    state.tools.retain(|_, owner| *owner != index);
    state.resources.retain(|_, owner| *owner != index);
    state
        .tools
        .extend(catalog.tools.iter().map(|tool| (tool.name.clone(), index)));
    state.resources.extend(
        catalog
            .resources
            .iter()
            .map(|resource| (resource.uri.clone(), index)),
    );
    state.providers[index].1 = catalog;
    if tools_changed || resources_changed {
        changes.send_modify(|revision| {
            revision.tools = revision.tools.wrapping_add(u64::from(tools_changed));
            revision.resources = revision
                .resources
                .wrapping_add(u64::from(resources_changed));
        });
    }
}
