use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::{Error as WebSocketError, Message, error::ProtocolError};

use super::*;
use crate::gateway::{
    auth::GatewaySecret,
    client::{GatewayClientMetadata, GatewayEndpoint, test_support::*},
    wire,
};

#[tokio::test(flavor = "current_thread")]
async fn security_emergency_requires_a_complete_lockdown_receipt_without_projection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let client = test_client(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket, SECURITY_EMERGENCY_RUN_METHOD).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], SECURITY_EMERGENCY_RUN_METHOD);
        assert_eq!(request["params"], json!({}));
        let request_id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": security_emergency_payload()
            }),
        )
        .await;
        assert_connection_closed(&mut socket).await;
    });

    let effect = SecurityEmergencyOperation::new(Arc::new(client))
        .run()
        .await;
    server.await.unwrap();

    assert_eq!(
        effect,
        SecurityEmergencyEffect::Applied(SecurityEmergencyReceipt)
    );
    assert!(!format!("{effect:?}").contains("private-canary"));
}

#[test]
fn security_emergency_decoder_rejects_unknown_or_incomplete_results_without_exposing_them() {
    let canary = "private-canary";
    let mut missing_lockdown = security_emergency_payload();
    missing_lockdown.as_object_mut().unwrap().remove("lockdown");
    let mut non_strict = security_emergency_payload();
    non_strict["lockdown"]["preset"] = json!("balanced");
    let mut unexpected = security_emergency_payload();
    unexpected["unexpected"] = json!(canary);

    for payload in [missing_lockdown, non_strict, unexpected] {
        let effect = decode_security_emergency(success_response(payload));
        assert!(effect.is_err());
        assert!(!format!("{effect:?}").contains(canary));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn security_emergency_rejection_and_transport_ambiguity_do_not_claim_lockdown() {
    for response in [
        json!({
            "type": "res", "ok": false,
            "error": {
                "code": "denied", "message": "access denied", "details": null,
                "retryable": false, "retryAfterMs": null
            }
        }),
        json!({
            "type": "res", "ok": true,
            "payload": {"backend": "security-core", "lockdownApplied": true}
        }),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket, SECURITY_EMERGENCY_RUN_METHOD).await;
            let request = read_json(&mut socket).await;
            let request_id = request["id"].as_str().unwrap();
            let mut response = response;
            response["id"] = json!(request_id);
            send_json(&mut socket, response).await;
            assert_connection_closed(&mut socket).await;
        });

        let effect = SecurityEmergencyOperation::new(Arc::new(client))
            .run()
            .await;
        server.await.unwrap();

        assert!(matches!(
            effect,
            SecurityEmergencyEffect::RuntimeRejected | SecurityEmergencyEffect::OutcomeUnknown
        ));
    }
}

fn success_response(payload: Value) -> GatewayResponse {
    GatewayResponse::Success {
        request_id: "test-request".into(),
        payload: Some(payload),
    }
}

fn security_emergency_payload() -> Value {
    json!({
        "backend": "security-core",
        "lockdownApplied": true,
        "lockdown": {
            "preset": "strict",
            "blockDestructive": true,
            "blockSecrets": true,
            "runtimeGuardEnabled": true,
            "enablePromptInjectionGuard": true,
            "allowlistedTools": 0,
            "allowlistedSessions": 0,
            "allowDomains": 0
        },
        "incidentId": "incident-1",
        "appliedAt": 42,
        "evidenceDir": "private-canary/evidence",
        "reportPath": "private-canary/report",
        "runtimeSnapshotPath": "private-canary/snapshot",
        "recentChanges": ["private-canary/change"],
        "recommendations": ["private-canary/recommendation"],
        "skippedChecks": ["private-canary/check"]
    })
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

async fn serve_hello(socket: &mut TestSocket, method: &str) {
    serve_hello_with_capability(socket, wire::OPENCLAW_GATEWAY_VERSION, vec![method]).await;
}

async fn serve_hello_with_capability(socket: &mut TestSocket, version: &str, methods: Vec<&str>) {
    send_json(
        socket,
        json!({
            "type": "event", "event": "connect.challenge",
            "payload": {"nonce": "fake-nonce", "ts": 42}
        }),
    )
    .await;
    let connect = read_json(socket).await;
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
    let request_id = connect["id"].as_str().unwrap();
    send_json(
        socket,
        json!({
            "type": "res", "id": request_id, "ok": true,
            "payload": {
                "type": "hello-ok", "protocol": 4,
                "server": {"version": version, "connId": "fixture"},
                "features": {
                    "methods": [
                        "status",
                        "config.get",
                        "config.patch",
                        "config.apply",
                        "agents.list",
                        "skills.status",
                        "system-presence",
                        methods[0]
                    ],
                    "events": ["tick"]
                },
                "snapshot": {
                    "presence": [], "health": {"ok": true},
                    "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 1
                },
                "auth": {
                    "role": "operator",
                    "scopes": [
                        "operator.read",
                        "operator.write",
                        "operator.admin",
                        "operator.approvals"
                    ]
                },
                "policy": {
                    "maxPayload": 26214400, "maxBufferedBytes": 52428800,
                    "tickIntervalMs": 15000
                }
            }
        }),
    )
    .await;
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

async fn assert_connection_closed(socket: &mut TestSocket) {
    assert!(matches!(
        socket.next().await,
        None | Some(Ok(Message::Close(_)))
            | Some(Err(WebSocketError::Protocol(
                ProtocolError::ResetWithoutClosingHandshake
            )))
    ));
}
