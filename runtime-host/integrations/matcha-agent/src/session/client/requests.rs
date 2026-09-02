use platform::exchange::InvocationOutcome;

use crate::{
    protocol::wire::{JsonRpcId, JsonRpcRequest, JsonRpcResponse},
    session::{
        approval::{
            ApprovalRespondParams, approval_respond_request, decode_approval_respond_result,
        },
        close::{
            SessionCloseParams, SessionCloseResult, decode_session_close_result,
            session_close_request,
        },
        model::{
            Sequence, SessionCancelResult, SessionId, SessionListResult, SessionPromptResult,
            SessionRecord, SessionSnapshot, SessionTranscriptResult,
        },
        models::{
            ModelsListParams, ModelsListResult, decode_models_list_result, models_list_request,
        },
        protocol_event::{
            EventsReplayParams, EventsSubscribeParams, EventsSubscribeResult, ReplayLimit,
            decode_events_replay_result, decode_events_subscribe_result, events_replay_request,
            events_subscribe_request,
        },
        request::{
            ResponseError, SessionCancelParams, SessionCreateParams, SessionLoadParams,
            SessionPromptParams, SessionSetModeParams, SessionSetModelParams,
            SessionSnapshotParams, SessionTranscriptParams, decode_session_cancel_result,
            decode_session_create_result, decode_session_list_result, decode_session_load_result,
            decode_session_prompt_result, decode_session_set_mode_result,
            decode_session_set_model_result, decode_session_snapshot_result,
            decode_session_transcript_result, session_cancel_request, session_create_request,
            session_list_request, session_load_request, session_prompt_request,
            session_set_mode_request, session_set_model_request, session_snapshot_request,
            session_transcript_request,
        },
    },
};

use super::{
    AppServerClient, AppServerClientError, EventRecovery, EventRecoveryCursor, EventReplay,
    EventReplayPayload, EventSubscription, EventSubscriptionCursor, connection::Delivery,
    next_json_rpc_id,
};

impl AppServerClient {
    pub async fn create_session(
        &self,
        params: SessionCreateParams,
    ) -> InvocationOutcome<SessionRecord, AppServerClientError> {
        let id = match next_json_rpc_id() {
            Ok(id) => id,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let request = match session_create_request(id, params) {
            Ok(request) => request,
            Err(_) => return InvocationOutcome::TargetRejected(AppServerClientError::Protocol),
        };
        self.mutate(request, decode_session_create_result).await
    }

    /// Ensures a native session exists without replaying an uncertain create.
    ///
    /// The app-server owns cwd canonicalization, sensitive-root rejection, and
    /// its private session metadata. This client only performs the native
    /// load/create/readback exchange and never stores a session shadow record.
    pub async fn load_or_create_session(
        &self,
        session_id: SessionId,
        params: SessionCreateParams,
    ) -> InvocationOutcome<SessionRecord, AppServerClientError> {
        match self
            .load_session(SessionLoadParams::new(session_id.clone()))
            .await
        {
            Ok(session) => confirm_session_identity(session, &session_id),
            Err(AppServerClientError::SessionNotFound) => match self.create_session(params).await {
                InvocationOutcome::Succeeded(session) => {
                    confirm_session_identity(session, &session_id)
                }
                InvocationOutcome::TargetRejected(error) => {
                    InvocationOutcome::TargetRejected(error)
                }
                InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
                    InvocationOutcome::Unknown
                }
            },
            Err(_) => InvocationOutcome::Unknown,
        }
    }

    pub async fn load_session(
        &self,
        params: SessionLoadParams,
    ) -> Result<SessionRecord, AppServerClientError> {
        let request = session_load_request(next_json_rpc_id()?, params)
            .map_err(|_| AppServerClientError::Protocol)?;
        self.read(request, decode_session_load_result).await
    }

    pub async fn list_sessions(&self) -> Result<SessionListResult, AppServerClientError> {
        self.read(
            session_list_request(next_json_rpc_id()?),
            decode_session_list_result,
        )
        .await
    }

    pub async fn transcript_session(
        &self,
        params: SessionTranscriptParams,
    ) -> Result<SessionTranscriptResult, AppServerClientError> {
        let request = session_transcript_request(next_json_rpc_id()?, params)
            .map_err(|_| AppServerClientError::Protocol)?;
        self.read(request, decode_session_transcript_result).await
    }

