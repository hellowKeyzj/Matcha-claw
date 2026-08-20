use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::*;
use crate::gateway::{
    auth::GatewaySecret,
    client::{GatewayClientMetadata, GatewayEndpoint, test_support::*},
    wire,
};

const SHARED_CONTROL_SCOPES: [&str; 4] = [
    "operator.read",
    "operator.write",
    "operator.admin",
    "operator.approvals",
];
const SHARED_CONTROL_CAPS: [&str; 1] = ["tool-events"];
const SHARED_CONTROL_EVENTS: [&str; 1] = ["tick"];
const SHARED_CONTROL_METHODS: [&str; 7] = [
    "status",
    "config.get",
    "config.patch",
    "config.apply",
    "agents.list",
    SKILLS_STATUS_METHOD,
    wire::SYSTEM_PRESENCE_METHOD,
];
const INSTALL_CONTROL_METHODS: [&str; 8] = [
    "status",
    "config.get",
    "config.patch",
    "config.apply",
    "agents.list",
    SKILLS_STATUS_METHOD,
    wire::SYSTEM_PRESENCE_METHOD,
    SKILLS_INSTALL_METHOD,
];

#[test]
fn request_validates_the_native_clawhub_slug_boundary_without_paths() {
    for slug in ["skill", "skill-2", "a1", "Skill"] {
        assert!(ClawHubSkillInstall::try_new(slug.into(), None, false).is_ok());
    }
    for slug in [
        "",
        "skill/escape",
        "skill\\escape",
        "skill..escape",
        "-skill",
        "skill-",
    ] {
        assert_eq!(
            ClawHubSkillInstall::try_new(slug.into(), None, false),
            Err(SkillInputError::InvalidSlug)
        );
    }
    for version in ["", "   "] {
        assert_eq!(
            ClawHubSkillInstall::try_new("safe-skill".into(), Some(version.into()), false),
            Err(SkillInputError::InvalidVersion)
        );
    }

    let request =
        ClawHubSkillInstall::try_new("safe-skill".into(), Some(" 1.2.3 ".into()), true).unwrap();
    assert_eq!(
        request.into_install_params(),
        json!({"source": "clawhub", "slug": "safe-skill", "version": "1.2.3", "force": true})
    );
    let request =
        ClawHubSkillInstall::try_new("safe-skill".into(), Some("1.2.3".into()), true).unwrap();
    let debug = format!("{request:?}");
    assert!(!debug.contains("safe-skill"));
    assert!(!debug.contains("1.2.3"));
    assert!(debug.contains("REDACTED"));
}

#[test]
fn installed_catalog_projects_only_selectable_normalized_skill_names() {
    let catalog = decode_installed_catalog(GatewayResponse::Success {
        request_id: "skills-status".into(),
        payload: Some(json!({
            "workspaceDir": "private-workspace",
            "skills": [
                {"skillKey": "private-key", "name": " Web ", "eligible": true},
                {"id": "private-id", "name": "writer", "eligible": true, "disabled": false},
                {"name": "blocked", "eligible": true, "blockedByAllowlist": true},
                {"name": "agent-filtered", "eligible": true, "blockedByAgentFilter": true},
                {"name": "missing-env", "eligible": false, "missing": {"env": ["PRIVATE_TOKEN"]}},
                {"name": "disabled", "eligible": true, "disabled": true},
                {"name": "not-installed", "installed": false},
                {"name": "web", "eligible": true}
            ]
        })),
    })
    .unwrap();

    assert_eq!(catalog.names(), ["web", "writer"]);
    let debug = format!("{catalog:?}");
    assert!(!debug.contains("private-workspace"));
    assert!(!debug.contains("PRIVATE_TOKEN"));
}

