mod adapters;
mod api;
mod application;
pub mod call;
pub mod delivery;
mod domain;
mod owner;
pub mod ports;
mod projection;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

use api::ConnectorHandle;
use owner::actor::ConnectorOwner;

const MODULE_ID: ModuleId = ModuleId::new("connectors");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("connectors")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.connectors")];
const ROUTES: &[&str] = &["connectors.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use api::ConnectorHandle as ModuleConnectorHandle;
pub use domain::{
    Connector, ConnectorCatalog, ConnectorConfig, ConnectorConfigValue, ConnectorError,
    ConnectorInput, ConnectorKind, ConnectorPublicInput, InvalidConnectorConfig, McpProgramSource,
    McpServerProgram, McpTransport,
};
pub use owner::actor::ConnectorOwnerInput;
pub use ports::{
    ConnectorSecretAuthority, ConnectorSecretAuthorityPortError, ConnectorSecretFact,
    ConnectorSecretFactSource, ConnectorSecretFactSourceError, ConnectorSecretRef,
    ConnectorSecretResolution, ConnectorSecretResolutionMetadata, ConnectorSecretResolverPort,
    ConnectorSecretSourceStatus, ConnectorSecretValue, InvalidConnectorSecretRef,
    InvalidConnectorSecretValue, UnavailableConnectorSecretAuthority,
    unavailable_connector_secret_authority,
};

#[derive(Clone)]
pub struct ConnectorModule {
    handle: ConnectorHandle,
}

impl ConnectorModule {
    fn new(handle: ConnectorHandle) -> Self {
        Self { handle }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.handle = self.handle.with_call_recorder(recorder);
        self
    }

    pub async fn configure_private_resolver(
        &self,
        resolver: Arc<dyn ConnectorSecretResolverPort>,
    ) -> Result<(), ()> {
        self.handle.configure_private_resolver(resolver).await
    }

    pub fn handle(&self) -> &ConnectorHandle {
        &self.handle
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::new(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(self.loopback_descriptor(verifier)),
        )
    }

    fn loopback_descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    ) -> platform::loopback::ModuleDescriptor {
        adapters::loopback::descriptor(adapters::loopback::Dependencies::new(
            verifier,
            self.handle.clone(),
        ))
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: ConnectorOwnerInput,
) -> Result<(ConnectorModule, OwnedTask<()>), ()> {
    let owner = ConnectorOwner::new(input)?;
    let observations = owner.observations();
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(64, ConnectorOwner::lane_retention()),
    );
    Ok((ConnectorModule::new(ConnectorHandle::new(handle, observations)), task))
}