    pub async fn prompt_session(
        &self,
        params: SessionPromptParams,
    ) -> InvocationOutcome<SessionPromptResult, AppServerClientError> {
        let id = match next_json_rpc_id() {
            Ok(id) => id,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let request = match session_prompt_request(id, params) {
            Ok(request) => request,
            Err(_) => return InvocationOutcome::TargetRejected(AppServerClientError::Protocol),
        };
        self.mutate(request, decode_session_prompt_result).await
    }

    pub async fn cancel_session(
        &self,
        params: SessionCancelParams,
    ) -> InvocationOutcome<SessionCancelResult, AppServerClientError> {
        let id = match next_json_rpc_id() {
            Ok(id) => id,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let request = match session_cancel_request(id, params) {
            Ok(request) => request,
            Err(_) => return InvocationOutcome::TargetRejected(AppServerClientError::Protocol),
        };
        self.mutate(request, decode_session_cancel_result).await
    }

    /// Closes one logical session through the native app-server owner.
    ///
    /// # Errors
    ///
    /// Returns a target-rejected or unknown outcome when the close cannot be
    /// confirmed.
    ///
    /// A successful result confirms that the server completed its session-close
    /// sequence. It intentionally does not expose the returned pre-removal
    /// session record as an active local state.
    pub async fn close_session(
        &self,
        params: SessionCloseParams,
    ) -> InvocationOutcome<SessionCloseResult, AppServerClientError> {
        let id = match next_json_rpc_id() {
            Ok(id) => id,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let request = match session_close_request(id, params) {
            Ok(request) => request,
            Err(_) => return InvocationOutcome::TargetRejected(AppServerClientError::Protocol),
        };
        self.mutate(request, decode_session_close_result).await
    }

    /// Lists native app-server model identifiers without exposing a wire payload.
    ///
    /// # Errors
    ///
    /// Returns a fixed error if the request cannot be completed or decoded.
    pub async fn list_models(
        &self,
        params: ModelsListParams,
    ) -> Result<ModelsListResult, AppServerClientError> {
        let request = models_list_request(next_json_rpc_id()?, params)
            .map_err(|_| AppServerClientError::Protocol)?;
        self.read(request, decode_models_list_result).await
    }

    pub async fn respond_to_approval(
        &self,
        params: ApprovalRespondParams,
    ) -> InvocationOutcome<(), AppServerClientError> {
        let id = match next_json_rpc_id() {
            Ok(id) => id,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let request = match approval_respond_request(id, params) {
            Ok(request) => request,
            Err(_) => return InvocationOutcome::TargetRejected(AppServerClientError::Protocol),
        };
        self.mutate(request, decode_approval_respond_result).await
    }

    pub async fn snapshot_session(
        &self,
        params: SessionSnapshotParams,
    ) -> Result<SessionSnapshot, AppServerClientError> {
        let request = session_snapshot_request(next_json_rpc_id()?, params)
            .map_err(|_| AppServerClientError::Protocol)?;
        self.read(request, decode_session_snapshot_result).await
    }

    pub async fn set_session_model(
        &self,
        params: SessionSetModelParams,
    ) -> InvocationOutcome<SessionRecord, AppServerClientError> {
        let id = match next_json_rpc_id() {
            Ok(id) => id,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let request = match session_set_model_request(id, params) {
            Ok(request) => request,
            Err(_) => return InvocationOutcome::TargetRejected(AppServerClientError::Protocol),
        };
        self.mutate(request, decode_session_set_model_result).await
    }

    pub async fn set_session_mode(
        &self,
        params: SessionSetModeParams,
    ) -> InvocationOutcome<SessionRecord, AppServerClientError> {
        let id = match next_json_rpc_id() {
            Ok(id) => id,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
        let request = match session_set_mode_request(id, params) {
            Ok(request) => request,
            Err(_) => return InvocationOutcome::TargetRejected(AppServerClientError::Protocol),
        };
        self.mutate(request, decode_session_set_mode_result).await
    }

    /// Replays a bounded event range into the single ingress cursor.
    ///
    /// # Errors
    ///
    /// Returns [`AppServerClientError::EventRecoveryRequired`] when ingress
    /// observations reveal a gap, overflow, or interrupted recovery.
    pub async fn replay_events(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
        limit: Option<ReplayLimit>,
    ) -> Result<EventReplay, AppServerClientError> {
        Ok(self
            .replay_event_payload(session_id, after, limit)
            .await?
            .summary())
    }

    pub(crate) async fn replay_event_payload(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
        limit: Option<ReplayLimit>,
    ) -> Result<EventReplayPayload, AppServerClientError> {
        let mut params = EventsReplayParams::new(session_id.clone());
        if let Some(after) = after {
            params = params.after(after);
        }
        if let Some(limit) = limit {
            params = params.with_limit(limit);
        }
        let request = events_replay_request(next_json_rpc_id()?, params)
            .map_err(|_| AppServerClientError::Protocol)?;
        self.ingress
            .begin_replay(session_id.clone(), after)
            .await
            .map_err(AppServerClientError::from_ingress)?;
        let replay = match self.read(request, decode_events_replay_result).await {
            Ok(replay) => replay,
            Err(error) => {
                self.ingress.abort().await;
                return Err(error);
            }
        };
        self.ingress
            .settle_replay_payload(session_id, after, replay.events)
            .await
            .map_err(AppServerClientError::from_ingress)
    }

    /// Recovers the app-server event stream from a session-bound replay cursor.
    ///
    /// The returned cursor is safe to persist as a replay lower bound for this
    /// same logical session. It cannot be substituted for a run or message ID.
    ///
    /// # Errors
    ///
    /// Returns [`AppServerClientError::EventRecoveryRequired`] if the replay
    /// cannot establish a contiguous cursor.
    pub async fn recover_events(
        &self,
        cursor: EventRecoveryCursor,
        limit: Option<ReplayLimit>,
    ) -> Result<EventRecovery, AppServerClientError> {
        let replay = self
            .replay_events(cursor.session_id().clone(), Some(cursor.sequence()), limit)
            .await?;
        Ok(EventRecovery::new(
            cursor.advanced_to(replay.cursor()),
            replay.event_count(),
        ))
    }

    pub async fn subscribe_events(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
    ) -> Result<EventSubscription, AppServerClientError> {
        match self.subscribe_events_with_cursor(session_id, after).await? {
            EventSubscriptionCursor::Subscribed(_) => Ok(EventSubscription::Subscribed),
            EventSubscriptionCursor::ClientNotFound => Ok(EventSubscription::ClientNotFound),
            EventSubscriptionCursor::ClientRequired => Ok(EventSubscription::ClientRequired),
        }
    }

    pub async fn subscribe_events_with_cursor(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
    ) -> Result<EventSubscriptionCursor, AppServerClientError> {
        let mut params = EventsSubscribeParams::new(session_id.clone());
        if let Some(after) = after {
            params = params.after(after);
        }
        let request = events_subscribe_request(next_json_rpc_id()?, params)
            .map_err(|_| AppServerClientError::Protocol)?;
        self.ingress
            .begin_subscription(session_id.clone(), after)
            .await
            .map_err(AppServerClientError::from_ingress)?;
        let result = match self.read(request, decode_events_subscribe_result).await {
            Ok(result) => result,
            Err(error) => {
                self.ingress.abort().await;
                return Err(error);
            }
        };
        match result {
            EventsSubscribeResult::Subscribed {
                session_id: returned_session,
                after_seq,
                last_seq,
                ..
            } if returned_session == session_id
                && after_seq
                    .is_none_or(|returned| returned == after.unwrap_or_else(zero_sequence)) =>
            {
                let replay = self
                    .ingress
                    .settle_subscription(session_id, after, last_seq)
                    .await
                    .map_err(AppServerClientError::from_ingress)?;
                Ok(EventSubscriptionCursor::Subscribed(replay))
            }
            EventsSubscribeResult::Subscribed { .. } => {
                self.ingress.abort().await;
                Err(AppServerClientError::Protocol)
            }
            EventsSubscribeResult::ClientNotFound { .. } => {
                self.ingress.abort().await;
                Ok(EventSubscriptionCursor::ClientNotFound)
            }
            EventsSubscribeResult::ClientRequired => {
                self.ingress.abort().await;
                Ok(EventSubscriptionCursor::ClientRequired)
            }
        }
    }

    async fn read<T>(
        &self,
        request: JsonRpcRequest,
        decode: fn(&JsonRpcId, JsonRpcResponse) -> Result<T, ResponseError>,
    ) -> Result<T, AppServerClientError> {
        let expected_id = request.id.clone();
        let response = self
            .connection
            .exchange(request, super::REQUEST_DEADLINE)
            .await
            .map_err(AppServerClientError::from_exchange)?;
        decode(&expected_id, response).map_err(AppServerClientError::from_response)
    }

    async fn mutate<T>(
        &self,
        request: JsonRpcRequest,
        decode: fn(&JsonRpcId, JsonRpcResponse) -> Result<T, ResponseError>,
    ) -> InvocationOutcome<T, AppServerClientError> {
        let expected_id = request.id.clone();
        match self
            .connection
            .exchange(request, super::REQUEST_DEADLINE)
            .await
        {
            Ok(response) => match decode(&expected_id, response) {
                Ok(result) => InvocationOutcome::Succeeded(result),
                Err(ResponseError::Remote {
                    session_not_found: true,
                    ..
                }) => InvocationOutcome::TargetRejected(AppServerClientError::SessionNotFound),
                Err(ResponseError::Remote {
                    session_not_found: false,
                    ..
                }) => InvocationOutcome::TargetRejected(AppServerClientError::PeerRejected),
                Err(_) => InvocationOutcome::Unknown,
            },
            Err(failure) if failure.delivery() == Delivery::NotWritten => {
                InvocationOutcome::TargetRejected(AppServerClientError::from_exchange(failure))
            }
            Err(_) => InvocationOutcome::Unknown,
        }
    }
}

fn confirm_session_identity(
    session: SessionRecord,
    expected: &SessionId,
) -> InvocationOutcome<SessionRecord, AppServerClientError> {
    if session.session_id == *expected {
        InvocationOutcome::Succeeded(session)
    } else {
        InvocationOutcome::Unknown
    }
}

fn zero_sequence() -> Sequence {
    Sequence::try_new(0).expect("zero is a valid replay cursor")
}
