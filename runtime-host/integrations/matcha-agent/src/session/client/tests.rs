use std::{
    sync::{Arc as StdArc, Mutex as StdMutex},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async,
    tungstenite::{
        Bytes, Message,
        handshake::server::{Callback, ErrorResponse, Request, Response},
    },
};

use super::*;
use crate::session::{
    approval::ApprovalRespondParams,
    close::SessionCloseParams,
    events::SessionEventObservation,
    model::{ApprovalId, OptionId, RunId, Sequence, SessionId},
    models::ModelsListParams,
    request::{
        AttachmentPromptPayload, PromptAttachment, SessionCancelParams, SessionCreateParams,
        SessionLoadParams, SessionPromptParams, SessionSetModeParams, SessionSetModelParams,
        SessionSnapshotParams, SessionTranscriptParams,
    },
};
use platform::exchange::InvocationOutcome;

const INITIALIZE_RESULT: &str = r#"{"protocolVersion":"matcha-agent-app-server-v1","serverVersion":"2.2.1","capabilities":{"eventReplay":true,"snapshots":true,"approvals":true,"sdkMessageEnvelope":true,"blobStore":true,"sessionTranscript":true}}"#;

#[test]
fn endpoint_deadline_and_bounds_are_fixed() {
    let endpoint = AppServerEndpoint::try_new("127.0.0.1:3212".parse().unwrap()).unwrap();
    assert_eq!(endpoint.address(), "127.0.0.1:3212".parse().unwrap());
    assert_eq!(REQUEST_DEADLINE, Duration::from_secs(30));
    assert_eq!(health::MAX_HTTP_HEADER_BYTES, 16 * 1024);
    assert_eq!(health::MAX_HTTP_BODY_BYTES, 64 * 1024);
    let runtime_endpoint = endpoint.runtime_endpoint();
    assert_eq!(runtime_endpoint.runtime_adapter_id(), "matcha-agent");
    assert_eq!(runtime_endpoint.runtime_instance_id(), "127.0.0.1:3212");
    assert!(matches!(
        endpoint.runtime_scope(),
        platform::endpoint::runtime_address::RuntimeScope::RuntimeInstance(_)
    ));
    let identity = endpoint.session_identity(&session_id());
    assert_eq!(identity.endpoint(), &runtime_endpoint);
    assert_eq!(identity.agent_id(), "app-server");
    assert!(
        endpoint
            .session_scope(&session_id())
            .contains_session(&identity)
    );
    for address in ["127.0.0.1:0", "192.0.2.1:3212"] {
        let error = AppServerEndpoint::try_new(address.parse().unwrap()).unwrap_err();
        assert_eq!(error, AppServerClientError::InvalidEndpoint);
        assert!(!error.to_string().contains(address));
    }
}

