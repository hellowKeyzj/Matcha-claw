mod admission;
mod events;
mod host;
mod peer;
pub use crate::runtime::adapters::matcha_agent::{
    ConstructionError as MatchaConstructionError, MatchaAgentInput,
};
pub use crate::runtime::adapters::openclaw::{
    ConstructionError as OpenClawConstructionError, OpenClawInput,
};
pub(crate) use crate::runtime::adapters::openclaw::{
    ControlLease, OpenClawBrowserGatewayRequest, OpenClawGatewayHealthObservation,
    OpenClawGatewayPayload, OpenClawGatewayStatusObservation, OpenClawLogSnapshot,
    OpenClawMcpAppGatewayRequest,
};
pub use crate::sessions::RuntimeSessionError;
pub(crate) use admission::HostAdmission;
pub use admission::{
    HostPhase, HostState as AdmissionState, HostTransitionError, RequestAdmission,
    RequestAdmissionClosed,
};
pub use events::{HostEvent, HostEvents};
pub use host::SessionShutdownFailure;
pub use host::{
    ConstructionError, Host, HostInput, HostShutdownError, OwnerShutdownFailure, RuntimeExit,
    RuntimeLifecycleFailure, RuntimeShutdownFailure, RuntimeShutdownOutcome, RuntimeStartFailure,
    ShutdownFailures, ShutdownReport, WorkspaceBinaryError, WorkspaceListError,
    WorkspaceMediaError, WorkspaceReadError, WorkspaceStatError, WorkspaceWriteError,
};
pub(crate) use peer::{
    PeerHandle, RestartMatchaError, RestartOpenClawError, StartMatchaError, StartOpenClawError,
    StopMatchaError, StopOpenClawError,
};
