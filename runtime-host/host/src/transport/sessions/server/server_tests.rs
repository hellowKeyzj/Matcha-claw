use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer as _, SigningKey};
use matcha_agent::lifecycle::secret::Secret;
use openclaw::{
    gateway::{auth::GatewaySecret, client::GatewayClientMetadata},
    lifecycle::state_dir::CanonicalStateDir,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    task::JoinHandle,
};

use super::*;
use crate::{Host, HostInput, MatchaAgentInput, OpenClawInput, owner};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    base: PathBuf,
    matcha_storage_parent: PathBuf,
    openclaw_dir: PathBuf,
    state_parent: PathBuf,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "runtime-host-session-transport-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        let state_parent = base.join("state");
        let matcha_storage_parent = base.join("matcha");
        let openclaw_dir = base.join("openclaw");
        let templates = openclaw_dir.join("docs/reference/templates");
        fs::create_dir_all(&state_parent).expect("create state parent");
        fs::create_dir(&matcha_storage_parent).expect("create matcha parent");
        fs::create_dir(matcha_storage_parent.join("app-server")).expect("create app-server root");
        fs::create_dir_all(&templates).expect("create workspace templates");
        for name in [
            "AGENTS.md",
            "SOUL.md",
            "TOOLS.md",
            "IDENTITY.md",
            "USER.md",
            "HEARTBEAT.md",
            "BOOTSTRAP.md",
        ] {
            fs::write(templates.join(name), format!("{name} template\n"))
                .expect("write workspace template");
        }
        Self {
            base,
            matcha_storage_parent,
            openclaw_dir,
            state_parent,
        }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

struct RunningServer {
    root: TestRoot,
    owner: owner::Owner,
    task: JoinHandle<io::Result<()>>,
    port: u16,
}

impl RunningServer {
    async fn start() -> Self {
        let root = TestRoot::new();
        let (host, events) = Host::new(host_input(&root)).expect("construct host");
        let owner = owner::Owner::spawn(host, events);
        let verifier = CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        let server = Server::bind(0, verifier, owner.handle())
            .await
            .expect("bind server");
        let port = server.port();
        let task = tokio::spawn(server.run());
        Self {
            root,
            owner,
            task,
            port,
        }
    }

