use std::{path::PathBuf, sync::Arc};

use ::security::ports::SecurityOps;
use ::settings::ports::SettingsOps;
use channels::{ports::ChannelOps, trace::ChannelTraceSpan};
use connectors::ports::ConnectorOps;
use foundation::process::supervision::{CommandReceipt, SupervisorHandle, SupervisorPhase};
use platform::exchange::InvocationOutcome;
use provider as provider_module;
use provider::ProviderHandle;
use runtime_directory::{OwnedRuntimeFuture, RuntimeDriverIdentity};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::{
    driver::OpenClawDriver,
    lifecycle::logs::LifecycleDiagnostic,
    port::{OpenClawControlReadiness, OpenClawDriverParentCallbackHandle},
};
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

mod runtime;
pub(crate) mod timeline;
