pub mod app;
mod composition;
mod control;
mod host_actor;
mod http;
mod mcp;
mod module_registry;
mod parent_callback;
mod public_string;

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
pub use mcp::{MatchaMcpConstructionError, run_matcha_mcp};
pub use organization::{
    TeamDecisionCompositionError, TeamDecisionFacade, TeamDecisionReceiptProjection,
    TeamDecisionRequest, TeamGraphContextOutcome, TeamGraphContextRequest,
    TeamGraphContextRequestView, TeamGraphPatchCommand, TeamNodeEventCommand,
    TeamNodeEventCommandKind, TeamNodeEventOutcome, TeamRunMcpError, TeamRunMcpFacade,
    open_organization_store,
};
pub use provider_module::{Resolver as ProviderCredentialResolver, ResolverConfigurationError};