    async fn request(&self, request: &str) -> Value {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port))
            .await
            .expect("connect transport");
        stream
            .write_all(request.as_bytes())
            .await
            .expect("write request");
        stream.shutdown().await.expect("close request");
        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .await
            .expect("read response");
        parse_response(&response)
    }

    async fn stop(mut self) {
        self.task.abort();
        let _ = self.task.await;
        loop {
            let attempt = self
                .owner
                .handle()
                .shutdown()
                .await
                .expect("shutdown request");
            if attempt.terminal {
                let _ = self.owner.join().await.expect("join owner");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let _ = &self.root;
    }
}

#[tokio::test]
async fn localhost_transport_enforces_fixed_route_authorization_and_redaction() {
    let server = RunningServer::start().await;

    for request in [
        http_request("GET", "/api/sessions", None, ""),
        http_request("POST", "/api/other", None, ""),
    ] {
        let response = server.request(&request).await;
        assert_eq!(response["status"], 404);
        assert_eq!(
            response["body"],
            json!({
                "success": false,
                "error": "Session list route is not available",
            })
        );
    }

    let private_decision = "private-capability-decision";
    let unauthorized = server
        .request(&http_request(
            "POST",
            "/api/sessions",
            Some(private_decision),
            &session_request().to_string(),
        ))
        .await;
    assert_eq!(unauthorized["status"], 401);
    assert_eq!(
        unauthorized["body"],
        json!({
            "success": false,
            "error": "Session list authorization is invalid",
        })
    );
    assert!(!unauthorized.to_string().contains(private_decision));

    let malformed = server
        .request(&http_request(
            "POST",
            "/api/sessions",
            Some(&decision()),
            "{private-malformed-body",
        ))
        .await;
    assert_eq!(malformed["status"], 400);
    assert_eq!(
        malformed["body"],
        json!({
            "success": false,
            "error": "Session list request is invalid",
        })
    );
    assert!(!malformed.to_string().contains("private-malformed-body"));

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_serves_fixed_runtime_endpoint_directory() {
    let server = RunningServer::start().await;

    let response = server
        .request(&http_request(
            "GET",
            "/api/runtime-endpoints/list",
            Some(&directory_decision()),
            "",
        ))
        .await;
    assert_eq!(response["status"], 200);
    let endpoints = response["body"]["endpoints"]
        .as_array()
        .expect("directory endpoints");
    assert_eq!(
        endpoints
            .iter()
            .map(|endpoint| endpoint["id"].as_str().expect("endpoint id"))
            .collect::<Vec<_>>(),
        ["openclaw-local", "matcha-agent-local"]
    );
    assert!(!response.to_string().contains("pid"));
    assert!(!response.to_string().contains("startupDiagnostic"));

    let get_without_content_length = server
        .request(&http_get_without_content_length(
            "/api/runtime-endpoints/list",
            Some(&directory_decision()),
        ))
        .await;
    assert_eq!(get_without_content_length["status"], 200);
    assert_eq!(
        get_without_content_length["body"]["endpoints"][0]["id"],
        "openclaw-local"
    );

    let unauthorized = server
        .request(&http_request(
            "GET",
            "/api/runtime-endpoints/list",
            None,
            "",
        ))
        .await;
    assert_eq!(unauthorized["status"], 401);
    assert_eq!(
        unauthorized["body"],
        json!({
            "success": false,
            "error": "Runtime endpoint directory authorization is invalid",
        })
    );

    let wrong_method = server
        .request(&http_request(
            "POST",
            "/api/runtime-endpoints/list",
            None,
            "",
        ))
        .await;
    assert_eq!(wrong_method["status"], 404);

    let tools_unauthorized = server
        .request(&http_request("GET", "/api/platform/tools", None, ""))
        .await;
    assert_eq!(tools_unauthorized["status"], 401);
    assert_eq!(
        tools_unauthorized["body"],
        json!({
            "success": false,
            "error": "Platform tools authorization is invalid",
        })
    );

    for decision in [
        directory_decision_with(
            "/api/sessions",
            "runtime:endpoints:read",
            "runtime.endpoints.directory",
            "runtime-endpoint-directory",
        ),
        directory_decision_with(
            "/api/runtime-endpoints/list",
            "sessions:read",
            "runtime.endpoints.directory",
            "runtime-endpoint-directory",
        ),
        directory_decision_with(
            "/api/runtime-endpoints/list",
            "runtime:endpoints:read",
            "sessions.list",
            "runtime-endpoint-directory",
        ),
        directory_decision_with(
            "/api/runtime-endpoints/list",
            "runtime:endpoints:read",
            "runtime.endpoints.directory",
            "session-catalog",
        ),
    ] {
        let response = server
            .request(&http_request(
                "GET",
                "/api/runtime-endpoints/list",
                Some(&decision),
                "",
            ))
            .await;
        assert_eq!(response["status"], 401);
        assert_eq!(
            response["body"],
            json!({
                "success": false,
                "error": "Runtime endpoint directory authorization is invalid",
            })
        );
    }

    let platform_tools_unavailable = server
        .request(&http_request(
            "GET",
            "/api/platform/tools",
            Some(&platform_tools_decision()),
            "",
        ))
        .await;
    assert_eq!(platform_tools_unavailable["status"], 503);
    assert_eq!(
        platform_tools_unavailable["body"],
        json!({
            "success": false,
            "error": "Platform tools catalog is unavailable",
        })
    );
    assert!(
        !platform_tools_unavailable
            .to_string()
            .contains("MatchaClaw")
    );

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_enforces_matcha_catalog_request_auth_endpoint_and_redaction() {
    let server = RunningServer::start().await;

    for request in [
        http_request("GET", "/api/matcha/sessions", None, ""),
        http_request("POST", "/api/matcha/sessions/other", None, ""),
    ] {
        let response = server.request(&request).await;
        assert_eq!(response["status"], 404);
        assert_eq!(response["connection"], "close");
    }

    let private_decision = "private-matcha-catalog-decision";
    let unauthorized = server
        .request(&http_request(
            "POST",
            "/api/matcha/sessions",
            Some(private_decision),
            &matcha_session_request().to_string(),
        ))
        .await;
    assert_eq!(unauthorized["status"], 401);
    assert_eq!(
        unauthorized["body"],
        json!({
            "success": false,
            "error": "Matcha session catalog authorization is invalid",
        })
    );
    assert!(!unauthorized.to_string().contains(private_decision));

    let mut unknown_field = matcha_session_request();
    unknown_field["input"]["endpoint"]["private"] = json!("do-not-leak");
    let invalid = server
        .request(&http_request(
            "POST",
            "/api/matcha/sessions",
            Some(&matcha_catalog_decision()),
            &unknown_field.to_string(),
        ))
        .await;
    assert_eq!(invalid["status"], 400);
    assert_eq!(
        invalid["body"],
        json!({
            "success": false,
            "error": "Matcha session catalog request is invalid",
        })
    );
    assert!(!invalid.to_string().contains("do-not-leak"));

    let mut wrong_endpoint = matcha_session_request();
    wrong_endpoint["scope"]["endpoint"]["runtimeAdapterId"] = json!("openclaw");
    let wrong_endpoint = server
        .request(&http_request(
            "POST",
            "/api/matcha/sessions",
            Some(&matcha_catalog_decision()),
            &wrong_endpoint.to_string(),
        ))
        .await;
    assert_eq!(wrong_endpoint["status"], 400);

    let unavailable = server
        .request(&http_request(
            "POST",
            "/api/matcha/sessions",
            Some(&matcha_catalog_decision()),
            &matcha_session_request().to_string(),
        ))
        .await;
    assert_eq!(unavailable["status"], 503);
    assert_eq!(
        unavailable["body"],
        json!({
            "success": false,
            "error": "Matcha session catalog is unavailable",
        })
    );
    assert!(!unavailable.to_string().contains("test-matcha-secret"));

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_binds_timeline_operations_to_fixed_endpoints() {
    let server = RunningServer::start().await;

    for (path, operation) in [
        ("/api/sessions/load", "sessions.load"),
        ("/api/sessions/window", "sessions.window"),
    ] {
        let response = server
            .request(&http_request(
                "POST",
                path,
                Some(&timeline_decision(path, "session.management")),
                &timeline_request(operation).to_string(),
            ))
            .await;
        assert_eq!(response["status"], 503);
        assert_eq!(
            response["body"],
            json!({
                "success": false,
                "error": "Session timeline is unavailable",
            })
        );
    }

    let operation_as_capability = server
        .request(&http_request(
            "POST",
            "/api/sessions/load",
            Some(&timeline_decision("/api/sessions/load", "sessions.load")),
            &timeline_request("sessions.load").to_string(),
        ))
        .await;
    assert_eq!(operation_as_capability["status"], 401);
    assert_eq!(
        operation_as_capability["body"],
        json!({
            "success": false,
            "error": "Session timeline authorization is invalid",
        })
    );

    let crossed = server
        .request(&http_request(
            "POST",
            "/api/sessions/window",
            Some(&timeline_decision(
                "/api/sessions/load",
                "session.management",
            )),
            &timeline_request("sessions.load").to_string(),
        ))
        .await;
    assert_eq!(crossed["status"], 400);
    assert_eq!(
        crossed["body"],
        json!({
            "success": false,
            "error": "Session timeline request is invalid",
        })
    );

    let mut invalid = timeline_request("sessions.load");
    invalid["input"]["private"] = json!("do-not-leak");
    let invalid = server
        .request(&http_request(
            "POST",
            "/api/sessions/load",
            Some(&timeline_decision(
                "/api/sessions/load",
                "session.management",
            )),
            &invalid.to_string(),
        ))
        .await;
    assert_eq!(invalid["status"], 400);
    assert!(!invalid.to_string().contains("do-not-leak"));

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_enforces_fixed_delete_identity_authorization_and_redaction() {
    let server = RunningServer::start().await;

    for request in [
        http_request("GET", "/api/sessions/delete", None, ""),
        http_request("POST", "/api/sessions/delete/other", None, ""),
    ] {
        let response = server.request(&request).await;
        assert_eq!(response["status"], 404);
        assert_eq!(response["connection"], "close");
    }

    let private_decision = "private-capability-decision";
    let unauthorized = server
        .request(&http_request(
            "POST",
            "/api/sessions/delete",
            Some(private_decision),
            &delete_request().to_string(),
        ))
        .await;
    assert_eq!(unauthorized["status"], 401);
    assert_eq!(unauthorized["connection"], "close");
    assert_eq!(
        unauthorized["body"],
        json!({
            "success": false,
            "error": "Session delete authorization is invalid",
        })
    );
    assert!(!unauthorized.to_string().contains(private_decision));

    let mut unknown_field = delete_request();
    unknown_field["input"]["sessionIdentity"]["private"] = json!("do-not-leak");
    let invalid = server
        .request(&http_request(
            "POST",
            "/api/sessions/delete",
            Some(&delete_decision()),
            &unknown_field.to_string(),
        ))
        .await;
    assert_eq!(invalid["status"], 400);
    assert_eq!(invalid["connection"], "close");
    assert_eq!(
        invalid["body"],
        json!({
            "success": false,
            "error": "Session delete request is invalid",
        })
    );
    assert!(!invalid.to_string().contains("do-not-leak"));

    let outcome = server
        .request(&http_request(
            "POST",
            "/api/sessions/delete",
            Some(&delete_decision()),
            &delete_request().to_string(),
        ))
        .await;
    assert_eq!(outcome["status"], 200);
    assert_eq!(outcome["connection"], "close");
    assert_eq!(outcome["body"], json!({ "outcome": "unknown" }));

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_enforces_fixed_rename_identity_authorization_and_redaction() {
    let server = RunningServer::start().await;

    for request in [
        http_request("GET", "/api/sessions/rename", None, ""),
        http_request("POST", "/api/sessions/rename/other", None, ""),
    ] {
        let response = server.request(&request).await;
        assert_eq!(response["status"], 404);
        assert_eq!(response["connection"], "close");
    }

    let private_decision = "private-capability-decision";
    let unauthorized = server
        .request(&http_request(
            "POST",
            "/api/sessions/rename",
            Some(private_decision),
            &rename_request().to_string(),
        ))
        .await;
    assert_eq!(unauthorized["status"], 401);
    assert_eq!(unauthorized["connection"], "close");
    assert_eq!(
        unauthorized["body"],
        json!({
            "success": false,
            "error": "Session rename authorization is invalid",
        })
    );
    assert!(!unauthorized.to_string().contains(private_decision));

    let mut unknown_field = rename_request();
    unknown_field["input"]["private"] = json!("do-not-leak");
    let invalid = server
        .request(&http_request(
            "POST",
            "/api/sessions/rename",
            Some(&rename_decision()),
            &unknown_field.to_string(),
        ))
        .await;
    assert_eq!(invalid["status"], 400);
    assert_eq!(invalid["connection"], "close");
    assert_eq!(
        invalid["body"],
        json!({
            "success": false,
            "error": "Session rename request is invalid",
        })
    );
    assert!(!invalid.to_string().contains("do-not-leak"));

    let outcome = server
        .request(&http_request(
            "POST",
            "/api/sessions/rename",
            Some(&rename_decision()),
            &rename_request().to_string(),
        ))
        .await;
    assert_eq!(outcome["status"], 200);
    assert_eq!(outcome["connection"], "close");
    assert_eq!(outcome["body"], json!({ "outcome": "unknown" }));

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_limits_headers_without_stalling_another_client() {
    let server = RunningServer::start().await;
    let stalled = TcpStream::connect(("127.0.0.1", server.port))
        .await
        .expect("connect stalled client");
    stalled
        .try_write(b"POST /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\n")
        .expect("write partial headers");

    let oversized_header = format!(
        "POST /api/sessions HTTP/1.1\r\nX-Test: {}",
        "x".repeat(MAX_HEADER_BYTES)
    );
    let response = server.request(&oversized_header).await;
    assert_eq!(response["status"], 400);

    let next_client = server
        .request(&http_request("GET", "/api/sessions", None, ""))
        .await;
    assert_eq!(next_client["status"], 404);
    drop(stalled);

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_projects_native_unavailability_without_private_details() {
    let server = RunningServer::start().await;
    let response = server
        .request(&http_request(
            "POST",
            "/api/sessions",
            Some(&decision()),
            &session_request().to_string(),
        ))
        .await;

    assert_eq!(response["status"], 503);
    assert_eq!(
        response["body"],
        json!({
            "success": false,
            "error": "Session catalog is unavailable",
        })
    );
    assert!(!response.to_string().contains("MatchaClaw"));

    server.stop().await;
}

#[test]
fn session_transport_does_not_reintroduce_gateway_subscription_client() {
    for source in [
        include_str!("../../../composition/session.rs"),
        include_str!("../../../composition/host.rs"),
        include_str!("../mod.rs"),
        include_str!("../server.rs"),
    ] {
        assert!(!source.contains("sessions.subscribe"));
        assert!(!source.contains("SessionClient"));
    }
}

fn http_request(method: &str, path: &str, authorization: Option<&str>, body: &str) -> String {
    format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{}Content-Length: {}\r\n\r\n{body}",
        authorization
            .map(|value| format!("Authorization: Bearer {value}\r\n"))
            .unwrap_or_default(),
        body.len(),
    )
}

fn http_get_without_content_length(path: &str, authorization: Option<&str>) -> String {
    format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{}\r\n",
        authorization
            .map(|value| format!("Authorization: Bearer {value}\r\n"))
            .unwrap_or_default(),
    )
}

fn parse_response(response: &[u8]) -> Value {
    let response = std::str::from_utf8(response).expect("response utf8");
    let (head, body) = response.split_once("\r\n\r\n").expect("response body");
    let status = head
        .split_whitespace()
        .nth(1)
        .expect("status")
        .parse::<u16>()
        .expect("numeric status");
    let connection = head
        .lines()
        .find_map(|line| line.strip_prefix("Connection: "))
        .expect("connection header");
    json!({
        "status": status,
        "connection": connection.to_ascii_lowercase(),
        "body": serde_json::from_str::<Value>(body).expect("json body"),
    })
}

fn timeline_request(operation: &str) -> Value {
    let identity = json!({
        "endpoint": {
            "kind": "native-runtime",
            "runtimeAdapterId": "openclaw",
            "runtimeInstanceId": "local",
        },
        "agentId": "main",
        "sessionKey": "session-1",
    });
    let mut input = json!({
        "sessionKey": "session-1",
        "sessionIdentity": identity.clone(),
    });
    if operation == "sessions.window" {
        input["mode"] = json!("latest");
    }
    json!({
        "id": "session.management",
        "operationId": operation,
        "scope": { "kind": "session", "identity": identity.clone() },
        "target": { "kind": "session", "identity": identity },
        "input": input,
    })
}

fn delete_request() -> Value {
    let identity = json!({
        "endpoint": {
            "kind": "native-runtime",
            "runtimeAdapterId": "openclaw",
            "runtimeInstanceId": "local",
        },
        "agentId": "main",
        "sessionKey": "session-1",
    });
    json!({
        "id": "session.management",
        "operationId": "sessions.delete",
        "scope": { "kind": "session", "identity": identity.clone() },
        "target": { "kind": "session", "identity": identity.clone() },
        "input": { "sessionIdentity": identity },
    })
}

fn rename_request() -> Value {
    let mut request = delete_request();
    let session_key = json!("agent:main:session-1");
    request["operationId"] = json!("sessions.rename");
    request["scope"]["identity"]["sessionKey"] = session_key.clone();
    request["target"]["identity"]["sessionKey"] = session_key.clone();
    request["input"]["sessionIdentity"]["sessionKey"] = session_key;
    request["input"]["label"] = json!("Renamed");
    request
}

fn session_request() -> Value {
    json!({
        "id": "session.management",
        "operationId": "sessions.list",
        "scope": {
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": "openclaw",
                "runtimeInstanceId": "local",
            },
        },
        "target": { "kind": "runtime-endpoint" },
        "input": {
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": "openclaw",
                "runtimeInstanceId": "local",
            },
        },
    })
}

fn matcha_session_request() -> Value {
    json!({
        "id": "session.management",
        "operationId": "sessions.list",
        "scope": {
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": "matcha-agent",
                "runtimeInstanceId": "local",
            },
        },
        "target": { "kind": "runtime-endpoint" },
        "input": {
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": "matcha-agent",
                "runtimeInstanceId": "local",
            },
        },
    })
}

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

fn verification_key() -> String {
    let mut bytes = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn timeline_decision(endpoint: &str, capability: &str) -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": endpoint,
        "scope": "sessions:read",
        "capability": capability,
        "subject": "session-timeline",
        "expiresAt": now_millis() + 60_000,
        "correlation": format!("test:timeline:{}", NEXT_ROOT.fetch_add(1, Ordering::Relaxed)),
        "revision": "test",
    });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
    let signed = format!("capability-decision.v1.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
    format!("{signed}.{signature}")
}

fn delete_decision() -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": "/api/sessions/delete",
        "scope": "sessions:write",
        "capability": "sessions.delete",
        "subject": "session-delete",
        "expiresAt": now_millis() + 60_000,
        "correlation": format!("test:{}", NEXT_ROOT.fetch_add(1, Ordering::Relaxed)),
        "revision": "test",
    });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
    let signed = format!("capability-decision.v1.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
    format!("{signed}.{signature}")
}

