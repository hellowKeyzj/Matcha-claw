use std::{future::Future, pin::Pin, sync::Arc};

use platform::endpoint::runtime_address::RuntimeEndpoint;
pub use runtime_directory::{LifecycleOps, RuntimeDriverIdentity};

use crate::{
    abort::{SessionAbortCommand, SessionAbortOutcome},
    approval::{
        PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
        SessionApprovalOutcome,
    },
    create::{SessionAdmission, SessionCreateCommand, SessionCreateOutcome},
    delete::{SessionDeleteCommand, SessionDeleteOutcome},
    model_selection::{ResolvedSessionModelSelection, SessionModelSelectionOutcome},
    rename::{SessionRenameCommand, SessionRenameOutcome},
    send::{SessionSendCommand, SessionSendOutcome},
    session_catalog::{SessionCatalogCommand, SessionCatalogOutcome},
    session_history::{SessionHistoryCommand, SessionHistoryFailure, SessionHistoryOutcome},
    session_permission::{SessionPermissionCommand, SessionPermissionOutcome},
    state::SessionView,
    timeline::{self, ContentCommand, ContentOutcome},
};

pub type SessionFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type OwnedRuntimeFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

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

pub trait SessionOps: Send + Sync {
    fn admission(&self) -> SessionAdmission;

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
}
