use std::sync::Arc;

use platform::exchange::InvocationOutcome;
use platform::state_dir::CanonicalStateDir;

use super::{
    OpenClawGateway,
    outcome::{
        OpenClawSessionError, OpenClawSessionMutationFailure, SessionModelPatchFailure,
        port_outcome, session_model_patch_outcome, session_mutation_outcome,
    },
};
use crate::{
    agents::{AgentWait, OpenClawAgents},
    gateway::client::GatewayClient,
    session::window::{self, PageRequest, SessionWindow},
    session::{
        CanonicalSessionReplay, SessionReplayError, SessionReplaySourceError,
        SessionReplaySourcePage,
        operation::SessionOperation,
        protocol::{
            ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
            ChatSendResult, SessionCreateParams, SessionCreateResult, SessionDeleteParams,
            SessionDeleteResult, SessionDescribeParams, SessionDescribeRow, SessionKey,
            SessionLabelPatchParams, SessionLabelPatchResult, SessionModelPatchParams,
            SessionModelPatchResult, SessionPermissionPatchParams, SessionPermissionProjection,
            SessionsListParams, SessionsListResult,
        },
    },
    team::NativeRunSettledOutcome,
};

#[derive(Clone)]
pub struct OpenClawSessionGateway {
    client: Arc<GatewayClient>,
    state_dir: Option<CanonicalStateDir>,
}

impl OpenClawGateway {
    pub fn session_gateway(&self) -> OpenClawSessionGateway {
        OpenClawSessionGateway {
            client: Arc::clone(&self.client),
            state_dir: self.state_dir.clone(),
        }
    }

