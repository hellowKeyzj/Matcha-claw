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
            "runtime-host-workspace-binary-transport-{}-{nanos}-{sequence}",
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

struct RunningServer {
    root: TestRoot,
    owner: owner::Owner,
    task: JoinHandle<io::Result<()>>,
    port: u16,
}

impl RunningServer {
    async fn start() -> Self {
        let root = TestRoot::new();
        let (host, events, handles) = Host::new(host_input(&root)).expect("construct host");
        let owner = owner::Owner::spawn(host, events);
        let verifier = CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        let server = Server::bind(0, verifier, handles.workspace.clone())
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
async fn localhost_transport_limits_the_route_and_redacts_invalid_requests() {
    let server = RunningServer::start().await;

    for request in [
        http_request("GET", "/api/workspace/files/binary", None, ""),
        http_request("POST", "/api/other", None, ""),
    ] {
        let response = server.request(&request).await;
        assert_eq!(response["status"], 404);
        assert_eq!(
            response["body"],
            json!({
                "success": false,
                "error": "Workspace binary route is not available",
            })
        );
    }

    let private_decision = "private-capability-decision";
    let unauthorized = server
        .request(&http_request(
            "POST",
            "/api/workspace/files/binary",
            Some(private_decision),
            &workspace_binary_request("files.readBinary", "docs/asset.bin").to_string(),
        ))
        .await;
    assert_eq!(unauthorized["status"], 401);
    assert_eq!(
        unauthorized["body"],
        json!({
            "success": false,
            "error": "Workspace binary authorization is invalid",
        })
    );
    assert!(!unauthorized.to_string().contains(private_decision));

    let malformed = server
        .request(&http_request(
            "POST",
            "/api/workspace/files/binary",
            Some(&decision("files.readBinary")),
            "{private-malformed-body",
        ))
        .await;
    assert_eq!(malformed["status"], 400);
    assert_eq!(
        malformed["body"],
        json!({
            "success": false,
            "error": "Workspace binary request is invalid",
        })
    );
    assert!(!malformed.to_string().contains("private-malformed-body"));

    for relative_path in ["C:/private/root/asset.bin", "../private.bin"] {
        let response = server
            .request(&http_request(
                "POST",
                "/api/workspace/files/binary",
                Some(&decision("files.readBinary")),
                &workspace_binary_request("files.readBinary", relative_path).to_string(),
            ))
            .await;
        assert_eq!(response["status"], 401);
        assert_eq!(
            response["body"],
            json!({
                "success": false,
                "error": "Workspace binary authorization is invalid",
            })
        );
        assert!(!response.to_string().contains(relative_path));
    }

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_rejects_raw_paths_unknown_fields_stat_limits_and_replays() {
    let server = RunningServer::start().await;

    let mut unknown_field = workspace_binary_request("files.readBinary", "docs/asset.bin");
    unknown_field["input"]["path"] = json!("C:/private/root/asset.bin");
    let unknown_field = server
        .request(&http_request(
            "POST",
            "/api/workspace/files/binary",
            Some(&decision("files.readBinary")),
            &unknown_field.to_string(),
        ))
        .await;
    assert_eq!(unknown_field["status"], 401);
    assert!(
        !unknown_field
            .to_string()
            .contains("C:/private/root/asset.bin")
    );

    let mut stat_with_limit = workspace_binary_request("files.stat", "docs/asset.bin");
    stat_with_limit["input"]["maxBytes"] = json!(1024);
    let stat_with_limit = server
        .request(&http_request(
            "POST",
            "/api/workspace/files/binary",
            Some(&decision("files.stat")),
            &stat_with_limit.to_string(),
        ))
        .await;
    assert_eq!(stat_with_limit["status"], 401);

    let replayed_decision = decision("files.stat");
    let first = server
        .request(&http_request(
            "POST",
            "/api/workspace/files/binary",
            Some(&replayed_decision),
            &workspace_binary_request("files.stat", "docs/asset.bin").to_string(),
        ))
        .await;
    assert_eq!(first["status"], 503);
    let replay = server
        .request(&http_request(
            "POST",
            "/api/workspace/files/binary",
            Some(&replayed_decision),
            &workspace_binary_request("files.stat", "docs/asset.bin").to_string(),
        ))
        .await;
    assert_eq!(replay["status"], 401);
    assert_eq!(
        replay["body"],
        json!({
            "success": false,
            "error": "Workspace binary authorization is invalid",
        })
    );

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

fn workspace_binary_request(operation_id: &str, relative_path: &str) -> Value {
    json!({
        "id": "workspace.file",
        "operationId": operation_id,
        "scope": {
            "kind": "session",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": "openclaw",
                "runtimeInstanceId": "local",
            },
            "sessionKey": "agent:main:demo",
        },
        "target": { "kind": "workspace-file" },
        "input": {
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": "openclaw",
                "runtimeInstanceId": "local",
            },
            "sessionKey": "agent:main:demo",
            "relativePath": relative_path,
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

fn decision(capability: &str) -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": "/api/workspace/files/binary",
        "scope": "workspace-files:binary",
        "capability": capability,
        "subject": "workspace-binary",
        "expiresAt": now_millis() + 60_000,
        "correlation": format!("test:{}", NEXT_ROOT.fetch_add(1, Ordering::Relaxed)),
        "revision": "test",
    });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
    let signed = format!("capability-decision.v1.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
    format!("{signed}.{signature}")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
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

fn absolute_path(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
    } else {
        PathBuf::from(format!("/MatchaClaw/{name}"))
    }
}
