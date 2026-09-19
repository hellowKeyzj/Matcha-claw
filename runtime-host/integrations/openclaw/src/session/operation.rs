use std::{fmt, sync::Arc};

use platform::exchange::InvocationOutcome;
use serde::Serialize;
use serde_json::Value;

use crate::{
    agents::{AgentsReadFailure, OpenClawAgents},
    gateway::{
        client::{GatewayClient, GatewayClientError},
        delivery::MutationDelivery,
        wire::{self, GatewayResponse},
    },
};

use super::protocol::{
    self, ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
    ChatSendResult, SessionCreateParams, SessionCreateResult, SessionDeleteParams,
    SessionDeleteResult, SessionDescribeParams, SessionDescribeRow, SessionLabelPatchParams,
    SessionLabelPatchResult, SessionModelPatchParams, SessionModelPatchResult,
    SessionPermissionMode, SessionPermissionPatchParams, SessionPermissionProjection,
    SessionsListParams, SessionsListResult,
};

static NEXT_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub(crate) struct SessionOperation {
    gateway: Arc<GatewayClient>,
}

impl SessionOperation {
    pub(crate) fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub(crate) async fn list_sessions(
        &self,
        params: SessionsListParams,
    ) -> Result<SessionsListResult, OperationError> {
        let request_id = next_request_id("sessions-list")?;
        let request = request(&request_id, protocol::SESSIONS_LIST_METHOD, params)?;
        let response = self
            .gateway
            .rpc_query(request)
            .await
            .map_err(OperationError::from)?;
        protocol::decode_sessions_list_result(&request_id, response).map_err(OperationError::from)
    }

    pub(crate) async fn describe_session(
        &self,
        params: SessionDescribeParams,
    ) -> Result<Option<SessionDescribeRow>, OperationError> {
        let request_id = next_request_id("sessions-describe")?;
        let request = request(&request_id, protocol::SESSIONS_DESCRIBE_METHOD, params)?;
        let response = self
            .gateway
            .rpc_query(request)
            .await
            .map_err(OperationError::from)?;
        protocol::decode_session_describe_result(&request_id, response)
            .map_err(OperationError::from)
    }

    pub(crate) async fn history(
        &self,
        params: ChatHistoryParams,
    ) -> Result<ChatHistoryResult, OperationError> {
        let limit = params.limit();
        let request_id = next_request_id("chat-history")?;
        let request = request(&request_id, protocol::CHAT_HISTORY_METHOD, params)?;
        let response = self
            .gateway
            .rpc_query(request)
            .await
            .map_err(OperationError::from)?;
        protocol::decode_chat_history_result(&request_id, response, limit)
            .map_err(OperationError::from)
    }

    pub(crate) async fn history_payload(
        &self,
        params: ChatHistoryParams,
    ) -> Result<Value, OperationError> {
        let request_id = next_request_id("chat-history")?;
        let request = request(&request_id, protocol::CHAT_HISTORY_METHOD, params)?;
        let response = self
            .gateway
            .rpc_query(request)
            .await
            .map_err(OperationError::from)?;
        payload(&request_id, response)
    }

    pub(crate) async fn subscribe_session_messages(
        &self,
        session_key: &protocol::SessionKey,
    ) -> Result<(), OperationError> {
        let request_id = next_request_id("sessions-messages-subscribe")?;
        let request = wire::sessions_messages_subscribe_request(
            request_id.clone(),
            session_key.as_str().to_owned(),
        )?;
        let response = self
            .gateway
            .rpc_query(request)
            .await
            .map_err(OperationError::from)?;
        wire::decode_sessions_messages_subscribe(response).map_err(OperationError::from)
    }

    pub(crate) async fn send_chat(
        &self,
        params: ChatSendParams,
    ) -> Result<InvocationOutcome<ChatSendResult, OperationError>, OperationError> {
        let request_id = next_request_id("chat-send")?;
        let request = request(&request_id, protocol::CHAT_SEND_METHOD, params)?;
        Ok(self
            .mutate(request, |response| {
                protocol::decode_chat_send_result(&request_id, response)
            })
            .await)
    }

