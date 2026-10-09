use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};

use platform::endpoint::runtime_address::{RuntimeEndpoint, SessionIdentity};
pub use runtime_directory::{LifecycleOps, RuntimeDriverIdentity};

use crate::{
    abort::{SessionAbortCommand, SessionAbortOutcome},
    approval::{
        PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
        SessionApprovalOutcome,
    },
    create::{SessionAdmission, SessionCreateCommand, SessionCreateOutcome},
    delete::{SessionDeleteCommand, SessionDeleteOutcome},
    goal::{SessionGoalCommand, SessionGoalOutcome},
    model_selection::{ResolvedSessionModelSelection, SessionModelSelectionOutcome},
    rename::{SessionRenameCommand, SessionRenameOutcome},
    send::{SessionSendCommand, SessionSendOutcome},
    session_catalog::{SessionCatalogCommand, SessionCatalogOutcome},
    session_history::{SessionHistoryCommand, SessionHistoryFailure, SessionHistoryOutcome},
    session_permission::{SessionPermissionCommand, SessionPermissionOutcome},
    state::{RunPhase, SessionIdentity as ViewIdentity, SessionSourceBinding, SessionView},
    timeline::WindowRequest,
    timeline::{self, ContentCommand, ContentOutcome},
};

pub type SessionFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type OwnedRuntimeFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

pub struct SessionOwnershipQuery {
    pub identity: SessionIdentity,
    pub endpoint_session_id: String,
}

pub trait SessionOwnershipReader: Send + Sync {
    /// A successful map contains Team bindings only; absence means Ordinary.
    /// None means ownership could not be read, not that the sessions are Ordinary.
    fn lookup<'a>(
        &'a self,
        queries: Vec<SessionOwnershipQuery>,
    ) -> SessionFuture<'a, Option<HashMap<SessionIdentity, SessionSourceBinding>>>;
}

pub trait SessionRuntimeDirectory: Send + Sync {
    fn lookup(&self, endpoint: &RuntimeEndpoint) -> Option<Arc<dyn RuntimeDriver>>;
}

pub trait RuntimeDriver: Send + Sync {
    fn identity(&self) -> RuntimeDriverIdentity;

    fn endpoint(&self) -> RuntimeEndpoint {
        self.identity().endpoint()
    }

    fn session_ops(&self) -> Option<&dyn SessionOps> {
        None
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        None
    }
}

/// Owner-internal binding. A UI lease ID is deliberately absent from native ingress.
#[derive(Clone, Debug)]
pub struct SessionObservationRequest {
    pub identity: ViewIdentity,
    pub endpoint_session_id: Option<String>,
    pub generation: u64,
}

