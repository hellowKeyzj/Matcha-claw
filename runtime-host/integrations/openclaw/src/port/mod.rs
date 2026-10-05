mod capability;
mod control;
mod cron;
mod outcome;
mod session;
mod team;

use std::{fmt, sync::Arc};

use platform::listener_identity::CertificateFingerprint;
use platform::state_dir::CanonicalStateDir;
use tokio::sync::mpsc;

use crate::{
    gateway::{
        auth::GatewaySecret,
        client::{GatewayClient, GatewayClientMetadata, GatewayEndpoint},
    },
    session::ingest::SessionEventIngest,
    surfaces::channels::gateway::{
        credentials::ChannelCredentialsOperation, pairing::ChannelPairingOperation,
    },
};

pub use crate::surfaces::providers::ProviderNativeConfigurationEffect;
pub use crate::surfaces::skills::SkillUploadOutcome;
pub use capability::OpenClawDriverParentCallbackHandle;
pub use control::{OpenClawControlReadiness, OpenClawGatewayControl};
pub use cron::await_cron_execution;
pub use outcome::{
    OpenClawGatewayRequestOutcome, OpenClawPeerRejection, OpenClawSessionError,
    OpenClawSessionMutationFailure, SessionModelPatchFailure,
};
pub use session::OpenClawSessionGateway;
pub(crate) use session::validate_observation_identity;
pub use team::TeamNativeRunWaiter;

pub use crate::session::{
    CanonicalIngressResult, CanonicalSessionReplay, SessionReplayError, SessionReplaySourceError,
    SessionReplaySourcePage, SessionReplaySourceRow, SessionReplaySourceSkip,
    SessionReplaySourceSkipReason,
    events::{LifecycleEvent, SessionEvent, SessionEventProvenance, TerminalOutcome},
};
pub use crate::surfaces::channels::gateway::config::{
    ChannelCatalogEffect, ChannelConfigMutationOutcome, ChannelConfigReadEffect,
    ChannelConfigReadProjection, ChannelConfigSchemaEffect, ChannelConfigureField,
    ChannelConfigureFieldKind, ChannelConfigureForm, DeleteConfigOutcome,
};
pub use crate::surfaces::channels::gateway::login::{
    ChannelRuntimeAction, ChannelRuntimeEffect, LoginProgress, LoginProgressStatus, WebLoginStart,
    WebLoginStartEffect, WebLoginWait, WebLoginWaitEffect,
};
pub use crate::surfaces::cron::{
    CronExecutionAdmission, CronExecutionStatus, CronHistoryReadFailure, CronMutationOutcome,
    CronReadFailure, CronRunDisposition, CronTriggerOutcome,
};
pub use crate::surfaces::plugins::gateway::refresh::PluginRefreshOutcome;
pub use crate::surfaces::providers::gateway::native_config::{
    AppliedStatus, ObservedStatus, ProviderNativeConfigurationDiagnostic,
    ProviderNativeConfigurationEvidence, ProviderNativeConfigurationOperation,
};
pub use crate::surfaces::skills::{
    SkillConfigRemoveOutcome, SkillDetail, SkillDetailRequest, SkillInstallRequest,
    SkillMutationOutcome, SkillReadError, SkillUpdateRequest, SkillUploadBegin, SkillUploadChunk,
    SkillUploadCommit,
};

pub struct OpenClawGateway {
    client: Arc<GatewayClient>,
    state_dir: Option<CanonicalStateDir>,
    team_state_dir: Option<CanonicalStateDir>,
    openclaw_dir: Option<std::path::PathBuf>,
    schema_executable: Option<std::path::PathBuf>,
    managed_plugin_root: Option<std::path::PathBuf>,
    pairing: Option<ChannelPairingOperation>,
    credentials: Option<ChannelCredentialsOperation>,
}