    pub(crate) async fn abort_chat(
        &self,
        params: ChatAbortParams,
    ) -> Result<InvocationOutcome<ChatAbortResult, OperationError>, OperationError> {
        let request_id = next_request_id("chat-abort")?;
        let request = request(&request_id, protocol::CHAT_ABORT_METHOD, params)?;
        Ok(self
            .mutate(request, |response| {
                protocol::decode_chat_abort_result(&request_id, response)
            })
            .await)
    }

    pub(crate) async fn patch_session_model(
        &self,
        params: SessionModelPatchParams,
    ) -> Result<InvocationOutcome<SessionModelPatchResult, OperationError>, OperationError> {
        let expected_key = params.key().clone();
        let request_id = next_request_id("sessions-patch-model")?;
        let request = request(&request_id, protocol::SESSIONS_PATCH_METHOD, params)?;
        Ok(self
            .mutate(request, |response| {
                protocol::decode_session_model_patch_result(&request_id, response, &expected_key)
            })
            .await)
    }

    pub(crate) async fn patch_session_label(
        &self,
        params: SessionLabelPatchParams,
    ) -> Result<InvocationOutcome<SessionLabelPatchResult, OperationError>, OperationError> {
        let expected_key = params.key().clone();
        let request_id = next_request_id("sessions-patch-label")?;
        let request = request(&request_id, protocol::SESSIONS_PATCH_METHOD, params)?;
        Ok(self
            .mutate(request, |response| {
                protocol::decode_session_label_patch_result(&request_id, response, &expected_key)
            })
            .await)
    }

    pub(crate) async fn get_session_permission(
        &self,
        session_key: protocol::SessionKey,
    ) -> Result<SessionPermissionProjection, OperationError> {
        self.session_permission_projection(session_key).await
    }

    pub(crate) async fn set_session_permission(
        &self,
        params: SessionPermissionPatchParams,
    ) -> Result<InvocationOutcome<SessionPermissionProjection, OperationError>, OperationError>
    {
        let expected_key = params.key().clone();
        let request_id = next_request_id("sessions-patch-permission")?;
        let request = request(&request_id, protocol::SESSIONS_PATCH_METHOD, params)?;
        match self
            .mutate(request, |response| {
                protocol::decode_session_permission_patch_result(
                    &request_id,
                    response,
                    &expected_key,
                )
            })
            .await
        {
            InvocationOutcome::Succeeded(_) => self
                .session_permission_projection(expected_key)
                .await
                .map(InvocationOutcome::Succeeded),
            InvocationOutcome::TargetRejected(error) => {
                Ok(InvocationOutcome::TargetRejected(error))
            }
            InvocationOutcome::Cancelled => Ok(InvocationOutcome::Cancelled),
            InvocationOutcome::Unknown => Ok(InvocationOutcome::Unknown),
        }
    }

    pub(crate) async fn create_session(
        &self,
        params: SessionCreateParams,
    ) -> Result<InvocationOutcome<SessionCreateResult, OperationError>, OperationError> {
        let expected_key = params.key().clone();
        let request_id = next_request_id("sessions-create")?;
        let request = request(&request_id, protocol::SESSIONS_CREATE_METHOD, params)?;
        Ok(self
            .mutate(request, |response| {
                protocol::decode_session_create_result(&request_id, response, &expected_key)
            })
            .await)
    }

    pub(crate) async fn delete_session(
        &self,
        params: SessionDeleteParams,
    ) -> Result<InvocationOutcome<SessionDeleteResult, OperationError>, OperationError> {
        let expected_key = params.key().clone();
        let request_id = next_request_id("sessions-delete")?;
        let request = request(&request_id, protocol::SESSIONS_DELETE_METHOD, params)?;
        Ok(self
            .mutate(request, |response| {
                protocol::decode_session_delete_result(&request_id, response, &expected_key)
            })
            .await)
    }