pub trait SessionObservation: Send + Sync {
    /// Subscribe before reading; reconcile native replay/history inside the Integration.
    /// The returned view is not by itself proof that Host consumed the event frontier.
    fn sync<'a>(
        &'a self,
        command: timeline::Command,
        epoch: u64,
    ) -> SessionFuture<'a, Result<SessionSync, RuntimeOperationFailure>>;

    /// Rebinds a failed receive resource while preserving Integration reconciliation facts.
    /// Native ingress for the new generation starts only after the owner's next sync.
    fn restart(&self, generation: u64) -> OwnedRuntimeFuture<Result<(), RuntimeOperationFailure>>;

    /// Closes only this receive resource; never aborts a native run.
    fn close(&self) -> OwnedRuntimeFuture<()>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionSyncCut {
    /// A history/snapshot read, not a consumed event frontier.
    Snapshot,
    /// The Integration actually projected events through this source cursor.
    /// Gateway-global cursors are non-contiguous; opaque history cursors stay private.
    EventFrontier { cursor: u64, contiguous: bool },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionTerminalRun {
    pub run_id: String,
    pub phase: RunPhase,
}

#[derive(Clone, Debug)]
pub struct SessionSync {
    pub view: SessionView,
    pub source_epoch: Option<u64>,
    /// Native transcript branch, distinct from the event source epoch; never public.
    pub source_branch: Option<String>,
    pub cut: SessionSyncCut,
    /// Facts at an actually consumed replay frontier, not transcript coverage.
    /// The Integration awaits Host ingress receipts before returning this baseline.
    pub replay_baseline: Option<SessionView>,
    /// Only explicit native run facts, never inferred from final history items.
    pub terminal_runs: Vec<SessionTerminalRun>,
    /// Explicit display retirement evidence from native reconciliation, not missing
    /// history rows, shared run IDs, or equal bodies. Applied even to partial items.
    pub retired_item_ids: Vec<String>,
    /// Exact removals from an Integration-confirmed scope replacement.
    pub retired_tool_ids: Vec<String>,
    pub retired_approval_ids: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SessionObserveCommand {
    pub identity: ViewIdentity,
    /// Receive resource ID, not a message-routing or native authorization token.
    pub lease_id: String,
    pub window: WindowRequest,
}

#[derive(Clone, Debug)]
pub enum SessionObserveOutcome {
    Observed { lease_id: String, view: SessionView },
    Released { lease_id: String },
    Rejected,
    Unavailable,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionReleaseOutcome {
    Released,
    NotFound,
    Rejected,
    Unavailable,
}

pub trait SessionOps: Send + Sync {
    fn admission(&self) -> SessionAdmission;

    /// Construct the handle without waiting for native IO; the Sessions owner runs
    /// sync/close under its existing OwnedTask lifetime and bounded ingress queue.
    fn prepare_observation(
        &self,
        request: SessionObservationRequest,
    ) -> Result<Arc<dyn SessionObservation>, RuntimeOperationFailure>;

    fn agent_scoped_session_key(
        &self,
        _agent_id: &str,
        _endpoint_session_id: &str,
    ) -> Option<String> {
        None
    }

    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> SessionFuture<'a, SessionAbortOutcome>;

    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> SessionFuture<'a, SessionCreateOutcome>;

    fn load_session_catalog<'a>(
        &'a self,
        _command: SessionCatalogCommand,
    ) -> SessionFuture<'a, SessionCatalogOutcome> {
        Box::pin(async { SessionCatalogOutcome::Unavailable })
    }

    fn open_session_ops(&self) -> Option<&dyn SessionOpenOps> {
        None
    }

    fn load_session_history<'a>(
        &'a self,
        _command: SessionHistoryCommand,
    ) -> SessionFuture<'a, SessionHistoryOutcome> {
        Box::pin(async { SessionHistoryOutcome::Failed(SessionHistoryFailure::Unavailable) })
    }

    fn rename_session<'a>(
        &'a self,
        _command: SessionRenameCommand,
    ) -> SessionFuture<'a, SessionRenameOutcome> {
        Box::pin(async { SessionRenameOutcome::Unknown })
    }

    fn delete_session<'a>(
        &'a self,
        _command: SessionDeleteCommand,
    ) -> SessionFuture<'a, SessionDeleteOutcome> {
        Box::pin(async { SessionDeleteOutcome::Unknown })
    }

    fn send_model_runtime_command<'a>(
        &'a self,
        _command: &'a SessionSendCommand,
    ) -> SessionFuture<
        'a,
        Result<
            Option<crate::model_selection::MatchaSessionModelRuntimeCommand>,
            SessionSendOutcome,
        >,
    > {
        Box::pin(async { Ok(None) })
    }

    fn load_session_timeline<'a>(
        &'a self,
        _command: timeline::Command,
        _epoch: u64,
    ) -> SessionFuture<'a, timeline::Outcome> {
        Box::pin(async {
            timeline::Outcome::unavailable(timeline::UnavailableReason::RuntimeUnavailable)
        })
    }

    fn load_session_content<'a>(
        &'a self,
        _command: ContentCommand,
    ) -> SessionFuture<'a, ContentOutcome> {
        Box::pin(async {
            ContentOutcome::unavailable(timeline::UnavailableReason::RuntimeUnavailable)
        })
    }

    fn pending_approvals<'a>(
        &'a self,
        _command: PendingApprovalsCommand,
    ) -> SessionFuture<'a, PendingApprovalsOutcome> {
        Box::pin(async { PendingApprovalsOutcome::Unsupported })
    }

    fn respond_to_approval<'a>(
        &'a self,
        _command: SessionApprovalCommand,
    ) -> SessionFuture<'a, SessionApprovalOutcome> {
        Box::pin(async { SessionApprovalOutcome::Unsupported })
    }

    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> SessionFuture<'a, SessionSendOutcome>;

    fn select_session_model<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
    ) -> SessionFuture<'a, SessionModelSelectionOutcome>;

    fn supports_goal(&self) -> bool {
        false
    }

    fn mutate_session_goal<'a>(
        &'a self,
        _command: SessionGoalCommand,
    ) -> SessionFuture<'a, SessionGoalOutcome> {
        Box::pin(async { SessionGoalOutcome::Unsupported })
    }

    fn session_permission<'a>(
        &'a self,
        _command: SessionPermissionCommand,
    ) -> SessionFuture<'a, SessionPermissionOutcome> {
        Box::pin(async { SessionPermissionOutcome::unsupported() })
    }
}

pub trait SessionOpenOps: Send + Sync {
    fn on_load_session_timeline<'a>(
        &'a self,
        command: &'a timeline::Command,
        view: SessionView,
        provider_handle: provider_module::ProviderHandle,
    ) -> SessionFuture<'a, SessionView>;

    fn agent_default_model<'a>(&'a self, _agent_id: String) -> SessionFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeOperationFailure {
    Unsupported,
    Unavailable,
    TargetRejected,
    Unknown,
    /// The Integration owns a bounded history retry on the same live observation.
    HistoryRetryPending,
}
