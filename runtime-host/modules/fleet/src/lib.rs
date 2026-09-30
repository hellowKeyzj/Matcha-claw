mod adapters;
mod api;
mod application;
mod call;
mod domain;
mod events;
mod owner;
pub mod ports;
mod projection;
pub mod store;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

const MODULE_ID: ModuleId = ModuleId::new("fleet");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("fleet")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.fleet")];
const ROUTES: &[&str] = &["fleet.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub mod runtime_agent_ingress {
    pub use crate::adapters::runtime_agent_ingress::*;
}

pub mod terminal_stream {
    pub use crate::adapters::terminal_stream::*;
}

pub use api::{FleetModule, FleetOwnerInput};
pub use application::delivery::{
    FleetDeliveryError, FleetDeliveryOutcome, FleetDeliveryOwner, FleetDeliveryRequest,
    FleetSubmitOutcome,
};
pub use domain::{
    audit, command, connection, effect, environment, lease, outbox, query, reachability, reconcile,
    runtime_agent, secret_ref, selector, ssh_authority, target, terminal, topology,
};
pub use owner::handle::FleetHandle;
pub use ports::{
    FleetDispatchOutcome, FleetDispatchPort, FleetDispatchReadbackError, FleetDispatchRequest,
    FleetDispatchRequestError, FleetDispatchTarget, FleetOwnerSpec, FleetRequestAdmission,
    FleetRequestAdmissionClosed, FleetSecretResolution, FleetSecretResolverPort, FleetTopologyPort,
    FleetTopologySnapshot,
};
pub use secret_ref::FleetSecretRef;
pub use ssh_authority::{
    SshHostKeyAuthority, SshHostKeyAuthorityDocument, SshHostKeyAuthorityError,
    SshHostKeyAuthorityInput, SshHostKeyAuthorityRecord, SshHostKeyAuthorityState,
};
pub use target::{
    CustomTargetConfig, CustomTerminalConfig, CustomTerminalTransport, DockerTargetConfig,
    FleetTargetBindingError, FleetTargetConfig, FleetTargetConfigError, FleetTargetSelector,
    KubernetesTargetConfig, RuntimeAgentEndpointConfig, SshAuthentication, SshTargetConfig,
    TargetEndpointBinding, TargetId, TargetKind, TargetSnapshot,
};

impl FleetModule {
    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::new(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(adapters::loopback::descriptor(
                adapters::loopback::Dependencies::new(verifier, self.handle().clone()),
            )),
        )
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: FleetOwnerInput,
) -> Result<(FleetModule, OwnedTask<()>), ()> {
    let owner = owner::actor::FleetOwner::open(
        input.facts_path,
        input.private_root,
        input.docker_ownership,
        input.ssh_host_keys,
    )?;
    let startup_dispatches = owner.pending_dispatches();
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(input.mailbox_capacity, input.lane_retention),
    );
    Ok((
        FleetModule::new(FleetHandle::new(handle), startup_dispatches),
        task,
    ))
}