#[test]
fn errors_and_debug_are_constantly_redacted() {
    for error in [
        AppServerClientError::UpgradeFailed,
        AppServerClientError::Transport,
        AppServerClientError::Protocol,
    ] {
        assert!(!error.to_string().contains("sentinel"));
        assert!(!format!("{error:?}").contains("sentinel"));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn readiness_checks_health_bearer_initialize_ping_and_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let authorization = StdArc::new(StdMutex::new(None));
    let observed = StdArc::clone(&authorization);
    let server = tokio::spawn(async move {
        serve_health(&listener, true).await;
        let mut socket = accept_app_server(&listener, observed).await;
        let initialize = read_json(&mut socket).await;
        assert!(initialize["id"].is_u64());
        assert_eq!(initialize["method"], "initialize");
        assert_eq!(initialize["params"]["clientName"], CLIENT_NAME);
        assert_eq!(
            initialize["params"]["protocolVersion"],
            crate::protocol::wire::APP_SERVER_PROTOCOL_VERSION
        );
        socket
            .send(Message::Ping(Bytes::from_static(b"ping")))
            .await
            .unwrap();
        send_initialize(&mut socket, initialize["id"].clone()).await;
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::Pong(Bytes::from_static(b"ping"))
        );
        assert!(matches!(
            socket.next().await.unwrap().unwrap(),
            Message::Close(_)
        ));
    });

    let secret = Secret::new("sentinel-token".into()).unwrap();
    let initialized = AppServerClient::inspect_health_and_initialize(endpoint, &secret)
        .await
        .unwrap();
    assert_eq!(initialized.server_version, "2.2.1");
    server.await.unwrap();
    assert_eq!(
        authorization.lock().unwrap().as_deref(),
        Some("Bearer sentinel-token")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn snapshot_session_decodes_the_typed_snapshot() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "session.snapshot");
        assert_eq!(request["params"]["sessionId"], "session-1");
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {
                    "session": session_record("model-1", "default", 3),
                    "version": 2,
                    "updatedAt": "snapshot-updated-at",
                    "runs": [],
                    "messages": [],
                    "pendingApprovals": []
                }
            }),
        )
        .await;
    });

    let secret = Secret::new("snapshot-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    let snapshot = client
        .snapshot_session(SessionSnapshotParams::new(session_id()))
        .await
        .unwrap();

    assert_eq!(snapshot.version, 2);
    assert_eq!(snapshot.session.last_seq.get(), 3);
    assert_eq!(snapshot.session.model.as_deref(), Some("model-1"));
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn named_session_commands_send_typed_requests_and_decode_results() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let create = read_json(&mut socket).await;
        assert_eq!(create["method"], "session.create");
        assert_eq!(
            create["params"],
            json!({
                "cwd": "E:/workspace-canary",
                "sessionId": "session-1",
                "title": "session",
                "model": "model-1",
                "permissionMode": "default"
            })
        );
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":create["id"],"result":session_record("model-1", "default", 1)}),
        )
        .await;

        let load = read_json(&mut socket).await;
        assert_eq!(load["method"], "session.load");
        assert_eq!(load["params"], json!({"sessionId":"session-1"}));
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":load["id"],"result":session_record("model-1", "default", 1)}),
        )
        .await;

        let list = read_json(&mut socket).await;
        assert_eq!(list["method"], "session.list");
        assert!(list.get("params").is_none());
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":list["id"],"result":{"sessions":[session_record("model-1", "default", 1)]}}),
        )
        .await;

        let transcript = read_json(&mut socket).await;
        assert_eq!(transcript["method"], "session.transcript");
        assert_eq!(transcript["params"], json!({"sessionId":"session-1"}));
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":transcript["id"],"result":{"lines":["line-1"]}}),
        )
        .await;

        let prompt = read_json(&mut socket).await;
        assert_eq!(prompt["method"], "session.prompt");
        assert_eq!(
            prompt["params"],
            json!({
                "sessionId": "session-1",
                "prompt": "prompt",
                "runId": "run-1",
                "payload": {
                    "version": "attachments-v1",
                    "attachments": [{
                        "name": "review.pdf",
                        "mediaType": "application/pdf",
                        "data": "aGVsbG8=",
                    }],
                },
            })
        );
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":prompt["id"],"result":{"runId":"run-1"}}),
        )
        .await;

        let cancel = read_json(&mut socket).await;
        assert_eq!(cancel["method"], "session.cancel");
        assert_eq!(
            cancel["params"],
            json!({"sessionId":"session-1","runId":"run-1","reason":"cancelled"})
        );
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":cancel["id"],"result":{"cancelledRunIds":["run-1"],"workerResponse":{"id":"request-1","ok":true}}}),
        )
        .await;

        let approval = read_json(&mut socket).await;
        assert_eq!(approval["method"], "approval.respond");
        assert_eq!(
            approval["params"],
            json!({"sessionId":"session-1","approvalId":"approval-1","optionId":"option-1"})
        );
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": approval["id"],
                "result": {
                    "resultType": "responded",
                    "approval": {
                        "approvalId": "approval-1",
                        "sessionId": "session-1",
                        "runId": "run-1",
                        "workerId": "worker-1",
                        "toolCallId": "tool-1",
                        "toolName": "tool",
                        "prompt": "approval prompt",
                        "options": [{"optionId":"allow-once","label":"Allow once","kind":"allow_once"}],
                        "status": {"type":"approved","resolvedAt":"now","optionId":"allow-once"}
                    },
                    "decision": {"type":"approved","optionId":"allow-once"}
                }
            }),
        )
        .await;
    });

    let secret = Secret::new("named-session-commands-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();

    let InvocationOutcome::Succeeded(created) = client
        .create_session(
            SessionCreateParams::try_new("E:/workspace-canary")
                .unwrap()
                .with_session_id(session_id())
                .with_title("session")
                .with_model("model-1")
                .with_permission_mode("default"),
        )
        .await
    else {
        panic!("create did not succeed");
    };
    assert_eq!(created.last_seq.get(), 1);
    assert_eq!(
        client
            .load_session(SessionLoadParams::new(session_id()))
            .await
            .unwrap()
            .model
            .as_deref(),
        Some("model-1")
    );
    assert_eq!(client.list_sessions().await.unwrap().sessions.len(), 1);
    assert_eq!(
        client
            .transcript_session(SessionTranscriptParams::new(session_id()))
            .await
            .unwrap()
            .lines,
        ["line-1"]
    );
    let InvocationOutcome::Succeeded(prompted) = client
        .prompt_session(
            SessionPromptParams::try_new(session_id(), "prompt")
                .unwrap()
                .with_run_id(RunId::try_new("run-1").unwrap())
                .with_attachments(
                    AttachmentPromptPayload::try_new(vec![
                        PromptAttachment::try_new("review.pdf", "application/pdf", "aGVsbG8=")
                            .unwrap(),
                    ])
                    .unwrap(),
                ),
        )
        .await
    else {
        panic!("prompt did not succeed");
    };
    assert_eq!(prompted.run_id.as_str(), "run-1");
    let InvocationOutcome::Succeeded(cancelled) = client
        .cancel_session(
            SessionCancelParams::new(session_id())
                .with_run_id(RunId::try_new("run-1").unwrap())
                .with_reason("cancelled"),
        )
        .await
    else {
        panic!("cancel did not succeed");
    };
    assert_eq!(cancelled.cancelled_run_ids.len(), 1);
    let InvocationOutcome::Succeeded(()) = client
        .respond_to_approval(ApprovalRespondParams::new(
            session_id(),
            ApprovalId::try_new("approval-1").unwrap(),
            OptionId::try_new("option-1").unwrap(),
        ))
        .await
    else {
        panic!("approval response did not succeed");
    };
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn close_session_and_list_models_use_typed_redacted_contracts() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let close = read_json(&mut socket).await;
        assert_eq!(close["method"], "session.close");
        assert_eq!(close["params"], json!({"sessionId": "session-1"}));
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": close["id"],
                "result": session_record("model-secret", "private-mode", 3),
            }),
        )
        .await;

        let models = read_json(&mut socket).await;
        assert_eq!(models["method"], "models.list");
        assert_eq!(models["params"], json!({"sessionId": "session-1"}));
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": models["id"],
                "result": {"models": ["model-secret", "model-2"]},
            }),
        )
        .await;
    });

    let secret = Secret::new("close-models-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();

    let InvocationOutcome::Succeeded(closed) = client
        .close_session(SessionCloseParams::new(session_id()))
        .await
    else {
        panic!("close did not succeed");
    };
    assert_eq!(closed.session_id().as_str(), "session-1");
    let closed_debug = format!("{closed:?}");
    assert_eq!(closed_debug, "SessionCloseResult { closed: true }");
    for canary in ["session-1", "model-secret", "private-mode", "/workspace"] {
        assert!(!closed_debug.contains(canary));
    }

    let models = client
        .list_models(ModelsListParams::for_session(session_id()))
        .await
        .unwrap();
    assert_eq!(models.models(), ["model-secret", "model-2"]);
    let models_debug = format!("{models:?}");
    assert_eq!(models_debug, "ModelsListResult { model_count: 2 }");
    assert!(!models_debug.contains("model-secret"));

    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn close_session_preserves_target_rejected_and_unknown_semantics() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let rejected = read_json(&mut socket).await;
        assert_eq!(rejected["method"], "session.close");
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": rejected["id"],
                "error": {"code": -32001, "message": "private close rejection"},
            }),
        )
        .await;

        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let unknown = read_json(&mut socket).await;
        assert_eq!(unknown["method"], "session.close");
        socket.close(None).await.unwrap();
    });

    let secret = Secret::new("close-outcome-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .close_session(SessionCloseParams::new(session_id()))
            .await,
        InvocationOutcome::TargetRejected(AppServerClientError::PeerRejected)
    );
    drop(client);

    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .close_session(SessionCloseParams::new(session_id()))
            .await,
        InvocationOutcome::Unknown
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn load_session_maps_remote_rejection_without_peer_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "session.load");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32001,"message":"private peer rejection","data":{"transcript":"private"}}}),
        )
        .await;
    });

    let secret = Secret::new("read-rejection-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    let error = client
        .load_session(SessionLoadParams::new(session_id()))
        .await
        .unwrap_err();

    assert_eq!(error, AppServerClientError::PeerRejected);
    assert!(!error.to_string().contains("private"));
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn missing_session_load_creates_with_peer_owned_native_cwd() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let load = read_json(&mut socket).await;
        assert_eq!(load["method"], "session.load");
        assert_eq!(load["params"], json!({"sessionId": "session-1"}));
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":load["id"],"error":{"code":-32001,"message":"Session not found: session-1"}}),
        )
        .await;

        let create = read_json(&mut socket).await;
        assert_eq!(create["method"], "session.create");
        assert_eq!(
            create["params"],
            json!({"sessionId":"session-1","cwd":"E:/peer-owned-workspace"})
        );
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":create["id"],"result":session_record("model-1", "default", 0)}),
        )
        .await;
    });

    let secret = Secret::new("session-create-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    let outcome = client
        .load_or_create_session(
            session_id(),
            SessionCreateParams::try_new("E:/peer-owned-workspace")
                .unwrap()
                .with_session_id(session_id()),
        )
        .await;

    let InvocationOutcome::Succeeded(session) = outcome else {
        panic!("missing session was not created");
    };
    assert_eq!(session.session_id, session_id());
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn duplicate_session_create_rejection_does_not_reload() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let load = read_json(&mut socket).await;
        assert_eq!(load["method"], "session.load");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":load["id"],"error":{"code":-32603,"message":"Session not found: session-1"}}),
        )
        .await;

        let create = read_json(&mut socket).await;
        assert_eq!(create["method"], "session.create");
        assert_eq!(
            create["params"],
            json!({"sessionId":"session-1","cwd":"E:/peer-owned-workspace"})
        );
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":create["id"],"error":{"code":-32603,"message":"Session cwd unavailable"}}),
        )
        .await;
        let follow_up =
            tokio::time::timeout(std::time::Duration::from_millis(100), socket.next()).await;
        assert!(!matches!(follow_up, Ok(Some(Ok(Message::Text(_))))));
    });

    let secret = Secret::new("duplicate-session-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .load_or_create_session(
                session_id(),
                SessionCreateParams::try_new("E:/peer-owned-workspace")
                    .unwrap()
                    .with_session_id(session_id()),
            )
            .await,
        InvocationOutcome::TargetRejected(AppServerClientError::PeerRejected)
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn session_identity_mismatch_is_unknown_without_follow_up_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let load = read_json(&mut socket).await;
        assert_eq!(load["method"], "session.load");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":load["id"],"result":session_record_for("other-session", "model-1", "default", 0)}),
        )
        .await;
    });

    let secret = Secret::new("identity-mismatch-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .load_or_create_session(
                session_id(),
                SessionCreateParams::try_new("E:/peer-owned-workspace")
                    .unwrap()
                    .with_session_id(session_id()),
            )
            .await,
        InvocationOutcome::Unknown
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn create_connection_loss_is_unknown_without_reload_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let load = read_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":load["id"],"error":{"code":-32001,"message":"Session not found: session-1"}}),
        )
        .await;
        let create = read_json(&mut socket).await;
        assert_eq!(create["method"], "session.create");
        socket.close(None).await.unwrap();
    });

    let secret = Secret::new("create-close-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .load_or_create_session(
                session_id(),
                SessionCreateParams::try_new("E:/peer-owned-workspace")
                    .unwrap()
                    .with_session_id(session_id()),
            )
            .await,
        InvocationOutcome::Unknown
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn unwritten_session_prompt_rejection_is_target_rejected() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        socket.close(None).await.unwrap();
    });

    let secret = Secret::new("unwritten-mutation-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    for _ in 0..32 {
        if client.is_closed() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(client.is_closed());
    assert_eq!(
        client
            .prompt_session(SessionPromptParams::try_new(session_id(), "prompt").unwrap())
            .await,
        InvocationOutcome::TargetRejected(AppServerClientError::ConnectionClosed)
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn set_session_model_and_mode_return_typed_records() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let set_model = read_json(&mut socket).await;
        assert_eq!(set_model["method"], "session.setModel");
        assert_eq!(set_model["params"]["sessionId"], "session-1");
        assert_eq!(set_model["params"]["model"], "model-2");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":set_model["id"],"result":session_record("model-2", "default", 4)}),
        )
        .await;

        let set_mode = read_json(&mut socket).await;
        assert_eq!(set_mode["method"], "session.setMode");
        assert_eq!(set_mode["params"]["sessionId"], "session-1");
        assert_eq!(set_mode["params"]["mode"], "plan");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":set_mode["id"],"result":session_record("model-2", "plan", 5)}),
        )
        .await;
    });

    let secret = Secret::new("set-session-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    let model = client
        .set_session_model(SessionSetModelParams::try_new(session_id(), "model-2").unwrap())
        .await;
    let mode = client
        .set_session_mode(SessionSetModeParams::try_new(session_id(), "plan").unwrap())
        .await;

    let InvocationOutcome::Succeeded(model) = model else {
        panic!("set model did not succeed");
    };
    assert_eq!(model.model.as_deref(), Some("model-2"));
    let InvocationOutcome::Succeeded(mode) = mode else {
        panic!("set mode did not succeed");
    };
    assert_eq!(mode.permission_mode.as_deref(), Some("plan"));
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn set_session_model_maps_remote_rejection_to_target_rejected() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "session.setModel");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32001,"message":"rejected"}}),
        )
        .await;
    });

    let secret = Secret::new("rejected-mutation-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    let outcome = client
        .set_session_model(SessionSetModelParams::try_new(session_id(), "model-2").unwrap())
        .await;

    assert_eq!(
        outcome,
        InvocationOutcome::TargetRejected(AppServerClientError::PeerRejected)
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn written_session_mutations_with_server_close_are_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        for method in ["session.setModel", "session.setMode"] {
            let mut socket = accept_app_server(&listener, Default::default()).await;
            initialize(&mut socket).await;
            let request = read_json(&mut socket).await;
            assert_eq!(request["method"], method);
            socket.close(None).await.unwrap();
        }
    });

    let secret = Secret::new("closed-mutation-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .set_session_model(SessionSetModelParams::try_new(session_id(), "model-2").unwrap())
            .await,
        InvocationOutcome::Unknown
    );
    drop(client);

    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .set_session_mode(SessionSetModeParams::try_new(session_id(), "plan").unwrap())
            .await,
        InvocationOutcome::Unknown
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn persistent_session_connection_keeps_request_success_and_written_mutation_unknown_distinct()
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let list = read_json(&mut socket).await;
        assert_eq!(list["method"], "session.list");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":list["id"],"result":{"sessions":[session_record("model-1", "default", 1)]}}),
        )
        .await;

        let mutation = read_json(&mut socket).await;
        assert_eq!(mutation["method"], "session.setModel");
        socket.close(None).await.unwrap();
    });

    let secret = Secret::new("persistent-mutation-boundary-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(client.list_sessions().await.unwrap().sessions.len(), 1);
    assert_eq!(
        client
            .set_session_model(SessionSetModelParams::try_new(session_id(), "model-2").unwrap())
            .await,
        InvocationOutcome::Unknown
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn written_session_cancel_with_server_close_is_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "session.cancel");
        socket.close(None).await.unwrap();
    });

    let secret = Secret::new("cancel-outcome-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .cancel_session(
                SessionCancelParams::new(session_id())
                    .with_run_id(RunId::try_new("run-1").unwrap())
                    .with_reason("cancelled"),
            )
            .await,
        InvocationOutcome::Unknown
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn written_set_session_mode_with_malformed_success_is_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "session.setMode");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":request["id"],"result":{"unexpected":true}}),
        )
        .await;
    });

    let secret = Secret::new("unknown-mutation-token".into()).unwrap();
    let (updates, _receiver) = mpsc::channel(1);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    let outcome = client
        .set_session_mode(SessionSetModeParams::try_new(session_id(), "plan").unwrap())
        .await;

    assert_eq!(outcome, InvocationOutcome::Unknown);
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn subscribe_events_projects_live_and_returned_replay_with_one_cursor() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "events.subscribe");
        assert_eq!(request["params"]["sessionId"], "session-1");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","method":"event","params":event_envelope(1, "live-event")}),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {
                    "resultType": "subscribed",
                    "clientId": "client-1",
                    "sessionId": "session-1",
                    "afterSeq": null,
                    "replayed": [event_envelope(1, "returned-replay")]
                }
            }),
        )
        .await;
    });

    let secret = Secret::new("subscribe-token".into()).unwrap();
    let (updates, mut receiver) = mpsc::channel(4);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    let EventSubscriptionCursor::Subscribed(replay) = client
        .subscribe_events_with_cursor(session_id(), None)
        .await
        .unwrap()
    else {
        panic!("expected subscribed response");
    };
    assert_eq!(replay.event_count(), 1);
    assert_eq!(replay.cursor(), sequence(1));

    let accepted = receiver.recv().await.unwrap();
    assert_eq!(
        accepted.observation(),
        SessionEventObservation::Accepted {
            sequence: sequence(1)
        }
    );
    assert_eq!(accepted.sequence(), Some(sequence(1)));
    assert!(accepted.has_run());
    assert!(accepted.has_message());

    let duplicate = receiver.recv().await.unwrap();
    assert_eq!(
        duplicate.observation(),
        SessionEventObservation::Duplicate {
            sequence: sequence(1)
        }
    );
    assert_eq!(duplicate.sequence(), Some(sequence(1)));
    assert!(duplicate.has_run());
    assert!(duplicate.has_message());
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn raw_only_subscription_consumes_consecutive_events_without_summary_receiver() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let (release_socket, wait_for_release) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "events.subscribe");
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {
                    "resultType": "subscribed",
                    "clientId": "client-1",
                    "sessionId": "session-1",
                    "afterSeq": null
                }
            }),
        )
        .await;
        for sequence in [1, 2] {
            send_json(
                &mut socket,
                json!({"jsonrpc":"2.0","method":"event","params":event_envelope(sequence, "live-event")}),
            )
            .await;
        }
        wait_for_release.await.unwrap();
    });

    let secret = Secret::new("raw-only-subscribe-token".into()).unwrap();
    let (client, _) = AppServerClient::connect_and_initialize_raw_only(endpoint, &secret)
        .await
        .unwrap();
    let mut events = client.raw_events();
    let EventSubscriptionCursor::Subscribed(replay) = client
        .subscribe_events_with_cursor(session_id(), None)
        .await
        .unwrap()
    else {
        panic!("expected subscribed response");
    };
    assert_eq!(replay.event_count(), 0);
    assert_eq!(replay.cursor(), sequence(2));

    for expected in [sequence(1), sequence(2)] {
        let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            event,
            RawEvent::Envelope(envelope) if envelope.seq == expected
        ));
    }
    release_socket.send(()).unwrap();
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn replay_duplicate_is_observed_without_recovery_while_gap_requires_recovery() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let initial_request = read_json(&mut socket).await;
        assert_eq!(initial_request["method"], "events.replay");
        send_json(
            &mut socket,
            json!({
                "jsonrpc":"2.0",
                "id":initial_request["id"],
                "result":{"events":[event_envelope(1, "initial-event")]}
            }),
        )
        .await;

        let duplicate_request = read_json(&mut socket).await;
        assert_eq!(duplicate_request["method"], "events.replay");
        send_json(
            &mut socket,
            json!({
                "jsonrpc":"2.0",
                "id":duplicate_request["id"],
                "result":{"events":[event_envelope(1, "duplicate-event")]}
            }),
        )
        .await;

        let gap_request = read_json(&mut socket).await;
        assert_eq!(gap_request["method"], "events.replay");
        send_json(
            &mut socket,
            json!({
                "jsonrpc":"2.0",
                "id":gap_request["id"],
                "result":{"events":[event_envelope(3, "gap-event")]}
            }),
        )
        .await;
    });

    let secret = Secret::new("duplicate-gap-token".into()).unwrap();
    let (updates, mut receiver) = mpsc::channel(4);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();

    let initial_result = client.replay_events(session_id(), None, None).await;
    assert!(
        initial_result.is_ok(),
        "initial replay failed: {initial_result:?}"
    );
    let accepted = receiver.recv().await.unwrap();
    assert_eq!(
        accepted.observation(),
        SessionEventObservation::Accepted {
            sequence: sequence(1)
        }
    );

    let duplicate_result = client
        .replay_events(session_id(), Some(sequence(1)), None)
        .await;
    assert!(
        duplicate_result.is_ok(),
        "duplicate replay failed: {duplicate_result:?}"
    );
    let duplicate = receiver.recv().await.unwrap();
    assert_eq!(
        duplicate.observation(),
        SessionEventObservation::Duplicate {
            sequence: sequence(1)
        }
    );

    assert_eq!(
        client
            .replay_events(session_id(), Some(sequence(1)), None)
            .await
            .unwrap_err(),
        AppServerClientError::EventRecoveryRequired
    );
    let gap = receiver.recv().await.unwrap();
    assert_eq!(
        gap.observation(),
        SessionEventObservation::Gap {
            expected: sequence(2),
            received: sequence(3)
        }
    );

    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn replay_gap_requires_recovery_after_emitting_the_gap_observation() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "events.replay");
        send_json(
            &mut socket,
            json!({"jsonrpc":"2.0","id":request["id"],"result":{"events":[event_envelope(2, "gap-event")]}}),
        )
        .await;
    });

    let secret = Secret::new("gap-token".into()).unwrap();
    let (updates, mut receiver) = mpsc::channel(2);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .replay_events(session_id(), None, None)
            .await
            .unwrap_err(),
        AppServerClientError::EventRecoveryRequired
    );

    let gap = receiver.recv().await.unwrap();
    assert_eq!(
        gap.observation(),
        SessionEventObservation::Gap {
            expected: sequence(1),
            received: sequence(2)
        }
    );
    assert_eq!(gap.sequence(), Some(sequence(2)));
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn recover_events_replays_from_the_bound_gap_cursor_without_payload_leaks() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;

        let gap = read_json(&mut socket).await;
        assert_eq!(gap["method"], "events.replay");
        assert_eq!(gap["params"], json!({"sessionId": "session-1"}));
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": gap["id"],
                "result": {"events": [event_envelope(2, "gap-event")]},
            }),
        )
        .await;

        let recovery = read_json(&mut socket).await;
        assert_eq!(recovery["method"], "events.replay");
        assert_eq!(
            recovery["params"],
            json!({"sessionId": "session-1", "afterSeq": 0})
        );
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": recovery["id"],
                "result": {
                    "events": [
                        event_envelope(1, "recovery-event-1"),
                        event_envelope(2, "recovery-event-2"),
                    ],
                },
            }),
        )
        .await;
    });

    let secret = Secret::new("recovery-token".into()).unwrap();
    let (updates, mut receiver) = mpsc::channel(4);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .replay_events(session_id(), None, None)
            .await
            .unwrap_err(),
        AppServerClientError::EventRecoveryRequired
    );
    let gap = receiver.recv().await.unwrap();
    assert!(matches!(
        gap.observation(),
        SessionEventObservation::Gap {
            expected,
            received
        } if expected == sequence(1) && received == sequence(2)
    ));

    let recovery = client
        .recover_events(EventRecoveryCursor::new(session_id()), None)
        .await
        .unwrap();
    assert_eq!(recovery.cursor().session_id().as_str(), "session-1");
    assert_eq!(recovery.cursor().sequence(), sequence(2));
    assert_eq!(recovery.event_count(), 2);
    let debug = format!("{recovery:?}");
    for canary in [
        "session-1",
        "recovery-event",
        "payload",
        "run-1",
        "message-1",
    ] {
        assert!(!debug.contains(canary));
    }

    for expected in [sequence(1), sequence(2)] {
        let update = receiver.recv().await.unwrap();
        assert_eq!(
            update.observation(),
            SessionEventObservation::Accepted { sequence: expected }
        );
    }
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn closing_a_subscribed_connection_emits_closed_update() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let (close_socket, wait_for_close) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "events.subscribe");
        send_json(
            &mut socket,
            json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {
                    "resultType": "subscribed",
                    "clientId": "client-1",
                    "sessionId": "session-1",
                    "afterSeq": null
                }
            }),
        )
        .await;
        wait_for_close.await.unwrap();
        socket.close(None).await.unwrap();
    });

    let secret = Secret::new("closed-update-token".into()).unwrap();
    let (updates, mut receiver) = mpsc::channel(2);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    let EventSubscriptionCursor::Subscribed(replay) = client
        .subscribe_events_with_cursor(session_id(), None)
        .await
        .unwrap()
    else {
        panic!("expected subscribed response");
    };
    assert_eq!(replay.cursor(), sequence(0));
    close_socket.send(()).unwrap();

    let closed = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        closed.observation(),
        SessionEventObservation::Closed {
            cursor: sequence(0)
        }
    );
    assert_eq!(closed.sequence(), Some(sequence(0)));
    assert!(!closed.has_run());
    assert!(!closed.has_message());
    assert!(client.is_closed());
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn closing_before_subscription_response_emits_one_closed_update_after_connection_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept_app_server(&listener, Default::default()).await;
        initialize(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "events.subscribe");
        socket.close(None).await.unwrap();
    });

    let secret = Secret::new("closed-pending-subscription-token".into()).unwrap();
    let (updates, mut receiver) = mpsc::channel(2);
    let (client, _) = AppServerClient::connect_and_initialize(endpoint, &secret, updates)
        .await
        .unwrap();
    assert_eq!(
        client
            .subscribe_events(session_id(), None)
            .await
            .unwrap_err(),
        AppServerClientError::ConnectionClosed
    );

    let closed = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        closed.observation(),
        SessionEventObservation::Closed {
            cursor: sequence(0)
        }
    );
    assert_eq!(closed.sequence(), Some(sequence(0)));
    assert!(!closed.has_run());
    assert!(!closed.has_message());
    assert!(
        tokio::time::timeout(Duration::from_millis(50), receiver.recv())
            .await
            .is_err()
    );
    drop(client);
    server.await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn health_requires_200_true_and_a_bounded_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
    let server = tokio::spawn(async move { serve_health(&listener, false).await });
    assert_eq!(
        health::inspect_health(endpoint).await.unwrap_err(),
        AppServerClientError::HealthFailed
    );
    server.await.unwrap();

    let oversized = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
        health::MAX_HTTP_BODY_BYTES + 1
    );
    assert!(health::validate_health_response(oversized.as_bytes()).is_err());
}

