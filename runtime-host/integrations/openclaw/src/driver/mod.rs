pub mod control;
pub mod directory;
pub mod lifecycle;
pub mod owner;
pub mod runtime_control;
pub mod runtime_control_route;

pub mod adapters;
mod instance;
pub mod ops;
pub mod projection;

use std::{path::PathBuf, sync::Arc};

use channels::{ports::ChannelOps, trace::ChannelTraceSpan};
use connectors::ports::ConnectorOps;
use foundation::process::supervision::{CommandReceipt, SupervisorHandle, SupervisorPhase};
use platform::exchange::InvocationOutcome;
use provider as provider_module;
use provider::ProviderHandle;
use runtime_directory::{OwnedRuntimeFuture, RuntimeDriverIdentity};
use security::ports::SecurityOps;
use serde_json::Value;
use settings::ports::SettingsOps;
use zeroize::Zeroizing;

use crate::{
    lifecycle::logs::LifecycleDiagnostic,
    port::{OpenClawControlReadiness, OpenClawDriverParentCallbackHandle},
};

use crate::operations::channel_config::{channel_trace, current_channel_trace, with_channel_trace};
use sessions_module::{
    SessionOpenOps, SessionOps,
    abort::{SessionAbortCommand, SessionAbortOutcome},
    create::{SessionAdmission, SessionCreateCommand, SessionCreateOutcome},
    delete::{SessionDeleteCommand, SessionDeleteOutcome},
    model_selection::{
        OpenClawPatchRejection, ResolvedSessionModelSelection, SessionModelSelectionBinding,
        SessionModelSelectionOutcome, SessionModelSelectionRejection, SessionRuntimeModelFacts,
    },
    rename::{SessionRenameCommand, SessionRenameOutcome},
    send::{Attachment, SessionSendCommand, SessionSendOutcome},
    session_catalog::{
        SessionCatalog, SessionCatalogCommand, SessionCatalogEntry, SessionCatalogOutcome,
    },
    session_history::{
        SessionHistoryCommand, SessionHistoryFailure, SessionHistoryMessage, SessionHistoryOutcome,
        SessionHistoryRole, SessionHistoryView,
    },
    session_permission::{
        SessionPermissionAction, SessionPermissionCommand, SessionPermissionOutcome,
        SessionPermissionProjection,
    },
};

pub use instance::{ConstructionError, OpenClawDriver, OpenClawInput, PreparedOpenClaw};
pub use owner::{
    PendingSupervisorJoin, SupervisorJoinError, SupervisorLifecycleHandle, SupervisorOwner,
    SupervisorShutdownFailureKind,
};
