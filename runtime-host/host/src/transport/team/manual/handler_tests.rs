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
use tokio::sync::Mutex;

use super::*;
use crate::{Host, HostInput, MatchaAgentInput, OpenClawInput, RuntimeObservationConfig};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    path: PathBuf,
    openclaw: WorkspaceProjectionFixture,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test root clock must follow the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "runtime-host-manual-team-transport-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(path.join("matcha")).expect("create test root");
        let openclaw = WorkspaceProjectionFixture::install(&path);
        Self { path, openclaw }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct RunningHandler {
    root: TestRoot,
    owner: crate::host_actor::Owner,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    organization: crate::organization::OrganizationHandle,
}

impl RunningHandler {
    async fn start() -> Self {
        let root = TestRoot::new();
        let (host, events, handles) = Host::new(host_input(&root)).expect("construct host");
        let owner = crate::host_actor::Owner::spawn(host, events);
        let verifier = Arc::new(Mutex::new(
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier"),
        ));
        Self {
            root,
            owner,
            verifier,
            organization: handles.organization,
        }
    }

    async fn request(&self, authorization: Option<&str>, body: &str) -> Value {
        let mut headers = Vec::new();
        if let Some(authorization) = authorization {
            headers.push((
                "authorization".to_owned(),
                format!("Bearer {authorization}"),
            ));
        }
        let response = handle_localhost(
            "POST".to_owned(),
            ROUTE.to_owned(),
            headers,
            body.as_bytes().to_vec(),
            Arc::clone(&self.verifier),
            self.organization.clone(),
        )
        .await;
        json!({ "status": response.status, "body": response.body })
    }

    async fn stop(mut self) {
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
async fn localhost_transport_rejects_nonsealed_or_legacy_requests_without_disclosure() {
    let server = RunningHandler::start().await;

    let private_decision = "private-capability-decision";
    let unauthorized = server
        .request(Some(private_decision), &manual_team_request().to_string())
        .await;
    assert_eq!(unauthorized["status"], 401);
    assert_eq!(
        unauthorized["body"],
        json!({ "success": false, "error": "Manual Team materialization authorization is invalid" })
    );
    assert!(!unauthorized.to_string().contains(private_decision));

    let mut unknown = manual_team_request();
    unknown["rawWorkspace"] = json!("C:/private/workspace");
    let invalid = server
        .request(
            Some(&decision("team.manual.materialize-and-create", "unknown")),
            &unknown.to_string(),
        )
        .await;
    assert_eq!(invalid["status"], 400);
    assert_eq!(
        invalid["body"],
        json!({ "success": false, "error": "Manual Team materialization request is invalid" })
    );
    assert!(!invalid.to_string().contains("C:/private/workspace"));

    let mut legacy_binding = manual_team_request();
    legacy_binding["roles"][0]["workspaceBinding"] = json!("binding.lead");
    let invalid = server
        .request(
            Some(&decision(
                "team.manual.materialize-and-create",
                "legacy-binding",
            )),
            &legacy_binding.to_string(),
        )
        .await;
    assert_eq!(invalid["status"], 400);
    assert!(!invalid.to_string().contains("binding.lead"));

    let wrong_operation = server
        .request(
            Some(&decision("team.skill.materialize", "wrong-operation")),
            &manual_team_request().to_string(),
        )
        .await;
    assert_eq!(wrong_operation["status"], 401);

    server.stop().await;
}

#[tokio::test]
async fn localhost_transport_rejects_replayed_decisions_without_active_delivery() {
    let server = RunningHandler::start().await;
    let replayed = decision("team.manual.materialize-and-create", "replayed");
    let mut invalid = manual_team_request();
    invalid["rawWorkspace"] = json!("C:/private/workspace");

    let first = server.request(Some(&replayed), &invalid.to_string()).await;
    assert_eq!(first["status"], 400);
    assert_eq!(
        first["body"],
        json!({ "success": false, "error": "Manual Team materialization request is invalid" })
    );
    assert!(!first.to_string().contains("C:/private/workspace"));

    let replay = server.request(Some(&replayed), &invalid.to_string()).await;
    assert_eq!(replay["status"], 401);
    assert_eq!(
        replay["body"],
        json!({ "success": false, "error": "Manual Team materialization authorization is invalid" })
    );

    server.stop().await;
}

fn manual_team_request() -> Value {
    json!({
        "teamId": "team:manual",
        "teamName": "Manual Team",
        "idempotencyKey": "manual:transport",
        "roles": [
            { "roleId": "leader", "agentId": "agent:lead", "displayName": "Lead", "leader": true }
        ]
    })
}

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[29; 32])
}

fn verification_key() -> String {
    let mut bytes = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decision(operation: &str, correlation: &str) -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": ROUTE,
        "scope": "team:write",
        "capability": operation,
        "subject": "team-manual-materialize-and-create",
        "expiresAt": now_millis() + 60_000,
        "correlation": correlation,
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
        CanonicalStateDir::provision(root.path.join("openclaw-state")).expect("state directory");
    HostInput {
        matcha: MatchaAgentInput {
            bun_executable: absolute_path("bin/bun"),
            entry: absolute_path("matcha-agent/dist/cli-bun.js"),
            working_directory: absolute_path("runtime"),
            storage_root: root.path.join("matcha/app-server"),
            port: 18_790,
            #[cfg(windows)]
            git_bash: absolute_path("bin/bash.exe"),
            #[cfg(unix)]
            guardian_executable: absolute_path("bin/runtime-host-guardian"),
        },
        matcha_secret: Secret::new("test-matcha-secret".into()).expect("matcha secret"),
        open_claw: OpenClawInput {
            team_run_mcp_executable: absolute_path("runtime-host-mcp"),
            team_run_mcp_state_dir: absolute_path("runtime-host"),
            electron_image: absolute_path("MatchaClaw"),
            working_directory: absolute_path("runtime"),
            openclaw_dir: root.openclaw.openclaw_dir().to_owned(),
            companion_skill_source_root: root.path.join("openclaw-plugins"),
            managed_plugin_root: root.path.join("openclaw-plugins"),
            subagent_template_dir: {
                let path = root.path.join("subagent-templates");
                fs::create_dir_all(&path).expect("create subagent template directory");
                path
            },
            entry: root.openclaw.openclaw_dir().join("openclaw.mjs"),
            state_dir,
            port: 18_789,
            sealed_endpoint: None,
            sealed_token: None,
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
            root.path.join("organization-facts.log"),
        )
        .expect("organization store"),
        runtime_state_dir: root.path.join("runtime-host"),
        app_log_dir: root.path.join("userdata-logs"),
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
