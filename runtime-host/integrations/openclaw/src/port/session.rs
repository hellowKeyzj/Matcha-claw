use std::sync::{Arc, atomic::{AtomicU64, Ordering}};

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
            ChatSendResult, SessionAbortParams, SessionAbortResult, SessionCreateParams,
            SessionCreateResult, SessionDeleteParams, SessionDeleteResult, SessionDescribeParams,
            SessionDescribeRow, SessionKey, SessionLabelPatchParams, SessionLabelPatchResult,
            SessionModelPatchParams, SessionModelPatchResult, SessionPermissionPatchParams,
            SessionPermissionProjection, SessionsListParams, SessionsListResult,
        },
    },
    team::NativeRunSettledOutcome,
};

pub(crate) fn validate_observation_identity(identity: &sessions_module::state::SessionIdentity) -> Result<(), sessions_module::ports::RuntimeOperationFailure> {
    use crate::session::protocol::{AgentId, AgentScopedSessionKey, EndpointSessionId};
    use sessions_module::ports::RuntimeOperationFailure;
    identity.validate().map_err(|_| RuntimeOperationFailure::TargetRejected)?;
    if identity.endpoint != sessions_module::state::SessionEndpoint::local(sessions_module::state::SessionProvider::OpenClaw) { return Err(RuntimeOperationFailure::TargetRejected); }
    let agent = AgentId::try_new(identity.agent_id.clone()).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
    let prefix = format!("agent:{}:", agent.as_str());
    let endpoint = identity.session_key.strip_prefix(&prefix).ok_or(RuntimeOperationFailure::TargetRejected)?;
    let endpoint = EndpointSessionId::try_new(endpoint.to_owned()).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
    let key = AgentScopedSessionKey::try_new(agent, endpoint).map_err(|_| RuntimeOperationFailure::TargetRejected)?;
    if key.as_str() != identity.session_key { return Err(RuntimeOperationFailure::TargetRejected); }
    Ok(())
}

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
    ) -> Result<CanonicalSessionReplay, SessionReplayError> {
        crate::session::materialize_session_replay(
            source.session_key().clone(),
            source.into_events(),
            source_epoch,
        )
    }

    pub async fn enqueue_chat(
        &mut self,
        params: ChatSendParams,
    ) -> Result<ChatSendResult, OpenClawSessionError> {
        match SessionOperation::new(Arc::clone(&self.client)).send_chat(params).await {
            Ok(InvocationOutcome::Succeeded(result)) => Ok(result),
            Ok(InvocationOutcome::TargetRejected(error)) => Err(error.into()),
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) => Err(OpenClawSessionError::UnknownResponse),
            Err(error) => Err(error.into()),
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

struct OpenClawObservation {
    client: Arc<GatewayClient>,
    identity: sessions_module::state::SessionIdentity,
    generation: Arc<AtomicU64>,
}

impl sessions_module::ports::SessionObservation for OpenClawObservation {
    fn sync<'a>(&'a self, command: sessions_module::timeline::Command, epoch: u64) -> sessions_module::SessionFuture<'a, Result<sessions_module::ports::SessionSync, sessions_module::ports::RuntimeOperationFailure>> {
        Box::pin(async move {
            if command.identity() != &self.identity { return Err(sessions_module::ports::RuntimeOperationFailure::TargetRejected); }
            let page = crate::session::adapters::timeline::openclaw_page_request(&command).map_err(|_| sessions_module::ports::RuntimeOperationFailure::TargetRejected)?;
            self.client.sync_observation(&self.identity, self.generation.load(Ordering::Acquire), page, epoch).await
        })
    }

    fn restart(&self, generation: u64) -> sessions_module::ports::OwnedRuntimeFuture<Result<(), sessions_module::ports::RuntimeOperationFailure>> {
        let client = Arc::clone(&self.client);
        let identity = self.identity.clone();
        let current = Arc::clone(&self.generation);
        Box::pin(async move {
            let previous_generation = current.load(Ordering::Acquire);
            if crate::session::trace::enabled() {
                crate::session::trace::log_unscoped("runtime.openclaw.observation.restart.handle_request", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&identity), "generation": previous_generation, "nextGeneration": generation }));
            }
            let result = client.restart_observation(&identity, previous_generation, generation).await;
            if crate::session::trace::enabled() {
                crate::session::trace::log_unscoped("runtime.openclaw.observation.restart.handle_result", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&identity), "generation": previous_generation, "nextGeneration": generation,
                    "completed": result.is_ok() }));
            }
            result?;
            current.store(generation, Ordering::Release);
            if crate::session::trace::enabled() {
                crate::session::trace::log_unscoped("runtime.openclaw.observation.restart.generation_stored", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&identity), "generation": generation, "previousGeneration": previous_generation }));
            }
            Ok(())
        })
    }

    fn close(&self) -> sessions_module::ports::OwnedRuntimeFuture<()> {
        let client = Arc::clone(&self.client);
        let identity = self.identity.clone();
        let generation = Arc::clone(&self.generation);
        Box::pin(async move { client.close_observation(identity, generation.load(Ordering::Acquire)).await; })
    }
}

impl OpenClawSessionGateway {
    pub(crate) fn supports_goal(&self) -> bool { self.client.supports_goal() }

    pub(crate) async fn goal_availability(&self) -> Result<(), sessions_module::ports::RuntimeOperationFailure> { self.client.goal_availability().await }

