mod observed;
mod oracle;
mod plan;
mod policy;

pub use observed::{
    AgentEnrollment, CapabilityFreshness, EndpointHealth, LeaseState, ObservedAgent,
    ObservedCapability, ObservedEndpoint, ObservedFleet, ObservedLease, ObservedRuntime,
    RuntimeLifecycle,
};
pub use oracle::plan_reconciliation;
pub use plan::{
    CapabilityStaleReason, FleetReconcileAction, FleetReconcilePlan, ProbeAgentReason,
    RunningRuntimeProbeReason,
};
pub use policy::{
    CapabilityStaleAfter, DesiredFleetRevision, FleetApplied, FleetDesired, FleetReconcileInput,
    FleetReconcilePolicy,
};

#[cfg(test)]
mod tests;
