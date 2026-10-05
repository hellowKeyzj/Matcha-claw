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
        SessionCommand, SessionEnsureOutcome, SessionEvent,
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
    call_recorder: Option<platform::call::CallRecorder>,
}

impl SessionHandle {
    pub fn new(
        owner: OwnerRuntimeHandle<SessionCommand, SessionQuery>,
        runtime_directory: Arc<dyn SessionRuntimeDirectory>,
    ) -> Self {
        Self {
            owner,
            runtime_directory,
            call_recorder: None,
        }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.call_recorder = Some(recorder);
        self
    }

    pub(crate) async fn record_boundary_outcome(
        &self,
        command: &'static str,
        outcome: crate::call::SessionsCallOutcome,
    ) {
        if self.request_query(|reply| SessionQuery::BoundaryOutcome {
            command,
            detail: crate::call::SessionsCallDetail::default(),
            outcome,
            reply,
        }).await.is_err() {
            eprintln!("Sessions boundary call audit unavailable");
        }
    }

    pub(crate) async fn record_events_subscription(&self) -> Result<(), ()> {
        self.request_query(|reply| SessionQuery::EventsSubscribed { reply }).await
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
        ops.admission()
            .prepare_create(input, now_ms, |agent_id, endpoint_session_id| {
                ops.agent_scoped_session_key(agent_id, endpoint_session_id)
            })
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

    pub async fn mutate_session_goal(&self, command: crate::goal::SessionGoalCommand) -> Result<crate::goal::SessionGoalOutcome, ()> {
        self.request_command(|reply| SessionCommand::Goal { command, reply }).await
    }

    pub async fn observe_session(&self, command: crate::ports::SessionObserveCommand) -> Result<crate::ports::SessionObserveOutcome, ()> {
        self.request_query(|reply| SessionQuery::Observe { command, reply }).await
    }

    pub async fn release_observation(&self, identity: SessionIdentity, lease_id: String) -> Result<crate::ports::SessionReleaseOutcome, ()> {
        self.request_command(|reply| SessionCommand::Release { identity, lease_id, reply }).await
    }

    pub async fn abort_session(
        &self,
        command: SessionAbortCommand,
    ) -> Result<SessionAbortOutcome, ()> {
        crate::trace::log("runtime.abort.api.submit", command.trace_id(), serde_json::json!({}));
        self.request_query(|reply| SessionQuery::Abort { command, reply })
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
        let command = command(reply);
        let call = self.begin_call(command.call_detail()).await?;
        let command = match &call {
            Some(call) => SessionCommand::Audited { command: Box::new(command), call: call.clone() },
            None => command,
        };
        if self.owner.send_command(command).await.is_err() {
            if let Some(call) = call { call.rejected().await; }
            return Err(());
        }
        response.await.map_err(|_| ())
    }

    async fn request_query<T>(
        &self,
        query: impl FnOnce(oneshot::Sender<T>) -> SessionQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        let query = query(reply);
        let abort_trace_id = match &query {
            SessionQuery::Abort { command, .. } => command.trace_id().map(str::to_owned),
            _ => None,
        };
        let started = std::time::Instant::now();
        let call = self.begin_call(query.call_detail()).await.map_err(|()| {
            crate::trace::log("runtime.abort.api.audit-failed", abort_trace_id.as_deref(), serde_json::json!({ "elapsedMs": started.elapsed().as_millis() }));
        })?;
        let query = match &call {
            Some(call) => SessionQuery::Audited { query: Box::new(query), call: call.clone() },
            None => query,
        };
        crate::trace::log("runtime.abort.api.dispatch", abort_trace_id.as_deref(), serde_json::json!({ "elapsedMs": started.elapsed().as_millis() }));
        if self.owner.send_query(query).await.is_err() {
            if let Some(call) = call { call.rejected().await; }
            crate::trace::log("runtime.abort.api.dispatch-failed", abort_trace_id.as_deref(), serde_json::json!({ "elapsedMs": started.elapsed().as_millis() }));
            return Err(());
        }
        let outcome = response.await.map_err(|_| ());
        crate::trace::log("runtime.abort.api.response", abort_trace_id.as_deref(), serde_json::json!({ "received": outcome.is_ok(), "elapsedMs": started.elapsed().as_millis() }));
        outcome
    }

    async fn begin_call(
        &self,
        detail: Option<(&'static str, crate::call::SessionsCallDetail)>,
    ) -> Result<Option<crate::call::SessionCall>, ()> {
        let (Some(recorder), Some((command, detail))) = (&self.call_recorder, detail) else {
            return Ok(None);
        };
        let context = recorder.begin(command, &detail).await.map_err(|error| {
            eprintln!("Sessions call audit: {error}");
        })?;
        Ok(Some(crate::call::SessionCall::new(context, detail)))
    }
}
