use std::sync::Arc;

use connectors::ConnectorSecretResolverPort;
use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use super::{
    abort::{SessionAbortCommand, SessionAbortOutcome},
    approval::{
        PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
        SessionApprovalOutcome,
    },
    command::{
        SessionAbortRequest, SessionCommand, SessionEnsureOutcome, SessionEvent,
        SessionEvictOutcome, SessionIngestOutcome, SessionIngressEvent, SessionSendRequest,
    },
    create::{
        InvalidSessionCreate, SessionCreateAdmissionInput, SessionCreateCommand,
        SessionCreateOutcome,
    },
    delete::{SessionDeleteCommand, SessionDeleteOutcome},
    model_selection::{SessionModelSelectionCommand, SessionModelSelectionOutcome},
    query::SessionQuery,
    rename::{SessionRenameCommand, SessionRenameOutcome},
    send::{SessionSendCommand, SessionSendOutcome},
    session_catalog::{SessionCatalogCommand, SessionCatalogOutcome},
    session_history::{SessionHistoryCommand, SessionHistoryOutcome},
    session_permission::{SessionPermissionCommand, SessionPermissionOutcome},
    state::{SessionIdentity, SessionSourceBinding, SessionView},
    timeline::{
        Command as SessionTimelineCommand, ContentCommand as SessionContentCommand,
        ContentOutcome as SessionContentOutcome, Outcome as SessionTimelineOutcome,
    },
};
use crate::ports::SessionRuntimeDirectory;

#[derive(Clone)]
pub struct SessionHandle {
    owner: OwnerRuntimeHandle<SessionCommand, SessionQuery>,
    runtime_directory: Arc<dyn SessionRuntimeDirectory>,
}

