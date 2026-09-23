mod events;
mod instance;
mod lifecycle;
pub mod runtime_control_route;
mod runtime_driver;

use platform::exchange::InvocationOutcome;
use runtime_directory::{
    LifecycleOps, OwnedRuntimeFuture, RuntimeCapabilitySurface, RuntimeDriverIdentity,
};
use sessions_module::trace as session_trace;
use sessions_module::{
    SessionOps,
    abort::{SessionAbortCommand, SessionAbortOutcome},
    approval::{
        PendingApproval, PendingApprovals, PendingApprovalsCommand, PendingApprovalsOutcome,
        SessionApprovalCommand, SessionApprovalOutcome,
    },
    command::SessionIngressEvent,
    create::{SessionAdmission, SessionCreateCommand, SessionCreateOutcome, project_matcha_create},
    model_selection::{
        MatchaSessionModelRuntimeCommand, ResolvedSessionModelSelection,
        SessionModelSelectionBinding, SessionModelSelectionOutcome, SessionModelSelectionRejection,
    },
    send::{SessionSendCommand, SessionSendOutcome, SessionSendStatus},
    session_catalog::{
        SessionCatalog, SessionCatalogCommand, SessionCatalogEntry, SessionCatalogOutcome,
    },
    session_history::{
        SessionHistoryCommand, SessionHistoryFailure, SessionHistoryMessage, SessionHistoryOutcome,
        SessionHistoryRole, SessionHistoryView,
    },
    session_permission::{SessionPermissionCommand, SessionPermissionOutcome},
    timeline,
};
use tokio::sync::mpsc;

use crate::{
    peer::MatchaPeerSessionHandle,
    session::{
        canonical::CanonicalSessionAssembler,
        history::HistoryResult,
        hydration::{
            HydratedMessageRole, HydrationSnapshot, HydrationWindowMode, HydrationWindowRequest,
        },
        model::{RunId, SessionId},
    },
};

pub use events::{matcha_event_changes, matcha_session_event};
pub use instance::{MatchaAgentInput, MatchaAgentInstance, MatchaRuntimeDriver, build_peer};