    pub(crate) async fn start_goal(&self, params: ChatSendParams) -> Result<InvocationOutcome<sessions_module::goal::SessionGoalReceipt, OpenClawSessionError>, sessions_module::ports::RuntimeOperationFailure> {
        SessionOperation::new(Arc::clone(&self.client)).goal_start(params).await.map(port_outcome)
    }

    pub(crate) async fn mutate_goal(&self, command: &sessions_module::goal::SessionGoalCommand) -> Result<InvocationOutcome<sessions_module::goal::SessionGoalReceipt, OpenClawSessionError>, sessions_module::ports::RuntimeOperationFailure> {
        SessionOperation::new(Arc::clone(&self.client)).mutate_goal_command(command).await.map(port_outcome)
    }

    pub(crate) fn prepare_observation(&self, request: sessions_module::ports::SessionObservationRequest) -> Result<Arc<dyn sessions_module::ports::SessionObservation>, sessions_module::ports::RuntimeOperationFailure> {
        validate_observation_identity(&request.identity)?;
        if request.generation == 0 || request.generation > 9_007_199_254_740_991 { return Err(sessions_module::ports::RuntimeOperationFailure::TargetRejected); }
        let identity = request.identity.clone();
        let generation = request.generation;
        self.client.prepare_observation(request)?;
        Ok(Arc::new(OpenClawObservation { client: Arc::clone(&self.client), identity, generation: Arc::new(AtomicU64::new(generation)) }))
    }

    pub(crate) async fn history_for_identity(&self, identity: &sessions_module::state::SessionIdentity, page: PageRequest, cursor: Option<String>) -> Result<SessionWindow, OpenClawSessionError> {
        validate_observation_identity(identity).map_err(|_| OpenClawSessionError::TargetRejected)?;
        let key = SessionKey::try_new(identity.session_key.clone()).map_err(|_| OpenClawSessionError::TargetRejected)?;
        let params = ChatHistoryParams::new(key).try_for_agent(identity.agent_id.clone()).map_err(|_| OpenClawSessionError::TargetRejected)?;
        if matches!(page.direction(), window::Direction::Latest) && page.limit() > 0 {
            let mut params = params.try_with_limit(page.limit() as u64).map_err(|_| OpenClawSessionError::TargetRejected)?;
            if let Some(cursor) = cursor { params = params.try_with_cursor(cursor).map_err(|_| OpenClawSessionError::TargetRejected)?; }
            return self.history_window(params, page).await;
        }
        // An exhausted native page returns the authoritative count without reading a tail body.
        let operation = SessionOperation::new(Arc::clone(&self.client));
        let count_params = params.clone().try_with_limit(1).and_then(|params| params.try_with_offset(9_007_199_254_740_991))
            .map_err(|_| OpenClawSessionError::TargetRejected)?;
        let count_payload = operation.history_payload(count_params).await.map_err(OpenClawSessionError::from)?;
        let mut total = window::decode_total_messages(&count_payload).map_err(|error| OpenClawSessionError::Protocol(Some(error)))?;
        let requested = window::window_range(total, page);
        if requested.start() == requested.end() {
            let empty_page = PageRequest::new(page.direction(), 0, page.offset()).ok_or(OpenClawSessionError::TargetRejected)?;
            return window::decode_window(count_payload, empty_page).map_err(|error| OpenClawSessionError::Protocol(Some(error)));
        }
        let mut end = requested.end();
        for attempt in 0..2 {
            let read_params = params.clone().try_with_limit(PageRequest::MAX_LIMIT as u64)
                .and_then(|params| params.try_with_offset(total.saturating_sub(end) as u64))
                .map_err(|_| OpenClawSessionError::TargetRejected)?;
            let payload = operation.history_payload(read_params).await.map_err(OpenClawSessionError::from)?;
            total = window::decode_total_messages(&payload).map_err(|error| OpenClawSessionError::Protocol(Some(error)))?;
            let window = window::decode_window(payload, page).map_err(|error| OpenClawSessionError::Protocol(Some(error)))?;
            let requested = window::window_range(total, page);
            let range = window.range();
            let covered = match page.direction() {
                window::Direction::Older => range.end() == requested.end() && range.start() < range.end(),
                window::Direction::Newer => range.start() == requested.start() && range.end() > range.start(),
                window::Direction::Latest => unreachable!(),
            };
            if covered { return Ok(window); }
            if attempt == 0 {
                // Rebase once after append; a dense newer page reads its first source group.
                end = match page.direction() {
                    window::Direction::Newer => requested.start().saturating_add(1).min(total),
                    _ => requested.end(),
                };
            }
        }
        Err(OpenClawSessionError::Protocol(None))
    }

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
    ) -> Result<CanonicalSessionReplay, SessionReplayError> {
        crate::session::materialize_session_replay(
            source.session_key().clone(),
            source.into_events(),
            source_epoch,
        )
    }

    pub async fn enqueue_chat(
        &self,
        params: ChatSendParams,
    ) -> Result<ChatSendResult, OpenClawSessionError> {
        match SessionOperation::new(Arc::clone(&self.client)).send_chat(params).await {
            Ok(InvocationOutcome::Succeeded(result)) => Ok(result),
            Ok(InvocationOutcome::TargetRejected(error)) => Err(error.into()),
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) => Err(OpenClawSessionError::UnknownResponse),
            Err(error) => Err(error.into()),
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

    pub async fn abort_session(
        &self,
        params: SessionAbortParams,
    ) -> Result<InvocationOutcome<SessionAbortResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .abort_session(params)
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
