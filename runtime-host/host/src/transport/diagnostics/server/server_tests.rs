use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer as _, SigningKey};
use foundation::execution::{ObservationObserver, ObservationRecord, ObservationSink};
use matcha_agent::lifecycle::secret::Secret;
use openclaw::{
    gateway::{auth::GatewaySecret, client::GatewayClientMetadata},
    lifecycle::state_dir::CanonicalStateDir,
    projection::workspace::WorkspaceProjectionFixture,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    task::JoinHandle,
};

use super::*;
use crate::{Host, HostInput, MatchaAgentInput, OpenClawInput, RuntimeObservationConfig, owner};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    base: PathBuf,
    matcha_storage_parent: PathBuf,
    state_parent: PathBuf,
    openclaw: WorkspaceProjectionFixture,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "runtime-host-diagnostics-transport-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        let state_parent = base.join("state");
        let matcha_storage_parent = base.join("matcha");
        fs::create_dir_all(&state_parent).expect("create state parent");
        fs::create_dir(&matcha_storage_parent).expect("create matcha parent");
        let openclaw = WorkspaceProjectionFixture::install(&base);
        Self {
            base,
            matcha_storage_parent,
            state_parent,
            openclaw,
        }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

struct RecordingObserver {
    records: StdMutex<Vec<ObservationRecord>>,
}

impl RecordingObserver {
    fn new() -> Self {
        Self {
            records: StdMutex::new(Vec::new()),
        }
    }

    fn records(&self) -> Vec<ObservationRecord> {
        self.records.lock().expect("records lock").clone()
    }
}

impl ObservationObserver for RecordingObserver {
    fn observe(&self, record: ObservationRecord) {
        self.records.lock().expect("records lock").push(record);
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
        Self::start_with_observation(ObservationSink::disabled()).await
    }

    async fn start_with_observation(observation: ObservationSink) -> Self {
        let root = TestRoot::new();
        let (mut host, events, handles) = Host::new(host_input(&root)).expect("construct host");
        host.start().await.expect("start host");
        let owner = owner::Owner::spawn(host, events);
        let verifier = CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        let server = Server::bind(0, verifier, handles.diagnostics.clone(), observation)
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
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _ = &self.root;
    }
}

