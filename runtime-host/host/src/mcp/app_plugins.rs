use std::{path::PathBuf, sync::Arc, time::Duration};

use platform::mcp::{
    CallToolResult, CapabilityCatalog, CapabilityProvider, ProviderRegistration,
    ReadResourceFuture, Registry, ToolCallError, ToolResultFuture,
};
use serde_json::{Map, Value};

mod gateway;
use gateway::Gateway;

pub(super) struct AppPlugins {
    watch: tokio::task::JoinHandle<()>,
}

impl AppPlugins {
    pub(super) async fn attach(state_dir: PathBuf, registry: &Registry) -> Result<Self, ()> {
        let gateway = Arc::new(Gateway::new(state_dir)?);
        let (catalog, current) = match gateway.discovery().map_err(|_| ())? {
            Some(discovery) => {
                let catalog = gateway.catalog(&discovery, None).await?.ok_or(())?;
                (
                    CapabilityCatalog {
                        tools: catalog.tools,
                        resources: catalog.resources,
                    },
                    Some((discovery.identity, catalog.revision)),
                )
            }
            None => (CapabilityCatalog::default(), None),
        };
        let registration = registry
            .register(gateway.clone(), catalog)
            .map_err(|error| {
                eprintln!("runtime-host mcp: {error}");
            })?;
        let watch = tokio::spawn(observe(gateway, registration, current));
        Ok(Self { watch })
    }
}

impl Drop for AppPlugins {
    fn drop(&mut self) {
        self.watch.abort();
    }
}

impl CapabilityProvider for Gateway {
    fn call_tool<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> ToolResultFuture<'a> {
        Box::pin(async move {
            match self.call(name, arguments).await {
                Err(ToolCallError::ExecutionText(text)) => Ok(CallToolResult::error(text)),
                result => result,
            }
        })
    }

    fn read_resource<'a>(&'a self, uri: &'a str) -> ReadResourceFuture<'a> {
        Box::pin(self.read(uri))
    }
}

async fn observe(
    gateway: Arc<Gateway>,
    registration: ProviderRegistration,
    mut current: Option<(String, String)>,
) {
    let mut reported_unavailable = false;
    loop {
        let discovery = gateway.discovery();
        let response = match &discovery {
            Ok(Some(discovery)) => {
                let revision = current
                    .as_ref()
                    .filter(|(identity, _)| identity == &discovery.identity)
                    .map(|(_, revision)| revision.as_str());
                gateway.catalog(discovery, revision).await
            }
            Ok(None) | Err(_) => Err(()),
        };
        match (discovery, response) {
            (Ok(Some(discovery)), Ok(Some(catalog))) => {
                current = publish(&registration, discovery.identity, catalog);
                reported_unavailable = false;
            }
            (Ok(Some(_)), Ok(None)) => {
                reported_unavailable = false;
                continue;
            }
            (Ok(None), _) if current.is_none() => {}
            (Err(error), _)
                if error.kind() == std::io::ErrorKind::NotFound && current.is_none() => {}
            _ => {
                if !reported_unavailable {
                    eprintln!(
                        "runtime-host mcp: app plugin catalog unavailable; dynamic capabilities withdrawn"
                    );
                    reported_unavailable = true;
                }
                let _ = registration.replace(CapabilityCatalog::default());
                current = None;
            }
        }
        // Missing/failed gateways are rediscovered; calls and their side effects are never retried.
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn publish(
    registration: &ProviderRegistration,
    identity: String,
    catalog: gateway::Catalog,
) -> Option<(String, String)> {
    match registration.replace(CapabilityCatalog {
        tools: catalog.tools,
        resources: catalog.resources,
    }) {
        Ok(()) => Some((identity, catalog.revision)),
        Err(error) => {
            eprintln!("runtime-host mcp: {error}; app plugin catalog rejected");
            let _ = registration.replace(CapabilityCatalog::default());
            None
        }
    }
}
