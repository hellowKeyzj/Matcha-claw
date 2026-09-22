mod codec;
mod durable;
mod facts;
mod fault;

pub use durable::{AgentIngressIdentity, FleetStore, IngressAuthentication};
pub(crate) use facts::TargetMatchError;
pub use facts::{FleetFacts, FleetFactsError, FleetFactsRestoreInput};
pub use fault::StoreFault;

#[cfg(test)]
mod tests;