fn rename_decision() -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": "/api/sessions/rename",
        "scope": "sessions:write",
        "capability": "sessions.rename",
        "subject": "session-rename",
        "expiresAt": now_millis() + 60_000,
        "correlation": format!("test:{}", NEXT_ROOT.fetch_add(1, Ordering::Relaxed)),
        "revision": "test",
    });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
    let signed = format!("capability-decision.v1.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
    format!("{signed}.{signature}")
}

fn matcha_catalog_decision() -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": "/api/matcha/sessions",
        "scope": "sessions:read",
        "capability": "sessions.list",
        "subject": "matcha-session-catalog",
        "expiresAt": now_millis() + 60_000,
        "correlation": format!("test:matcha:{}", NEXT_ROOT.fetch_add(1, Ordering::Relaxed)),
        "revision": "test",
    });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
    let signed = format!("capability-decision.v1.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
    format!("{signed}.{signature}")
}

fn decision() -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": "/api/sessions",
        "scope": "sessions:read",
        "capability": "sessions.list",
        "subject": "session-catalog",
        "expiresAt": now_millis() + 60_000,
        "correlation": format!("test:{}", NEXT_ROOT.fetch_add(1, Ordering::Relaxed)),
        "revision": "test",
    });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
    let signed = format!("capability-decision.v1.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
    format!("{signed}.{signature}")
}