#[test]
fn status_catalog_projects_only_safe_renderer_fields_and_semantics() {
    let catalog = decode_skill_status_catalog(GatewayResponse::Success {
        request_id: "skills-status".into(),
        payload: Some(json!({
            "workspaceDir": "private-workspace",
            "skills": [
                {
                    "skillKey": "  eligible-skill ",
                    "name": " Eligible ",
                    "description": " Safe description ",
                    "eligible": true
                },
                {
                    "skillKey": "blocked-skill",
                    "name": "Blocked",
                    "description": "Blocked description",
                    "installed": true,
                    "eligible": true,
                    "blockedByAllowlist": true
                },
                {
                    "skillKey": "missing-skill",
                    "name": "Missing",
                    "description": "Missing description",
                    "installed": true,
                    "eligible": false,
                    "missing": {"bins": ["private-bin"], "env": ["PRIVATE_TOKEN"]}
                },
                {
                    "skillKey": "disabled-skill",
                    "name": "Disabled",
                    "description": "Disabled description",
                    "installed": true,
                    "eligible": true,
                    "disabled": true
                }
            ]
        })),
    })
    .unwrap();

    let eligible = catalog
        .entries()
        .iter()
        .find(|entry| entry.key() == "eligible-skill")
        .unwrap();
    assert_eq!(eligible.key(), "eligible-skill");
    assert_eq!(eligible.display_name(), "Eligible");
    assert_eq!(eligible.description(), "Safe description");
    assert!(eligible.enabled());
    assert!(eligible.selectable());
    assert_eq!(eligible.unavailable_reason(), None);

    let blocked = catalog
        .entries()
        .iter()
        .find(|entry| entry.key() == "blocked-skill")
        .unwrap();
    assert!(blocked.enabled());
    assert!(!blocked.selectable());
    assert_eq!(
        blocked.unavailable_reason(),
        Some(SkillStatusUnavailableReason::Blocked)
    );

    let missing = catalog
        .entries()
        .iter()
        .find(|entry| entry.key() == "missing-skill")
        .unwrap();
    assert!(missing.enabled());
    assert!(!missing.selectable());
    assert_eq!(
        missing.unavailable_reason(),
        Some(SkillStatusUnavailableReason::MissingRequirements)
    );
    assert_eq!(
        missing.missing_requirement_categories(),
        [
            MissingSkillRequirementCategory::Binaries,
            MissingSkillRequirementCategory::Environment
        ]
    );

    let disabled = catalog
        .entries()
        .iter()
        .find(|entry| entry.key() == "disabled-skill")
        .unwrap();
    assert!(!disabled.enabled());
    assert!(!disabled.selectable());
    assert_eq!(
        disabled.unavailable_reason(),
        Some(SkillStatusUnavailableReason::Disabled)
    );

    let rendered = format!("{catalog:?}");
    for private in [
        "private-workspace",
        "private-bin",
        "PRIVATE_TOKEN",
        "source",
        "baseDir",
        "filePath",
        "config",
        "version",
        "author",
    ] {
        assert!(!rendered.contains(private), "leaked {private}");
    }
}