#[tokio::test]
async fn localhost_transport_enforces_fixed_authorized_redacted_archive_request() {
    let server = RunningServer::start().await;

    for request in [
        http_request("GET", "/api/diagnostics/archive", None, ""),
        http_request("POST", "/api/other", None, ""),
    ] {
        let response = server.request(&request).await;
        assert_eq!(response["status"], 404);
        assert_eq!(
            response["body"],
            json!({
                "success": false,
                "error": "Diagnostics archive route is not available",
            })
        );
    }

    let private_decision = "private-capability-decision";
    let unauthorized = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            Some(private_decision),
            "{}",
        ))
        .await;
    assert_eq!(unauthorized["status"], 401);
    assert_eq!(
        unauthorized["body"],
        json!({
            "success": false,
            "error": "Diagnostics archive authorization is invalid",
        })
    );
    assert!(!unauthorized.to_string().contains(private_decision));

    let invalid_body = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            Some(&decision(
                "/api/diagnostics/archive",
                "diagnostics:write",
                "diagnostics.archive",
            )),
            r#"{"path":"private"}"#,
        ))
        .await;
    assert_eq!(invalid_body["status"], 401);
    assert_eq!(
        invalid_body["body"],
        json!({
            "success": false,
            "error": "Diagnostics archive authorization is invalid",
        })
    );
    assert!(!invalid_body.to_string().contains("private"));

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_observes_ingress_without_sensitive_material() {
    let observer = Arc::new(RecordingObserver::new());
    let sink = {
        let observer: Arc<dyn ObservationObserver> = observer.clone();
        ObservationSink::new(observer)
    };
    let server = RunningServer::start_with_observation(sink).await;

    let unknown_path = "/api/private-raw-path";
    let missing_auth = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            None,
            "{}",
        ))
        .await;
    assert_eq!(missing_auth["status"], 401);

    let rejected_path = server
        .request(&http_request("POST", unknown_path, None, "{}"))
        .await;
    assert_eq!(rejected_path["status"], 404);

    let bad_json = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            Some(&decision(
                "/api/diagnostics/archive",
                "diagnostics:write",
                "diagnostics.archive",
            )),
            "{private-json",
        ))
        .await;
    assert_eq!(bad_json["status"], 400);

    let private_decision = "private-capability-decision";
    let capability_rejected = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            Some(private_decision),
            r#"{"token":"private-token"}"#,
        ))
        .await;
    assert_eq!(capability_rejected["status"], 401);

    let accepted = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            Some(&decision(
                "/api/diagnostics/archive",
                "diagnostics:write",
                "diagnostics.archive",
            )),
            "{}",
        ))
        .await;
    assert_eq!(accepted["status"], 200);

    let archive_id = "0123456789abcdef0123456789abcdef";
    let download_missing = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive/download",
            Some(&decision(
                "/api/diagnostics/archive/download",
                "diagnostics:read",
                "diagnostics.archive.download",
            )),
            &serde_json::to_string(&json!({ "archiveId": archive_id })).unwrap(),
        ))
        .await;
    assert_eq!(download_missing["status"], 404);

    let records = format!("{:?}", observer.records());
    for expected in [
        "unknown",
        "diagnostics.archive",
        "diagnostics.download",
        "diagnostics.ingress.methodOrPathRejected",
        "diagnostics.ingress.missingAuthorization",
        "diagnostics.ingress.badJson",
        "diagnostics.ingress.capabilityRejected",
        "diagnostics.archive.accepted",
        "diagnostics.archive.completed",
        "diagnostics.download.accepted",
        "diagnostics.download.archiveNotFound",
    ] {
        assert!(
            records.contains(expected),
            "missing {expected} in {records}"
        );
    }
    for forbidden in [
        private_decision,
        "private-token",
        "private-json",
        unknown_path,
        archive_id,
        "authorization",
        "headers",
    ] {
        assert!(
            !records.contains(forbidden),
            "leaked {forbidden} in {records}"
        );
    }

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_returns_only_the_completed_opaque_receipt() {
    let server = RunningServer::start().await;

    let response = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            Some(&decision(
                "/api/diagnostics/archive",
                "diagnostics:write",
                "diagnostics.archive",
            )),
            "{}",
        ))
        .await;

    assert_eq!(response["status"], 200);
    let receipt = response["body"]
        .as_object()
        .expect("opaque archive receipt");
    assert_eq!(receipt.len(), 4);
    assert!(receipt["archiveId"].as_str().is_some_and(
        |value| value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    ));
    assert_eq!(receipt["terminal"], "completed");
    assert!(
        receipt["entries"]
            .as_u64()
            .is_some_and(|entries| entries > 0)
    );
    assert!(receipt["bytes"].as_u64().is_some_and(|bytes| bytes > 0));
    let wire = response.to_string();
    for forbidden in [
        "path",
        "reveal",
        "workspace",
        "config",
        "transcript",
        "secret",
    ] {
        assert!(!wire.contains(forbidden));
    }

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_rejects_replayed_and_misbinding_decisions() {
    let server = RunningServer::start().await;
    let issued_decision = decision(
        "/api/diagnostics/archive",
        "diagnostics:write",
        "diagnostics.archive",
    );
    let first = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            Some(&issued_decision),
            "{}",
        ))
        .await;
    assert_eq!(first["status"], 200);
    let receipt = first["body"].as_object().expect("opaque archive receipt");
    assert_eq!(receipt.len(), 4);
    assert_eq!(receipt["terminal"], "completed");
    assert!(
        receipt["archiveId"]
            .as_str()
            .is_some_and(|value| value.len() == 32)
    );
    assert!(receipt["bytes"].as_u64().is_some_and(|bytes| bytes > 0));

    let replay = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            Some(&issued_decision),
            "{}",
        ))
        .await;
    assert_eq!(replay["status"], 401);

    for (endpoint, scope, capability) in [
        ("/api/sessions", "diagnostics:write", "diagnostics.archive"),
        (
            "/api/diagnostics/archive",
            "sessions:read",
            "diagnostics.archive",
        ),
        (
            "/api/diagnostics/archive",
            "diagnostics:write",
            "sessions.list",
        ),
    ] {
        let response = server
            .request(&http_request(
                "POST",
                "/api/diagnostics/archive",
                Some(&decision(endpoint, scope, capability)),
                "{}",
            ))
            .await;
        assert_eq!(response["status"], 401);
    }

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_downloads_a_completed_archive_with_the_frozen_shape() {
    let server = RunningServer::start().await;
    let created = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive",
            Some(&decision(
                "/api/diagnostics/archive",
                "diagnostics:write",
                "diagnostics.archive",
            )),
            "{}",
        ))
        .await;
    assert_eq!(created["status"], 200);
    let archive_id = created["body"]["archiveId"]
        .as_str()
        .expect("created archive id")
        .to_owned();

    let downloaded = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive/download",
            Some(&decision(
                "/api/diagnostics/archive/download",
                "diagnostics:read",
                "diagnostics.archive.download",
            )),
            &serde_json::to_string(&json!({ "archiveId": archive_id })).unwrap(),
        ))
        .await;

    assert_eq!(downloaded["status"], 200);
    let body = downloaded["body"].as_object().expect("download body");
    assert_eq!(body.len(), 2);
    assert_eq!(
        body.get("archiveId").and_then(Value::as_str),
        Some(archive_id.as_str())
    );
    let data = body
        .get("data")
        .and_then(Value::as_str)
        .expect("standard base64 archive data");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("valid standard base64");
    assert!(decoded.starts_with(b"PK"), "downloaded bytes must be a ZIP");

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_rejects_invalid_misbinding_and_replayed_download_decisions() {
    let server = RunningServer::start().await;
    let archive_id = "0123456789abcdef0123456789abcdef";
    let body = serde_json::to_string(&json!({ "archiveId": archive_id })).unwrap();

    let invalid = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive/download",
            Some("not-a-capability-decision"),
            &body,
        ))
        .await;
    assert_eq!(invalid["status"], 401);
    assert_eq!(
        invalid["body"],
        json!({
            "success": false,
            "error": "Diagnostics archive authorization is invalid",
        })
    );

    for (endpoint, scope, capability) in [
        (
            "/api/diagnostics/archive",
            "diagnostics:read",
            "diagnostics.archive.download",
        ),
        (
            "/api/diagnostics/archive/download",
            "diagnostics:write",
            "diagnostics.archive",
        ),
        (
            "/api/diagnostics/archive/download",
            "diagnostics:read",
            "diagnostics.archive",
        ),
    ] {
        let response = server
            .request(&http_request(
                "POST",
                "/api/diagnostics/archive/download",
                Some(&decision(endpoint, scope, capability)),
                &body,
            ))
            .await;
        assert_eq!(response["status"], 401);
    }

    let issued = decision(
        "/api/diagnostics/archive/download",
        "diagnostics:read",
        "diagnostics.archive.download",
    );
    let unknown = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive/download",
            Some(&issued),
            &body,
        ))
        .await;
    assert_eq!(unknown["status"], 404);
    assert_eq!(
        unknown["body"],
        json!({
            "success": false,
            "error": "Diagnostics archive was not found",
        })
    );
    assert!(!unknown.to_string().contains(archive_id));

    let replay = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive/download",
            Some(&issued),
            &body,
        ))
        .await;
    assert_eq!(replay["status"], 401);

    let invalid_id = server
        .request(&http_request(
            "POST",
            "/api/diagnostics/archive/download",
            Some(&decision(
                "/api/diagnostics/archive/download",
                "diagnostics:read",
                "diagnostics.archive.download",
            )),
            r#"{"archiveId":"../escape"}"#,
        ))
        .await;
    assert_eq!(invalid_id["status"], 401);

    server.stop().await;
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

