use std::{path::PathBuf, sync::Arc};

use foundation::process::{
    ShutdownOutcome,
    supervision::{RestartOutcome, StartOutcome, SupervisorSnapshot, TerminationCompletion},
};
use platform::exchange::InvocationOutcome;
use tokio::sync::mpsc;
use toolchain::NativeToolchain;

use ::matcha_agent::{
    lifecycle::{output::StartupDiagnosticCategory, secret::Secret},
    peer::{
        LifecycleError as MatchaLifecycleError, MatchaPeer, MatchaPeerFactory, MatchaPeerInput,
        MatchaPeerLifecycleHandle, MatchaPeerSessionHandle, RoleSessionNativeHandle,
        RoleSessionPromptHandle, SessionSubscriptionItem,
    },
    session::{
        client::AppServerClientError,
        history::HistoryResult,
        hydration::{HydrationWindowMode, HydrationWindowRequest},
        model::{RunId, SessionId},
    },
    team::{abort_role_sessions, delete_role_sessions, deliver_prompt, deliver_prompt_with_handle},
};

pub use ::matcha_agent::peer::ConstructionError;

use crate::{
    runtime::driver::{
        LifecycleOps, OwnedRuntimeFuture, RuntimeCapabilitySurface, RuntimeDriver,
        RuntimeDriverIdentity, SessionOps, TeamOps, TeamTerminalOps,
    },
    sessions::abort::{SessionAbortCommand, SessionAbortOutcome},
    sessions::approval::{
        PendingApproval, PendingApprovals, PendingApprovalsCommand, PendingApprovalsOutcome,
        SessionApprovalCommand, SessionApprovalOutcome,
    },
    sessions::create::{
        SessionAdmission, SessionCreateCommand, SessionCreateOutcome, project_matcha_create,
    },
    sessions::model_selection::{
        ResolvedSessionModelSelection, SessionModelSelectionBinding, SessionModelSelectionOutcome,
        SessionModelSelectionRejection,
    },
    sessions::send::{SessionSendCommand, SessionSendOutcome, SessionSendStatus},
    sessions::session_permission::{SessionPermissionCommand, SessionPermissionOutcome},
    sessions::timeline,
    transport::sessions::trace as session_trace,
};

pub(crate) mod adapters;
mod driver;
mod instance;
pub(crate) mod ops;
pub(crate) mod owner;

pub use instance::MatchaAgentInput;
pub(crate) use instance::{MatchaAgentInstance, MatchaRuntimeDriver, build_peer};