fn session_id() -> SessionId {
    SessionId::try_new("session-1").unwrap()
}

fn sequence(value: u64) -> Sequence {
    Sequence::try_new(value).unwrap()
}

fn session_record(model: &str, permission_mode: &str, last_seq: u64) -> Value {
    session_record_for("session-1", model, permission_mode, last_seq)
}

fn session_record_for(
    session_id: &str,
    model: &str,
    permission_mode: &str,
    last_seq: u64,
) -> Value {
    json!({
        "sessionId": session_id,
        "createdAt": "created-at",
        "updatedAt": "updated-at",
        "runtime": "matcha-agent",
        "lastSeq": last_seq,
        "lastSnapshotVersion": 1,
        "model": model,
        "permissionMode": permission_mode,
        "workerState": {"state": "unloaded", "reason": "notStarted"}
    })
}

fn event_envelope(sequence: u64, event_id: &str) -> Value {
    json!({
        "eventId": event_id,
        "sessionId": "session-1",
        "seq": sequence,
        "runId": "run-1",
        "createdAt": "now",
        "event": {
            "type": "message.delta",
            "messageId": format!("message-{sequence}"),
            "delta": "payload"
        }
    })
}

async fn serve_health(listener: &TcpListener, ok: bool) {
    let (mut stream, _) = listener.accept().await.unwrap();
    let request = read_http_request(&mut stream).await;
    assert!(request.starts_with("GET /health HTTP/1.1\r\n"));
    assert!(!request.to_ascii_lowercase().contains("authorization"));
    let body = json!({"ok":ok,"version":"2.2.1"}).to_string();
    stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    stream.shutdown().await.unwrap();
}