    pub async fn list_sessions(
        &mut self,
        params: SessionsListParams,
    ) -> Result<SessionsListResult, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .list_sessions(params)
            .await
            .map_err(Into::into)
    }

    pub async fn history(
        &mut self,
        params: ChatHistoryParams,
    ) -> Result<ChatHistoryResult, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .history(params)
            .await
            .map_err(Into::into)
    }

    pub async fn history_window(
        &mut self,
        params: ChatHistoryParams,
        request: PageRequest,
    ) -> Result<SessionWindow, OpenClawSessionError> {
        let payload = SessionOperation::new(Arc::clone(&self.client))
            .history_payload(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        window::decode_window(payload, request)
            .map_err(|error| OpenClawSessionError::Protocol(Some(error)))
    }

    pub fn replay_source_page(
        &self,
        session_key: SessionKey,
        request: PageRequest,
    ) -> Result<SessionReplaySourcePage, SessionReplaySourceError> {
        let Some(state_dir) = &self.state_dir else {
            return Err(SessionReplaySourceError::MissingStateDir);
        };
        crate::session::load_session_replay_source(state_dir, session_key, request)
    }

    pub fn materialize_session_replay(
        &self,
        source: SessionReplaySourcePage,
        source_epoch: Option<u64>,
        route_key: Option<String>,
    ) -> Result<CanonicalSessionReplay, SessionReplayError> {
        crate::session::materialize_session_replay(
            source.session_key().clone(),
            source.into_events(),
            source_epoch,
            route_key,
        )
    }

    pub async fn enqueue_chat(
        &mut self,
        params: ChatSendParams,
        route_key: String,
    ) -> Result<ChatSendResult, OpenClawSessionError> {
        let session_key = params.session_key().clone();
        let operation = SessionOperation::new(Arc::clone(&self.client));
        operation.subscribe_session_messages(&session_key).await?;
        self.client.register_session_route(&session_key, route_key);
        match operation.send_chat(params).await {
            Ok(InvocationOutcome::Succeeded(result)) => Ok(result),
            Ok(InvocationOutcome::TargetRejected(error)) => {
                self.client.unregister_session_route(&session_key);
                Err(error.into())
            }
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) => {
                self.client.unregister_session_route(&session_key);
                Err(OpenClawSessionError::UnknownResponse)
            }
            Err(error) => {
                self.client.unregister_session_route(&session_key);
                Err(error.into())
            }
        }
    }

    pub async fn send_chat(
        &mut self,
        params: ChatSendParams,
    ) -> Result<InvocationOutcome<ChatSendResult, OpenClawSessionError>, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .send_chat(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn abort_chat(
        &mut self,
        params: ChatAbortParams,
    ) -> Result<InvocationOutcome<ChatAbortResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .abort_chat(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn abort_chat_diagnostic(
        &mut self,
        params: ChatAbortParams,
    ) -> Result<
        InvocationOutcome<ChatAbortResult, OpenClawSessionMutationFailure>,
        OpenClawSessionError,
    > {
        let outcome = SessionOperation::new(Arc::clone(&self.client))
            .abort_chat(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        Ok(session_mutation_outcome(outcome))
    }

    pub async fn patch_session_model(
        &mut self,
        params: SessionModelPatchParams,
    ) -> Result<
        InvocationOutcome<SessionModelPatchResult, OpenClawSessionError>,
        OpenClawSessionError,
    > {
        match self.patch_session_model_diagnostic(params).await? {
            InvocationOutcome::Succeeded(result) => Ok(InvocationOutcome::Succeeded(result)),
            InvocationOutcome::TargetRejected(_) => Ok(InvocationOutcome::TargetRejected(
                OpenClawSessionError::TargetRejected,
            )),
            InvocationOutcome::Cancelled => Ok(InvocationOutcome::Cancelled),
            InvocationOutcome::Unknown => Ok(InvocationOutcome::Unknown),
        }
    }

    pub async fn patch_session_model_diagnostic(
        &mut self,
        params: SessionModelPatchParams,
    ) -> Result<
        InvocationOutcome<SessionModelPatchResult, SessionModelPatchFailure>,
        OpenClawSessionError,
    > {
        let outcome = SessionOperation::new(Arc::clone(&self.client))
            .patch_session_model(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        Ok(session_model_patch_outcome(outcome))
    }

    pub async fn patch_session_label(
        &mut self,
        params: SessionLabelPatchParams,
    ) -> Result<
        InvocationOutcome<SessionLabelPatchResult, OpenClawSessionError>,
        OpenClawSessionError,
    > {
        SessionOperation::new(Arc::clone(&self.client))
            .patch_session_label(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn get_session_permission(
        &mut self,
        session_key: SessionKey,
    ) -> Result<SessionPermissionProjection, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .get_session_permission(session_key)
            .await
            .map_err(Into::into)
    }

    pub async fn set_session_permission(
        &mut self,
        params: SessionPermissionPatchParams,
    ) -> Result<
        InvocationOutcome<SessionPermissionProjection, OpenClawSessionError>,
        OpenClawSessionError,
    > {
        SessionOperation::new(Arc::clone(&self.client))
            .set_session_permission(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn create_session(
        &mut self,
        params: SessionCreateParams,
    ) -> Result<InvocationOutcome<SessionCreateResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .create_session(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn delete_session(
        &mut self,
        params: SessionDeleteParams,
    ) -> Result<InvocationOutcome<SessionDeleteResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .delete_session(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn delete_session_diagnostic(
        &mut self,
        params: SessionDeleteParams,
    ) -> Result<
        InvocationOutcome<SessionDeleteResult, OpenClawSessionMutationFailure>,
        OpenClawSessionError,
    > {
        let outcome = SessionOperation::new(Arc::clone(&self.client))
            .delete_session(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        Ok(session_mutation_outcome(outcome))
    }
}

impl OpenClawSessionGateway {
    pub async fn list_sessions(
        &self,
        params: SessionsListParams,
    ) -> Result<SessionsListResult, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .list_sessions(params)
            .await
            .map_err(Into::into)
    }

    pub async fn describe_session(
        &self,
        params: SessionDescribeParams,
    ) -> Result<Option<SessionDescribeRow>, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .describe_session(params)
            .await
            .map_err(Into::into)
    }

    pub async fn history(
        &self,
        params: ChatHistoryParams,
    ) -> Result<ChatHistoryResult, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .history(params)
            .await
            .map_err(Into::into)
    }

    pub async fn history_window(
        &self,
        params: ChatHistoryParams,
        request: PageRequest,
    ) -> Result<SessionWindow, OpenClawSessionError> {
        let payload = SessionOperation::new(Arc::clone(&self.client))
            .history_payload(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        window::decode_window(payload, request)
            .map_err(|error| OpenClawSessionError::Protocol(Some(error)))
    }

    pub fn replay_source_page(
        &self,
        session_key: SessionKey,
        request: PageRequest,
    ) -> Result<SessionReplaySourcePage, SessionReplaySourceError> {
        let Some(state_dir) = &self.state_dir else {
            return Err(SessionReplaySourceError::MissingStateDir);
        };
        crate::session::load_session_replay_source(state_dir, session_key, request)
    }

    pub fn materialize_session_replay(
        &self,
        source: SessionReplaySourcePage,
        source_epoch: Option<u64>,
        route_key: Option<String>,
    ) -> Result<CanonicalSessionReplay, SessionReplayError> {
        crate::session::materialize_session_replay(
            source.session_key().clone(),
            source.into_events(),
            source_epoch,
            route_key,
        )
    }

    pub async fn enqueue_chat(
        &self,
        params: ChatSendParams,
        route_key: String,
    ) -> Result<ChatSendResult, OpenClawSessionError> {
        let session_key = params.session_key().clone();
        let operation = SessionOperation::new(Arc::clone(&self.client));
        operation.subscribe_session_messages(&session_key).await?;
        self.client.register_session_route(&session_key, route_key);
        match operation.send_chat(params).await {
            Ok(InvocationOutcome::Succeeded(result)) => Ok(result),
            Ok(InvocationOutcome::TargetRejected(error)) => {
                self.client.unregister_session_route(&session_key);
                Err(error.into())
            }
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) => {
                self.client.unregister_session_route(&session_key);
                Err(OpenClawSessionError::UnknownResponse)
            }
            Err(error) => {
                self.client.unregister_session_route(&session_key);
                Err(error.into())
            }
        }
    }

    pub async fn send_chat(
        &self,
        params: ChatSendParams,
    ) -> Result<InvocationOutcome<ChatSendResult, OpenClawSessionError>, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .send_chat(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn wait_team_native_run(&self, input: AgentWait) -> NativeRunSettledOutcome {
        OpenClawAgents::new(Arc::clone(&self.client))
            .wait(input)
            .await
            .into()
    }

    pub async fn abort_chat(
        &self,
        params: ChatAbortParams,
    ) -> Result<InvocationOutcome<ChatAbortResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .abort_chat(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn abort_chat_diagnostic(
        &self,
        params: ChatAbortParams,
    ) -> Result<
        InvocationOutcome<ChatAbortResult, OpenClawSessionMutationFailure>,
        OpenClawSessionError,
    > {
        let outcome = SessionOperation::new(Arc::clone(&self.client))
            .abort_chat(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        Ok(session_mutation_outcome(outcome))
    }

    pub async fn patch_session_model(
        &self,
        params: SessionModelPatchParams,
    ) -> Result<
        InvocationOutcome<SessionModelPatchResult, OpenClawSessionError>,
        OpenClawSessionError,
    > {
        match self.patch_session_model_diagnostic(params).await? {
            InvocationOutcome::Succeeded(result) => Ok(InvocationOutcome::Succeeded(result)),
            InvocationOutcome::TargetRejected(_) => Ok(InvocationOutcome::TargetRejected(
                OpenClawSessionError::TargetRejected,
            )),
            InvocationOutcome::Cancelled => Ok(InvocationOutcome::Cancelled),
            InvocationOutcome::Unknown => Ok(InvocationOutcome::Unknown),
        }
    }

    pub async fn patch_session_model_diagnostic(
        &self,
        params: SessionModelPatchParams,
    ) -> Result<
        InvocationOutcome<SessionModelPatchResult, SessionModelPatchFailure>,
        OpenClawSessionError,
    > {
        let outcome = SessionOperation::new(Arc::clone(&self.client))
            .patch_session_model(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        Ok(session_model_patch_outcome(outcome))
    }

    pub async fn patch_session_label(
        &self,
        params: SessionLabelPatchParams,
    ) -> Result<
        InvocationOutcome<SessionLabelPatchResult, OpenClawSessionError>,
        OpenClawSessionError,
    > {
        SessionOperation::new(Arc::clone(&self.client))
            .patch_session_label(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn get_session_permission(
        &self,
        session_key: SessionKey,
    ) -> Result<SessionPermissionProjection, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .get_session_permission(session_key)
            .await
            .map_err(Into::into)
    }

    pub async fn set_session_permission(
        &self,
        params: SessionPermissionPatchParams,
    ) -> Result<
        InvocationOutcome<SessionPermissionProjection, OpenClawSessionError>,
        OpenClawSessionError,
    > {
        SessionOperation::new(Arc::clone(&self.client))
            .set_session_permission(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn create_session(
        &self,
        params: SessionCreateParams,
    ) -> Result<InvocationOutcome<SessionCreateResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .create_session(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn delete_session(
        &self,
        params: SessionDeleteParams,
    ) -> Result<InvocationOutcome<SessionDeleteResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .delete_session(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn delete_session_diagnostic(
        &self,
        params: SessionDeleteParams,
    ) -> Result<
        InvocationOutcome<SessionDeleteResult, OpenClawSessionMutationFailure>,
        OpenClawSessionError,
    > {
        let outcome = SessionOperation::new(Arc::clone(&self.client))
            .delete_session(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        Ok(session_mutation_outcome(outcome))
    }
}