#[test]
fn status_catalog_rejects_unknown_or_invalid_wire_payloads() {
    for payload in [
        json!({}),
        json!({"skills": {}}),
        json!({"skills": [{"name": "missing-key"}]}),
        json!({"skills": [{"skillKey": "bad/key"}]}),
        json!({"skills": [{"skillKey": "skill", "installed": "yes"}]}),
        json!({"skills": [{"skillKey": "skill", "missing": {"env": "TOKEN"}}]}),
    ] {
        assert!(
            decode_skill_status_catalog(GatewayResponse::Success {
                request_id: "skills-status".into(),
                payload: Some(payload),
            })
            .is_err()
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn status_catalog_uses_the_dedicated_read_scope_and_method() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let catalog = OpenClawSkillStatusCatalog::new(test_client(&listener, identity.fingerprint()));
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_status_hello(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], SKILLS_STATUS_METHOD);
        assert_eq!(request["params"], json!({}));
        let request_id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {"skills": []}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    assert_eq!(catalog.read().await.unwrap().entries(), []);
    server.await.unwrap();
}

#[test]
fn installed_catalog_rejects_non_status_payloads() {
    assert!(
        decode_installed_catalog(GatewayResponse::Success {
            request_id: "skills-status".into(),
            payload: Some(json!({"skills": {}})),
        })
        .is_err()
    );
}

#[test]
fn installed_catalog_requires_an_explicit_selectable_name() {
    let catalog = decode_installed_catalog(GatewayResponse::Success {
        request_id: "skills-status".into(),
        payload: Some(json!({
            "workspaceDir": "private-workspace",
            "skills": [
                {"skillKey": "only-key", "eligible": true},
                {"skillKey": "not-selectable", "name": "Not selectable", "eligible": false},
                {"skillKey": "also-disabled", "name": "Also disabled", "eligible": true, "disabled": true},
                {"skillKey": "selectable", "name": " Selectable ", "eligible": true}
            ]
        })),
    })
    .unwrap();

    assert_eq!(catalog.names(), ["selectable"]);
    let debug = format!("{catalog:?}");
    assert!(!debug.contains("private-workspace"));
    assert!(!debug.contains("only-key"));
}

#[test]
fn detail_projection_preserves_nested_renderer_safe_fields() {
    let detail = super::operations::decode_detail(serde_json::json!({
        "skill": {
            "slug": "safe-skill",
            "displayName": "Safe Skill",
            "summary": "summary",
            "tags": {"category": "productivity"},
            "createdAt": 10,
            "updatedAt": 20
        },
        "latestVersion": {"version": "1.2.3", "createdAt": 11, "changelog": "changes"},
        "metadata": {"os": ["windows"], "systems": ["node"]},
        "owner": {"handle": "owner", "displayName": "Owner", "image": "https://example.invalid/avatar"}
    })).unwrap();
    let skill = detail.skill().unwrap();
    assert_eq!(skill.slug(), "safe-skill");
    assert_eq!(
        skill.tags().get("category").map(String::as_str),
        Some("productivity")
    );
    assert_eq!(skill.created_at(), 10);
    assert_eq!(skill.updated_at(), 20);
    let version = detail.latest_version().unwrap();
    assert_eq!(version.version(), "1.2.3");
    assert_eq!(version.created_at(), 11);
    assert_eq!(version.changelog(), Some("changes"));
    assert_eq!(
        detail.metadata().unwrap().os(),
        Some(["windows".to_owned()].as_slice())
    );
    assert_eq!(detail.owner().unwrap().handle(), Some("owner"));
}

#[test]
fn skill_slug_requests_reject_path_fragments() {
    for slug in [
        "skill/escape",
        "skill\\\\escape",
        "skill..escape",
        "/skill",
        "skill/",
    ] {
        assert!(SkillDetailRequest::try_new(slug.to_owned()).is_err());
        assert!(SkillInstallRequest::clawhub(slug.to_owned(), None, false).is_err());
    }
}

#[tokio::test(flavor = "current_thread")]
async fn gateway_port_projects_native_install_acknowledgement_without_status_readback() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let gateway = test_gateway(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], SKILLS_INSTALL_METHOD);
        assert_eq!(
            request["params"],
            json!({"source": "clawhub", "slug": "safe-skill", "version": "1.2.3", "force": true})
        );
        let request_id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {
                    "ok": true, "slug": "safe-skill", "version": "1.2.3",
                    "targetDir": "private-target-dir", "stdout": "private-stdout", "stderr": "private-stderr"
                }
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let request =
        ClawHubSkillInstall::try_new("safe-skill".into(), Some("1.2.3".into()), true).unwrap();
    let outcome = gateway.install_clawhub_skill(request).await;
    server.await.unwrap();

    assert_eq!(outcome, ClawHubSkillInstallOutcome::Accepted);
    let debug = format!("{gateway:?}");
    for private in ["private-target-dir", "private-stdout", "private-stderr"] {
        assert!(!debug.contains(private));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn install_capability_gate_prevents_mutation_without_the_native_effect_method() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let installer = test_installer(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello_with_methods(&mut socket, &[]).await;
        socket.close(None).await.unwrap();
    });

    let outcome = installer
        .install(ClawHubSkillInstall::try_new("safe-skill".into(), None, false).unwrap())
        .await;
    server.await.unwrap();

    assert_eq!(outcome, ClawHubSkillInstallOutcome::Unknown);
}