impl OpenClawGateway {
    pub fn new(
        endpoint: GatewayEndpoint,
        certificate_fingerprint: CertificateFingerprint,
        secret: Arc<GatewaySecret>,
        metadata: GatewayClientMetadata,
        events: mpsc::Sender<SessionEvent>,
        session_events: mpsc::Sender<sessions_module::command::SessionIngressEvent>,
    ) -> Self {
        let ingest = Arc::new(SessionEventIngest::new(events, session_events));
        let client = GatewayClient::new(endpoint, certificate_fingerprint, secret, metadata)
            .with_event_ingest(ingest);
        Self::with_client(Arc::new(client))
    }

    pub fn new_with_state_dir(
        endpoint: GatewayEndpoint,
        certificate_fingerprint: CertificateFingerprint,
        secret: Arc<GatewaySecret>,
        metadata: GatewayClientMetadata,
        state_dir: CanonicalStateDir,
        events: mpsc::Sender<SessionEvent>,
        session_events: mpsc::Sender<sessions_module::command::SessionIngressEvent>,
    ) -> Self {
        let ingest = Arc::new(SessionEventIngest::new(events, session_events));
        let client = GatewayClient::new_with_state_dir(
            endpoint,
            certificate_fingerprint,
            secret,
            metadata,
            state_dir.clone(),
        )
        .with_event_ingest(ingest);
        let mut gateway = Self::with_client(Arc::new(client));
        gateway.state_dir = Some(state_dir);
        gateway
    }

    fn with_client(client: Arc<GatewayClient>) -> Self {
        Self {
            client,
            state_dir: None,
            team_state_dir: None,
            openclaw_dir: None,
            schema_executable: None,
            managed_plugin_root: None,
            pairing: None,
            credentials: None,
        }
    }

    pub(crate) fn client(&self) -> Arc<GatewayClient> {
        Arc::clone(&self.client)
    }

    pub(crate) fn state_dir(&self) -> Option<CanonicalStateDir> {
        self.state_dir.clone()
    }

    pub(crate) fn team_state_dir(&self) -> Option<CanonicalStateDir> {
        self.team_state_dir.clone()
    }

    pub(crate) fn openclaw_dir(&self) -> Option<std::path::PathBuf> {
        self.openclaw_dir.clone()
    }

    pub(crate) fn schema_executable(&self) -> Option<std::path::PathBuf> {
        self.schema_executable.clone()
    }

    pub(crate) fn managed_plugin_root(&self) -> Option<std::path::PathBuf> {
        self.managed_plugin_root.clone()
    }

    pub(crate) fn channel_pairing_operation(&self) -> Option<&ChannelPairingOperation> {
        self.pairing.as_ref()
    }

    pub(crate) fn channel_credentials_operation(&self) -> Option<&ChannelCredentialsOperation> {
        self.credentials.as_ref()
    }

    pub(crate) fn set_openclaw_dir(&mut self, openclaw_dir: std::path::PathBuf) {
        self.openclaw_dir = Some(openclaw_dir);
    }

    pub(crate) fn set_channel_schema_source(
        &mut self,
        executable: std::path::PathBuf,
        managed_plugin_root: std::path::PathBuf,
    ) {
        self.schema_executable = Some(executable);
        self.managed_plugin_root = Some(managed_plugin_root);
    }

    pub(crate) fn set_channel_pairing_operation(&mut self, operation: ChannelPairingOperation) {
        self.pairing = Some(operation);
    }

    pub(crate) fn set_channel_credentials_operation(
        &mut self,
        operation: ChannelCredentialsOperation,
    ) {
        self.credentials = Some(operation);
    }
}