    async fn session_permission_projection(
        &self,
        session_key: protocol::SessionKey,
    ) -> Result<SessionPermissionProjection, OperationError> {
        let params = SessionsListParams::default()
            .try_with_limit(100)?
            .try_with_search(session_key.as_str())?;
        let result = self.list_sessions(params).await?;
        let Some(summary) = result
            .sessions
            .into_iter()
            .find(|summary| summary.key == session_key)
        else {
            return Ok(SessionPermissionProjection::unsupported(
                "OpenClaw session was not found",
            ));
        };
        let default_mode = match summary.agent_id.as_ref() {
            Some(agent_id) => self.default_permission_mode(agent_id.as_str()).await?,
            None => None,
        };
        Ok(SessionPermissionProjection::supported(
            summary.permission_mode,
            default_mode,
            summary.permission_mode_pending.unwrap_or(false),
            true,
        ))
    }

    async fn default_permission_mode(
        &self,
        agent_id: &str,
    ) -> Result<Option<SessionPermissionMode>, OperationError> {
        let agents = OpenClawAgents::new(Arc::clone(&self.gateway))
            .list()
            .await
            .map_err(OperationError::from)?;
        let Some(agent) = agents.agents.iter().find(|agent| agent.id == agent_id) else {
            return Ok(None);
        };
        agent
            .default_permission_mode
            .as_deref()
            .map(|mode| serde_json::from_value(Value::String(mode.to_owned())))
            .transpose()
            .map_err(|_| OperationError::Protocol)
    }

    async fn mutate<T>(
        &self,
        request: wire::RpcRequest,
        decode: impl FnOnce(GatewayResponse) -> Result<T, protocol::ProtocolError>,
    ) -> InvocationOutcome<T, OperationError> {
        let request_id = request.request_id().to_owned();
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(response) if response.request_id() != request_id => {
                InvocationOutcome::TargetRejected(OperationError::UnknownResponse)
            }
            MutationDelivery::Response(GatewayResponse::Failure { error, .. }) => {
                InvocationOutcome::TargetRejected(OperationError::gateway_rejected(error))
            }
            MutationDelivery::Response(response) => match decode(response) {
                Ok(result) => InvocationOutcome::Succeeded(result),
                Err(protocol::ProtocolError::Rejected) => {
                    InvocationOutcome::TargetRejected(OperationError::Rejected)
                }
                Err(error) => InvocationOutcome::TargetRejected(OperationError::from(error)),
            },
            MutationDelivery::NotWritten(error) | MutationDelivery::MayHaveReached(error) => {
                let _ = error;
                InvocationOutcome::Unknown
            }
        }
    }
}

impl fmt::Debug for SessionOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionOperation")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) enum OperationError {
    RequestIdExhausted,
    RequestDeadline,
    ConnectionClosed,
    UnknownResponse,
    Transport,
    Protocol,
    Rejected,
    GatewayRejected {
        code: String,
        message: String,
        retryable: Option<bool>,
    },
}

impl OperationError {
    fn gateway_rejected(error: wire::GatewayError) -> Self {
        Self::GatewayRejected {
            code: error.code().to_owned(),
            message: error.message().to_owned(),
            retryable: error.retryable(),
        }
    }

    pub(crate) fn gateway_rejection(&self) -> Option<(&str, &str)> {
        match self {
            Self::GatewayRejected { code, message, .. } => Some((code, message)),
            _ => None,
        }
    }
}

impl fmt::Debug for OperationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RequestIdExhausted => formatter.write_str("RequestIdExhausted"),
            Self::RequestDeadline => formatter.write_str("RequestDeadline"),
            Self::ConnectionClosed => formatter.write_str("ConnectionClosed"),
            Self::UnknownResponse => formatter.write_str("UnknownResponse"),
            Self::Transport => formatter.write_str("Transport"),
            Self::Protocol => formatter.write_str("Protocol"),
            Self::Rejected => formatter.write_str("Rejected"),
            Self::GatewayRejected { code, .. } => formatter
                .debug_struct("GatewayRejected")
                .field("code", code)
                .field("message", &"[REDACTED]")
                .finish(),
        }
    }
}

impl From<GatewayClientError> for OperationError {
    fn from(value: GatewayClientError) -> Self {
        match value {
            GatewayClientError::RpcDeadline => Self::RequestDeadline,
            GatewayClientError::ConnectionClosed => Self::ConnectionClosed,
            GatewayClientError::Protocol | GatewayClientError::RpcFailed => Self::Protocol,
            _ => Self::Transport,
        }
    }
}