impl SessionHandle {
    pub fn new(
        owner: OwnerRuntimeHandle<SessionCommand, SessionQuery>,
        runtime_directory: Arc<dyn SessionRuntimeDirectory>,
    ) -> Self {
        Self {
            owner,
            runtime_directory,
        }
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionView>, ()> {
        self.request_query(|reply| SessionQuery::ListSessions { reply })
            .await
    }

    pub async fn get_session(&self, session_key: String) -> Result<Option<SessionView>, ()> {
        self.request_query(|reply| SessionQuery::GetSession { session_key, reply })
            .await
    }

    pub async fn ensure_session(
        &self,
        identity: SessionIdentity,
    ) -> Result<SessionEnsureOutcome, ()> {
        self.ensure_bound_session(identity, SessionSourceBinding::ordinary())
            .await
    }

    pub async fn ensure_bound_session(
        &self,
        identity: SessionIdentity,
        source_binding: SessionSourceBinding,
    ) -> Result<SessionEnsureOutcome, ()> {
        self.request_command(|reply| SessionCommand::Ensure {
            identity,
            source_binding,
            reply,
        })
        .await
    }

    pub async fn ingest_event(
        &self,
        identity: SessionIdentity,
        event: SessionEvent,
    ) -> Result<SessionIngestOutcome, ()> {
        self.request_command(|reply| SessionCommand::Ingest {
            identity,
            event,
            reply,
        })
        .await
    }

    pub async fn ingest_ingress_event(
        &self,
        event: SessionIngressEvent,
    ) -> Result<SessionIngestOutcome, ()> {
        let (identity, event) = event.into_parts();
        self.ingest_event(identity, event).await
    }

    pub async fn evict_session(&self, session_key: String) -> Result<SessionEvictOutcome, ()> {
        self.request_command(|reply| SessionCommand::Evict { session_key, reply })
            .await
    }

    pub fn prepare_create(
        &self,
        input: SessionCreateAdmissionInput,
        now_ms: u64,
    ) -> Result<SessionCreateCommand, InvalidSessionCreate> {
        let driver = self
            .runtime_directory
            .lookup(input.endpoint())
            .ok_or(InvalidSessionCreate)?;
        let ops = driver.session_ops().ok_or(InvalidSessionCreate)?;
        ops.admission().prepare_create(input, now_ms)
    }

    pub async fn create_session(
        &self,
        command: SessionCreateCommand,
    ) -> Result<SessionCreateOutcome, ()> {
        self.request_command(|reply| SessionCommand::Create { command, reply })
            .await
    }

    pub async fn send_session(
        &self,
        command: SessionSendCommand,
    ) -> Result<SessionSendOutcome, ()> {
        self.request_command(|reply| SessionCommand::Send {
            request: SessionSendRequest::Session { command, reply },
        })
        .await
    }

    pub async fn abort_session(
        &self,
        command: SessionAbortCommand,
    ) -> Result<SessionAbortOutcome, ()> {
        self.request_command(|reply| SessionCommand::Abort {
            request: SessionAbortRequest::Session { command, reply },
        })
        .await
    }

    pub async fn delete_session(
        &self,
        command: SessionDeleteCommand,
    ) -> Result<SessionDeleteOutcome, ()> {
        self.request_command(|reply| SessionCommand::Delete { command, reply })
            .await
    }

    pub async fn rename_session(
        &self,
        command: SessionRenameCommand,
    ) -> Result<SessionRenameOutcome, ()> {
        self.request_command(|reply| SessionCommand::Rename { command, reply })
            .await
    }

    pub async fn pending_approvals(
        &self,
        command: PendingApprovalsCommand,
    ) -> Result<PendingApprovalsOutcome, ()> {
        self.request_query(|reply| SessionQuery::PendingApprovals { command, reply })
            .await
    }

    pub async fn respond_to_approval(
        &self,
        command: SessionApprovalCommand,
    ) -> Result<SessionApprovalOutcome, ()> {
        self.request_command(|reply| SessionCommand::Approval { command, reply })
            .await
    }

    pub async fn select_model(
        &self,
        command: SessionModelSelectionCommand,
    ) -> Result<SessionModelSelectionOutcome, ()> {
        self.request_command(|reply| SessionCommand::ModelSelection { command, reply })
            .await
    }

    pub async fn configure_private_resolver(
        &self,
        resolver: Arc<dyn ConnectorSecretResolverPort>,
    ) -> Result<(), ()> {
        self.request_command(|reply| SessionCommand::ConfigurePrivateResolver { resolver, reply })
            .await
    }

    pub async fn session_permission(
        &self,
        command: SessionPermissionCommand,
    ) -> Result<SessionPermissionOutcome, ()> {
        self.request_command(|reply| SessionCommand::Permission { command, reply })
            .await
    }

    pub async fn load_timeline(
        &self,
        command: SessionTimelineCommand,
    ) -> Result<SessionTimelineOutcome, ()> {
        self.request_query(|reply| SessionQuery::Timeline { command, reply })
            .await
    }

    pub async fn load_content(
        &self,
        command: SessionContentCommand,
    ) -> Result<SessionContentOutcome, ()> {
        self.request_query(|reply| SessionQuery::Content { command, reply })
            .await
    }

    pub async fn list_session_catalog(
        &self,
        command: SessionCatalogCommand,
    ) -> Result<SessionCatalogOutcome, ()> {
        self.request_query(|reply| SessionQuery::Catalog { command, reply })
            .await
    }

    pub async fn load_session_history(
        &self,
        command: SessionHistoryCommand,
    ) -> Result<SessionHistoryOutcome, ()> {
        self.request_query(|reply| SessionQuery::History { command, reply })
            .await
    }

    async fn request_command<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> SessionCommand,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(command(reply))
            .await
            .map_err(|_| ())?;
        response.await.map_err(|_| ())
    }

    async fn request_query<T>(
        &self,
        query: impl FnOnce(oneshot::Sender<T>) -> SessionQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner.send_query(query(reply)).await.map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