fn directory_decision() -> String {
    directory_decision_with(
        "/api/runtime-endpoints/list",
        "runtime:endpoints:read",
        "runtime.endpoints.directory",
        "runtime-endpoint-directory",
    )
}

fn platform_tools_decision() -> String {
    directory_decision_with(
        "/api/platform/tools",
        "platform:tools:read",
        "platform.tools.list",
        "platform-tools",
    )
}

fn directory_decision_with(endpoint: &str, scope: &str, capability: &str, subject: &str) -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": endpoint,
        "scope": scope,
        "capability": capability,
        "subject": subject,
        "expiresAt": now_millis() + 60_000,
        "correlation": format!("test:directory:{}", NEXT_ROOT.fetch_add(1, Ordering::Relaxed)),
        "revision": "test",
    });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
    let signed = format!("capability-decision.v1.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
    format!("{signed}.{signature}")
}

fn host_input(root: &TestRoot) -> HostInput {
    let state_dir =
        CanonicalStateDir::provision(root.state_parent.join("openclaw")).expect("state directory");
    HostInput {
        matcha: MatchaAgentInput {
            bun_executable: absolute_path("bin/bun"),
            entry: absolute_path("matcha-agent/dist/cli-bun.js"),
            working_directory: absolute_path("runtime"),
            storage_root: root.matcha_storage_parent.join("app-server"),
            port: 18_790,
            #[cfg(windows)]
            git_bash: absolute_path("bin/bash.exe"),
            #[cfg(unix)]
            guardian_executable: absolute_path("bin/runtime-host-guardian"),
        },
        matcha_secret: Secret::new("test-matcha-secret".into()).expect("matcha secret"),
        open_claw: OpenClawInput {
            electron_image: absolute_path("MatchaClaw"),
            working_directory: absolute_path("runtime"),
            openclaw_dir: root.openclaw_dir.clone(),
            companion_skill_source_root: root.state_parent.join("openclaw-plugins"),
            managed_plugin_root: root.state_parent.join("openclaw-plugins"),
            subagent_template_dir: {
                let path = root.state_parent.join("subagent-templates");
                fs::create_dir_all(&path).expect("create subagent template directory");
                path
            },
            entry: root.openclaw_dir.join("openclaw.mjs"),
            state_dir,
            port: 18_789,
            client_metadata: GatewayClientMetadata::try_new(
                "test".into(),
                std::env::consts::OS.into(),
            )
            .expect("metadata"),
            report_diagnostic: Arc::new(|_| {}),
            #[cfg(unix)]
            guardian_executable: absolute_path("bin/runtime-host-guardian"),
        },
        open_claw_secret: GatewaySecret::new("test-openclaw-secret".into())
            .expect("openclaw secret"),
        organization_store: organization::OrganizationStore::open(
            root.state_parent.join("organization-facts.log"),
        )
        .expect("organization store"),
        runtime_state_dir: root.state_parent.join("runtime-host"),
        app_log_dir: root.state_parent.join("userdata-logs"),
        parent_callback_base_url: "http://127.0.0.1:34100".into(),
        parent_callback_dispatch_token: "test-parent-dispatch-token".into(),
        cron_transport_port: 18_791,
    }
}

fn absolute_path(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
    } else {
        PathBuf::from(format!("/MatchaClaw/{name}"))
    }
}
