mod codec;
mod durable;
mod facts;
mod fault;

pub(crate) use durable::FleetStore;
pub use durable::{
    AgentIngressIdentity, IngressAuthentication, IngressCredential, IngressEnrollment,
};
pub(crate) use facts::{FleetFacts, FleetFactsRestoreInput, TargetMatchError};
pub use facts::FleetFactsError;
pub use fault::StoreFault;

#[cfg(test)]
mod tests;
