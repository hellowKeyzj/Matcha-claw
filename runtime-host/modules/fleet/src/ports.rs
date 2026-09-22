pub use foundation::execution::OwnerSpec as FleetOwnerSpec;

pub use crate::domain::ports::{
    FleetDispatchOutcome, FleetDispatchPort, FleetDispatchReadbackError, FleetDispatchRequest,
    FleetDispatchRequestError, FleetDispatchTarget, FleetSecretResolution, FleetSecretResolverPort,
    FleetTopologyPort, FleetTopologySnapshot,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FleetRequestAdmissionClosed;

pub trait FleetRequestAdmission: Clone + Send + Sync + 'static {
    fn ensure_open(&self) -> Result<(), FleetRequestAdmissionClosed>;
}
