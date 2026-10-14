pub mod app;
mod composition;
mod control;
mod host_actor;
mod http;
pub mod mcp;
mod module_registry;
mod parent_callback;

pub use ::diagnostics::{
    HostLifecycle, HostState, RuntimeFailure, RuntimeLifecycle, RuntimeObservationConfig,
    RuntimeObservationMode, RuntimeState,
};
pub use app::{AppInput, run_app_service};
pub use composition::{
    AdmissionState, ConstructionError, Host, HostEvent, HostEvents, HostInput, HostPhase,
    HostShutdownError, HostTransitionError, MatchaAgentInput, MatchaConstructionError,
    OpenClawConstructionError, OpenClawInput, OwnerShutdownFailure, RequestAdmission,
    RequestAdmissionClosed, RuntimeExit, RuntimeLifecycleFailure, RuntimeSessionError,
    RuntimeShutdownFailure, RuntimeShutdownOutcome, RuntimeStartFailure, SessionShutdownFailure,
    ShutdownFailures, ShutdownReport,
};
pub use control::ControlError;
pub use organization::{TeamRunMcpFacade, open_organization_store};
pub use provider_module::{Resolver as ProviderCredentialResolver, ResolverConfigurationError};