#[tokio::test(flavor = "current_thread")]
async fn install_version_gate_prevents_mutation() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let gateway = test_gateway(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello_with_methods_and_version(
            &mut socket,
            &INSTALL_CONTROL_METHODS,
            "unexpected-openclaw-version",
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let outcome = gateway
        .install_clawhub_skill(
            ClawHubSkillInstall::try_new("safe-skill".into(), None, false).unwrap(),
        )
        .await;
    server.await.unwrap();

    assert_eq!(outcome, ClawHubSkillInstallOutcome::Unknown);
}

#[tokio::test(flavor = "current_thread")]
async fn an_explicit_native_rejection_is_rejected_without_exposure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let installer = test_installer(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], SKILLS_INSTALL_METHOD);
        let request_id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request_id, "ok": false,
                "error": {
                    "code": "UNAVAILABLE", "message": "private native failure",
                    "details": {"targetDir": "private-target-dir"}, "retryable": false, "retryAfterMs": null
                }
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let outcome = installer
        .install(ClawHubSkillInstall::try_new("safe-skill".into(), None, false).unwrap())
        .await;
    server.await.unwrap();

    assert_eq!(outcome, ClawHubSkillInstallOutcome::Rejected);
}

#[tokio::test(flavor = "current_thread")]
async fn connection_loss_after_send_is_unknown_and_never_attempts_a_retry_or_readback() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let installer = test_installer(&listener, identity.fingerprint());
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], SKILLS_INSTALL_METHOD);
        socket.send(Message::Close(None)).await.unwrap();
    });

    let outcome = installer
        .install(ClawHubSkillInstall::try_new("safe-skill".into(), None, false).unwrap())
        .await;
    server.await.unwrap();

    assert_eq!(outcome, ClawHubSkillInstallOutcome::Unknown);
}

fn test_installer(
    listener: &TcpListener,
    certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
) -> ClawHubSkillInstaller {
    ClawHubSkillInstaller::new(test_client(listener, certificate_fingerprint))
}

fn test_gateway(
    listener: &TcpListener,
    certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
) -> crate::port::OpenClawGateway {
    let (events, _) = tokio::sync::mpsc::channel(1);
    let (canonical_events, _) = tokio::sync::mpsc::channel(32);
    crate::port::OpenClawGateway::new(
        GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
        certificate_fingerprint,
        Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
        GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
        events,
        canonical_events,
    )
}

fn test_client(
    listener: &TcpListener,
    certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
) -> Arc<GatewayClient> {
    Arc::new(GatewayClient::new(
        GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
        certificate_fingerprint,
        Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
        GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
    ))
}

async fn serve_hello(socket: &mut TestSocket) {
    serve_hello_with_methods(socket, &INSTALL_CONTROL_METHODS).await;
}

async fn serve_status_hello(socket: &mut TestSocket) {
    serve_hello_with_methods(socket, &SHARED_CONTROL_METHODS).await;
}

async fn serve_hello_with_methods(socket: &mut TestSocket, methods: &[&str]) {
    serve_hello_with_methods_and_version(socket, methods, wire::OPENCLAW_GATEWAY_VERSION).await;
}

async fn serve_hello_with_methods_and_version(
    socket: &mut TestSocket,
    methods: &[&str],
    version: &str,
) {
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
    assert_eq!(connect["params"]["scopes"], json!(SHARED_CONTROL_SCOPES));
    assert_eq!(connect["params"]["caps"], json!(SHARED_CONTROL_CAPS));
    let request_id = connect["id"].as_str().unwrap();
    send_json(
        socket,
        json!({
            "type": "res", "id": request_id, "ok": true,
            "payload": {
                "type": "hello-ok", "protocol": 4,
                "server": {"version": version, "connId": "fixture"},
                "features": {"methods": methods, "events": SHARED_CONTROL_EVENTS},
                "snapshot": {
                    "presence": [], "health": {"ok": true},
                    "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 1
                },
                "auth": {"role": "operator", "scopes": SHARED_CONTROL_SCOPES},
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
