use crate::channel::trace::ChannelTraceSpan;
use openclaw::operations::channel_config::{
    channel_trace, current_channel_trace, with_channel_trace,
};

use std::{
    collections::HashSet,
    fmt,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

#[cfg(unix)]
use foundation::process::InvalidGuardianExecutable;
use foundation::process::{
    ProcessContainment, supervise,
    supervision::{
        CommandReceipt, CompletionError, RestartOutcome, StartOutcome, SupervisorHandle,
        SupervisorPhase, SupervisorSnapshot, TerminationCompletion,
    },
};
use openclaw::{
    bootstrap::{ConfigWriteEffect, PrivateProjectionEffect},
    gateway::{
        auth::GatewaySecret,
        client::{GatewayClientError, GatewayClientMetadata, GatewayEndpoint},
        control_ui::{ControlUiUrlError, PublicControlUiUrl},
    },
    lifecycle::{
        launch::{LaunchError, LaunchFactory, OpenClawLaunchInput, SealedRuntimeHost},
        logs::{LifecycleDiagnostic, LifecycleLogBuffer, sanitize_log_line},
        recovery::{DoctorRepairError, OpenClawDoctorRepair, OpenClawStartRecovery},
        restart::OpenClawRestartPolicy,
        state_dir::CanonicalStateDir,
        stdio::OpenClawStdioActivation,
    },
    port::{
        AppliedStatus, ObservedStatus, OpenClawControlReadiness, OpenClawGateway,
        OpenClawSessionGateway, ProviderNativeConfigurationDiagnostic,
        ProviderNativeConfigurationEvidence,
    },
};
use platform::{exchange::InvocationOutcome, listener_identity::ListenerIdentity};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, watch};
use zeroize::Zeroizing;

use self::owner::{SupervisorLifecycleHandle, SupervisorOwner};
use crate::{
    runtime::driver::{
        ChannelOps, ConnectorOps, CronOps, LifecycleOps, OwnedRuntimeFuture, ProviderConfigOps,
        ProviderNativeConfigurationCommand, RuntimeCapabilitySurface, RuntimeDriver,
        RuntimeDriverIdentity, RuntimeLifecycleFailure, RuntimeStartFailure, SecurityOps,
        SessionFuture, SessionOps, SettingsOps, SettingsProjectionEffect, SkillOps, SubagentOps,
        TaskOps, TeamOps, WorkspaceOps,
    },
    sessions::abort::{SessionAbortCommand, SessionAbortOutcome},
    sessions::create::{
        SessionAdmission, SessionCreateCommand, SessionCreateOutcome,
        project_openclaw_client_error as project_create_client_error, project_openclaw_create,
    },
    sessions::delete::{
        SessionDeleteCommand, SessionDeleteOutcome,
        project_openclaw_client_error as project_delete_client_error, project_openclaw_delete,
    },
    sessions::model_selection::{
        OpenClawPatchRejection, ResolvedSessionModelSelection, SessionModelSelectionBinding,
        SessionModelSelectionOutcome, SessionModelSelectionRejection,
    },
    sessions::rename::{
        SessionRenameCommand, SessionRenameOutcome,
        project_openclaw_client_error as project_rename_client_error, project_openclaw_rename,
    },
    sessions::send::{Attachment, SessionSendCommand, SessionSendOutcome},
    sessions::session_permission::{
        SessionPermissionAction, SessionPermissionCommand, SessionPermissionOutcome,
        SessionPermissionProjection,
    },
    transport::runtime::parent_callback::{ParentCallbackHandle, ParentShellAction},
};

pub(crate) mod adapters;
mod driver;
mod instance;
pub(crate) mod ops;
pub(crate) mod owner;

#[cfg(test)]
mod tests;

pub(crate) use instance::OpenClawInstance;
pub use instance::{ConstructionError, OpenClawInput};
pub(crate) use owner::gateway::{
    ControlLease, OpenClawBrowserGatewayRequest, OpenClawGatewayHealthObservation,
    OpenClawGatewayPayload, OpenClawGatewayStatusObservation, OpenClawLogSnapshot,
    OpenClawMcpAppGatewayRequest,
};