impl fmt::Debug for OpenClawGateway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenClawGateway")
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
use crate::{
    session::operation::OperationError,
    task_manager::{TaskCreate, TaskMutationOutcome, TaskScope, TaskUpdate},
};
#[cfg(test)]
use outcome::port_outcome;
#[cfg(test)]
use platform::exchange::InvocationOutcome;

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use futures_util::{SinkExt, StreamExt};
    use platform::listener_identity::ListenerIdentity;
    use serde_json::{Value, json};
    use tokio::{net::TcpListener, sync::mpsc, time::timeout};
    use tokio_tungstenite::tungstenite::Message;

    use crate::{
        gateway::{
            client::test_support::{TestSocket, TestTlsIdentity, accept_websocket},
            wire,
        },
        session::protocol::{
            AgentId, AgentScopedSessionKey, ChatAbortParams, ChatHistoryParams, ChatSendParams,
            EndpointSessionId, ModelRef, RunId, SessionCreateParams, SessionDeleteParams,
            SessionKey, SessionLabelPatchParams, SessionModelPatchParams, SessionsListParams,
        },
    };

    use super::*;

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);

    #[tokio::test(flavor = "current_thread")]
    async fn gateway_port_debug_excludes_endpoint_and_secret() {
        let identity = ListenerIdentity::generate_loopback().unwrap();
        let (events, _) = mpsc::channel(1);
        let (session_events, _) = mpsc::channel(32);
        let gateway = OpenClawGateway::new(
            GatewayEndpoint::try_new("127.0.0.1:18789".parse().unwrap()).unwrap(),
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("gateway-port-secret-canary".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "windows".into()).unwrap(),
            events,
            session_events,
        );

        let debug = format!("{gateway:?}");
        assert!(!debug.contains("gateway-port-secret-canary"));
        assert!(!debug.contains("127.0.0.1"));
        assert!(!debug.contains("18789"));
    }

    #[test]
    fn lifecycle_event_sink_uses_only_safe_value_facts() {
        let (events, mut received) = mpsc::channel::<LifecycleEvent>(1);
        events
            .try_send(LifecycleEvent::new(Some(7), true, false, true))
            .unwrap();

        let event = received.try_recv().unwrap();
        assert_eq!(event.sequence(), Some(7));
        assert!(event.has_run());
        assert!(!event.has_message());
        assert!(event.has_session_activity());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn skill_status_catalog_uses_global_status() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let endpoint = GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let acceptor = identity.acceptor();
        let peer = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type":"event",
                    "event":"connect.challenge",
                    "payload":{"nonce":"port-skill-nonce","ts":42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            assert_eq!(connect["method"], "connect");
            send_json(&mut socket, hello(connect["id"].as_str().unwrap())).await;

            let status = read_json(&mut socket).await;
            assert_eq!(status["method"], "skills.status");
            assert_eq!(status["params"], json!({}));
            send_json(
                &mut socket,
                task_response(
                    &status,
                    json!({
                        "skills":[{
                            "skillKey":"Excel XLSX",
                            "name":"Excel XLSX",
                            "installed":true,
                            "eligible":true,
                            "clawhub":{"slug":"excel-xlsx"}
                        }]
                    }),
                ),
            )
            .await;
            socket.close(None).await.unwrap();
        });
        let (events, _) = mpsc::channel(1);
        let (session_events, _) = mpsc::channel(32);
        let gateway = OpenClawGateway::new(
            endpoint,
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("port-skill-secret".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "test".into()).unwrap(),
            events,
            session_events,
        );

        let catalog = gateway.skill_status_catalog().await.unwrap();
        assert_eq!(catalog.entries()[0].key(), "Excel XLSX");
        assert_eq!(catalog.entries()[0].slug(), Some("excel-xlsx"));
        timeout(TEST_TIMEOUT, peer).await.unwrap().unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn task_operations_reuse_gateway_control_exchange() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let endpoint = GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let acceptor = identity.acceptor();
        let peer = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type":"event",
                    "event":"connect.challenge",
                    "payload":{"nonce":"port-task-nonce","ts":42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            assert_eq!(connect["method"], "connect");
            send_json(&mut socket, hello(connect["id"].as_str().unwrap())).await;

            let list = read_json(&mut socket).await;
            assert_task_request(&list, "TaskList");
            send_json(&mut socket, task_response(&list, task_list_payload())).await;

            let get = read_json(&mut socket).await;
            assert_task_request(&get, "TaskGet");
            send_json(
                &mut socket,
                task_response(&get, json!({"scope":task_scope(),"task":task()})),
            )
            .await;

            let create = read_json(&mut socket).await;
            assert_task_request(&create, "TaskCreate");
            send_json(
                &mut socket,
                task_response(&create, json!({"scope":task_scope(),"task":task()})),
            )
            .await;

            let create_snapshot = read_json(&mut socket).await;
            assert_task_request(&create_snapshot, "TaskList");
            send_json(
                &mut socket,
                task_response(&create_snapshot, task_list_payload()),
            )
            .await;

            let update = read_json(&mut socket).await;
            assert_task_request(&update, "TaskUpdate");
            send_json(
                &mut socket,
                task_response(&update, json!({"scope":task_scope(),"task":updated_task()})),
            )
            .await;

            let update_snapshot = read_json(&mut socket).await;
            assert_task_request(&update_snapshot, "TaskList");
            send_json(
                &mut socket,
                task_response(&update_snapshot, updated_task_list_payload()),
            )
            .await;

            let todo_write = read_json(&mut socket).await;
            assert_task_request(&todo_write, "TodoWrite");
            send_json(
                &mut socket,
                task_response(&todo_write, todo_snapshot_payload()),
            )
            .await;

            let todo_get = read_json(&mut socket).await;
            assert_task_request(&todo_get, "TodoGet");
            send_json(
                &mut socket,
                task_response(&todo_get, todo_snapshot_payload()),
            )
            .await;

            match timeout(Duration::from_millis(100), socket.next()).await {
                Err(_) | Ok(None) | Ok(Some(Ok(Message::Close(_)))) => {}
                Ok(Some(Ok(frame))) => panic!("unexpected extra Gateway frame: {frame:?}"),
                Ok(Some(Err(error))) => panic!("unexpected Gateway peer error: {error}"),
            }
        });
        let (events, _) = mpsc::channel(1);
        let (session_events, _) = mpsc::channel(32);
        let mut gateway = OpenClawGateway::new(
            endpoint,
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("port-task-secret".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "test".into()).unwrap(),
            events,
            session_events,
        );

        assert!(gateway.list_tasks(task_scope_input()).await.is_ok());
        assert!(
            gateway
                .get_task(task_scope_input(), "task-1".into())
                .await
                .is_ok()
        );
        assert!(matches!(
            gateway
                .create_task(
                    task_scope_input(),
                    TaskCreate::try_new("subject".into(), "description".into(), None, None, None)
                        .unwrap(),
                )
                .await,
            TaskMutationOutcome::Applied(_)
        ));
        assert!(matches!(
            gateway
                .update_task(
                    task_scope_input(),
                    TaskUpdate::try_new(
                        "task-1".into(),
                        None,
                        Some("updated subject".into()),
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                    .unwrap(),
                )
                .await,
            TaskMutationOutcome::Applied(_)
        ));
        assert!(matches!(
            gateway
                .write_todos(task_scope_input(), vec![], vec![])
                .await,
            TaskMutationOutcome::Applied(_)
        ));
        assert!(gateway.get_todos(task_scope_input()).await.is_ok());
        timeout(TEST_TIMEOUT, peer).await.unwrap().unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn session_operations_use_gateway_control() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let endpoint = GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let acceptor = identity.acceptor();
        let peer = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type":"event",
                    "event":"connect.challenge",
                    "payload":{"nonce":"port-session-nonce","ts":42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            assert_eq!(connect["method"], "connect");
            send_json(&mut socket, hello(connect["id"].as_str().unwrap())).await;

            let list = read_json(&mut socket).await;
            assert_session_request(&list, "sessions.list");
            send_json(
                &mut socket,
                session_response(&list, sessions_list_payload()),
            )
            .await;

            let history = read_json(&mut socket).await;
            assert_session_request(&history, "chat.history");
            send_json(&mut socket, session_response(&history, history_payload())).await;

            let subscribe = read_json(&mut socket).await;
            assert_session_request(&subscribe, "sessions.messages.subscribe");
            assert_eq!(
                subscribe["params"],
                json!({"key":"agent:port-agent:session-1"})
            );
            send_json(
                &mut socket,
                session_response(
                    &subscribe,
                    json!({"subscribed":true,"key":"agent:port-agent:session-1"}),
                ),
            )
            .await;

            let send = read_json(&mut socket).await;
            assert_session_request(&send, "chat.send");
            send_json(&mut socket, session_response(&send, chat_send_payload())).await;

            let abort = read_json(&mut socket).await;
            assert_session_request(&abort, "chat.abort");
            send_json(&mut socket, session_response(&abort, chat_abort_payload())).await;

            let patch_model = read_json(&mut socket).await;
            assert_session_request(&patch_model, "sessions.patch");
            send_json(
                &mut socket,
                session_response(&patch_model, session_model_patch_payload()),
            )
            .await;

            let patch_label = read_json(&mut socket).await;
            assert_session_request(&patch_label, "sessions.patch");
            send_json(
                &mut socket,
                session_response(&patch_label, session_label_patch_payload()),
            )
            .await;

            let create = read_json(&mut socket).await;
            assert_session_request(&create, "sessions.create");
            send_json(
                &mut socket,
                session_response(&create, session_create_payload()),
            )
            .await;

            let delete = read_json(&mut socket).await;
            assert_session_request(&delete, "sessions.delete");
            send_json(
                &mut socket,
                session_response(&delete, session_delete_payload()),
            )
            .await;

            match timeout(Duration::from_millis(100), socket.next()).await {
                Err(_) | Ok(None) | Ok(Some(Ok(Message::Close(_)))) => {}
                Ok(Some(Ok(frame))) => panic!("unexpected extra Gateway frame: {frame:?}"),
                Ok(Some(Err(error))) => panic!("unexpected Gateway peer error: {error}"),
            }
        });
        let (events, _) = mpsc::channel(1);
        let (session_events, _) = mpsc::channel(32);
        let mut gateway = OpenClawGateway::new(
            endpoint,
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("port-session-secret".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "test".into()).unwrap(),
            events,
            session_events,
        );

        assert!(
            gateway
                .list_sessions(SessionsListParams::default())
                .await
                .is_ok()
        );
        assert!(gateway.history(history_params()).await.is_ok());
        let send_result = gateway
            .enqueue_chat(chat_send_params(), "renderer-route:test".into())
            .await
            .unwrap();
        assert_eq!(send_result.run_id.as_str(), "native-run-1");
        assert!(matches!(
            gateway.abort_chat(chat_abort_params()).await.unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        assert!(matches!(
            gateway
                .patch_session_model(session_model_patch_params())
                .await
                .unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        assert!(matches!(
            gateway
                .patch_session_label(session_label_patch_params())
                .await
                .unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        assert!(matches!(
            gateway
                .create_session(session_create_params())
                .await
                .unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        assert!(matches!(
            gateway
                .delete_session(session_delete_params())
                .await
                .unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        timeout(TEST_TIMEOUT, peer).await.unwrap().unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn diagnostic_session_mutations_preserve_peer_not_found_rejection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let endpoint = GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let acceptor = identity.acceptor();
        let peer = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type":"event",
                    "event":"connect.challenge",
                    "payload":{"nonce":"port-session-not-found","ts":42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            send_json(&mut socket, hello(connect["id"].as_str().unwrap())).await;
            for method in ["chat.abort", "sessions.delete"] {
                let request = read_json(&mut socket).await;
                assert_session_request(&request, method);
                send_json(
                    &mut socket,
                    json!({"type":"res","id":request["id"],"ok":false,"error":{"code":"NOT_FOUND","message":"gone"}}),
                )
                .await;
            }
        });
        let (events, _) = mpsc::channel(1);
        let (session_events, _) = mpsc::channel(32);
        let mut gateway = OpenClawGateway::new(
            endpoint,
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("port-session-not-found-secret".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "test".into()).unwrap(),
            events,
            session_events,
        );

        let abort = gateway
            .abort_chat_diagnostic(chat_abort_params())
            .await
            .unwrap();
        assert!(matches!(
            abort,
            InvocationOutcome::TargetRejected(ref failure)
                if failure.peer_rejection().is_some_and(|rejection| rejection.code() == "NOT_FOUND")
        ));
        let delete = gateway
            .delete_session_diagnostic(session_delete_params())
            .await
            .unwrap();
        assert!(matches!(
            delete,
            InvocationOutcome::TargetRejected(ref failure)
                if failure.peer_rejection().is_some_and(|rejection| rejection.code() == "NOT_FOUND")
        ));
        timeout(TEST_TIMEOUT, peer).await.unwrap().unwrap();
    }

    #[test]
    fn mutation_outcomes_project_only_typed_rejections() {
        assert_eq!(
            port_outcome::<()>(InvocationOutcome::TargetRejected(OperationError::Protocol)),
            InvocationOutcome::TargetRejected(OpenClawSessionError::Protocol(None))
        );
        assert_eq!(
            port_outcome::<()>(InvocationOutcome::Unknown),
            InvocationOutcome::Unknown
        );
    }

    #[test]
    fn operation_errors_are_projected_to_openclaw_session_errors() {
        assert_eq!(
            OpenClawSessionError::from(OperationError::Rejected),
            OpenClawSessionError::TargetRejected
        );
        assert_eq!(
            OpenClawSessionError::from(OperationError::ConnectionClosed),
            OpenClawSessionError::ConnectionClosed
        );
    }

    fn task_scope_input() -> TaskScope {
        TaskScope::try_new(
            "session-canary".into(),
            Some("team-canary".into()),
            "workspace-canary".into(),
        )
        .unwrap()
    }

    fn task_scope() -> Value {
        json!({"type":"team","key":"team:team-canary","label":"Team · team-canary","teamKey":"team-canary"})
    }

    fn task() -> Value {
        json!({
            "id":"task-1", "subject":"subject", "description":"description",
            "activeForm":"working", "status":"pending", "owner":"owner",
            "blockedBy":[], "blocks":[], "createdAt":1, "updatedAt":2
        })
    }

    fn updated_task() -> Value {
        json!({
            "id":"task-1", "subject":"updated subject", "description":"description",
            "activeForm":"working", "status":"pending", "owner":"owner",
            "blockedBy":[], "blocks":[], "createdAt":1, "updatedAt":3
        })
    }

    fn task_list_payload() -> Value {
        json!({"scope":task_scope(),"tasks":[task()],"todos":[]})
    }

    fn updated_task_list_payload() -> Value {
        json!({"scope":task_scope(),"tasks":[updated_task()],"todos":[]})
    }

    fn todo_snapshot_payload() -> Value {
        json!({
            "todos":[{"id":"todo-1","content":"content","status":"pending"}],
            "updatedAt":2
        })
    }

    fn assert_task_request(request: &Value, method: &str) {
        assert_eq!(request["type"], "req");
        assert_eq!(request["method"], method);
        assert_ne!(request["method"], "sessions.subscribe");
        assert_eq!(request["params"]["sessionKey"], "session-canary");
        assert_eq!(request["params"]["workspaceDir"], "workspace-canary");
    }

    fn task_response(request: &Value, payload: Value) -> Value {
        json!({"type":"res","id":request["id"],"ok":true,"payload":payload})
    }

    fn session_key() -> SessionKey {
        SessionKey::try_new("agent:port-agent:session-1").unwrap()
    }

    fn run_id() -> RunId {
        RunId::try_new("run-1").unwrap()
    }

    fn agent_id() -> AgentId {
        AgentId::try_new("port-agent").unwrap()
    }

    fn endpoint_session_id() -> EndpointSessionId {
        EndpointSessionId::try_new("session-1").unwrap()
    }

    fn scoped_session_key() -> AgentScopedSessionKey {
        AgentScopedSessionKey::try_new(agent_id(), endpoint_session_id()).unwrap()
    }

    fn history_params() -> ChatHistoryParams {
        ChatHistoryParams::new(session_key())
    }

    fn chat_send_params() -> ChatSendParams {
        ChatSendParams::try_new(session_key(), "hello", run_id()).unwrap()
    }

    fn chat_abort_params() -> ChatAbortParams {
        ChatAbortParams::new(session_key()).for_run(run_id())
    }

    fn session_model_patch_params() -> SessionModelPatchParams {
        SessionModelPatchParams::new(
            session_key(),
            Some(ModelRef::try_new("claude-sonnet").unwrap()),
        )
    }

    fn session_label_patch_params() -> SessionLabelPatchParams {
        SessionLabelPatchParams::try_new(session_key(), "Port Session").unwrap()
    }

    fn session_create_params() -> SessionCreateParams {
        SessionCreateParams::try_new(
            agent_id(),
            endpoint_session_id(),
            ModelRef::try_new("claude-sonnet").unwrap(),
        )
        .unwrap()
    }

    fn session_delete_params() -> SessionDeleteParams {
        SessionDeleteParams::new(scoped_session_key())
    }

    fn assert_session_request(request: &Value, method: &str) {
        assert_eq!(request["type"], "req");
        assert_eq!(request["method"], method);
        assert_ne!(request["method"], "sessions.subscribe");
    }

    fn session_response(request: &Value, payload: Value) -> Value {
        json!({"type":"res","id":request["id"],"ok":true,"payload":payload})
    }

    fn sessions_list_payload() -> Value {
        json!({
            "ts": 42,
            "count": 1,
            "totalCount": 1,
            "hasMore": false,
            "sessions": [{
                "key": "agent:port-agent:session-1",
                "kind": "direct",
                "agentId": "port-agent",
                "label": "Port Session",
                "displayName": "Port Agent",
                "derivedTitle": "Hello",
                "updatedAt": 42,
                "status": "idle",
                "hasActiveRun": false,
                "model": "claude-sonnet"
            }]
        })
    }

    fn history_payload() -> Value {
        json!({"messages":[{"role":"user","content":"hello"}]})
    }

    fn chat_send_payload() -> Value {
        json!({"runId":"native-run-1","status":"started"})
    }

    fn chat_abort_payload() -> Value {
        json!({"ok":true,"aborted":true,"runIds":["run-1"]})
    }

    fn session_model_patch_payload() -> Value {
        json!({
            "ok": true,
            "key": "agent:port-agent:session-1",
            "resolved": {
                "modelProvider": "anthropic",
                "model": "claude-sonnet",
                "agentRuntime": {"id":"runtime-1","source":"agent"}
            }
        })
    }

    fn session_label_patch_payload() -> Value {
        json!({"ok":true,"key":"agent:port-agent:session-1"})
    }

    fn session_create_payload() -> Value {
        json!({"ok":true,"key":"agent:port-agent:session-1","sessionId":"session-1"})
    }

    fn session_delete_payload() -> Value {
        json!({"ok":true,"key":"agent:port-agent:session-1","deleted":true})
    }

    async fn read_json(socket: &mut TestSocket) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected text Gateway frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn send_json(socket: &mut TestSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    fn hello(id: &str) -> Value {
        json!({
            "type":"res",
            "id":id,
            "ok":true,
            "payload":{
                "type":"hello-ok",
                "protocol":4,
                "server":{"version":"2026.5.20","connId":"port-task-connection"},
                "features":{"methods":[
                    "status",
                    "config.get",
                    "config.patch",
                    "config.apply",
                    "plugins.refresh",
                    "agents.list",
                    "skills.status",
                    wire::SYSTEM_PRESENCE_METHOD,
                    "chat.send",
                    "chat.abort",
                    "chat.history",
                    "sessions.list",
                    "sessions.patch",
                    "sessions.create",
                    "sessions.delete",
                    "TaskCreate",
                    "TaskUpdate",
                    "TaskList",
                    "TaskGet",
                    "TodoWrite",
                    "TodoGet"
                ],"events":["tick", "chat", "session.message", "session.operation", "session.tool", "sessions.changed"]},
                "snapshot":{
                    "presence":[],
                    "health":{"ok":true},
                    "stateVersion":{"presence":1,"health":1},
                    "uptimeMs":100
                },
                "auth":{"role":"operator","scopes":["operator.read", "operator.write", "operator.admin", "operator.approvals"]},
                "policy":{
                    "maxPayload":26214400,
                    "maxBufferedBytes":52428800,
                    "tickIntervalMs":15000
                }
            }
        })
    }
}
