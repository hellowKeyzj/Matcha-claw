mod codec;
mod durable;
mod facts;
mod fault;

pub use crate::connection::{ConnectionMutation, ConnectionMutationError, ProbeOutcome};
pub use crate::environment::{
    EnvironmentMutation, EnvironmentMutationError, ManagedResourceMutation,
};
pub use durable::{
    AgentIngressIdentity, FleetStore, IngressAuthentication, IngressCredential, IngressEnrollment,
};
pub(crate) use facts::TargetMatchError;
pub use facts::{FleetFacts, FleetFactsError, FleetFactsRestoreInput};
pub use fault::StoreFault;

#[cfg(test)]
mod tests;