impl From<protocol::ValidationError> for OperationError {
    fn from(_: protocol::ValidationError) -> Self {
        Self::Protocol
    }
}

impl From<AgentsReadFailure> for OperationError {
    fn from(value: AgentsReadFailure) -> Self {
        match value {
            AgentsReadFailure::Unavailable => Self::Transport,
            AgentsReadFailure::Protocol => Self::Protocol,
            AgentsReadFailure::Rejected => Self::Rejected,
        }
    }
}

impl From<protocol::ProtocolError> for OperationError {
    fn from(value: protocol::ProtocolError) -> Self {
        match value {
            protocol::ProtocolError::Rejected => Self::Rejected,
            protocol::ProtocolError::MismatchedResponse => Self::UnknownResponse,
            _ => Self::Protocol,
        }
    }
}

impl From<wire::WireError> for OperationError {
    fn from(_: wire::WireError) -> Self {
        Self::Protocol
    }
}

fn request<P: Serialize>(
    request_id: &str,
    method: &'static str,
    params: P,
) -> Result<wire::RpcRequest, OperationError> {
    let params = serde_json::to_value(params).map_err(|_| OperationError::Protocol)?;
    wire::session_request(request_id.to_owned(), method, params).map_err(Into::into)
}

fn payload(request_id: &str, response: GatewayResponse) -> Result<Value, OperationError> {
    if response.request_id() != request_id {
        return Err(OperationError::UnknownResponse);
    }
    match response {
        GatewayResponse::Success {
            payload: Some(payload),
            ..
        } => Ok(payload),
        GatewayResponse::Success { payload: None, .. } => Err(OperationError::Protocol),
        GatewayResponse::Failure { .. } => Err(OperationError::Rejected),
    }
}

