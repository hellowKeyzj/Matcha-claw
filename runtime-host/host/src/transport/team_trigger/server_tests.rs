use std::{
    fs, io,
    num::NonZeroU32,
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
use organization::{
    DeliveryLedgerSnapshot, GraphDefinition, GraphRunFacts, GraphRunId, GraphState, MemberId,
    NodeDefinition, NodeId, OrganizationFacts, RoleAssignment, RoleId, RoleKind, StartTrigger,
    TeamDefinition, TeamFacts, TeamId, TeamMember, TeamRevision, TeamRole,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    task::JoinHandle,
};

use super::*;
use crate::{Host, HostInput, MatchaAgentInput, OpenClawInput, RuntimeObservationConfig, owner};

const ROUTE: &str = "/api/team/trigger";
const WEBHOOK_AUTH_ROUTE: &str = "/api/team/webhook-auth";
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
            .expect("test clock must follow the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "runtime-host-team-trigger-transport-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(path.join("matcha/app-server")).expect("create test root");
        let openclaw = WorkspaceProjectionFixture::install(&path);
        Self { path, openclaw }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
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
        Self::start_with_facts(None).await
    }

    async fn start_with_facts(facts: Option<OrganizationFacts>) -> Self {
        let root = TestRoot::new();
        let mut input = host_input(&root);
        if let Some(facts) = facts {
            input
                .organization_store
                .replace_facts(facts)
                .expect("seed organization facts");
        }
        let (host, events, handles) = Host::new(input).expect("construct host");
        let owner = owner::Owner::spawn(host, events);
        let verifier = CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        let token = WebhookToken::try_new(&test_webhook_token()).expect("valid webhook token");
        let server = Server::bind(0, verifier, token, handles.organization.clone())
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

    async fn request(&self, request: &str) -> (Value, String) {
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
        let wire = String::from_utf8(response).expect("response utf8");
        let parsed = parse_response(&wire);
        (parsed, wire)
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
async fn localhost_auth_request_returns_the_sealed_persisted_projection() {
    let server = RunningServer::start().await;
    let body = r#"{}"#;
    let (response, wire) = server
        .request(&http_request(WEBHOOK_AUTH_ROUTE, &decision(), body))
        .await;

    assert_eq!(response["status"], 200);
    assert_eq!(
        response["body"],
        json!({
            "success": true,
            "enabled": true,
            "source": "settings",
            "headerName": "x-matchaclaw-webhook-token",
            "authorizationScheme": "Bearer",
            "maskedToken": "mctwh_…aaaa",
            "copySupported": false,
        })
    );
    assert!(!wire.contains(&test_webhook_token()));

    server.stop().await;
}

#[tokio::test]
async fn localhost_auth_route_requires_post_authorization_and_empty_json_object() {
    let server = RunningServer::start().await;

    let (response, _) = server
        .request(&http_request_without_authorization(
            WEBHOOK_AUTH_ROUTE,
            r#"{}"#,
        ))
        .await;
    assert_eq!(response["status"], 401);

    let (response, _) = server
        .request(&http_request(
            WEBHOOK_AUTH_ROUTE,
            &decision(),
            r#"{"action":"auth"}"#,
        ))
        .await;
    assert_eq!(response["status"], 400);

    let (response, _) = server
        .request(&http_request_with_method(
            "GET",
            WEBHOOK_AUTH_ROUTE,
            Some(&decision()),
            r#"{}"#,
        ))
        .await;
    assert_eq!(response["status"], 404);

    server.stop().await;
}

#[tokio::test]
async fn trigger_management_rejects_auth_without_a_compatibility_fallback() {
    let server = RunningServer::start().await;
    let (response, _) = server
        .request(&http_request(
            ROUTE,
            &trigger_decision(),
            r#"{"action":"auth"}"#,
        ))
        .await;

    assert_eq!(response["status"], 400);
    server.stop().await;
}

#[tokio::test]
async fn external_webhook_accepts_native_token_and_returns_accepted_without_body_projection() {
    let server = RunningServer::start_with_facts(Some(facts_with_armed_webhook_run())).await;
    let body = r#"{"token":"private-body-secret","message":"ignored"}"#;
    let (response, wire) = server
        .request(&external_webhook_request(
            "/api/team-runtime/webhooks/private-webhook-path",
            Some(&test_webhook_token()),
            Some("request:one"),
            body,
            false,
        ))
        .await;

    assert_eq!(response["status"], 202);
    assert_eq!(response["body"]["success"], true);
    assert_eq!(response["body"]["runId"], "run:one");
    assert!(!wire.contains("private-body-secret"));
    assert!(!wire.contains(&test_webhook_token()));

    server.stop().await;
}

#[tokio::test]
async fn external_webhook_accepts_bearer_token_and_generates_idempotency_when_missing() {
    let server = RunningServer::start_with_facts(Some(facts_with_armed_webhook_run())).await;
    let (response, wire) = server
        .request(&external_webhook_request(
            "/api/team-runtime/webhooks/alternate",
            Some(&test_webhook_token()),
            None,
            "{}",
            true,
        ))
        .await;

    assert_eq!(response["status"], 202);
    assert_eq!(response["body"]["success"], true);
    assert_eq!(response["body"]["runId"], "run:one");
    assert!(!wire.contains(&test_webhook_token()));

    server.stop().await;
}

#[tokio::test]
async fn external_webhook_rejects_bad_token_and_preserves_not_found_and_duplicate_decisions() {
    let server = RunningServer::start_with_facts(Some(facts_with_armed_webhook_run())).await;
    let (response, _) = server
        .request(&external_webhook_request(
            "/api/team-runtime/webhooks/private-webhook-path",
            Some("wrong-token"),
            Some("request:unauthorized"),
            "{}",
            false,
        ))
        .await;
    assert_eq!(response["status"], 401);

    let (response, _) = server
        .request(&external_webhook_request(
            "/api/team-runtime/webhooks/missing",
            Some(&test_webhook_token()),
            Some("request:not-found"),
            "{}",
            false,
        ))
        .await;
    assert_eq!(response["status"], 404);

    let duplicate_facts = facts_with_duplicate_webhook_run();
    let duplicate = RunningServer::start_with_facts(Some(duplicate_facts)).await;
    let (response, _) = duplicate
        .request(&external_webhook_request(
            "/api/team-runtime/webhooks/private-webhook-path",
            Some(&test_webhook_token()),
            Some("request:duplicate"),
            "{}",
            false,
        ))
        .await;
    assert_eq!(response["status"], 409);

    duplicate.stop().await;
    server.stop().await;
}

fn test_webhook_token() -> String {
    format!("mctwh_{}", "a".repeat(64))
}

fn external_webhook_request(
    path: &str,
    token: Option<&str>,
    idempotency_key: Option<&str>,
    body: &str,
    bearer: bool,
) -> String {
    let authorization = match (token, bearer) {
        (Some(token), true) => format!("Authorization: Bearer {token}\r\n"),
        _ => String::new(),
    };
    let webhook_token = match (token, bearer) {
        (Some(token), false) => format!("x-matchaclaw-webhook-token: {token}\r\n"),
        _ => String::new(),
    };
    let idempotency = idempotency_key
        .map(|key| format!("x-idempotency-key: {key}\r\n"))
        .unwrap_or_default();
    format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{authorization}{webhook_token}{idempotency}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len(),
    )
}

fn http_request(path: &str, authorization: &str, body: &str) -> String {
    http_request_with_method("POST", path, Some(authorization), body)
}

fn http_request_without_authorization(path: &str, body: &str) -> String {
    http_request_with_method("POST", path, None, body)
}

fn http_request_with_method(
    method: &str,
    path: &str,
    authorization: Option<&str>,
    body: &str,
) -> String {
    let authorization = authorization
        .map(|value| format!("Authorization: Bearer {value}\r\n"))
        .unwrap_or_default();
    format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{authorization}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len(),
    )
}

fn parse_response(response: &str) -> Value {
    let (head, body) = response.split_once("\r\n\r\n").expect("response body");
    let status = head
        .split_whitespace()
        .nth(1)
        .expect("status")
        .parse::<u16>()
        .expect("numeric status");
    json!({
        "status": status,
        "body": serde_json::from_str::<Value>(body).expect("json body")
    })
}

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[37; 32])
}