async fn read_http_request(stream: &mut (impl AsyncRead + Unpin)) -> String {
    let mut request = Vec::new();
    let mut byte = [0_u8; 1];
    while !request.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        request.push(byte[0]);
    }
    String::from_utf8(request).unwrap()
}

struct AuthorizationRecorder {
    authorization: StdArc<StdMutex<Option<String>>>,
}

impl Callback for AuthorizationRecorder {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        assert_eq!(request.uri().path(), "/ws");
        *self.authorization.lock().unwrap() = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        Ok(response)
    }
}

async fn accept_app_server(
    listener: &TcpListener,
    authorization: StdArc<StdMutex<Option<String>>>,
) -> WebSocketStream<TcpStream> {
    let (stream, _) = listener.accept().await.unwrap();
    accept_hdr_async(stream, AuthorizationRecorder { authorization })
        .await
        .unwrap()
}

async fn initialize(socket: &mut WebSocketStream<TcpStream>) {
    let request = read_json(socket).await;
    send_initialize(socket, request["id"].clone()).await;
}

async fn send_initialize(socket: &mut WebSocketStream<TcpStream>, id: Value) {
    send_json(
        socket,
        json!({"jsonrpc":"2.0","id":id,"result":serde_json::from_str::<Value>(INITIALIZE_RESULT).unwrap()}),
    )
    .await;
}

async fn read_json(socket: &mut WebSocketStream<TcpStream>) -> Value {
    let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
        panic!("expected text frame");
    };
    serde_json::from_str(text.as_str()).unwrap()
}

async fn send_json(socket: &mut WebSocketStream<TcpStream>, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