fn next_request_id(operation: &str) -> Result<String, OperationError> {
    let sequence = NEXT_REQUEST_ID
        .fetch_update(
            std::sync::atomic::Ordering::Relaxed,
            std::sync::atomic::Ordering::Relaxed,
            |current| current.checked_add(1),
        )
        .map_err(|_| OperationError::RequestIdExhausted)?;
    Ok(format!("matcha-session-{operation}-{sequence}"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    use crate::gateway::{
        auth::GatewaySecret,
        client::{
            GatewayClientMetadata, GatewayEndpoint,
            test_support::{TestSocket, TestTlsIdentity, accept_websocket},
        },
    };

    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn session_operation_reuses_control_gateway_for_every_method() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = Arc::new(test_client(&listener, identity.fingerprint()));
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_control(&listener, &acceptor).await;
            serve_session_success(
                &mut socket,
                protocol::SESSIONS_LIST_METHOD,
                json!({
                    "ts": 42,
                    "count": 0,
                    "sessions": []
                }),
            )
            .await;
            serve_session_success(
                &mut socket,
                protocol::CHAT_HISTORY_METHOD,
                json!({
                    "messages": [{"role": "user", "content": "hello"}]
                }),
            )
            .await;
            serve_session_success(
                &mut socket,
                wire::SESSIONS_MESSAGES_SUBSCRIBE_METHOD,
                json!({
                    "subscribed": true,
                    "key": "agent:main:session-1"
                }),
            )
            .await;
            serve_session_success(
                &mut socket,
                protocol::CHAT_SEND_METHOD,
                json!({
                    "runId": "run-7",
                    "status": "started"
                }),
            )
            .await;
            serve_session_success(
                &mut socket,
                protocol::CHAT_ABORT_METHOD,
                json!({
                    "ok": true,
                    "aborted": true,
                    "runIds": ["run-7"]
                }),
            )
            .await;
            serve_session_success(
                &mut socket,
                protocol::SESSIONS_PATCH_METHOD,
                json!({
                    "ok": true,
                    "key": "agent:main:session-1",
                    "resolved": {
                        "modelProvider": "anthropic",
                        "model": "anthropic/claude-opus-4-7",
                        "agentRuntime": {"id": "acpx", "source": "session-key"}
                    }
                }),
            )
            .await;
            serve_session_success(
                &mut socket,
                protocol::SESSIONS_PATCH_METHOD,
                json!({
                    "ok": true,
                    "key": "agent:main:session-1"
                }),
            )
            .await;
            serve_permission_projection(&mut socket, Some("guarded"), true).await;
            serve_session_request_success(
                &mut socket,
                protocol::SESSIONS_PATCH_METHOD,
                json!({
                    "key": "agent:main:session-1",
                    "permissionMode": "full"
                }),
                json!({
                    "ok": true,
                    "key": "agent:main:session-1",
                    "entry": {"permissionMode": "full"}
                }),
            )
            .await;
            serve_permission_projection(&mut socket, Some("full"), false).await;
            serve_session_request_success(
                &mut socket,
                protocol::SESSIONS_PATCH_METHOD,
                json!({
                    "key": "agent:main:session-1",
                    "permissionMode": null
                }),
                json!({
                    "ok": true,
                    "key": "agent:main:session-1",
                    "entry": {}
                }),
            )
            .await;
            serve_permission_projection(&mut socket, None, false).await;
            serve_session_success(
                &mut socket,
                protocol::SESSIONS_CREATE_METHOD,
                json!({
                    "ok": true,
                    "key": "agent:mct-team:team-endpoint-session-run-1-reviewer",
                    "sessionId": "team-endpoint-session-run-1-reviewer"
                }),
            )
            .await;
            serve_session_success(
                &mut socket,
                protocol::SESSIONS_DELETE_METHOD,
                json!({
                    "ok": true,
                    "key": "agent:mct-team:team-endpoint-session-run-1-reviewer",
                    "deleted": true
                }),
            )
            .await;
        });

        let operation = SessionOperation::new(Arc::clone(&client));
        let session_key = protocol::SessionKey::try_new("agent:main:session-1").unwrap();
        let run_id = protocol::RunId::try_new("run-7").unwrap();
        let create = protocol::SessionCreateParams::try_new(
            protocol::AgentId::try_new("mct-team").unwrap(),
            protocol::EndpointSessionId::try_new("team-endpoint-session-run-1-reviewer").unwrap(),
            protocol::ModelRef::try_new("anthropic/claude-opus-4-7").unwrap(),
        )
        .unwrap();
        let delete = protocol::SessionDeleteParams::new(create.key().clone());

        operation
            .list_sessions(protocol::SessionsListParams::default())
            .await
            .unwrap();
        let history = operation
            .history(protocol::ChatHistoryParams::new(session_key.clone()))
            .await
            .unwrap();
        assert_eq!(history.messages.len(), 1);
        operation
            .subscribe_session_messages(&session_key)
            .await
            .unwrap();
        assert!(matches!(
            operation
                .send_chat(
                    protocol::ChatSendParams::try_new(session_key.clone(), "hello", run_id.clone())
                        .unwrap()
                )
                .await,
            Ok(InvocationOutcome::Succeeded(_))
        ));
        assert!(matches!(
            operation
                .abort_chat(protocol::ChatAbortParams::new(session_key.clone()).for_run(run_id))
                .await,
            Ok(InvocationOutcome::Succeeded(_))
        ));
        assert!(matches!(
            operation
                .patch_session_model(protocol::SessionModelPatchParams::new(
                    session_key.clone(),
                    Some(protocol::ModelRef::try_new("anthropic/claude-opus-4-7").unwrap()),
                ))
                .await,
            Ok(InvocationOutcome::Succeeded(_))
        ));
        assert!(matches!(
            operation
                .patch_session_label(
                    protocol::SessionLabelPatchParams::try_new(session_key.clone(), "Review")
                        .unwrap()
                )
                .await,
            Ok(InvocationOutcome::Succeeded(_))
        ));
        let permission = operation
            .get_session_permission(session_key.clone())
            .await
            .unwrap();
        assert_eq!(
            permission.mode,
            Some(protocol::SessionPermissionMode::Guarded)
        );
        assert_eq!(
            permission.default_mode,
            Some(protocol::SessionPermissionMode::Workspace)
        );
        assert!(permission.pending);
        assert!(matches!(
            operation
                .set_session_permission(protocol::SessionPermissionPatchParams::new(
                    session_key.clone(),
                    Some(protocol::SessionPermissionMode::Full),
                ))
                .await,
            Ok(InvocationOutcome::Succeeded(
                protocol::SessionPermissionProjection {
                    mode: Some(protocol::SessionPermissionMode::Full),
                    pending: false,
                    ..
                }
            ))
        ));
        assert!(matches!(
            operation
                .set_session_permission(protocol::SessionPermissionPatchParams::new(
                    session_key,
                    None
                ))
                .await,
            Ok(InvocationOutcome::Succeeded(
                protocol::SessionPermissionProjection {
                    mode: None,
                    pending: false,
                    ..
                }
            ))
        ));
        assert!(matches!(
            operation.create_session(create).await,
            Ok(InvocationOutcome::Succeeded(_))
        ));
        assert!(matches!(
            operation.delete_session(delete).await,
            Ok(InvocationOutcome::Succeeded(
                protocol::SessionDeleteResult { deleted: true }
            ))
        ));

        client.close_control_connection().await;
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn session_operation_maps_gateway_failure_responses_without_subscribe() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = Arc::new(test_client(&listener, identity.fingerprint()));
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_control(&listener, &acceptor).await;
            serve_session_failure(&mut socket, protocol::SESSIONS_LIST_METHOD).await;
            serve_session_failure(&mut socket, protocol::CHAT_SEND_METHOD).await;
        });

        let operation = SessionOperation::new(Arc::clone(&client));
        assert_eq!(
            operation
                .list_sessions(protocol::SessionsListParams::default())
                .await,
            Err(OperationError::Rejected)
        );
        let rejection = operation
            .send_chat(
                protocol::ChatSendParams::try_new(
                    protocol::SessionKey::try_new("agent:main:session-1").unwrap(),
                    "hello",
                    protocol::RunId::try_new("run-7").unwrap(),
                )
                .unwrap(),
            )
            .await;
        assert!(matches!(
            rejection,
            Ok(InvocationOutcome::TargetRejected(
                OperationError::GatewayRejected { .. }
            ))
        ));

        client.close_control_connection().await;
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn session_operation_maps_unknown_mutation_delivery_without_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = Arc::new(test_client(&listener, identity.fingerprint()));
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_control(&listener, &acceptor).await;
            let request = read_session_request(&mut socket, protocol::CHAT_ABORT_METHOD).await;
            socket.close(None).await.unwrap();
            request
        });

        let operation = SessionOperation::new(Arc::clone(&client));
        assert_eq!(
            operation
                .abort_chat(protocol::ChatAbortParams::new(
                    protocol::SessionKey::try_new("agent:main:session-1").unwrap(),
                ))
                .await,
            Ok(InvocationOutcome::Unknown)
        );
        client.close_control_connection().await;
        server.await.unwrap();

        assert_eq!(
            SessionOperation::new(client)
                .send_chat(
                    protocol::ChatSendParams::try_new(
                        protocol::SessionKey::try_new("agent:main:session-1").unwrap(),
                        "hello",
                        protocol::RunId::try_new("run-7").unwrap(),
                    )
                    .unwrap()
                )
                .await,
            Ok(InvocationOutcome::Unknown)
        );
    }

    async fn accept_control(
        listener: &TcpListener,
        acceptor: &tokio_rustls::TlsAcceptor,
    ) -> TestSocket {
        let mut socket = accept_websocket(listener, acceptor).await;
        send_json(
            &mut socket,
            json!({
                "type": "event",
                "event": "connect.challenge",
                "payload": {"nonce": "fake-nonce", "ts": 42}
            }),
        )
        .await;
        let connect = read_json(&mut socket).await;
        assert_eq!(connect["method"], "connect");
        assert_eq!(
            connect["params"]["scopes"],
            json!([
                "operator.read",
                "operator.write",
                "operator.admin",
                "operator.approvals"
            ])
        );
        assert_ne!(connect["method"], wire::SESSIONS_SUBSCRIBE_METHOD);
        send_json(
            &mut socket,
            json!({
                "type": "res",
                "id": connect["id"],
                "ok": true,
                "payload": {
                    "type": "hello-ok",
                    "protocol": 4,
                    "server": {"version": wire::OPENCLAW_GATEWAY_VERSION, "connId": "fake-connection"},
                    "features": {
                        "methods": [
                            "status",
                            "config.get",
                            "config.patch",
                            "config.apply",
                            "plugins.refresh",
                            "agents.list",
                            "skills.status",
                            wire::SYSTEM_PRESENCE_METHOD,
                            protocol::SESSIONS_LIST_METHOD,
                            protocol::CHAT_HISTORY_METHOD,
                            protocol::CHAT_SEND_METHOD,
                            protocol::CHAT_ABORT_METHOD,
                            protocol::SESSIONS_PATCH_METHOD,
                            protocol::SESSIONS_CREATE_METHOD,
                            protocol::SESSIONS_DELETE_METHOD,
                            protocol::SESSIONS_DESCRIBE_METHOD
                        ],
                        "events": ["tick"]
                    },
                    "snapshot": {
                        "presence": [{"ts": 41}],
                        "health": {"ok": true},
                        "stateVersion": {"presence": 1, "health": 1},
                        "uptimeMs": 100
                    },
                    "auth": {
                        "role": "operator",
                        "scopes": ["operator.read", "operator.write", "operator.admin", "operator.approvals"]
                    },
                    "policy": {
                        "maxPayload": 26214400,
                        "maxBufferedBytes": 52428800,
                        "tickIntervalMs": 15000
                    }
                }
            }),
        )
        .await;
        socket
    }

    async fn serve_session_success(socket: &mut TestSocket, method: &str, payload: Value) {
        let request = read_session_request(socket, method).await;
        send_json(
            socket,
            json!({
                "type": "res",
                "id": request["id"],
                "ok": true,
                "payload": payload
            }),
        )
        .await;
    }

    async fn serve_session_request_success(
        socket: &mut TestSocket,
        method: &str,
        expected_params: Value,
        payload: Value,
    ) {
        let request = read_session_request(socket, method).await;
        assert_eq!(request["params"], expected_params);
        send_json(
            socket,
            json!({
                "type": "res",
                "id": request["id"],
                "ok": true,
                "payload": payload
            }),
        )
        .await;
    }

    async fn serve_permission_projection(
        socket: &mut TestSocket,
        permission_mode: Option<&str>,
        pending: bool,
    ) {
        let mut session = json!({
            "key": "agent:main:session-1",
            "kind": "direct",
            "agentId": "main",
            "permissionModePending": pending
        });
        if let Some(mode) = permission_mode {
            session["permissionMode"] = json!(mode);
        }
        serve_session_request_success(
            socket,
            protocol::SESSIONS_LIST_METHOD,
            json!({
                "limit": 100,
                "search": "agent:main:session-1"
            }),
            json!({
                "ts": 42,
                "count": 1,
                "sessions": [session]
            }),
        )
        .await;
        serve_session_success(
            socket,
            "agents.list",
            json!({
                "defaultId": "main",
                "mainKey": "main",
                "scope": "global",
                "agents": [{
                    "id": "main",
                    "kind": "system",
                    "defaultPermissionMode": "workspace"
                }]
            }),
        )
        .await;
    }

    async fn serve_session_failure(socket: &mut TestSocket, method: &str) {
        let request = read_session_request(socket, method).await;
        send_json(
            socket,
            json!({
                "type": "res",
                "id": request["id"],
                "ok": false,
                "error": {"code": "REJECTED", "message": "rejected", "retryable": false}
            }),
        )
        .await;
    }

    async fn read_session_request(socket: &mut TestSocket, method: &str) -> Value {
        let request = read_json(socket).await;
        assert_eq!(request["method"], method);
        assert_ne!(request["method"], wire::SESSIONS_SUBSCRIBE_METHOD);
        request
    }

    async fn read_json(socket: &mut TestSocket) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected text frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn send_json(socket: &mut TestSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    fn test_client(
        listener: &TcpListener,
        certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
    ) -> GatewayClient {
        GatewayClient::new(
            GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
            certificate_fingerprint,
            Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
            GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
        )
    }
}
