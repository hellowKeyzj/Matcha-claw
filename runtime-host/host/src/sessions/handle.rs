use std::sync::Arc;

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
        SessionEvictOutcome, SessionIngestOutcome, SessionSendRequest,
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
    state::{SessionIdentity, SessionView},
    timeline::{Command as SessionTimelineCommand, Outcome as SessionTimelineOutcome},
};
use crate::{RuntimeSessionError, runtime_directory::RuntimeDriverDirectory};
use openclaw::{
    port::OpenClawSessionError,
    session::protocol::{
        ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
        ChatSendResult,
    },
};
use platform::exchange::InvocationOutcome;

#[derive(Clone)]
pub(crate) struct SessionHandle {
    owner: OwnerRuntimeHandle<SessionCommand, SessionQuery>,
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

impl SessionHandle {
    pub(crate) fn new(
        owner: OwnerRuntimeHandle<SessionCommand, SessionQuery>,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        Self {
            owner,
            runtime_directory,
        }
    }

    pub(crate) async fn list_sessions(&self) -> Result<Vec<SessionView>, ()> {
        self.request_query(|reply| SessionQuery::ListSessions { reply })
            .await
    }

    pub(crate) async fn get_session(&self, session_key: String) -> Result<Option<SessionView>, ()> {
        self.request_query(|reply| SessionQuery::GetSession { session_key, reply })
            .await
    }

    pub(crate) async fn ensure_session(
        &self,
        identity: SessionIdentity,
    ) -> Result<SessionEnsureOutcome, ()> {
        self.request_command(|reply| SessionCommand::Ensure { identity, reply })
            .await
    }

    pub(crate) async fn ingest_event(
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

    pub(crate) async fn touch_session(&self, session_key: String) -> Result<(), ()> {
        self.request_command(|reply| SessionCommand::Touch { session_key, reply })
            .await
    }

    pub(crate) async fn evict_session(
        &self,
        session_key: String,
    ) -> Result<SessionEvictOutcome, ()> {
        self.request_command(|reply| SessionCommand::Evict { session_key, reply })
            .await
    }

    pub(crate) fn prepare_create(
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

    pub(crate) async fn create_session(
        &self,
        command: SessionCreateCommand,
    ) -> Result<SessionCreateOutcome, ()> {
        self.request_command(|reply| SessionCommand::Create { command, reply })
            .await
    }

    pub(crate) async fn send_session(
        &self,
        command: SessionSendCommand,
    ) -> Result<SessionSendOutcome, ()> {
        self.request_command(|reply| SessionCommand::Send {
            request: SessionSendRequest::Session { command, reply },
        })
        .await
    }

    pub(crate) async fn abort_session(
        &self,
        command: SessionAbortCommand,
    ) -> Result<SessionAbortOutcome, ()> {
        self.request_command(|reply| SessionCommand::Abort {
            request: SessionAbortRequest::Session { command, reply },
        })
        .await
    }

    pub(crate) async fn delete_session(
        &self,
        command: SessionDeleteCommand,
    ) -> Result<SessionDeleteOutcome, ()> {
        self.request_command(|reply| SessionCommand::Delete { command, reply })
            .await
    }

    pub(crate) async fn rename_session(
        &self,
        command: SessionRenameCommand,
    ) -> Result<SessionRenameOutcome, ()> {
        self.request_command(|reply| SessionCommand::Rename { command, reply })
            .await
    }

    pub(crate) async fn pending_approvals(
        &self,
        command: PendingApprovalsCommand,
    ) -> Result<PendingApprovalsOutcome, ()> {
        self.request_query(|reply| SessionQuery::PendingApprovals { command, reply })
            .await
    }

    pub(crate) async fn respond_to_approval(
        &self,
        command: SessionApprovalCommand,
    ) -> Result<SessionApprovalOutcome, ()> {
        self.request_command(|reply| SessionCommand::Approval { command, reply })
            .await
    }

    pub(crate) async fn select_model(
        &self,
        command: SessionModelSelectionCommand,
    ) -> Result<SessionModelSelectionOutcome, ()> {
        self.request_command(|reply| SessionCommand::ModelSelection { command, reply })
            .await
    }

    pub(crate) async fn load_timeline(
        &self,
        command: SessionTimelineCommand,
    ) -> Result<SessionTimelineOutcome, ()> {
        self.request_query(|reply| SessionQuery::Timeline { command, reply })
            .await
    }

    pub(crate) async fn list_openclaw_sessions(
        &self,
    ) -> Result<
        Result<
            openclaw::session::protocol::SessionsListResult,
            crate::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
        (),
    > {
        self.request_query(|reply| SessionQuery::ListOpenClaw { reply })
            .await
    }

    pub(crate) async fn openclaw_history(
        &self,
        params: ChatHistoryParams,
    ) -> Result<Result<ChatHistoryResult, RuntimeSessionError<OpenClawSessionError>>, ()> {
        self.request_query(|reply| SessionQuery::OpenClawHistory { params, reply })
            .await
    }

    pub(crate) async fn send_openclaw_chat(
        &self,
        params: ChatSendParams,
    ) -> Result<
        Result<
            InvocationOutcome<ChatSendResult, OpenClawSessionError>,
            RuntimeSessionError<OpenClawSessionError>,
        >,
        (),
    > {
        self.request_command(|reply| SessionCommand::Send {
            request: SessionSendRequest::OpenClawChat { params, reply },
        })
        .await
    }

    pub(crate) async fn abort_openclaw_chat(
        &self,
        params: ChatAbortParams,
    ) -> Result<
        Result<
            InvocationOutcome<ChatAbortResult, OpenClawSessionError>,
            RuntimeSessionError<OpenClawSessionError>,
        >,
        (),
    > {
        self.request_command(|reply| SessionCommand::Abort {
            request: SessionAbortRequest::OpenClawChat { params, reply },
        })
        .await
    }

    pub(crate) async fn list_matcha_sessions(
        &self,
    ) -> Result<crate::matcha_session_catalog::Outcome, ()> {
        self.request_query(|reply| SessionQuery::ListMatcha { reply })
            .await
    }

    pub(crate) async fn load_matcha_history(
        &self,
        command: crate::matcha_history::Command,
    ) -> Result<crate::matcha_history::Outcome, ()> {
        self.request_query(|reply| SessionQuery::MatchaHistory { command, reply })
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
