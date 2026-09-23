use platform::exchange::InvocationOutcome;
use runtime_directory::RuntimeDriverIdentity;
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
    timeline as session_timeline,
};
use tokio::sync::mpsc;

use crate::{
    driver::MatchaRuntimeDriver,
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

mod model;
mod runtime;
mod timeline;