fn parse_response(response: &[u8]) -> Value {
    let response = std::str::from_utf8(response).expect("response utf8");
    let (head, body) = response.split_once("\r\n\r\n").expect("response body");
    let status = head
        .split_whitespace()
        .nth(1)
        .expect("status")
        .parse::<u16>()
        .expect("numeric status");
    json!({ "status": status, "body": serde_json::from_str::<Value>(body).expect("json body") })
}

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[9; 32])
}

fn verification_key() -> String {
    let mut bytes = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decision(endpoint: &str, scope: &str, capability: &str) -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": endpoint,
        "scope": scope,
        "capability": capability,
        "subject": "host-diagnostics",
        "expiresAt": now_millis() + 60_000,
        "correlation": format!("test:{}", NEXT_ROOT.fetch_add(1, Ordering::Relaxed)),
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
            openclaw_dir: root.openclaw.openclaw_dir().to_owned(),
            companion_skill_source_root: root.state_parent.join("openclaw-plugins"),
            managed_plugin_root: root.state_parent.join("openclaw-plugins"),
            subagent_template_dir: {
                let path = root.state_parent.join("subagent-templates");
                fs::create_dir_all(&path).expect("create subagent template directory");
                path
            },
            entry: root.openclaw.openclaw_dir().join("openclaw.mjs"),
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
        runtime_observation: RuntimeObservationConfig::off(),
    }
}

fn absolute_path(path: &str) -> PathBuf {
    std::env::current_dir()
        .expect("current directory")
        .join(path)
}
