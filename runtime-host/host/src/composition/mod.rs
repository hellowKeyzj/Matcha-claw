mod admission;
mod events;
pub(crate) mod host;
mod peer;
pub(crate) mod runtime_ports;
pub(crate) use admission::HostAdmission;
pub use admission::{
    HostPhase, HostState as AdmissionState, HostTransitionError, RequestAdmission,
    RequestAdmissionClosed,
};
pub use events::{HostEvent, HostEvents};
pub(crate) use host::HostHandles;
pub use host::SessionShutdownFailure;
pub use host::{
    ConstructionError, Host, HostInput, HostShutdownError, OwnerShutdownFailure, RuntimeExit,
    RuntimeLifecycleFailure, RuntimeShutdownFailure, RuntimeShutdownOutcome, RuntimeStartFailure,
    ShutdownFailures, ShutdownReport,
};
pub use matcha_agent::{
    driver::MatchaAgentInput, peer::ConstructionError as MatchaConstructionError,
};
pub(crate) use openclaw::driver::control::{
    OpenClawControlSnapshotObservation, OpenClawGatewayHealthObservation,
    OpenClawGatewaySnapshotObservation, OpenClawGatewayStatusObservation, OpenClawLogSnapshot,
};
pub use openclaw::driver::{ConstructionError as OpenClawConstructionError, OpenClawInput};
pub(crate) use peer::{
    PeerHandle, RuntimeRestartCommandError, RuntimeStartCommandError, RuntimeStopCommandError,
};
pub use sessions_module::RuntimeSessionError;