fn verification_key() -> String {
    let mut bytes = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decision() -> String {
    decision_at(
        WEBHOOK_AUTH_ROUTE,
        "team:read",
        "team.webhook-auth",
        "team-webhook-auth",
    )
}

fn trigger_decision() -> String {
    decision_at(ROUTE, "team:write", "team.trigger", "team-trigger")
}

fn decision_at(endpoint: &str, scope: &str, capability: &str, subject: &str) -> String {
    let payload = json!({
        "version": 1,
        "principal": "localhost-test",
        "endpoint": endpoint,
        "scope": scope,
        "capability": capability,
        "subject": subject,
        "expiresAt": now_millis() + 60_000,
        "correlation": "team-webhook-auth-listener-test",
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

fn facts_with_armed_webhook_run() -> OrganizationFacts {
    let team = TeamId::try_new("team:one").expect("team id");
    let definition = GraphDefinition::new(
        "graph:one",
        "plan:one",
        GraphRunId::new("run:one"),
        "display",
        vec![
            NodeDefinition::start(
                NodeId::new("start"),
                "webhook start",
                NonZeroU32::new(2).expect("attempt count"),
                Some(StartTrigger::Webhook {
                    path: "private-webhook-path".to_owned(),
                }),
            ),
            NodeDefinition::start(
                NodeId::new("alternate"),
                "alternate webhook start",
                NonZeroU32::new(2).expect("attempt count"),
                Some(StartTrigger::Webhook {
                    path: "alternate".to_owned(),
                }),
            ),
        ],
        Vec::new(),
    )
    .expect("graph definition");
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(team.clone()),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![
            GraphRunFacts::new(
                team,
                TeamRevision::initial(),
                GraphState::initialize(definition, 1),
                None,
            )
            .expect("graph run facts"),
        ],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .expect("organization facts")
}

fn facts_with_duplicate_webhook_run() -> OrganizationFacts {
    let team = TeamId::try_new("team:one").expect("team id");
    let definition = GraphDefinition::new(
        "graph:duplicate",
        "plan:duplicate",
        GraphRunId::new("run:duplicate"),
        "display",
        vec![
            NodeDefinition::start(
                NodeId::new("first"),
                "first webhook start",
                NonZeroU32::new(2).expect("attempt count"),
                Some(StartTrigger::Webhook {
                    path: "private-webhook-path".to_owned(),
                }),
            ),
            NodeDefinition::start(
                NodeId::new("second"),
                "second webhook start",
                NonZeroU32::new(2).expect("attempt count"),
                Some(StartTrigger::Webhook {
                    path: "private-webhook-path".to_owned(),
                }),
            ),
        ],
        Vec::new(),
    )
    .expect("graph definition");
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(team.clone()),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![
            GraphRunFacts::new(
                team,
                TeamRevision::initial(),
                GraphState::initialize(definition, 1),
                None,
            )
            .expect("graph run facts"),
        ],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .expect("organization facts")
}

fn team_definition(team_id: TeamId) -> TeamDefinition {
    let member_id = MemberId::try_new("member:leader").expect("member id");
    let role_id = RoleId::try_new("leader").expect("role id");
    TeamDefinition::try_new(
        team_id,
        "Team One",
        vec![TeamMember::try_new(member_id.clone(), "Leader").expect("team member")],
        vec![TeamRole::try_new(role_id.clone(), "Leader", RoleKind::Leader).expect("team role")],
        vec![RoleAssignment::new(member_id, role_id)],
    )
    .expect("team definition")
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
